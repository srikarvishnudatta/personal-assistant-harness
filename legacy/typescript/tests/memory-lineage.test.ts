import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LocalStore } from '../src/local/store.ts';

test('memory corrections retain inspectable supersession and claim source lineage', t => {
  const store = new LocalStore(':memory:'); t.after(() => store.close());
  const source = store.addMessage('user', 'I prefer evening workouts.');
  const memory = store.saveMemory({ text: 'Prefers morning workouts', source: 'extraction', sourceIds: [source.id], provenance: 'inferred' });
  store.updateMemory(memory.id, { text: 'Prefers evening workouts', source: 'user-correction', provenance: 'explicit' });
  const lineage = store.memoryLineage(memory.id);
  assert.equal(lineage.length, 2);
  assert.equal(lineage[1]!.supersedes, lineage[0]!.id);
  assert.equal(lineage[0]!.snapshot.sourceIds[0], source.id);
  assert.equal(lineage[1]!.snapshot.provenance, 'explicit');
});
test('forget invalidates summary and removes known copies while reporting retained history', t => {
  const store = new LocalStore(':memory:'); t.after(() => store.close());
  const message = store.addMessage('user', 'Personal claim to forget');
  const memory = store.saveMemory({ text: message.content, source: 'extraction', sourceIds: [message.id], provenance: 'inferred' });
  store.setSetting('conversationSummary', { text: message.content });
  store.createTask({ prompt: `Consider: ${message.content}` });
  const approval = store.createApproval({ kind: 'gmail.send', payload: { body: message.content }, summary: 'Review send' });
  const report = store.forgetMemory(memory.id);
  assert.equal(report.rawHistoryRetained, true);
  assert.equal(store.listMessages().length, 1);
  assert.equal(store.getSetting('conversationSummary'), undefined);
  assert.equal(store.memoryLineage(memory.id).length, 0);
  assert.equal(store.listTasks()[0]!.prompt.includes(message.content), false);
  assert.equal(store.getApproval(approval.id)!.status, 'rejected');
  assert.deepEqual(store.getApproval(approval.id)!.payload, {});
});
test('optional source forgetting removes recorded source messages and never races executing actions', t => {
  const store = new LocalStore(':memory:'); t.after(() => store.close());
  const message = store.addMessage('user', 'Claim with a recorded source');
  const memory = store.saveMemory({ text: message.content, source: 'extraction', sourceIds: [message.id], provenance: 'inferred' });
  const approval = store.createApproval({ kind: 'gmail.send', payload: { body: message.content }, summary: 'Review' });
  store.decideApproval(approval.id, 'approved', approval.digest); store.claimExecution(approval.id);
  assert.throws(() => store.forgetMemory(memory.id, true), /executing/);
  assert.equal(store.listMemories().length, 1);
  store.completeAction(approval.id, { result: { sent: true } });
  const report = store.forgetMemory(memory.id, true);
  assert.equal(report.removedSourceMessages, 1);
  assert.equal(store.listMessages().length, 0);
});
