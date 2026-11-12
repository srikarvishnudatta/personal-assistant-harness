"""HTTP operation dispatch; orchestration and durable state live in application services."""
import base64
import json
import re
from zoneinfo import ZoneInfo

from starlette.responses import JSONResponse, Response

from harness.core.utils import text, dump, safe_error
from harness.knowledge.memory import build_context


async def dispatch(runtime, method, path, body=None, query=None):
    body = body or {}; query = query or {}; route = re.sub(r'^/api', '', path)
    parts = route.split('/'); id_ = parts[2] if len(parts) > 2 else ''
    try:
        if path == '/health': return JSONResponse({'ok': True, 'runtime': 'local', 'backend': 'python'})
        if path == '/oauth/google/callback':
            await runtime.google.complete_auth(query.get('code', ''), query.get('state', ''))
            return Response('Google connected. Return to the assistant Connections tab.', media_type='text/plain')
        if path == '/oauth/spotify/callback':
            await runtime.providers.complete_spotify(query.get('code',''),query.get('state',''))
            return Response('Spotify connected. Return to Connections and refresh.',media_type='text/plain')
        if method == 'GET':
            if route == '/history/index': return JSONResponse(runtime.history_index.status())
            if route == '/people': return JSONResponse(runtime.people.list(query.get('query','')))
            if re.fullmatch(r'/people/[^/]+/lineage',route): return JSONResponse({'lineage':runtime.people.lineage(id_)})
            if route == '/repairs': return JSONResponse({'repairs':runtime.repairs.list()})
            if route == '/freshness': return JSONResponse({'reports':[json.loads(r[0]) for r in runtime.store.db.execute('SELECT report FROM freshness_reports ORDER BY created_at DESC LIMIT 50')]})
            if route == '/status': return JSONResponse(dict(local=True, backend='python', runtimeId=runtime.instance_id, model=runtime.config.model,
                activity=dict(activeTasks=len(runtime.active), chatBusy=runtime.chat_busy, queuedTasks=sum(t['status'] == 'queued' for t in runtime.store.list_tasks(500))),
                capabilities=dict(browser=await runtime.browser.status(), google=await runtime.google.status(), workspace=True, docker=runtime.config.docker_enabled),
                budget=dict(dailyTokenLimit=runtime.config.daily_token_limit, perRunReservation=runtime.config.run_token_reservation, usage=runtime.store.list_usage())))
            if route == '/history': return JSONResponse({'messages': runtime.store.list_messages(500)})
            if route == '/memories': return JSONResponse(dict(memories=runtime.store.list_memories(query.get('query')), revision=runtime.store.revision()))
            if re.fullmatch(r'/memories/[^/]+/lineage', route): return JSONResponse({'lineage': runtime.store.memory_lineage(id_)})
            if route == '/memory/files': return JSONResponse(await runtime.project_memory())
            if route == '/workflows': return JSONResponse({'workflows': [runtime.workflow_view(w) for w in runtime.store.list_workflows()]})
            if re.fullmatch(r'/workflows/[^/]+', route):
                workflow = runtime.store.get_workflow(id_)
                if not workflow: raise ValueError('Workflow not found')
                return JSONResponse(runtime.workflow_view(workflow))
            for name, getter in [('goals', runtime.store.list_goals), ('tasks', runtime.store.list_tasks), ('schedules', runtime.store.list_schedules), ('approvals', runtime.store.list_approvals), ('notifications', runtime.store.list_notifications), ('events', runtime.store.list_events)]:
                if route == '/' + name: return JSONResponse({name: getter()})
            if route == '/connections': return JSONResponse({'google': await runtime.google.status(), 'providers':await runtime.providers.status()})
            if route == '/browser/status': return JSONResponse(await runtime.browser.status())
            if route == '/browser/tabs': return JSONResponse({'tabs': await runtime.browser.tabs()})
            if route == '/browser/snapshot': return JSONResponse(await runtime.browser.snapshot(query.get('tabId', '')))
            if route == '/browser/screenshot': return Response(base64.b64decode((await runtime.browser.screenshot(query.get('tabId', '')))['base64']), media_type='image/png')
            if route == '/files': return JSONResponse({'entries': [{**e, 'type': 'directory' if e['directory'] else 'file'} for e in await runtime.workspace.list(query.get('path', ''))]})
            if route in ('/files/read', '/files/download'):
                path_ = query.get('path', ''); runtime.check_memory_file(path_); file = await runtime.workspace.read(path_)
                if route.endswith('download'): return Response(file['content'], media_type='application/octet-stream', headers={'Content-Disposition': 'attachment; filename="artifact.txt"'})
                return JSONResponse(file)
            if route == '/settings': return JSONResponse({'timezone': runtime.store.get_setting('timezone') or 'America/Toronto', 'nightlyDreamEnabled': runtime.store.get_setting('nightlyDreamEnabled') is not False})
        if method == 'POST':
            if route == '/history/search': return JSONResponse(await runtime.search_history(text(body.get('query')),body.get('semantic') is True))
            if route == '/people': return JSONResponse(runtime.people.save(body),201)
            if route == '/people/relationships': return JSONResponse(runtime.people.relate(body),201)
            if route == '/repairs': return JSONResponse(runtime.repairs.create(text(body.get('kind'),'other'),text(body.get('subject')),text(body.get('description'))),201)
            if route == '/freshness/verify': return JSONResponse(await runtime.freshness.verify(text(body.get('text')),max_age_seconds=body.get('maxAgeSeconds',600)))
            if route == '/connections/spotify/start': return JSONResponse(runtime.providers.start_spotify())
            if re.fullmatch(r'/connections/(slack|mastodon|shopify|homeassistant)/authorize',route):
                return JSONResponse(await runtime.providers.connect_token(id_,body.get('token')))
            if re.fullmatch(r'/connections/(slack|mastodon|spotify|shopify|homeassistant)/read',route):
                return JSONResponse({'result':await runtime.providers.read(id_,text(body.get('action')),body)})
            if route == '/workflows': return JSONResponse(runtime.create_workflow(body), 202)
            if re.fullmatch(r'/workflows/[^/]+/cancel', route):
                if not runtime.store.get_workflow(id_): raise ValueError('Workflow not found')
                return JSONResponse(runtime.cancel_task(id_))
            if re.fullmatch(r'/workflows/[^/]+/retry', route): return JSONResponse(runtime.retry_workflow(id_), 202)
            if route == '/chat':
                if runtime.chat_busy: return JSONResponse({'error': 'A chat turn is already running'}, 409)
                message = text(body.get('message')).strip()
                if not message or len(message) > 12000: raise ValueError('Message must have 1-12000 characters')
                runtime.chat_busy = True
                try:
                    runtime.store.add_message('user', message)
                    result = await runtime.model(message, build_context(runtime.store, message))
                    runtime.store.add_message('assistant', result); await runtime.project_memory()
                    return JSONResponse({'message': result})
                finally: runtime.chat_busy = False
            if route == '/memories':
                memory = runtime.store.save_memory(dict(text=text(body.get('text')), kind=body.get('kind') or 'fact', source='user', provenance='explicit'))
                await runtime.project_memory(); return JSONResponse(memory, 201)
            if re.fullmatch(r'/memories/[^/]+/forget', route): return JSONResponse(await runtime.forget(id_, body.get('includeSourceMessages') is True))
            if route == '/memory/search':
                query_ = text(body.get('query')).strip()
                if not query_: raise ValueError('Search query required')
                if body.get('semantic') is not True: return JSONResponse({'memories': runtime.store.list_memories(query_), 'mode': 'keyword'})
                memories = runtime.store.list_memories()
                response = await runtime.model(f'Select up to 10 existing memory IDs relevant in meaning to: {query_}. Return ONLY a JSON array of IDs.', dump(memories)[:20000], read_only=True, no_tools=True)
                ids = json.loads(re.sub(r'^```(?:json)?\s*|\s*```$', '', response))
                if not isinstance(ids, list): raise ValueError('Semantic search returned an invalid selection')
                return JSONResponse({'memories': [m for m in memories if m['id'] in ids[:10]], 'mode': 'gpt-6-luna-ranked', 'scope': 'saved memories'})
            if route == '/goals': return JSONResponse(runtime.store.create_goal(dict(title=text(body.get('title')), description=text(body.get('description')), steps=runtime.steps(body.get('steps')))), 201)
            if re.fullmatch(r'/goals/[^/]+/run', route):
                goal = next((g for g in runtime.store.list_goals() if g['id'] == id_ and g['status'] == 'active'), None)
                if not goal: raise ValueError('Active goal not found')
                return JSONResponse(runtime.store.create_task(dict(prompt='Advance this goal using actual tools. Do not mark steps complete without evidence. ' + dump(goal), kind='goal', goalId=id_)), 202)
            if route == '/schedules': return JSONResponse(runtime.create_schedule(body), 201)
            if route == '/tasks': return JSONResponse(runtime.store.create_task(dict(prompt=text(body.get('prompt')), kind='dream' if body.get('kind') == 'dream' else 'task')), 202)
            if re.fullmatch(r'/tasks/[^/]+/cancel', route): return JSONResponse(runtime.cancel_task(id_))
            if re.fullmatch(r'/tasks/[^/]+/retry', route):
                task = runtime.store.get_task(id_)
                workflow_id = id_ if runtime.store.get_workflow(id_) else task.get('parentId') if task and task.get('parentId') and runtime.store.get_workflow(task['parentId']) else None
                if workflow_id: return JSONResponse(runtime.retry_workflow(workflow_id), 202)
                if not task or task['status'] != 'failed': raise ValueError('Only a failed task can retry')
                if any(a['taskId'] == id_ and a['status'] in ('uncertain', 'executing') for a in runtime.store.list_approvals()): raise ValueError('Reconcile uncertain actions before retrying')
                return JSONResponse(runtime.store.update_task(id_, {'status': 'queued', 'error': None}), 202)
            if route == '/actions': return JSONResponse(await runtime.propose_action(text(body.get('kind')), body.get('payload'), text(body.get('summary'))), 201)
            if re.fullmatch(r'/approvals/[^/]+/decision', route):
                if body.get('decision') not in ('approved', 'rejected'): raise ValueError('Invalid approval decision')
                approval = runtime.store.decide_approval(id_, body['decision'], text(body.get('expectedDigest')))
                if approval['status'] == 'approved': return JSONResponse(await runtime.execute_action(approval))
                runtime.resume_task(approval['taskId']); return JSONResponse(approval)
            if re.fullmatch(r'/approvals/[^/]+/reconcile', route):
                approval = runtime.store.reconcile_action(id_, body.get('outcome'), text(body.get('evidence')))
                runtime.store.append_event('action.reconciled', {'approvalId': id_, 'outcome': approval['status'], 'verifiedBy': 'user'}, approval['taskId'])
                runtime.resume_task(approval['taskId']); return JSONResponse(approval)
            if re.fullmatch(r'/notifications/[^/]+/read', route): runtime.store.mark_read(id_); return JSONResponse({'ok': True})
            if route == '/browser/launch': return JSONResponse(await runtime.browser.launch(visible=body.get('visible') is True))
            if route == '/browser/close': await runtime.browser.close(); return JSONResponse({'ok': True})
            if route == '/browser/navigate': return JSONResponse(await runtime.browser.navigate(text(body.get('url'))))
            if route == '/files':
                if text(body.get('path')).startswith('memory/'): raise ValueError('Managed memory files must be edited in Memory')
                return JSONResponse(await runtime.workspace.write(text(body.get('path')), text(body.get('content'))), 201)
            if route == '/connections/google/start': return JSONResponse({'url': runtime.google.begin_auth()['url']})
            if route == '/context/compact': return JSONResponse(await runtime.compact_history())
            if route == '/dreams/apply':
                task_id = text(body.get('taskId')); task = runtime.store.get_task(task_id); snapshot = runtime.store.get_setting(f'dream:{task_id}')
                if not task or task['kind'] != 'dream' or task['status'] != 'completed' or not snapshot: raise ValueError('Completed dream required')
                memory = runtime.store.save_memory(dict(text=text(body.get('text')), source=f'dream:{task_id}:user-approved', sourceIds=snapshot['sourceMessageIds'] or [task_id], provenance='explicit', expectedRevision=snapshot['revision']))
                await runtime.project_memory(); return JSONResponse(memory, 201)
            if route == '/hooks':
                key = text(body.get('eventId'))
                if not re.fullmatch(r'[\w.-]{1,100}', key, flags=re.ASCII): raise ValueError('A stable eventId is required')
                return JSONResponse(runtime.store.create_task(dict(id=f'hook-{key}', prompt=text(body.get('prompt')), kind='task')), 202)
        if method == 'PATCH':
            if re.fullmatch(r'/people/[^/]+',route): return JSONResponse(runtime.people.save(body,id_))
            if re.fullmatch(r'/repairs/[^/]+',route): return JSONResponse(runtime.repairs.transition(id_,body))
            if re.fullmatch(r'/memories/[^/]+', route):
                memory = runtime.store.update_memory(id_, dict(text=text(body.get('text')), source='user-correction', provenance='explicit', expectedRevision=body.get('expectedRevision')))
                runtime.repairs.create('correction','memory:'+id_,'User corrected a saved claim. Review related goals, summaries and derived advice; record evidence when repaired.')
                await runtime.project_memory(); return JSONResponse(memory)
            if re.fullmatch(r'/goals/[^/]+', route): return JSONResponse(runtime.store.update_goal(id_, {k: body[k] for k in ('title', 'status', 'steps') if k in body}))
            if route == '/settings':
                if body.get('timezone'): ZoneInfo(body['timezone']); runtime.store.set_setting('timezone', body['timezone'])
                if type(body.get('nightlyDreamEnabled')) is bool:
                    runtime.store.set_setting('nightlyDreamEnabled', body['nightlyDreamEnabled'])
                    if not body['nightlyDreamEnabled']: runtime.store.delete_schedule('nightly-dream')
                return JSONResponse({'ok': True})
        if method == 'DELETE':
            if re.fullmatch(r'/people/[^/]+',route): runtime.people.remove(id_); return JSONResponse({'deleted':True})
            if re.fullmatch(r'/people/relationships/[^/]+',route):
                runtime.store.db.execute('DELETE FROM people_edges WHERE id=?',(parts[3],)); return JSONResponse({'deleted':True})
            if re.fullmatch(r'/connections/(slack|mastodon|spotify|shopify|homeassistant)',route): return JSONResponse(await runtime.providers.disconnect(id_))
            if re.fullmatch(r'/memories/[^/]+', route): return JSONResponse(await runtime.forget(id_))
            if re.fullmatch(r'/schedules/[^/]+', route):
                runtime.store.delete_schedule(id_)
                if id_ == 'nightly-dream': runtime.store.set_setting('nightlyDreamEnabled', False)
                return JSONResponse({'deleted': True})
            if route == '/connections/google': await runtime.google.disconnect(); return JSONResponse({'ok': True})
        return JSONResponse({'error': 'Not found'}, 404)
    except Exception as error:
        message = safe_error(error)
        status = 409 if re.search(r'revision conflict|already|expired|changed|pending|digest mismatch', message, re.I) else 404 if re.search(r'not found', message, re.I) else 429 if 'budget' in message.lower() else 400
        return JSONResponse({'error': message}, status)
