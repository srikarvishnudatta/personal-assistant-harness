import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { LocalStore, canonicalJson } from '../src/local/store.ts';

test('a second local runtime cannot claim live state, and a clean shutdown releases ownership', t => {
  const directory = mkdtempSync(join(tmpdir(), 'assistant-owner-'));
  const path = join(directory, 'state.sqlite');
  const first = new LocalStore(path), second = new LocalStore(path);
  let firstClosed = false;
  t.after(() => { if (!firstClosed) first.close(); second.close(); assert.equal(dirname(resolve(directory)), resolve(tmpdir())); rmSync(directory, { recursive: true, force: true }); });
  first.claimRuntimeOwnership();
  assert.throws(() => second.claimRuntimeOwnership(), /Another local assistant owns/);
  first.close(); firstClosed = true;
  assert.doesNotThrow(() => second.claimRuntimeOwnership());
});

test('local memory persists across restarts and corrections use revision checks', t => {
  const directory = mkdtempSync(join(tmpdir(), 'assistant-store-'));
  const path = join(directory, 'state.sqlite');
  let store = new LocalStore(path);
  t.after(() => {
    store.close();
    assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
    rmSync(directory, { recursive: true, force: true });
  });
  const saved = store.saveMemory({ text: 'I prefer short explanations', source: 'message:one', provenance: 'explicit', kind: 'preference' });
  store.addMessage('user', 'Remember my preference', 'run-one');
  store.close();
  store = new LocalStore(path);
  assert.equal(store.revision(), 1);
  assert.equal(store.listMessages()[0]?.runId, 'run-one');
  assert.equal(store.listMemories('SHORT')[0]?.id, saved.id);
  assert.throws(() => store.updateMemory(saved.id, { text: 'Changed', expectedRevision: 0 }), /revision conflict/);
  assert.throws(() => store.updateMemory(saved.id, { text: 'Inference', provenance: 'inferred', expectedRevision: 1 }), /Inference/);
  assert.equal(store.revision(), 1);
  assert.equal(store.updateMemory(saved.id, { text: 'I prefer visual explanations', expectedRevision: 1 }).text, 'I prefer visual explanations');
  assert.equal(store.deleteMemory(saved.id, 2), 3);
  assert.deepEqual(store.listMemories(), []);
});

test('approval digest binds the reviewed action and execution can only be claimed once', t => {
  const store = new LocalStore(':memory:'); t.after(() => store.close());
  assert.equal(canonicalJson({ b: 2, a: { d: 4, c: 3 } }), canonicalJson({ a: { c: 3, d: 4 }, b: 2 }));
  assert.throws(() => canonicalJson({ bad: undefined }), /finite JSON/);
  const approval = store.createApproval({ kind: 'gmail.send', payload: { to: 'example@example.com', subject: 'A' }, summary: 'Send this exact email' });
  assert.throws(() => store.decideApproval(approval.id, 'approved', 'different-action'), /digest mismatch/);
  assert.equal(store.decideApproval(approval.id, 'approved', approval.digest).status, 'approved');
  assert.throws(() => store.decideApproval(approval.id, 'rejected', approval.digest), /no longer pending/);
  assert.equal(store.claimExecution(approval.id).status, 'executing');
  assert.throws(() => store.claimExecution(approval.id), /already claimed/);
  assert.equal(store.completeAction(approval.id, { result: { messageId: 'sent-one' } }).status, 'completed');
  assert.throws(() => store.completeAction(approval.id, { result: 'overwrite' }), /not executing/);
  assert.deepEqual(store.getApproval(approval.id)?.result, { messageId: 'sent-one' });
});

test('restart recovery holds tasks with uncertain writes and preserves waiting approvals', t => {
  const store = new LocalStore(':memory:'); t.after(() => store.close());
  const task = store.createTask({ prompt: 'Do an external action' });
  store.updateTask(task.id, { status: 'running' });
  const approval = store.createApproval({ taskId: task.id, kind: 'browser.click', payload: { selector: '#submit' }, summary: 'Submit form' });
  store.decideApproval(approval.id, 'approved', approval.digest);
  store.claimExecution(approval.id);
  const safe = store.createTask({ prompt: 'Read context' });
  store.updateTask(safe.id, { status: 'running' });
  const waiting = store.createTask({ prompt: 'Await user' });
  store.updateTask(waiting.id, { status: 'running' }); store.updateTask(waiting.id, { status: 'waiting_approval' });
  const exhausted = store.createTask({ prompt: 'Repeated failure' });
  store.updateTask(exhausted.id, { status: 'running', attempts: 3 });
  const recovered = store.recoverInterrupted();
  assert.equal(recovered.uncertain, 1);
  assert.equal(recovered.failed, 1);
  assert.equal(store.getApproval(approval.id)?.status, 'uncertain');
  assert.equal(store.getTask(task.id)?.status, 'waiting_approval');
  assert.equal(store.getTask(safe.id)?.status, 'queued');
  assert.equal(store.getTask(waiting.id)?.status, 'waiting_approval');
  assert.equal(store.getTask(exhausted.id)?.status, 'failed');
  assert.throws(() => store.claimExecution(approval.id), /not approved/);
});

test('task occurrence IDs deduplicate only the same request and terminal results cannot change', t => {
  const store = new LocalStore(':memory:'); t.after(() => store.close());
  const task = store.createTask({ id: 'occurrence-one', prompt: 'Review goals' });
  assert.equal(store.createTask({ id: 'occurrence-one', prompt: 'Review goals' }).id, task.id);
  assert.equal(store.listTasks().length, 1);
  assert.throws(() => store.createTask({ id: 'occurrence-one', prompt: 'Another action' }), /conflicts/);
  assert.throws(() => store.updateTask(task.id, { status: 'completed' }), /Illegal task transition/);
  assert.equal(store.updateTask(task.id, { status: 'running' }).attempts, 1);
  store.updateTask(task.id, { status: 'completed', result: 'Done' });
  assert.throws(() => store.updateTask(task.id, { result: 'Replace' }), /cannot be rewritten/);
});

test('usage reservations prevent concurrent overspend and uncertain usage is not refunded', t => {
  const store = new LocalStore(':memory:'); t.after(() => store.close());
  store.reserveUsage('run-one', 1000, 600);
  assert.throws(() => store.reserveUsage('run-two', 1000, 500), /budget exceeded/);
  store.finishUsage('run-one', 200, 100);
  store.reserveUsage('run-two', 1000, 500);
  store.failUsage('run-two');
  assert.throws(() => store.reserveUsage('run-three', 1000, 250), /budget exceeded/);
  assert.throws(() => store.finishUsage('run-one', 0, 0), /already settled/);
  assert.equal(store.listUsage().find(row => row.runId === 'run-two')?.inputTokens, 500);
});

test('notifications deduplicate delivery and schedule updates retain recurrence', t => {
  const store = new LocalStore(':memory:'); t.after(() => store.close());
  const first = store.addNotification({ title: 'Result', body: 'Useful change', dedupeKey: 'task-one' });
  assert.equal(store.addNotification({ title: 'Duplicate', body: 'Same', dedupeKey: 'task-one' }).id, first.id);
  store.markRead(first.id); assert.ok(store.listNotifications()[0]?.readAt);
  const schedule = store.saveSchedule({ prompt: 'Daily review', runAt: Date.now() + 60000, cron: '0 9 * * *', timezone: 'America/Toronto' });
  store.updateSchedule(schedule.id, { nextRunAt: schedule.nextRunAt + 86400000 });
  assert.equal(store.listSchedules()[0]?.cron, '0 9 * * *');
  store.deleteSchedule(schedule.id); assert.deepEqual(store.listSchedules(), []);
});

test('ambiguous action outcome remains uncertain and cannot be executed again', t => {
  const store = new LocalStore(':memory:'); t.after(() => store.close());
  const action = store.createApproval({ kind: 'calendar.create', payload: { title: 'Meeting' }, summary: 'Create meeting' });
  assert.throws(() => store.markActionUncertain(action.id, 'Not sent'), /Only an executing/);
  store.decideApproval(action.id, 'approved', action.digest); store.claimExecution(action.id);
  assert.equal(store.markActionUncertain(action.id, 'Response lost after provider received request').status, 'uncertain');
  assert.throws(() => store.claimExecution(action.id), /not approved/);
  assert.throws(() => store.completeAction(action.id, { result: 'Assume completed' }), /not executing/);
  assert.equal(store.reconcileAction(action.id, 'completed', 'User checked the calendar event ID').status, 'completed');
  assert.throws(() => store.claimExecution(action.id), /not approved/);
  assert.throws(() => store.reconcileAction(action.id, 'failed', 'Changed my mind'), /Only an uncertain/);
});

test('schedule occurrence enqueue and advancement are atomic and replay-safe', t => {
  const store = new LocalStore(':memory:'); t.after(() => store.close());
  const now = Date.now();
  const schedule = store.saveSchedule({ prompt: 'Review context', runAt: now - 1000 });
  assert.throws(() => store.dispatchOccurrence(schedule.id, now, schedule.nextRunAt), /must advance/);
  assert.equal(store.listTasks().length, 0, 'invalid advancement must not leave a task');
  const task = store.dispatchOccurrence(schedule.id, now, null)!;
  assert.equal(task.id, `schedule-${schedule.id}-${schedule.nextRunAt}`);
  assert.equal(store.listSchedules()[0]?.status, 'completed');
  assert.equal(store.dispatchOccurrence(schedule.id, now, null), undefined);
  assert.equal(store.listTasks().length, 1);
});

test('goals retain structured steps and settings reject credential fields', t => {
  const store = new LocalStore(':memory:'); t.after(() => store.close());
  const goal = store.createGoal({ title: 'Plan trip', steps: [{ id: 'research', title: 'Read official sources', status: 'pending' }] });
  const completed = store.updateGoal(goal.id, { steps: [{ ...goal.steps[0]!, status: 'completed' }], status: 'completed' });
  assert.equal(completed.steps[0]?.status, 'completed');
  store.setSetting('dailyTokenLimit', 50000); assert.equal(store.getSetting('dailyTokenLimit'), 50000);
  assert.throws(() => store.setSetting('OPENAI_API_KEY', 'secret'), /vault/);
  assert.throws(() => store.setSetting('google', { oauth: { refreshToken: 'secret' } }), /vault/);
});
