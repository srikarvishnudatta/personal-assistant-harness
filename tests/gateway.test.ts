import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handleRequest } from '../src/gateway.ts';
import type { Env } from '../src/env.js';

function setup() {
  const calls: Request[] = [];
  const env = {
    HARNESS_TOKEN: 'test-private-secret',
    ASSETS: { fetch: async () => new Response('ui') },
    ASSISTANTS: { getByName(name: string) {
      assert.equal(name, 'personal');
      return { async fetch(request: Request) { calls.push(request); return Response.json({ ok: true }); } };
    } },
  } as unknown as Env;
  const request = (path: string, init: RequestInit = {}) => new Request(`https://harness.test${path}`, {
    ...init, headers: { Authorization: `Bearer ${env.HARNESS_TOKEN}`, ...init.headers },
  });
  return { env, calls, request };
}

test('API fails closed without server token or correct bearer', async () => {
  const { env, calls } = setup();
  assert.equal((await handleRequest(new Request('https://harness.test/api/history'), env)).status, 401);
  assert.equal((await handleRequest(new Request('https://harness.test/api/history'), { ...env, HARNESS_TOKEN: '' })).status, 503);
  assert.equal(calls.length, 0);
});
test('gateway rejects internal routes and ignores caller identity', async () => {
  const { env, calls, request } = setup();
  assert.equal((await handleRequest(request('/api/internal/task-result', { method: 'POST' }), env)).status, 404);
  assert.equal((await handleRequest(request('/api/history', { headers: { 'X-User-Id': 'victim' } }), env)).status, 200);
  assert.equal(calls[0]!.headers.get('X-User-Id'), 'personal');
  assert.equal(calls[0]!.headers.get('Authorization'), null);
});
test('gateway allows reviewed dreams and enforces actual body bytes', async () => {
  const { env, calls, request } = setup();
  assert.equal((await handleRequest(request('/api/dreams/apply', { method: 'POST', body: '{}' }), env)).status, 200);
  assert.equal((await handleRequest(request('/api/chat', { method: 'POST', body: 'x'.repeat(65537) }), env)).status, 413);
  assert.equal(calls.length, 1);
});
test('static shell remains accessible; API responses are not cached', async () => {
  const { env, request } = setup();
  assert.equal(await (await handleRequest(new Request('https://harness.test/'), env)).text(), 'ui');
  assert.equal((await handleRequest(request('/api/tasks'), env)).headers.get('Cache-Control'), 'no-store');
});
