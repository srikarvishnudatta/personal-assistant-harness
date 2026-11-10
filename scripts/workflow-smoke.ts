import assert from 'node:assert/strict';
import { loadLocalConfig } from './local-config.ts';

type Data = Record<string, any>;
const config = loadLocalConfig();
const origin = `http://127.0.0.1:${config.port}`;
let workflowId: string | undefined;
let passed = false;
async function api(path: string, body?: unknown): Promise<Data> {
  let response: Response;
  try {
    response = await fetch(`${origin}/api${path}`, { method: body === undefined ? 'GET' : 'POST',
      headers: { Authorization: `Bearer ${config.token}`, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(15000) });
  } catch { throw new Error('Cannot reach the local API. Keep the updated npm run dev server running in another terminal.'); }
  const data = await response.json() as Data;
  if (!response.ok) throw new Error(`${path}: ${String(data.error ?? response.status)}`);
  return data;
}

try {
  console.log('Testing a durable four-agent workflow through the local API. Four short GPT-6 Luna calls are expected.');
  const status = await api('/status');
  assert.equal(status.local, true); assert.equal(status.model, 'gpt-6-luna');
  assert.equal(status.backend, 'python', 'Stop the old server and restart npm run dev to use the Python backend');
  assert.equal(status.activity.activeTasks, 0, 'Wait for other agents to finish');
  assert.equal(status.activity.queuedTasks, 0, 'Wait for the queue to drain');
  assert.equal(status.activity.chatBusy, false, 'Wait for chat to finish');
  const workflow = await api('/workflows', {
    prompt: 'Synthetic workflow connectivity test. Use only the provided synthetic data. Do not call tools, browse or change anything.',
    nodes: [
      { id: 'a', role: 'Specialist A', prompt: 'Reply with exactly A=3. Do not call tools.', dependsOn: [] },
      { id: 'b', role: 'Specialist B', prompt: 'Reply with exactly B=4. Do not call tools.', dependsOn: [] },
      { id: 'verify', role: 'Verifier', prompt: 'Read the dependency results. If they are A=3 and B=4, reply with exactly SUM=7. Otherwise reply INVALID. Do not call tools.', dependsOn: ['a', 'b'] },
      { id: 'answer', role: 'Synthesizer', prompt: 'Read the verifier dependency result. If it is SUM=7, reply with exactly WORKFLOW_SMOKE_OK. Otherwise reply INVALID. Do not call tools.', dependsOn: ['verify'] },
    ], output: 'answer',
  });
  workflowId = workflow.id;
  let current = workflow;
  const deadline = Date.now() + 240000;
  while (!['completed', 'failed', 'cancelled'].includes(current.status) && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 1000));
    current = await api(`/workflows/${encodeURIComponent(workflow.id)}`);
  }
  assert.equal(current.status, 'completed', `Workflow did not complete: ${current.error ?? current.status}`);
  const nodes = current.nodes as Data[];
  for (const [id, result] of [['a', 'A=3'], ['b', 'B=4'], ['verify', 'SUM=7'], ['answer', 'WORKFLOW_SMOKE_OK']]) {
    const task = nodes.find(node => node.id === id)?.task;
    assert.ok(task, `Missing ${id} checkpoint`); assert.equal(task.status, 'completed');
    assert.equal(task.result.trim(), result); assert.equal(task.attempts, 1, `${id} ran more than once`);
  }
  assert.equal(current.result.trim(), 'WORKFLOW_SMOKE_OK');
  const notifications = (await api('/notifications')).notifications as Data[];
  assert.equal(notifications.filter(notice => notice.taskId === workflow.id).length, 1, 'Expected one final workflow receipt');
  passed = true;
  console.log('Specialists completed; verifier and synthesizer consumed dependency results.');
  console.log('Workflow checkpoints, one attempt per agent and one final inbox result passed.');
  console.log('Synthetic workflow/task/audit records are retained for inspection.');
} catch (error) {
  let message = error instanceof Error ? error.message : 'Unknown failure';
  for (const secret of [config.apiKey, config.token, config.encryptionSecret]) if (secret) message = message.replaceAll(secret, '[redacted]');
  console.error('Workflow smoke test failed:', message.slice(0, 800)); process.exitCode = 1;
} finally {
  if (!passed && workflowId) {
    try { await api(`/workflows/${encodeURIComponent(workflowId)}/cancel`, {}); }
    catch { console.warn('Could not cancel the synthetic workflow. Review Workflows before retrying.'); }
  }
}
