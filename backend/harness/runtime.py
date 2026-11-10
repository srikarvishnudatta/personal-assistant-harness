"""Python-owned agent loop, memory, approvals, workflows and background scheduler."""
import asyncio
import base64
import hashlib
import json
import re
import time
from uuid import uuid4
from zoneinfo import ZoneInfo

from starlette.responses import JSONResponse, Response

from .agent import AgentCapabilities, run_assistant
from .browser import BrowserService
from .config import Config
from .connectors import GoogleConnector
from .memory import build_context, sync_memory_files
from .proactivity import select_update
from .scheduling import next_cron_time, next_interval_time
from .store import LocalStore
from .workflows import research_workflow, workflow_task_id
from .workspace import WorkspaceService


def now_ms(): return int(time.time() * 1000)
def text(value, fallback=''): return value if isinstance(value, str) else fallback
def dump(value): return json.dumps(value, ensure_ascii=False, separators=(',', ':'))
def safe_error(error):
    message = re.sub(r'sk-[A-Za-z0-9_-]+', '[redacted]', str(error) or type(error).__name__)
    return re.sub(r'Bearer\s+\S+', 'Bearer [redacted]', message, flags=re.I)[:800]


WRITES = {'browser.click', 'browser.fill', 'gmail.send', 'calendar.create', 'workspace.execute', 'skill.save'}
READ_ONLY = {'browser_read', 'memory_search', 'skills', 'gmail_read', 'calendar_read'}
BLOCKING_APPROVALS = {'pending', 'approved', 'executing', 'uncertain'}


class Runtime:
    def __init__(self, config: Config, store=None, runner=None, browser=None, google=None, workspace=None):
        self.config = config
        if len(config.token) < 24: raise ValueError('HARNESS_TOKEN must have at least 24 characters')
        if config.model != 'gpt-6-luna': raise ValueError('Only gpt-6-luna is permitted')
        if any(type(n) is not int or n <= 0 for n in (config.daily_token_limit, config.run_token_reservation)):
            raise ValueError('Token limits must be positive integers')
        self.store = store or LocalStore(config.data_dir / 'assistant.sqlite')
        self.runner = runner or run_assistant
        self.browser = browser or BrowserService(config.data_dir / 'browser-profile', executable_path=config.browser_executable, channel=config.browser_channel)
        self.google = google or GoogleConnector(config.google_client_id, config.google_client_secret,
            f'http://127.0.0.1:{config.port}/oauth/google/callback', config.data_dir / 'credentials' / 'google.enc', config.encryption_secret)
        self.workspace = workspace or WorkspaceService(config.data_dir / 'workspace', docker_enabled=config.docker_enabled, docker_image=config.docker_image)
        self.instance_id = str(uuid4())
        self.active = {}
        self.model_tasks = {}
        self.chat_busy = False
        self.stopping = False
        self.ticking = False
        self.privacy_epoch = 0
        self.timer = None
        self.projection_lock = asyncio.Lock()
        self.store.append_event('runtime.recovery', self.store.recover_interrupted())

    async def start(self):
        self.stopping = False
        if self.store.get_setting('nightlyDreamEnabled') is not False and not any(s['id'] == 'nightly-dream' for s in self.store.list_schedules()):
            timezone = self.store.get_setting('timezone') or 'America/Toronto'
            self.store.save_schedule(dict(id='nightly-dream', prompt='Consolidate recent context into evidence-backed memory proposals. Preserve user corrections.', kind='dream', cron='0 3 * * *', timezone=timezone, runAt=next_cron_time('0 3 * * *', timezone)))
        await self.tick()
        self.timer = asyncio.create_task(self._loop())

    async def _loop(self):
        while not self.stopping:
            await asyncio.sleep(1)
            try: await self.tick()
            except Exception as error: self.store.append_event('scheduler.error', {'message': safe_error(error)})

    async def close(self):
        self.stopping = True
        current = asyncio.current_task()
        tasks = set(self.active.values()) | set(self.model_tasks.values())
        if self.timer: tasks.add(self.timer)
        tasks.discard(current)
        for task in tasks: task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        await self.browser.close()
        close = getattr(self.google, 'close', None)
        if close: await close()
        self.store.close()

    async def project_memory(self):
        async with self.projection_lock:
            try:
                report = await sync_memory_files(self.store, self.workspace)
                self.store.set_setting('memoryProjectionStale', False)
                return report
            except Exception as error:
                self.store.set_setting('memoryProjectionStale', True)
                self.store.append_event('memory.projection-failed', {'message': safe_error(error)})
                return {'error': 'Readable memory projection could not be refreshed. SQLite remains authoritative; managed files are blocked until refreshed.', 'revision': self.store.revision()}

    async def model(self, prompt, context, task=None, read_only=False, no_tools=False):
        if not self.config.api_key: raise ValueError('Configure OPENAI_API_KEY in .dev.vars')
        run_id = str(uuid4()); key = task['id'] if task else run_id
        self.store.reserve_usage(run_id, self.config.daily_token_limit, self.config.run_token_reservation)
        recorded = False; epoch = self.privacy_epoch
        self.model_tasks[key] = asyncio.current_task()
        def ensure_active():
            if self.stopping or epoch != self.privacy_epoch or (task and self.store.get_task(task['id'])['status'] == 'cancelled'):
                raise ValueError('Run cancelled or context forgotten')
        async def remember(value):
            ensure_active()
            if read_only: raise ValueError('This run is read-only')
            memory = self.store.save_memory(dict(text=value, source=f'run:{run_id}', sourceIds=[m['id'] for m in self.store.list_messages(1)], provenance='inferred', confidence=0.7))
            await self.project_memory(); return memory
        async def schedule(prompt, run_at, interval_seconds=None):
            ensure_active()
            if read_only: raise ValueError('This run is read-only')
            return self.create_schedule(dict(prompt=prompt, runAt=run_at, intervalSeconds=interval_seconds))
        async def operate(operation, arguments_json):
            ensure_active()
            args = json.loads(arguments_json)
            if not isinstance(args, dict): raise ValueError('Tool arguments must be a JSON object')
            return await self.operate(operation, args, task, read_only)
        def on_usage(input_tokens, output_tokens):
            nonlocal recorded
            self.store.finish_usage(run_id, input_tokens, output_tokens); recorded = True
        def on_evidence(urls): self.store.append_event('source.observed', {'urls': urls, 'observedAt': now_ms()}, task['id'] if task else None)
        capabilities = AgentCapabilities(remember=remember, schedule=schedule, operate=None if no_tools else operate,
            read_only=read_only, web_search=not no_tools, on_usage=on_usage, on_evidence=on_evidence)
        try:
            self.store.append_event('run.started', {'runId': run_id, 'model': self.config.model, 'readOnly': read_only}, task['id'] if task else None)
            async with asyncio.timeout(180): result = await self.runner(self.config, prompt, context, capabilities)
            ensure_active()
            self.store.append_event('run.completed', {'runId': run_id}, task['id'] if task else None)
            return result
        except BaseException as error:
            self.store.append_event('run.failed', {'runId': run_id, 'message': safe_error(error)}, task['id'] if task else None)
            raise
        finally:
            if not recorded: self.store.fail_usage(run_id)
            self.model_tasks.pop(key, None)

    @staticmethod
    def steps(value):
        if not isinstance(value, list): return []
        return [dict(id=str(uuid4()), title=step, status='pending') if isinstance(step, str) else step for step in value]

    def check_memory_file(self, path):
        if path.startswith('memory/') and self.store.get_setting('memoryProjectionStale'):
            raise ValueError('Managed memory files are stale; refresh the memory projection first')

    def create_schedule(self, body):
        timezone = text(body.get('timezone'), self.store.get_setting('timezone') or 'America/Toronto')
        ZoneInfo(timezone)
        cron = text(body.get('cron')) or None
        run_at = next_cron_time(cron, timezone) if cron else body.get('runAt')
        if not text(body.get('prompt')).strip(): raise ValueError('Schedule prompt required')
        schedule = self.store.save_schedule(dict(prompt=body['prompt'], runAt=run_at, timezone=timezone, cron=cron,
            intervalSeconds=body.get('intervalSeconds'), kind='dream' if body.get('kind') == 'dream' else 'task'))
        self.store.set_setting(f"deliveryPolicy:{schedule['id']}", 'changes' if body.get('deliveryPolicy') == 'changes' else 'every')
        return schedule

    async def operate(self, operation, args, task=None, read_only=False):
        if read_only and operation not in READ_ONLY and not (operation == 'files' and args.get('action') in ('list', 'read')):
            raise ValueError('This reflection/subtask is read-only')
        task_id = task['id'] if task else None
        self.store.append_event('tool.requested', {'operation': operation, 'action': args.get('action')}, task_id)
        action = args.get('action')
        if operation == 'workflow':
            if task and task.get('parentId'): raise ValueError('Child agents cannot create workflows')
            if action == 'list': return {'workflows': [self.workflow_view(w) for w in self.store.list_workflows()]}
            if action != 'create': raise ValueError('Unknown workflow action')
            return self.create_workflow(args)
        if operation == 'browser_read':
            if (await self.browser.status())['manualControl']: raise ValueError('Browser is under manual user control')
            if action == 'tabs': return {'tabs': await self.browser.tabs()}
            result = await self.browser.navigate(text(args.get('url'))) if action == 'navigate' else await self.browser.snapshot(text(args.get('tabId')))
            self.store.append_event('source.observed', {'urls': [result['url']], 'observedAt': now_ms()}, task_id)
            return result
        if operation == 'memory_search': return {'memories': self.store.list_memories(text(args.get('query'))), 'revision': self.store.revision()}
        if operation == 'goals':
            if action == 'create': return self.store.create_goal(dict(title=text(args.get('title')), description=text(args.get('description')), steps=[{**s, 'status': 'pending'} for s in self.steps(args.get('steps'))]))
            if action == 'update':
                if args.get('status') == 'completed' or any(s.get('status') == 'completed' for s in self.steps(args.get('steps'))): raise ValueError('Goal completion requires supporting evidence')
                return self.store.update_goal(text(args.get('id')), {k: args[k] for k in ('status', 'steps') if k in args})
            return {'goals': self.store.list_goals()}
        if operation == 'complete_goal_step':
            goal = next((g for g in self.store.list_goals() if g['id'] == args.get('goalId')), None)
            if not goal or not task or task.get('goalId') != goal['id'] or not any(s['id'] == args.get('stepId') for s in goal['steps']): raise ValueError('Only the owning goal task can complete an existing step')
            references = []
            for event in self.store.list_events(500):
                if event['taskId'] == task_id and event['type'] in ('source.observed', 'artifact.written'):
                    detail = event['detail']; references.extend(detail.get('urls', [detail['path']] if 'path' in detail else []))
            if not any(ref in text(args.get('result')) for ref in references): raise ValueError('Step result must cite an observed source or artifact')
            return self.store.update_goal(goal['id'], {'steps': [{**s, 'status': 'completed', 'result': args['result']} if s['id'] == args['stepId'] else s for s in goal['steps']]})
        if operation == 'files':
            path = text(args.get('path'))
            if action == 'write':
                if path.startswith('memory/'): raise ValueError('Managed memory files must be edited through memory operations')
                result = await self.workspace.write(path, text(args.get('content')))
                self.store.append_event('artifact.written', result, task_id); return result
            if action == 'read': self.check_memory_file(path); return await self.workspace.read(path)
            return {'entries': await self.workspace.list(path)}
        if operation == 'skills': return await self.workspace.read_skill(text(args.get('name'))) if action == 'read' else {'skills': await self.workspace.list_skills()}
        if operation == 'gmail_read': return await self.google.read_mail(text(args.get('id'))) if action == 'read' else await self.google.list_mail(text(args.get('query')), 10)
        if operation == 'calendar_read': return await self.google.list_events(text(args.get('start')), text(args.get('end')))
        if operation == 'propose_action': return await self.propose_action(text(args.get('kind')), args.get('payload'), text(args.get('summary')), task_id)
        if operation == 'delegate':
            if not task or task.get('parentId'): raise ValueError('Only a top-level background task can delegate')
            if len([t for t in self.store.list_tasks(500) if t['parentId'] == task_id]) >= 3: raise ValueError('Subtask limit reached')
            return self.store.create_task(dict(prompt=text(args.get('prompt')), parentId=task_id, kind='task'))
        if operation == 'notify': return self.store.add_notification(dict(title=text(args.get('title')), body=text(args.get('body')), taskId=task_id, dedupeKey=f"agent:{task_id or 'chat'}:{hashlib.sha256(text(args.get('body')).encode()).hexdigest()}"))
        if operation == 'schedule_cron': return self.create_schedule(args)
        raise ValueError('Unknown capability')

    async def propose_action(self, kind, payload, summary, task_id=None):
        if kind not in WRITES or not isinstance(payload, dict): raise ValueError('Unsupported action payload')
        if len(dump(payload)) > 16000: raise ValueError('Action is too large')
        if kind.startswith('browser.'):
            tab = next((t for t in await self.browser.tabs() if t['id'] == payload.get('tabId')), None)
            if not tab: raise ValueError('Browser tab missing')
            if payload.get('expectedUrl') and payload['expectedUrl'] != tab['url']: raise ValueError('Browser page changed; inspect it again')
            payload = {**payload, 'expectedUrl': tab['url']}
        pending = next((a for a in self.store.list_approvals() if a['status'] == 'pending' and a['taskId'] == task_id and a['kind'] == kind and a['payload'] == payload), None)
        if pending: return pending
        approval = self.store.create_approval(dict(taskId=task_id, kind=kind, payload=payload, summary=summary or f'Review {kind}'))
        self.store.add_notification(dict(title='Approval needed', body=approval['summary'], taskId=task_id, dedupeKey=f"approval:{approval['id']}"))
        return approval

    def resume_task(self, task_id):
        if not task_id: return
        task = self.store.get_task(task_id)
        blocked = any(a['taskId'] == task_id and a['status'] in BLOCKING_APPROVALS for a in self.store.list_approvals())
        if task and task['status'] == 'waiting_approval' and not blocked: self.store.update_task(task_id, {'status': 'queued'})

    async def execute_action(self, approval):
        claimed = self.store.claim_execution(approval['id']); payload = claimed['payload']; task_id = claimed['taskId']
        self.store.append_event('action.started', {'approvalId': claimed['id'], 'kind': claimed['kind']}, task_id)
        try:
            kind = claimed['kind']
            if kind.startswith('browser.'):
                if (await self.browser.status())['manualControl']: raise ValueError('Browser is under manual control')
                tab = next((t for t in await self.browser.tabs() if t['id'] == payload.get('tabId')), None)
                if not tab or tab['url'] != payload.get('expectedUrl'): raise ValueError('Browser page changed; create a new approval')
                result = await self.browser.click(payload['tabId'], payload['selector']) if kind == 'browser.click' else await self.browser.fill(payload['tabId'], payload['selector'], payload.get('value', ''))
            elif kind == 'gmail.send': result = await self.google.send_mail(payload)
            elif kind == 'calendar.create': result = await self.google.create_event({**payload, 'timeZone': payload.get('timeZone', 'America/Toronto')})
            elif kind == 'workspace.execute':
                if self.store.get_setting('memoryProjectionStale'): raise ValueError('Refresh stale managed memory files before script execution')
                result = await self.workspace.execute_script(payload)
            elif kind == 'skill.save': result = await self.workspace.save_skill(payload['name'], payload['content'])
            else: raise ValueError('Unsupported approved action')
            completed = self.store.complete_action(claimed['id'], {'result': result or {'ok': True}})
            self.store.append_event('action.completed', {'approvalId': claimed['id'], 'result': result}, task_id)
            self.store.add_notification(dict(title='Action completed', body=claimed['summary'], taskId=task_id, dedupeKey=f"action:{claimed['id']}"))
            self.resume_task(task_id); return completed
        except BaseException as error:
            message = f'Action outcome needs review: {safe_error(error)}. Reconcile with the destination before retrying.'
            uncertain = self.store.mark_action_uncertain(claimed['id'], message)
            self.store.append_event('action.uncertain', {'approvalId': claimed['id'], 'message': message}, task_id)
            if isinstance(error, asyncio.CancelledError): raise
            return uncertain

    def cancel_task(self, task_id):
        candidate = self.store.get_task(task_id)
        if candidate and candidate['parentId'] and self.store.get_workflow(candidate['parentId']): task_id = candidate['parentId']
        root = self.store.get_task(task_id)
        if not root: raise ValueError('Task not found')
        tasks = self.store.workflow_tasks(task_id) if self.store.get_workflow(task_id) else self.store.list_tasks(1000)
        ids = {task_id}
        for _ in tasks:
            ids.update(t['id'] for t in tasks if t['parentId'] in ids)
        for id_ in ids:
            task = self.store.get_task(id_)
            if task['status'] not in ('completed', 'cancelled'): self.store.update_task(id_, {'status': 'cancelled'})
            if id_ in self.active: self.active[id_].cancel()
            for approval in self.store.list_approvals():
                if approval['taskId'] == id_ and approval['status'] == 'pending': self.store.decide_approval(approval['id'], 'rejected', approval['digest'])
        return self.store.get_task(task_id)

    def workflow_view(self, workflow):
        return {**workflow, **self.store.get_task(workflow['id']), 'nodes': [{**node, 'task': self.store.get_task(workflow_task_id(workflow['id'], node['id']))} for node in workflow['nodes']]}

    def create_workflow(self, body):
        if sum(self.store.get_task(w['id'])['status'] in ('queued', 'running') for w in self.store.list_workflows()) >= 5: raise ValueError('Too many active workflows')
        definition = research_workflow(text(body.get('prompt')), body.get('specialists')) if 'nodes' not in body else body
        workflow = self.store.create_workflow(definition)
        self.store.append_event('workflow.created', {'nodes': [{k: n[k] for k in ('id', 'role', 'dependsOn')} for n in workflow['nodes']]}, workflow['id'])
        return self.workflow_view(workflow)

    def retry_workflow(self, id_):
        workflow = self.store.get_workflow(id_)
        if not workflow: raise ValueError('Workflow not found')
        if self.store.get_task(id_)['status'] != 'failed': raise ValueError('Only a failed workflow can retry')
        tasks = self.store.workflow_tasks(id_)
        if any(t['id'] in self.active for t in tasks): raise ValueError('Workflow agents are still finishing')
        if any(t['status'] == 'cancelled' for t in tasks): raise ValueError('Cancelled workflow agents cannot retry')
        if any(t['status'] == 'failed' and t['attempts'] >= 3 for t in tasks): raise ValueError('Workflow retry limit reached')
        for task in tasks:
            if task['status'] == 'failed': self.store.update_task(task['id'], {'status': 'queued', 'error': None})
        self.store.update_task(id_, {'status': 'queued', 'error': None})
        self.store.append_event('workflow.retry', {'reusedCompletedStages': sum(t['status'] == 'completed' for t in tasks)}, id_)
        return self.workflow_view(workflow)

    def advance_workflows(self):
        for workflow in self.store.list_workflows():
            root = self.store.get_task(workflow['id'])
            if root['status'] == 'cancelled': self.cancel_task(root['id']); continue
            if root['status'] not in ('queued', 'running'): continue
            if root['status'] == 'queued': self.store.update_task(root['id'], {'status': 'running'})
            tasks = self.store.workflow_tasks(root['id'])
            failed = next((t for t in tasks if t['status'] in ('failed', 'cancelled')), None)
            if failed:
                self.store.update_task(root['id'], {'status': 'failed', 'error': f"Agent {failed['id'].split(':')[-1]} {failed['status']}: {failed.get('error') or 'no result'}"})
                self.store.append_event('workflow.failed', {'agentTaskId': failed['id']}, root['id']); continue
            if all(t['status'] == 'completed' for t in tasks):
                output = self.store.get_task(workflow_task_id(root['id'], workflow['output']))
                self.store.update_task(root['id'], {'status': 'completed', 'result': output['result'], 'error': None})
                self.store.append_event('workflow.completed', {'outputTaskId': output['id']}, root['id'])
        for workflow in self.store.list_workflows():
            root = self.store.get_task(workflow['id'])
            if root['status'] == 'failed': self.store.add_notification(dict(title='Workflow needs attention', body='An agent failed. Review its error and retry the workflow to reuse completed stages.', taskId=root['id'], dedupeKey=f"workflow-failed:{root['id']}:{root['attempts']}"))
            if root['status'] == 'completed': self.store.add_notification(dict(title='Workflow completed', body=(root['result'] or 'Workflow completed with no text output.')[:12000], taskId=root['id'], dedupeKey=f"workflow-completed:{root['id']}"))

    def workflow_ready(self, task):
        if self.store.get_workflow(task['id']): return False
        workflow = self.store.get_workflow(task['parentId']) if task['parentId'] else None
        if not workflow: return True
        if self.store.get_task(workflow['id'])['status'] != 'running': return False
        node = next((n for n in workflow['nodes'] if workflow_task_id(workflow['id'], n['id']) == task['id']), None)
        return bool(node and all(self.store.get_task(workflow_task_id(workflow['id'], dep))['status'] == 'completed' for dep in node['dependsOn']))

    async def tick(self, now=None):
        if self.ticking or self.stopping: return
        self.ticking = True; now = now or now_ms()
        try:
            for schedule in [s for s in self.store.list_schedules() if s['status'] == 'active' and s['nextRunAt'] <= now][:20]:
                next_ = next_cron_time(schedule['cron'], schedule['timezone'], now) if schedule['cron'] else next_interval_time(schedule['nextRunAt'], schedule['intervalSeconds'], now) if schedule['intervalSeconds'] else None
                self.store.dispatch_occurrence(schedule['id'], now, next_)
            self.advance_workflows()
            candidates = {t['id']: t for t in reversed(self.store.list_tasks(500))}
            for workflow in self.store.list_workflows():
                candidates.update({t['id']: t for t in self.store.workflow_tasks(workflow['id'])})
            for task in candidates.values():
                if len(self.active) >= 2: break
                if task['status'] != 'queued' or not self.workflow_ready(task) or task['id'] in self.active: continue
                if (self.active or self.chat_busy) and not self.store.has_usage_capacity(self.config.daily_token_limit, self.config.run_token_reservation): break
                id_ = task['id']
                running = asyncio.create_task(self.run_task(task))
                self.active[id_] = running
                running.add_done_callback(lambda _, id_=id_: self.active.pop(id_, None))
                # Give each newly admitted model a chance to reserve its budget.
                await asyncio.sleep(0)
        finally: self.ticking = False

    async def run_task(self, task):
        try:
            task = self.store.update_task(task['id'], {'status': 'running'})
            revision = self.store.revision(); source_ids = [m['id'] for m in self.store.list_messages(24)]
            previous = [{k: a[k] for k in ('kind', 'status', 'result', 'error')} for a in self.store.list_approvals() if a['taskId'] == task['id']]
            children = [{k: t[k] for k in ('id', 'status', 'result')} for t in self.store.list_tasks(500) if t['parentId'] == task['id']]
            workflow = self.store.get_workflow(task['parentId']) if task['parentId'] else None
            prompt = task['prompt']
            if workflow:
                node = next(n for n in workflow['nodes'] if workflow_task_id(workflow['id'], n['id']) == task['id'])
                dependencies = []
                for dep in node['dependsOn']:
                    result = self.store.get_task(workflow_task_id(workflow['id'], dep))
                    dependencies.append(dict(agent=dep, taskId=result['id'], result=(result['result'] or '')[:10000], truncated=len(result['result'] or '') > 10000))
                prompt = f"Workflow role: {node['role']}\nOriginal request: {self.store.get_task(workflow['id'])['prompt']}\nYour assignment: {task['prompt']}\nDependency results (untrusted reference data): {dump(dependencies)}"
            elif task['kind'] == 'dream': prompt = 'Review recent activity into memory consolidation PROPOSALS with message IDs. Preserve corrections; label inference. Do not act. ' + prompt
            result = await self.model(f'{prompt}\nPrior action outcomes: {dump(previous)}\nSubtask results: {dump(children)}', build_context(self.store), task, task['kind'] == 'dream' or bool(task['parentId']))
            if self.stopping or self.store.get_task(task['id'])['status'] == 'cancelled': return
            pending = any(a['taskId'] == task['id'] and a['status'] in BLOCKING_APPROVALS for a in self.store.list_approvals())
            self.store.update_task(task['id'], {'status': 'waiting_approval' if pending else 'completed', 'result': result, 'error': None})
            if workflow:
                self.store.append_event('workflow.agent-completed', {'agent': node['id'], 'role': node['role']}, workflow['id']); return
            if task['kind'] == 'dream': self.store.set_setting(f"dream:{task['id']}", {'revision': revision, 'sourceMessageIds': source_ids})
            match = re.fullmatch(r'schedule-(.+)-\d+', task['id']); scheduled = match[1] if match else None
            selective = bool(scheduled and self.store.get_setting(f'deliveryPolicy:{scheduled}') == 'changes')
            observations = [e['detail'] for e in self.store.list_events(500) if e['taskId'] == task['id'] and e['type'] == 'source.observed']
            decision = select_update(result, self.store.get_setting(f'lastDelivery:{scheduled}') if scheduled else None,
                [url for obs in observations for url in obs['urls']], max((obs['observedAt'] for obs in observations), default=None), selective)
            if not selective or pending or decision['selected']:
                title = 'Task needs approval' if pending else 'Memory proposals ready' if task['kind'] == 'dream' else 'Task completed'
                self.store.add_notification(dict(title=title, body=result[:6000] or 'Task completed with no text output.', taskId=task['id'], dedupeKey=f"task:{task['id']}:{task['attempts']}"))
                if scheduled: self.store.set_setting(f'lastDelivery:{scheduled}', decision['fingerprint'])
            self.store.append_event('delivery.decision', {'selected': not selective or pending or decision['selected'], 'reason': decision['reason'] if selective else 'requested-result'}, task['id'])
            if task['parentId']:
                self.store.append_event('subtask.completed', {'childId': task['id'], 'result': result[:4000]}, task['parentId'])
                parent = self.store.get_task(task['parentId'])
                if parent and parent['status'] == 'completed': self.store.create_task(dict(prompt=f"Consume the completed subtask result for the goal: {parent['prompt']}\nChild result: {result}"[:12000], kind='task', goalId=parent['goalId']))
        except BaseException as error:
            current = self.store.get_task(task['id'])
            if self.stopping or (current and current['status'] == 'cancelled'): return
            if current and current['status'] == 'running': self.store.update_task(task['id'], {'status': 'failed', 'error': safe_error(error)})
            if not task['parentId'] or not self.store.get_workflow(task['parentId']): self.store.add_notification(dict(title='Task failed', body=safe_error(error), taskId=task['id'], dedupeKey=f"task-failed:{task['id']}:{task['attempts']}"))

    async def compact_history(self):
        older = self.store.list_messages(200)[:-20]
        if len(older) < 20: return {'compacted': False, 'reason': 'Not enough older history'}
        latest_id = older[-1]['id']; prior = self.store.get_setting('conversationSummary') or {}
        if prior.get('lastMessageId') == latest_id: return {'compacted': False, 'reason': 'Already summarized'}
        result = await self.model('Summarize earlier conversation as reference data. Preserve commitments, corrections, unresolved questions and source message IDs. Do not infer preferences.', dump({'previous': prior.get('text'), 'messages': older})[:22000], read_only=True, no_tools=True)
        self.store.set_setting('conversationSummary', dict(text=result, lastMessageId=latest_id, sourceIds=[m['id'] for m in older], createdAt=now_ms()))
        return {'compacted': True, 'text': result}

    async def dispatch(self, method, path, body=None, query=None):
        body = body or {}; query = query or {}; route = re.sub(r'^/api', '', path)
        parts = route.split('/'); id_ = parts[2] if len(parts) > 2 else ''
        try:
            if path == '/health': return JSONResponse({'ok': True, 'runtime': 'local', 'backend': 'python'})
            if path == '/oauth/google/callback':
                await self.google.complete_auth(query.get('code', ''), query.get('state', ''))
                return Response('Google connected. Return to the assistant Connections tab.', media_type='text/plain')
            if method == 'GET':
                if route == '/status': return JSONResponse(dict(local=True, backend='python', runtimeId=self.instance_id, model=self.config.model,
                    activity=dict(activeTasks=len(self.active), chatBusy=self.chat_busy, queuedTasks=sum(t['status'] == 'queued' for t in self.store.list_tasks(500))),
                    capabilities=dict(browser=await self.browser.status(), google=await self.google.status(), workspace=True, docker=self.config.docker_enabled),
                    budget=dict(dailyTokenLimit=self.config.daily_token_limit, perRunReservation=self.config.run_token_reservation, usage=self.store.list_usage())))
                if route == '/history': return JSONResponse({'messages': self.store.list_messages(500)})
                if route == '/memories': return JSONResponse(dict(memories=self.store.list_memories(query.get('query')), revision=self.store.revision()))
                if re.fullmatch(r'/memories/[^/]+/lineage', route): return JSONResponse({'lineage': self.store.memory_lineage(id_)})
                if route == '/memory/files': return JSONResponse(await self.project_memory())
                if route == '/workflows': return JSONResponse({'workflows': [self.workflow_view(w) for w in self.store.list_workflows()]})
                if re.fullmatch(r'/workflows/[^/]+', route):
                    workflow = self.store.get_workflow(id_)
                    if not workflow: raise ValueError('Workflow not found')
                    return JSONResponse(self.workflow_view(workflow))
                for name, getter in [('goals', self.store.list_goals), ('tasks', self.store.list_tasks), ('schedules', self.store.list_schedules), ('approvals', self.store.list_approvals), ('notifications', self.store.list_notifications), ('events', self.store.list_events)]:
                    if route == '/' + name: return JSONResponse({name: getter()})
                if route == '/connections': return JSONResponse({'google': await self.google.status()})
                if route == '/browser/status': return JSONResponse(await self.browser.status())
                if route == '/browser/tabs': return JSONResponse({'tabs': await self.browser.tabs()})
                if route == '/browser/snapshot': return JSONResponse(await self.browser.snapshot(query.get('tabId', '')))
                if route == '/browser/screenshot': return Response(base64.b64decode((await self.browser.screenshot(query.get('tabId', '')))['base64']), media_type='image/png')
                if route == '/files': return JSONResponse({'entries': [{**e, 'type': 'directory' if e['directory'] else 'file'} for e in await self.workspace.list(query.get('path', ''))]})
                if route in ('/files/read', '/files/download'):
                    path_ = query.get('path', ''); self.check_memory_file(path_); file = await self.workspace.read(path_)
                    if route.endswith('download'): return Response(file['content'], media_type='application/octet-stream', headers={'Content-Disposition': 'attachment; filename="artifact.txt"'})
                    return JSONResponse(file)
                if route == '/settings': return JSONResponse({'timezone': self.store.get_setting('timezone') or 'America/Toronto', 'nightlyDreamEnabled': self.store.get_setting('nightlyDreamEnabled') is not False})
            if method == 'POST':
                if route == '/workflows': return JSONResponse(self.create_workflow(body), 202)
                if re.fullmatch(r'/workflows/[^/]+/cancel', route):
                    if not self.store.get_workflow(id_): raise ValueError('Workflow not found')
                    return JSONResponse(self.cancel_task(id_))
                if re.fullmatch(r'/workflows/[^/]+/retry', route): return JSONResponse(self.retry_workflow(id_), 202)
                if route == '/chat':
                    if self.chat_busy: return JSONResponse({'error': 'A chat turn is already running'}, 409)
                    message = text(body.get('message')).strip()
                    if not message or len(message) > 12000: raise ValueError('Message must have 1-12000 characters')
                    self.chat_busy = True
                    try:
                        self.store.add_message('user', message)
                        result = await self.model(message, build_context(self.store, message))
                        self.store.add_message('assistant', result); await self.project_memory()
                        return JSONResponse({'message': result})
                    finally: self.chat_busy = False
                if route == '/memories':
                    memory = self.store.save_memory(dict(text=text(body.get('text')), kind=body.get('kind') or 'fact', source='user', provenance='explicit'))
                    await self.project_memory(); return JSONResponse(memory, 201)
                if re.fullmatch(r'/memories/[^/]+/forget', route): return JSONResponse(await self.forget(id_, body.get('includeSourceMessages') is True))
                if route == '/memory/search':
                    query_ = text(body.get('query')).strip()
                    if not query_: raise ValueError('Search query required')
                    if body.get('semantic') is not True: return JSONResponse({'memories': self.store.list_memories(query_), 'mode': 'keyword'})
                    memories = self.store.list_memories()
                    response = await self.model(f'Select up to 10 existing memory IDs relevant in meaning to: {query_}. Return ONLY a JSON array of IDs.', dump(memories)[:20000], read_only=True, no_tools=True)
                    ids = json.loads(re.sub(r'^```(?:json)?\s*|\s*```$', '', response))
                    if not isinstance(ids, list): raise ValueError('Semantic search returned an invalid selection')
                    return JSONResponse({'memories': [m for m in memories if m['id'] in ids[:10]], 'mode': 'gpt-6-luna-ranked', 'scope': 'saved memories'})
                if route == '/goals': return JSONResponse(self.store.create_goal(dict(title=text(body.get('title')), description=text(body.get('description')), steps=self.steps(body.get('steps')))), 201)
                if re.fullmatch(r'/goals/[^/]+/run', route):
                    goal = next((g for g in self.store.list_goals() if g['id'] == id_ and g['status'] == 'active'), None)
                    if not goal: raise ValueError('Active goal not found')
                    return JSONResponse(self.store.create_task(dict(prompt='Advance this goal using actual tools. Do not mark steps complete without evidence. ' + dump(goal), kind='goal', goalId=id_)), 202)
                if route == '/schedules': return JSONResponse(self.create_schedule(body), 201)
                if route == '/tasks': return JSONResponse(self.store.create_task(dict(prompt=text(body.get('prompt')), kind='dream' if body.get('kind') == 'dream' else 'task')), 202)
                if re.fullmatch(r'/tasks/[^/]+/cancel', route): return JSONResponse(self.cancel_task(id_))
                if re.fullmatch(r'/tasks/[^/]+/retry', route):
                    task = self.store.get_task(id_)
                    workflow_id = id_ if self.store.get_workflow(id_) else task.get('parentId') if task and task.get('parentId') and self.store.get_workflow(task['parentId']) else None
                    if workflow_id: return JSONResponse(self.retry_workflow(workflow_id), 202)
                    if not task or task['status'] != 'failed': raise ValueError('Only a failed task can retry')
                    if any(a['taskId'] == id_ and a['status'] in ('uncertain', 'executing') for a in self.store.list_approvals()): raise ValueError('Reconcile uncertain actions before retrying')
                    return JSONResponse(self.store.update_task(id_, {'status': 'queued', 'error': None}), 202)
                if route == '/actions': return JSONResponse(await self.propose_action(text(body.get('kind')), body.get('payload'), text(body.get('summary'))), 201)
                if re.fullmatch(r'/approvals/[^/]+/decision', route):
                    if body.get('decision') not in ('approved', 'rejected'): raise ValueError('Invalid approval decision')
                    approval = self.store.decide_approval(id_, body['decision'], text(body.get('expectedDigest')))
                    if approval['status'] == 'approved': return JSONResponse(await self.execute_action(approval))
                    self.resume_task(approval['taskId']); return JSONResponse(approval)
                if re.fullmatch(r'/approvals/[^/]+/reconcile', route):
                    approval = self.store.reconcile_action(id_, body.get('outcome'), text(body.get('evidence')))
                    self.store.append_event('action.reconciled', {'approvalId': id_, 'outcome': approval['status'], 'verifiedBy': 'user'}, approval['taskId'])
                    self.resume_task(approval['taskId']); return JSONResponse(approval)
                if re.fullmatch(r'/notifications/[^/]+/read', route): self.store.mark_read(id_); return JSONResponse({'ok': True})
                if route == '/browser/launch': return JSONResponse(await self.browser.launch(visible=body.get('visible') is True))
                if route == '/browser/close': await self.browser.close(); return JSONResponse({'ok': True})
                if route == '/browser/navigate': return JSONResponse(await self.browser.navigate(text(body.get('url'))))
                if route == '/files':
                    if text(body.get('path')).startswith('memory/'): raise ValueError('Managed memory files must be edited in Memory')
                    return JSONResponse(await self.workspace.write(text(body.get('path')), text(body.get('content'))), 201)
                if route == '/connections/google/start': return JSONResponse({'url': self.google.begin_auth()['url']})
                if route == '/context/compact': return JSONResponse(await self.compact_history())
                if route == '/dreams/apply':
                    task_id = text(body.get('taskId')); task = self.store.get_task(task_id); snapshot = self.store.get_setting(f'dream:{task_id}')
                    if not task or task['kind'] != 'dream' or task['status'] != 'completed' or not snapshot: raise ValueError('Completed dream required')
                    memory = self.store.save_memory(dict(text=text(body.get('text')), source=f'dream:{task_id}:user-approved', sourceIds=snapshot['sourceMessageIds'] or [task_id], provenance='explicit', expectedRevision=snapshot['revision']))
                    await self.project_memory(); return JSONResponse(memory, 201)
                if route == '/hooks':
                    key = text(body.get('eventId'))
                    if not re.fullmatch(r'[\w.-]{1,100}', key, flags=re.ASCII): raise ValueError('A stable eventId is required')
                    return JSONResponse(self.store.create_task(dict(id=f'hook-{key}', prompt=text(body.get('prompt')), kind='task')), 202)
            if method == 'PATCH':
                if re.fullmatch(r'/memories/[^/]+', route):
                    memory = self.store.update_memory(id_, dict(text=text(body.get('text')), source='user-correction', provenance='explicit', expectedRevision=body.get('expectedRevision')))
                    await self.project_memory(); return JSONResponse(memory)
                if re.fullmatch(r'/goals/[^/]+', route): return JSONResponse(self.store.update_goal(id_, {k: body[k] for k in ('title', 'status', 'steps') if k in body}))
                if route == '/settings':
                    if body.get('timezone'): ZoneInfo(body['timezone']); self.store.set_setting('timezone', body['timezone'])
                    if type(body.get('nightlyDreamEnabled')) is bool:
                        self.store.set_setting('nightlyDreamEnabled', body['nightlyDreamEnabled'])
                        if not body['nightlyDreamEnabled']: self.store.delete_schedule('nightly-dream')
                    return JSONResponse({'ok': True})
            if method == 'DELETE':
                if re.fullmatch(r'/memories/[^/]+', route): return JSONResponse(await self.forget(id_))
                if re.fullmatch(r'/schedules/[^/]+', route):
                    self.store.delete_schedule(id_)
                    if id_ == 'nightly-dream': self.store.set_setting('nightlyDreamEnabled', False)
                    return JSONResponse({'deleted': True})
                if route == '/connections/google': await self.google.disconnect(); return JSONResponse({'ok': True})
            return JSONResponse({'error': 'Not found'}, 404)
        except Exception as error:
            message = safe_error(error)
            status = 409 if re.search(r'revision conflict|already|expired|changed|pending|digest mismatch', message, re.I) else 404 if re.search(r'not found', message, re.I) else 429 if 'budget' in message.lower() else 400
            return JSONResponse({'error': message}, status)

    async def forget(self, id_, include_source_messages=False):
        report = self.store.forget_memory(id_, include_source_messages)
        self.privacy_epoch += 1
        for task in list(self.model_tasks.values()): task.cancel()
        projection = await self.project_memory()
        return {**report, 'managedCopiesRemoved': 'error' not in projection, 'projection': projection}
