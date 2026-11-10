import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { LocalStore } from '../src/local/store.ts';
import { researchWorkflow, validateWorkflow, workflowTaskId } from '../src/local/workflows.ts';
import { LocalRuntime } from '../src/local/runtime.ts';
import type { LocalConfig } from '../src/local/config.ts';
import type { BrowserService } from '../src/local/browser.ts';

test('workflow validation rejects cycles, missing dependencies, duplicate IDs and disconnected agents', () => {
  const definition = researchWorkflow('Compare options');
  assert.equal(definition.nodes.length, 4);
  for (const mutate of [
    (nodes: typeof definition.nodes) => { nodes[0]!.dependsOn = ['answer']; },
    (nodes: typeof definition.nodes) => { nodes[0]!.dependsOn = ['missing']; },
    (nodes: typeof definition.nodes) => { nodes[0]!.id = nodes[1]!.id; },
    (nodes: typeof definition.nodes) => { nodes.push({ id: 'unused', role: 'Unused', prompt: 'Unused', dependsOn: [] }); },
  ]) { const copy = structuredClone(definition); mutate(copy.nodes); assert.throws(() => validateWorkflow(copy)); }
  assert.throws(() => researchWorkflow('Compare', []), /2-4/);
  assert.throws(() => validateWorkflow({ ...definition, nodes: Array(9).fill(definition.nodes[0]) }), /2-8/);
  const store = new LocalStore(':memory:');
  try { assert.throws(() => store.createWorkflow({ ...definition, output: 'missing' })); assert.equal(store.listTasks().length, 0); }
  finally { store.close(); }
});

test('workflow restart reuses completed stages, recovers an interrupted agent, and joins once', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'assistant-workflow-'));
  const config: LocalConfig = {
    root: directory, dataDir: directory, port: 8787, token: 'test-token-with-at-least-24-characters',
    apiKey: 'test-key', model: 'gpt-6-luna', googleClientId: '', googleClientSecret: '',
    encryptionSecret: 'test-encryption-secret-long-enough', dockerEnabled: false, dockerImage: 'python:3.12-slim',
    browserExecutable: undefined, browserChannel: undefined,
    dailyTokenLimit: 100000, runTokenReservation: 1000,
  };
  const path = join(directory, 'assistant.sqlite');
  let store = new LocalStore(path);
  const definition = researchWorkflow('Checkpoint test');
  const workflow = store.createWorkflow(definition);
  store.updateTask(workflow.id, { status: 'running' });
  const first = workflowTaskId(workflow.id, 'specialist-1'), second = workflowTaskId(workflow.id, 'specialist-2');
  store.updateTask(first, { status: 'running' }); store.updateTask(first, { status: 'completed', result: 'saved-specialist-result' });
  store.updateTask(second, { status: 'running' });
  store.close();
  store = new LocalStore(path);
  const calls: string[] = [];
  const runtime = new LocalRuntime(config, { store, browser: { close: async () => {} } as unknown as BrowserService,
    runner: async (_env, prompt, _context, caps) => { calls.push(prompt); caps!.onUsage!(5, 5); return 'stage-result'; } });
  try {
    assert.equal(store.getTask(workflow.id)!.status, 'running');
    assert.equal(store.getTask(second)!.status, 'queued');
    for (let i = 0; i < 6; i++) { await runtime.tick(); for (let j = 0; j < 15; j++) await new Promise<void>(resolve => setImmediate(resolve)); }
    assert.equal(store.getTask(workflow.id)!.status, 'completed');
    assert.equal(calls.length, 3, 'Completed specialist must not run again');
    assert.ok(calls.some(prompt => prompt.includes('saved-specialist-result')));
    assert.equal(store.getTask(second)!.attempts, 2);
    assert.equal(store.listNotifications().length, 1);
  } finally { await runtime.close(); assert.equal(dirname(resolve(directory)), resolve(tmpdir())); rmSync(directory, { recursive: true, force: true }); }
});

test('workflow forgetting redacts exact managed definition copies', () => {
  const store = new LocalStore(':memory:');
  try {
    const text = 'Synthetic fact to forget';
    const memory = store.saveMemory({ text, source: 'user', provenance: 'explicit' });
    const workflow = store.createWorkflow(researchWorkflow(text));
    store.forgetMemory(memory.id);
    assert.equal(store.getWorkflow(workflow.id)!.prompt, '[forgotten]');
    assert.equal(store.getTask(workflow.id)!.prompt, '[forgotten]');
  } finally { store.close(); }
});
