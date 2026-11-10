import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { LocalRuntime } from '../src/local/runtime.ts';
import type { LocalConfig } from '../src/local/config.ts';
import type { BrowserService } from '../src/local/browser.ts';
import type { runAssistant } from '../src/agent.ts';

type Runner = typeof runAssistant;
function fixture(runner?: Runner) {
  const directory = mkdtempSync(join(tmpdir(), 'assistant-runtime-'));
  let url = 'https://example.com/'; let clicks = 0; let broken = false;
  const browser = {
    status: async () => ({ available: true, active: true, manualControl: false }),
    tabs: async () => [{ id: 'tab-one', url, title: 'Example' }],
    click: async () => { clicks++; if (broken) throw new Error('Simulated connection lost after click'); return { url }; },
    fill: async () => ({ ok: true }), close: async () => {},
  } as unknown as BrowserService;
  const config: LocalConfig = {
    root: directory, dataDir: join(directory, '.assistant'), port: 8787,
    token: 'test-personal-token-with-enough-entropy', apiKey: 'test-key', model: 'gpt-6-luna',
    googleClientId: '', googleClientSecret: '', encryptionSecret: 'test-vault-key-with-enough-entropy',
    browserExecutable: undefined, browserChannel: undefined, dockerEnabled: false, dockerImage: 'python:3.12-slim',
    dailyTokenLimit: 1000000, runTokenReservation: 1000,
  };
  const runtime = new LocalRuntime(config, { browser, runner: runner ?? (async (_env, _input, _context, caps) => { caps?.onUsage?.(10, 5); return 'Verified component result'; }) });
  const request = (path: string, method = 'GET', body?: unknown, token = config.token) => runtime.handle(new Request(`http://127.0.0.1:8787/api${path}`, { method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) }));
  const done = async () => { await runtime.close(); assert.equal(dirname(resolve(directory)), resolve(tmpdir())); rmSync(directory, { recursive: true, force: true }); };
  return { runtime, request, done, clicks: () => clicks, movePage: () => { url = 'https://example.com/changed'; }, breakClick: () => { broken = true; } };
}
async function settle() { for (let i = 0; i < 20; i++) await new Promise<void>(resolve => setImmediate(resolve)); }

test('workflow joins parallel specialists, verifies, synthesizes and delivers once', async t => {
  const calls: string[] = [];
  const gates: (() => void)[] = [];
  let concurrent = 0, peak = 0;
  const f = fixture(async (_env, prompt, _context, caps) => {
    assert.equal(caps!.readOnly, true);
    concurrent++; peak = Math.max(peak, concurrent);
    calls.push(prompt);
    const specialistNumber = gates.length + 1;
    if (prompt.includes('Workflow role: Specialist')) await new Promise<void>(resolve => gates.push(resolve));
    if (prompt.includes('Workflow role: Verifier')) { assert.ok(prompt.includes('result-1') && prompt.includes('result-2')); }
    if (prompt.includes('Workflow role: Synthesizer')) assert.ok(prompt.includes('verified-result'));
    caps!.onUsage!(5, 5); concurrent--;
    return prompt.includes('Workflow role: Verifier') ? 'verified-result' : prompt.includes('Workflow role: Synthesizer') ? 'final-answer' : `result-${specialistNumber}`;
  });
  t.after(f.done);
  const response = await f.request('/workflows', 'POST', { prompt: 'Compare approaches', specialists: [{ role: 'Specialist A', prompt: 'Investigate A' }, { role: 'Specialist B', prompt: 'Investigate B' }] });
  assert.equal(response.status, 202);
  const workflow = await response.json() as { id: string };
  await f.runtime.tick(); await settle();
  assert.equal(calls.length, 2); assert.equal(peak, 2);
  gates[0]!(); await settle(); await f.runtime.tick(); await settle();
  assert.equal(calls.length, 2, 'Verifier must wait for both specialists');
  gates[1]!(); await settle();
  for (let i = 0; i < 4; i++) { await f.runtime.tick(); await settle(); }
  assert.equal(calls.length, 4); assert.equal(f.runtime.store.getTask(workflow.id)!.result, 'final-answer');
  assert.equal(f.runtime.store.listNotifications().length, 1);
  assert.equal(f.runtime.store.listNotifications()[0]!.taskId, workflow.id);
  await f.runtime.tick(); await settle();
  assert.equal(calls.length, 4); assert.equal(f.runtime.store.listNotifications().length, 1);
});

test('chat can create a workflow and child agents cannot mutate or delegate', async t => {
  let created = '';
  const f = fixture(async (_env, _prompt, _context, caps) => {
    if (!caps!.readOnly) {
      const result = await caps!.operate!('workflow', JSON.stringify({ action: 'create', prompt: 'Read-only comparison' })) as { id: string };
      created = result.id;
    } else {
      for (const operation of ['workflow', 'delegate', 'propose_action', 'notify', 'schedule_cron']) await assert.rejects(caps!.operate!(operation, '{}'), /read-only/);
    }
    caps!.onUsage!(5, 5); return 'Result';
  });
  t.after(f.done);
  assert.equal((await f.request('/chat', 'POST', { message: 'Create a workflow' })).status, 200);
  assert.ok(created);
  for (let i = 0; i < 5; i++) { await f.runtime.tick(); await settle(); }
  assert.equal(f.runtime.store.getTask(created)!.status, 'completed');
});

test('workflow failure blocks dependents and explicit retry reuses completed stages', async t => {
  let fail = true; const counts = new Map<string, number>();
  const f = fixture(async (_env, prompt, _context, caps) => {
    const role = prompt.split('\n')[0]!; counts.set(role, (counts.get(role) ?? 0) + 1);
    caps!.onUsage!(5, 5);
    if (role.endsWith('Researcher') && fail) throw new Error('Transient research failure');
    return 'Stage result';
  });
  t.after(f.done);
  const workflow = await (await f.request('/workflows', 'POST', { prompt: 'Research options' })).json() as { id: string };
  for (let i = 0; i < 3; i++) { await f.runtime.tick(); await settle(); }
  assert.equal(f.runtime.store.getTask(workflow.id)!.status, 'failed');
  assert.equal(counts.has('Workflow role: Verifier'), false);
  fail = false;
  assert.equal((await f.request(`/workflows/${workflow.id}/retry`, 'POST', {})).status, 202);
  for (let i = 0; i < 6; i++) { await f.runtime.tick(); await settle(); }
  assert.equal(f.runtime.store.getTask(workflow.id)!.status, 'completed');
  assert.equal(counts.get('Workflow role: Critical reviewer'), 1);
  assert.equal(counts.get('Workflow role: Researcher'), 2);
  assert.equal(counts.get('Workflow role: Synthesizer'), 1);
});

test('cancelling a workflow aborts running agents and prevents later stages', async t => {
  let calls = 0;
  const f = fixture(async (_env, _prompt, _context, caps) => {
    calls++; await new Promise<void>(resolve => caps!.signal!.addEventListener('abort', () => resolve(), { once: true }));
    caps!.onUsage!(5, 5); return 'Cancelled output';
  });
  t.after(f.done);
  const workflow = await (await f.request('/workflows', 'POST', { prompt: 'Cancelable workflow' })).json() as { id: string };
  await f.runtime.tick(); await settle(); assert.equal(calls, 2);
  assert.equal((await f.request(`/workflows/${workflow.id}/cancel`, 'POST', {})).status, 200);
  await settle(); await f.runtime.tick(); await settle();
  assert.equal(calls, 2); assert.equal(f.runtime.store.getTask(workflow.id)!.status, 'cancelled');
  assert.ok(f.runtime.store.workflowTasks(workflow.id).every(task => task.status === 'cancelled'));
  assert.equal(f.runtime.store.listNotifications().length, 0);
});

test('workflow enforces a three-attempt retry limit', async t => {
  const f = fixture(async (_env, _prompt, _context, caps) => { caps!.onUsage!(5, 5); throw new Error('Persistent failure'); });
  t.after(f.done);
  const workflow = await (await f.request('/workflows', 'POST', { prompt: 'Retry cap test' })).json() as { id: string };
  for (let attempt = 1; attempt <= 3; attempt++) {
    for (let i = 0; i < 2; i++) { await f.runtime.tick(); await settle(); }
    assert.equal(f.runtime.store.getTask(workflow.id)!.status, 'failed');
    const response = await f.request(`/workflows/${workflow.id}/retry`, 'POST', {});
    assert.equal(response.status, attempt === 3 ? 400 : 202);
  }
  assert.ok(f.runtime.store.workflowTasks(workflow.id).filter(task => task.status === 'failed').every(task => task.attempts === 3));
});

test('workflow waits for token reservation capacity rather than failing a sibling', async t => {
  let release: () => void = () => {}; let calls = 0;
  const f = fixture(async (_env, _prompt, _context, caps) => {
    calls++;
    if (calls === 1) await new Promise<void>(resolve => { release = resolve; });
    caps!.onUsage!(5, 5); return 'Stage result';
  });
  t.after(f.done); f.runtime.config.dailyTokenLimit = 1500;
  const workflow = await (await f.request('/workflows', 'POST', { prompt: 'Budget-aware scheduling' })).json() as { id: string };
  await f.runtime.tick(); await settle();
  assert.equal(calls, 1);
  assert.equal(f.runtime.store.workflowTasks(workflow.id).filter(task => task.status === 'failed').length, 0);
  release(); await settle();
  for (let i = 0; i < 5; i++) { await f.runtime.tick(); await settle(); }
  assert.equal(calls, 4); assert.equal(f.runtime.store.getTask(workflow.id)!.status, 'completed');
});

test('workflow repairs interrupted cancellation and completion receipt on tick', async t => {
  const f = fixture(); t.after(f.done);
  const cancelled = await (await f.request('/workflows', 'POST', { prompt: 'Cancellation recovery' })).json() as { id: string };
  const child = f.runtime.store.workflowTasks(cancelled.id)[0]!;
  f.runtime.store.updateTask(child.id, { status: 'running' });
  f.runtime.store.updateTask(cancelled.id, { status: 'cancelled' });
  await f.runtime.tick(); await settle();
  assert.ok(f.runtime.store.workflowTasks(cancelled.id).every(task => task.status === 'cancelled'));
  const completed = await (await f.request('/workflows', 'POST', { prompt: 'Receipt recovery' })).json() as { id: string };
  for (const task of [f.runtime.store.getTask(completed.id)!, ...f.runtime.store.workflowTasks(completed.id)]) {
    f.runtime.store.updateTask(task.id, { status: 'running' });
    f.runtime.store.updateTask(task.id, { status: 'completed', result: 'Saved result before crash' });
  }
  assert.equal(f.runtime.store.listNotifications().length, 0);
  await f.runtime.tick(); await settle(); await f.runtime.tick();
  assert.equal(f.runtime.store.listNotifications().length, 1);
  assert.equal(f.runtime.store.listNotifications()[0]!.body, 'Saved result before crash');
});

test('local API authenticates and stores chat, inferred memory and actual run usage', async t => {
  const f = fixture(async (_env, input, _context, caps) => { await caps!.remember('Prefers concise explanations'); caps!.onUsage!(12, 9); return `Reply: ${input}`; });
  t.after(f.done);
  assert.equal((await f.request('/history', 'GET', undefined, 'wrong')).status, 401);
  const chatResponse = await f.request('/chat', 'POST', { message: 'Remember my preference' });
  assert.equal(chatResponse.status, 200, await chatResponse.text());
  assert.equal(f.runtime.store.listMessages().length, 2);
  assert.equal(f.runtime.store.listMemories()[0]!.provenance, 'inferred');
  assert.equal(f.runtime.store.listUsage()[0]!.inputTokens, 12);
  const revision = f.runtime.store.revision();
  const memory = f.runtime.store.listMemories()[0]!;
  assert.equal((await f.request(`/memories/${memory.id}`, 'PATCH', { text: 'Corrected preference', expectedRevision: revision })).status, 200);
  assert.equal((await f.request(`/memories/${memory.id}`, 'PATCH', { text: 'Stale preference', expectedRevision: revision })).status, 409);
});
test('local scheduler records one completed occurrence and one inbox result', async t => {
  const f = fixture(); t.after(f.done);
  f.runtime.store.saveSchedule({ id: 'due', prompt: 'Review goal', runAt: Date.now() - 1000 });
  await f.runtime.tick(); await settle(); await f.runtime.tick(); await settle();
  assert.equal(f.runtime.store.listTasks().length, 1);
  assert.equal(f.runtime.store.listTasks()[0]!.status, 'completed');
  assert.equal(f.runtime.store.listNotifications().length, 1);
  assert.equal(f.runtime.store.listSchedules()[0]!.status, 'completed');
});
test('approved browser action runs only once, while rejection never executes it', async t => {
  const f = fixture(); t.after(f.done);
  const make = async () => (await (await f.request('/actions', 'POST', { kind: 'browser.click', payload: { tabId: 'tab-one', selector: '#submit' }, summary: 'Click the reviewed button' })).json()) as { id: string; digest: string };
  const approval = await make(); assert.equal(f.clicks(), 0);
  assert.equal((await f.request(`/approvals/${approval.id}/decision`, 'POST', { decision: 'approved', expectedDigest: 'altered' })).status, 409);
  assert.equal(f.clicks(), 0);
  assert.equal((await f.request(`/approvals/${approval.id}/decision`, 'POST', { decision: 'approved', expectedDigest: approval.digest })).status, 200);
  assert.equal(f.clicks(), 1);
  assert.equal((await f.request(`/approvals/${approval.id}/decision`, 'POST', { decision: 'approved', expectedDigest: approval.digest })).status, 409);
  assert.equal(f.clicks(), 1);
  const rejected = await make();
  await f.request(`/approvals/${rejected.id}/decision`, 'POST', { decision: 'rejected', expectedDigest: rejected.digest });
  assert.equal(f.clicks(), 1);
});
test('browser approvals cannot execute on a changed page or retry an uncertain outcome', async t => {
  const f = fixture(); t.after(f.done);
  const approval = await (await f.request('/actions', 'POST', { kind: 'browser.click', payload: { tabId: 'tab-one', selector: '#submit' }, summary: 'Click' })).json() as { id: string; digest: string };
  f.movePage();
  await f.request(`/approvals/${approval.id}/decision`, 'POST', { decision: 'approved', expectedDigest: approval.digest });
  assert.equal(f.clicks(), 0);
  assert.equal(f.runtime.store.getApproval(approval.id)!.status, 'uncertain');
  const another = await (await f.request('/actions', 'POST', { kind: 'browser.click', payload: { tabId: 'tab-one', selector: '#submit' }, summary: 'Click new page' })).json() as { id: string; digest: string };
  f.breakClick(); await f.request(`/approvals/${another.id}/decision`, 'POST', { decision: 'approved', expectedDigest: another.digest });
  assert.equal(f.clicks(), 1);
  assert.equal(f.runtime.store.getApproval(another.id)!.status, 'uncertain');
  await f.request(`/approvals/${another.id}/decision`, 'POST', { decision: 'approved', expectedDigest: another.digest });
  assert.equal(f.clicks(), 1);
});
test('dream proposals cannot overwrite a newer correction', async t => {
  const f = fixture(); t.after(f.done);
  const task = f.runtime.store.createTask({ prompt: 'Review memories', kind: 'dream' });
  await f.runtime.tick(); await settle();
  assert.equal(f.runtime.store.getTask(task.id)!.status, 'completed');
  await f.request('/memories', 'POST', { text: 'New user correction' });
  assert.equal((await f.request('/dreams/apply', 'POST', { taskId: task.id, text: 'Outdated proposal' })).status, 409);
  assert.equal(f.runtime.store.listMemories()[0]!.text, 'New user correction');
});
test('event hooks deduplicate their stable event ID', async t => {
  const f = fixture(); t.after(f.done);
  assert.equal((await f.request('/hooks', 'POST', { eventId: 'source-123', prompt: 'Check event' })).status, 202);
  assert.equal((await f.request('/hooks', 'POST', { eventId: 'source-123', prompt: 'Check event' })).status, 202);
  assert.equal(f.runtime.store.listTasks().length, 1);
});
