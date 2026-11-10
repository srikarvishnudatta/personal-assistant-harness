import asyncio
import json
import subprocess
from pathlib import Path
import tempfile
from types import SimpleNamespace
from unittest.mock import AsyncMock
from unittest.mock import patch

from backend.tests.offline_loop import OfflineAsyncCase
from harness.config import Config
from harness.runtime import Runtime
from harness.store import LocalStore


class RuntimeTests(OfflineAsyncCase):
    async def asyncSetUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix='python-runtime-', dir=Path.cwd())
        self.root = Path(self.tmp.name)
        self.config = Config(root=self.root, data_dir=self.root, token='test-access-token-at-least-24-characters',
            api_key='test-only-key', encryption_secret='test-credential-key-at-least-24-characters', daily_token_limit=1000000, run_token_reservation=1000)
        self.browser = SimpleNamespace(status=AsyncMock(return_value={'active': True, 'manualControl': False}),
            tabs=AsyncMock(return_value=[{'id': 'tab', 'url': 'https://playwright.dev/'}]),
            click=AsyncMock(return_value={'url': 'https://playwright.dev/docs/intro'}), fill=AsyncMock(return_value={'ok': True}), close=AsyncMock())
        self.google = SimpleNamespace(status=AsyncMock(return_value={'configured': False, 'connected': False}), close=AsyncMock())
        self.runtime = Runtime(self.config, browser=self.browser, google=self.google, runner=self.runner)

    async def runner(self, config, prompt, context, caps):
        self.assertEqual(config.model, 'gpt-6-luna'); caps.on_usage(5, 5)
        return 'Synthetic result'

    async def asyncTearDown(self):
        await self.runtime.close()
        for attempt in range(8):
            try: self.tmp.cleanup(); break
            except PermissionError:
                if attempt == 7: raise
                await asyncio.sleep(0.05 * (attempt + 1))

    async def request(self, path, body=None, method=None):
        response = await self.runtime.dispatch(method or ('GET' if body is None else 'POST'), '/api' + path, body)
        return response.status_code, json.loads(response.body)

    async def pump(self, count=5):
        for _ in range(count):
            await self.runtime.tick()
            for _ in range(12): await asyncio.sleep(0)

    async def test_chat_memory_and_usage(self):
        async def runner(config, prompt, context, caps):
            await caps.remember('Synthetic preference'); caps.on_usage(12, 9); return 'Stored result'
        self.runtime.runner = runner
        status, data = await self.request('/chat', {'message': 'Remember the preference'})
        self.assertEqual(status, 200, data); self.assertEqual(data['message'], 'Stored result')
        self.assertEqual(len(self.runtime.store.list_messages()), 2)
        self.assertEqual(self.runtime.store.list_memories()[0]['provenance'], 'inferred')
        self.assertEqual(self.runtime.store.list_usage()[0]['inputTokens'], 12)
        self.assertTrue((self.root / 'workspace/memory/MEMORY.md').exists())

    async def test_schedule_executes_once_and_persists(self):
        self.runtime.store.save_schedule({'id': 'due', 'prompt': 'Synthetic reminder', 'runAt': 1})
        await self.pump(); self.assertEqual(len(self.runtime.store.list_tasks()), 1)
        self.assertEqual(self.runtime.store.list_tasks()[0]['status'], 'completed')
        self.assertEqual(len(self.runtime.store.list_notifications()), 1)
        self.assertEqual(self.runtime.store.list_schedules()[0]['status'], 'completed')

    async def test_approval_digest_rejection_and_exactly_once_execution(self):
        async def proposal(selector):
            status, approval = await self.request('/actions', {'kind': 'browser.click', 'payload': {'tabId': 'tab', 'selector': selector}, 'summary': 'Synthetic public click'})
            self.assertEqual(status, 201); return approval
        approval = await proposal('#first')
        self.assertEqual(self.browser.click.await_count, 0)
        status, _ = await self.request(f"/approvals/{approval['id']}/decision", {'decision': 'approved', 'expectedDigest': 'wrong'})
        self.assertEqual(status, 409); self.assertEqual(self.browser.click.await_count, 0)
        decision = {'decision': 'approved', 'expectedDigest': approval['digest']}
        status, data = await self.request(f"/approvals/{approval['id']}/decision", decision)
        self.assertEqual(status, 200, data); self.assertEqual(data['status'], 'completed')
        self.assertEqual((await self.request(f"/approvals/{approval['id']}/decision", decision))[0], 409)
        self.assertEqual(self.browser.click.await_count, 1)
        rejected = await proposal('#second')
        await self.request(f"/approvals/{rejected['id']}/decision", {'decision': 'rejected', 'expectedDigest': rejected['digest']})
        self.assertEqual(self.browser.click.await_count, 1)

    async def test_browser_changed_page_and_uncertain_write_do_not_repeat(self):
        approval = await self.runtime.propose_action('browser.click', {'tabId': 'tab', 'selector': '#x'}, 'Reviewed click')
        self.browser.tabs.return_value = [{'id': 'tab', 'url': 'https://playwright.dev/changed'}]
        self.runtime.store.decide_approval(approval['id'], 'approved', approval['digest'])
        result = await self.runtime.execute_action(approval)
        self.assertEqual(result['status'], 'uncertain'); self.assertEqual(self.browser.click.await_count, 0)
        self.assertEqual((await self.request('/tasks', {'prompt': 'Unrelated task'}))[0], 202)

    async def test_workflow_join_parallel_results_and_one_final_receipt(self):
        gates = []; calls = []
        async def runner(config, prompt, context, caps):
            self.assertTrue(caps.read_only); calls.append(prompt)
            if 'Workflow role: Researcher' in prompt or 'Workflow role: Critical reviewer' in prompt:
                number = len(gates) + 1; gate = asyncio.get_running_loop().create_future(); gates.append(gate)
                await gate; result = f'result-{number}'
            elif 'Workflow role: Verifier' in prompt:
                self.assertIn('result-1', prompt); self.assertIn('result-2', prompt); result = 'verified'
            else: self.assertIn('verified', prompt); result = 'final-answer'
            caps.on_usage(5, 5); return result
        self.runtime.runner = runner
        _, workflow = await self.request('/workflows', {'prompt': 'Synthetic comparison'})
        await self.pump(1); self.assertEqual(len(calls), 2)
        gates[0].set_result(None); await self.pump(1); self.assertEqual(len(calls), 2)
        gates[1].set_result(None); await self.pump()
        self.assertEqual(len(calls), 4)
        self.assertEqual(self.runtime.store.get_task(workflow['id'])['result'], 'final-answer')
        self.assertEqual(len(self.runtime.store.list_notifications()), 1)
        await self.pump(); self.assertEqual(len(self.runtime.store.list_notifications()), 1)

    async def test_workflow_retry_reuses_completed_stage_and_limit(self):
        fail = True; roles = []
        async def runner(config, prompt, context, caps):
            role = prompt.splitlines()[0]; roles.append(role); caps.on_usage(5, 5)
            if role.endswith('Researcher') and fail: raise ValueError('Transient failure')
            return 'Stage result'
        self.runtime.runner = runner
        _, workflow = await self.request('/workflows', {'prompt': 'Retry comparison'})
        await self.pump(); self.assertEqual(self.runtime.store.get_task(workflow['id'])['status'], 'failed')
        fail = False
        self.assertEqual((await self.request(f"/workflows/{workflow['id']}/retry", {}))[0], 202)
        await self.pump(); self.assertEqual(self.runtime.store.get_task(workflow['id'])['status'], 'completed')
        self.assertEqual(roles.count('Workflow role: Critical reviewer'), 1)
        self.assertEqual(roles.count('Workflow role: Researcher'), 2)

    async def test_chat_creates_workflow_and_children_cannot_mutate(self):
        created = []
        async def runner(config, prompt, context, caps):
            if not caps.read_only:
                workflow = await caps.operate('workflow', json.dumps({'action': 'create', 'prompt': 'Synthetic team'})); created.append(workflow['id'])
            else:
                for operation in ('workflow', 'delegate', 'propose_action', 'notify', 'schedule_cron'):
                    with self.assertRaisesRegex(ValueError, 'read-only'): await caps.operate(operation, '{}')
                with self.assertRaisesRegex(ValueError, 'read-only'): await caps.remember('Should not save')
            caps.on_usage(5, 5); return 'Stage result'
        self.runtime.runner = runner
        self.assertEqual((await self.request('/chat', {'message': 'Start a team'}))[0], 200)
        await self.pump(); self.assertEqual(self.runtime.store.get_task(created[0])['status'], 'completed')

    async def test_cancellation_stops_running_and_queued_agents(self):
        calls = []
        async def runner(config, prompt, context, caps): calls.append(prompt); await asyncio.Future()
        self.runtime.runner = runner
        _, workflow = await self.request('/workflows', {'prompt': 'Cancelable team'})
        await self.pump(1); self.assertEqual(len(calls), 2)
        await self.request(f"/workflows/{workflow['id']}/cancel", {}); await self.pump()
        self.assertEqual(len(calls), 2)
        self.assertTrue(all(t['status'] == 'cancelled' for t in self.runtime.store.workflow_tasks(workflow['id'])))
        self.assertFalse(self.runtime.store.list_notifications())

    async def test_dream_requires_current_memory_revision(self):
        _, task = await self.request('/tasks', {'kind': 'dream', 'prompt': 'Synthetic proposal'})
        await self.pump()
        await self.request('/memories', {'text': 'New correction'})
        status, _ = await self.request('/dreams/apply', {'taskId': task['id'], 'text': 'Old inference'})
        self.assertEqual(status, 409)

    async def test_model_refuses_other_models(self):
        from harness.agent import run_assistant
        self.config.model = 'other-model'
        with self.assertRaisesRegex(ValueError, 'gpt-6-luna'): await run_assistant(self.config, 'x', 'x')

    async def test_python_sdk_adapter_settles_usage_and_citations(self):
        from harness.agent import AgentCapabilities, run_assistant
        from agents.items import ModelResponse
        from agents.usage import Usage
        usage = []; evidence = []
        result = SimpleNamespace(final_output='Synthetic SDK result', context_wrapper=SimpleNamespace(usage=SimpleNamespace(input_tokens=12, output_tokens=8)),
            raw_responses=[ModelResponse(output=[{'id': 'msg_test', 'type': 'message', 'role': 'assistant', 'status': 'completed',
                'content': [{'type': 'output_text', 'text': 'Synthetic citation', 'annotations': [
                    {'type': 'url_citation', 'url': 'https://playwright.dev/', 'title': 'Playwright', 'start_index': 0, 'end_index': 9}]}]}], usage=Usage(), response_id=None)])
        client = SimpleNamespace(close=AsyncMock())
        call = AsyncMock(return_value=result)
        with patch('agents.Runner.run', call), patch('openai.AsyncOpenAI', return_value=client):
            output = await run_assistant(self.config, 'Synthetic prompt', 'Synthetic context',
                AgentCapabilities(read_only=True, on_usage=lambda i, o: usage.append((i, o)), on_evidence=evidence.append))
        self.assertEqual(output, 'Synthetic SDK result')
        self.assertEqual(usage, [(12, 8)]); self.assertEqual(evidence, [['https://playwright.dev/']])
        self.assertEqual(call.call_args.args[0].model, 'gpt-6-luna'); self.assertEqual(client.close.await_count, 1)

    async def test_workflow_retry_cap_and_budget_capacity(self):
        async def fail(config, prompt, context, caps): caps.on_usage(5, 5); raise ValueError('Persistent failure')
        self.runtime.runner = fail
        _, workflow = await self.request('/workflows', {'prompt': 'Retry cap'})
        for attempt in range(1, 4):
            await self.pump(2)
            self.assertEqual(self.runtime.store.get_task(workflow['id'])['status'], 'failed')
            status, _ = await self.request(f"/workflows/{workflow['id']}/retry", {})
            self.assertEqual(status, 400 if attempt == 3 else 202)

    async def test_parallel_workflow_waits_for_token_reservations(self):
        self.config.daily_token_limit = 1500; calls = []; gate = asyncio.Future()
        async def runner(config, prompt, context, caps):
            calls.append(prompt)
            if len(calls) == 1: await gate
            caps.on_usage(5, 5); return 'Stage result'
        self.runtime.runner = runner
        _, workflow = await self.request('/workflows', {'prompt': 'Budget-aware team'})
        await self.pump(1); self.assertEqual(len(calls), 1)
        self.assertFalse(any(t['status'] == 'failed' for t in self.runtime.store.workflow_tasks(workflow['id'])))
        gate.set_result(None); await self.pump(7)
        self.assertEqual(len(calls), 4); self.assertEqual(self.runtime.store.get_task(workflow['id'])['status'], 'completed')

    async def test_fastapi_real_runtime_handover_and_empty_delete(self):
        import httpx
        from harness.server import create_app
        await self.runtime.close()
        def factory(config, store):
            self.runtime = Runtime(config, store=store, browser=self.browser, google=self.google, runner=self.runner)
            return self.runtime
        app = create_app(self.config, runtime_factory=factory)
        async with app.router.lifespan_context(app):
            async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url='http://127.0.0.1:8787', headers={'Authorization': f'Bearer {self.config.token}'}) as client:
                self.assertEqual((await client.get('/api/status')).json()['backend'], 'python')
                memory = await client.post('/api/memories', json={'text': 'Persisted Python HTTP memory'})
                self.assertEqual(memory.status_code, 201, memory.text)
                self.assertEqual((await client.post('/api/chat', json={'message': 'Synthetic API chat'})).status_code, 200)
                schedule = await client.post('/api/schedules', json={'prompt': 'Future synthetic task', 'runAt': '2099-01-01T00:00:00Z'})
                self.assertEqual(schedule.status_code, 201, schedule.text)
                self.assertEqual((await client.delete('/api/schedules/' + schedule.json()['id'])).status_code, 200)
        second = create_app(self.config, runtime_factory=factory)
        async with second.router.lifespan_context(second):
            async with httpx.AsyncClient(transport=httpx.ASGITransport(app=second), base_url='http://127.0.0.1:8787', headers={'Authorization': f'Bearer {self.config.token}'}) as client:
                self.assertTrue(any(m['text'] == 'Persisted Python HTTP memory' for m in (await client.get('/api/memories')).json()['memories']))
                self.assertEqual(len((await client.get('/api/history')).json()['messages']), 2)
                self.assertEqual((await client.delete('/api/memories/' + memory.json()['id'])).status_code, 200)

    async def test_python_resumes_existing_node_database_without_replaying_completed_agents(self):
        await self.runtime.close()
        module = (Path(__file__).resolve().parents[2] / 'legacy/typescript/src/local/store.ts').as_uri()
        seed = '''
import { LocalStore } from MODULE;
const store = new LocalStore(process.argv[1]);
const memory = store.saveMemory({text:'Synthetic Node migration memory',source:'user',provenance:'explicit'});
const workflow = store.createWorkflow({prompt:'Synthetic migration workflow',nodes:[
 {id:'a',role:'A',prompt:'Stage A',dependsOn:[]},
 {id:'b',role:'B',prompt:'Stage B',dependsOn:['a']}],output:'b'});
store.updateTask(workflow.id,{status:'running'});
store.updateTask(`${workflow.id}:a`,{status:'running'});
store.updateTask(`${workflow.id}:a`,{status:'completed',result:'Node checkpoint'});
store.updateTask(`${workflow.id}:b`,{status:'running'});
store.addMessage('user','Synthetic retained Node chat');
store.close(); process.stdout.write(JSON.stringify({workflowId:workflow.id,memoryId:memory.id}));
'''.replace('MODULE', json.dumps(module))
        result = subprocess.run(['node', '--experimental-strip-types', '--input-type=module', '-e', seed, str(self.root / 'assistant.sqlite')], capture_output=True, text=True, timeout=20)
        self.assertEqual(result.returncode, 0, result.stderr)
        ids = json.loads(result.stdout); calls = []
        async def runner(config, prompt, context, caps):
            calls.append(prompt); self.assertIn('Node checkpoint', prompt); caps.on_usage(5, 5); return 'Python resumed result'
        # Copy the closed fixture bytes to a Python-created file. The restricted
        # test host applies different access to Node-created SQLite files.
        restored = self.root / 'python-restored.sqlite'
        restored.write_bytes((self.root / 'assistant.sqlite').read_bytes())
        self.runtime = Runtime(self.config, store=LocalStore(restored), browser=self.browser, google=self.google, runner=runner)
        await self.pump()
        self.assertEqual(len(calls), 1)
        self.assertEqual(self.runtime.store.get_task(ids['workflowId'])['result'], 'Python resumed result')
        self.assertTrue(any(m['id'] == ids['memoryId'] for m in self.runtime.store.list_memories()))
        self.assertEqual(self.runtime.store.list_messages()[0]['content'], 'Synthetic retained Node chat')


if __name__ == '__main__':
    import unittest
    unittest.main()
