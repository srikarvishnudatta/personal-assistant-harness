import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, unlink } from 'node:fs/promises';
import { resolve } from 'node:path';
import { loadLocalConfig } from './local-config.ts';

type Data = Record<string, any>;
interface Fixture { runtimeId: string; marker: string; memoryId: string; text: string; recall: string; scheduleId?: string; taskId?: string; complete: boolean }
const config = loadLocalConfig();
const origin = `http://127.0.0.1:${config.port}`;
const manifest = resolve(config.dataDir, 'local-smoke.json');
const verifyRestart = process.argv.includes('--verify-restart');
const cleanupOnly = process.argv.includes('--cleanup');

async function api(path: string, body?: unknown, method = body === undefined ? 'GET' : 'POST'): Promise<Data> {
  let response: Response;
  try {
    response = await fetch(`${origin}/api${path}`, { method,
      headers: { Authorization: `Bearer ${config.token}`, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(path === '/chat' ? 90000 : 15000) });
  } catch (error) {
    if (error instanceof Error && ['TimeoutError', 'AbortError'].includes(error.name)) throw new Error(`${path} timed out. The server may still be working; wait for the queue to become idle before retrying.`);
    throw new Error(`Cannot reach the local API at ${origin}. Keep npm run dev running in another terminal and check LOCAL_PORT.`);
  }
  let data: Data;
  try { data = await response.json() as Data; } catch { throw new Error(`Local API returned non-JSON for ${path}; make sure the new Python server is running.`); }
  if (!response.ok) throw new Error(`${path}: ${String(data.error ?? response.status)}`);
  return data;
}
function idle(status: Data) {
  assert.equal(status.local, true, 'This test needs the local Python runtime, not Wrangler');
  assert.equal(status.backend, 'python', 'Stop the old server and restart npm run dev to use the Python backend');
  assert.equal(status.model, 'gpt-6-luna');
  assert.ok(typeof status.runtimeId === 'string' && status.activity, 'Restart npm run dev to load the updated local runtime');
  assert.equal(status.activity.activeTasks, 0, 'Wait until other background tasks finish before testing');
  assert.equal(status.activity.chatBusy, false, 'Wait until the current chat finishes');
  assert.equal(status.activity.queuedTasks, 0, 'Wait until the task queue drains before testing');
}
async function save(fixture: Fixture) { await mkdir(config.dataDir, { recursive: true }); await writeFile(manifest, JSON.stringify(fixture), { mode: 0o600 }); }
async function cleanup(fixture: Fixture) {
  assert.match(fixture.marker, /^local-smoke-[0-9a-f-]{36}$/);
  assert.match(fixture.recall, /^recall-[0-9a-f-]{36}$/);
  assert.equal(fixture.text, `Synthetic test-only memory ${fixture.marker}: the recall marker is ${fixture.recall}.`);
  if (fixture.scheduleId) {
    const schedule = ((await api('/schedules')).schedules as Data[]).find(schedule => schedule.id === fixture.scheduleId);
    if (schedule) { assert.ok(String(schedule.prompt).includes(fixture.marker), 'Refusing to remove a schedule that does not match this test'); await api(`/schedules/${encodeURIComponent(fixture.scheduleId)}`, undefined, 'DELETE'); }
  }
  const memory = ((await api('/memories')).memories as Data[]).find(memory => memory.id === fixture.memoryId);
  if (memory) {
    assert.equal(memory.text, fixture.text, 'Refusing to remove a memory changed outside this test');
    const report = await api(`/memories/${encodeURIComponent(fixture.memoryId)}`, undefined, 'DELETE');
    if (report.managedCopiesRemoved === false) console.warn('Temporary memory removed from SQLite, but readable projections need refresh. Check Activity.');
  }
  await unlink(manifest);
  console.log('Temporary memory and schedule removed. Synthetic chat/task audit records are retained.');
}
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

try {
  console.log('Testing the actual local API. Fixtures contain synthetic data; two short model runs are expected.');
  const status = await api('/status'); idle(status);
  if (cleanupOnly) {
    await cleanup(JSON.parse(await readFile(manifest, 'utf8')) as Fixture);
  } else if (verifyRestart) {
    const fixture = JSON.parse(await readFile(manifest, 'utf8')) as Fixture;
    assert.equal(fixture.complete, true, 'Complete the first local test before restart verification');
    assert.notEqual(status.runtimeId, fixture.runtimeId, 'The server has not restarted. Stop and restart npm run dev, then retry this command.');
    const memories = (await api('/memories')).memories as Data[];
    assert.ok(memories.some(memory => memory.id === fixture.memoryId && memory.text === fixture.text), 'Saved memory did not survive restart');
    const history = (await api('/history')).messages as Data[];
    assert.ok(history.some(message => message.role === 'assistant' && String(message.content).trim() === fixture.recall), 'Chat history did not survive restart');
    const tasks = (await api('/tasks')).tasks as Data[];
    assert.ok(tasks.some(task => task.id === fixture.taskId && task.status === 'completed'), 'Completed task did not survive restart');
    const notices = (await api('/notifications')).notifications as Data[];
    assert.ok(notices.some(notice => notice.taskId === fixture.taskId), 'Inbox result did not survive restart');
    console.log('Restart persistence passed: memory, chat, completed task and inbox result.');
    await cleanup(fixture);
  } else {
    let existing: Fixture | undefined;
    try { existing = JSON.parse(await readFile(manifest, 'utf8')) as Fixture; } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    if (existing) throw new Error('A previous smoke fixture exists. If its first phase completed, restart the server and run npm run test:local -- --verify-restart. To remove incomplete synthetic fixtures after the queue is idle, run npm run test:local -- --cleanup.');
    const unauthenticated = await fetch(`${origin}/api/history`, { signal: AbortSignal.timeout(10000) });
    assert.equal(unauthenticated.status, 401, 'History must require authentication');
    console.log('Authenticated API and unauthenticated-access rejection passed.');
    const marker = `local-smoke-${randomUUID()}`;
    const recall = `recall-${randomUUID()}`;
    const text = `Synthetic test-only memory ${marker}: the recall marker is ${recall}.`;
    const memory = await api('/memories', { text, kind: 'fact' });
    const fixture: Fixture = { runtimeId: status.runtimeId, marker, memoryId: memory.id, text, recall, complete: false };
    await save(fixture);
    const lineage = (await api(`/memories/${encodeURIComponent(memory.id)}/lineage`)).lineage as Data[];
    assert.ok(lineage.some(version => version.snapshot.text === text), 'Memory lineage did not retain the saved claim');
    console.log('Saved memory and source lineage passed.');
    const oldEvents = new Set(((await api('/events')).events as Data[]).map(event => event.id));
    const reply = await api('/chat', { message: `Connectivity test ${marker}. Use assistant_operation memory_search with query "${marker}" to retrieve the saved synthetic memory. Reply with only its recall marker. Do not change memory, create files, browse, schedule work or propose actions.` });
    assert.equal(String(reply.message).trim(), recall, 'Chat did not retrieve the synthetic recall marker');
    const events = (await api('/events')).events as Data[];
    assert.ok(events.some(event => !oldEvents.has(event.id) && event.type === 'tool.requested' && event.detail?.operation === 'memory_search'), 'Model answered, but the requested memory-search tool call was not observed');
    console.log('Live chat -> actual memory-search tool -> expected response passed.');
    const prompt = `Synthetic scheduled test ${marker}. Reply with exactly SCHEDULE_SMOKE_OK. Do not call tools, browse, or send external messages.`;
    const schedule = await api('/schedules', { prompt, runAt: new Date(Date.now() + 5000).toISOString(), deliveryPolicy: 'every' });
    fixture.scheduleId = schedule.id; await save(fixture);
    console.log('One-shot schedule saved; waiting for execution (up to two minutes).');
    const deadline = Date.now() + 120000;
    let task: Data | undefined;
    while (Date.now() < deadline) {
      const matching = ((await api('/tasks')).tasks as Data[]).filter(task => task.prompt === prompt);
      assert.ok(matching.length <= 1, 'The schedule created duplicate tasks');
      task = matching[0];
      if (task?.status === 'failed') throw new Error(`Scheduled task failed: ${String(task.error)}`);
      if (task?.status === 'completed') break;
      await delay(1000);
    }
    assert.equal(task?.status, 'completed', 'Scheduled task did not complete before the deadline');
    assert.equal(String(task.result).trim(), 'SCHEDULE_SMOKE_OK');
    const notices = (await api('/notifications')).notifications as Data[];
    assert.ok(notices.some(notice => notice.taskId === task!.id && String(notice.body).trim() === 'SCHEDULE_SMOKE_OK'), 'Execution completed but the inbox receipt was not found');
    fixture.taskId = task.id; fixture.complete = true; await save(fixture);
    console.log('Scheduled execution, duplicate suppression and inbox receipt passed.');
    console.log('Next: restart npm run dev, then run npm run test:local -- --verify-restart');
    console.log('The synthetic memory/schedule remain until that persistence check cleans them up.');
  }
} catch (error) {
  let message = error instanceof Error ? error.message : 'Unknown failure';
  for (const secret of [config.apiKey, config.token, config.encryptionSecret]) if (secret) message = message.replaceAll(secret, '[redacted]');
  console.error('Local smoke test failed:', message.replace(/sk-[A-Za-z0-9_-]+/g, '[redacted]').slice(0, 1200));
  process.exitCode = 1;
}
