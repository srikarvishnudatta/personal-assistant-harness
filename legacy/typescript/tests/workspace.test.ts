import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { WorkspaceService } from '../src/local/workspace.ts';
import { GoogleConnector } from '../src/local/connectors.ts';

async function fixture(t: { after(fn: () => Promise<void>): void }) {
  const base = path.resolve('.local-tools');
  await fs.mkdir(base, { recursive: true });
  const root = await fs.mkdtemp(path.join(base, 'workspace-test-'));
  t.after(async () => {
    if (!root.startsWith(base + path.sep) || !path.basename(root).startsWith('workspace-test-')) throw new Error('Unsafe test cleanup target');
    await fs.rm(root, { recursive: true, force: true });
  });
  return root;
}
test('workspace persists bounded artifacts and reviewed procedures', async t => {
  const root = await fixture(t), service = new WorkspaceService(root);
  assert.deepEqual(await service.write('reports/trip.md', '# Trip\nPlan here.'), { path: 'reports/trip.md', size: 17 });
  assert.equal((await service.read('reports/trip.md')).content, '# Trip\nPlan here.');
  assert.equal((await service.list())[0]?.directory, true);
  assert.deepEqual(await service.listSkills(), []);
  await service.saveSkill('trip-research', 'Use official sources.');
  assert.equal((await service.readSkill('trip-research')).content, 'Use official sources.');
  assert.equal((await service.listSkills())[0]?.name, 'trip-research.md');
});
test('workspace refuses traversal, hidden secrets, reserved names, and oversized artifacts', async t => {
  const service = new WorkspaceService(await fixture(t));
  for (const filename of ['../escape.md', '/absolute.md', '.env', 'a/../secret.md', 'a\\escape.md', 'C:secret.md', 'con.txt', 'space ./a.md']) {
    await assert.rejects(service.write(filename, 'bad'), /Invalid|Hidden|Unsupported/);
  }
  await assert.rejects(service.write('huge.txt', 'x'.repeat(1024 * 1024 + 1)), /1 MiB/);
  await assert.rejects(service.executeScript({ path: 'script.py', language: 'python' }), /disabled/);
});
test('workspace does not traverse symlinks or list hidden files', async t => {
  const root = await fixture(t), outside = await fixture(t), service = new WorkspaceService(root);
  await fs.writeFile(path.join(root, '.env'), 'not exposed');
  await fs.writeFile(path.join(outside, 'secret.txt'), 'outside');
  try { await fs.symlink(outside, path.join(root, 'linked'), process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) { if (['EPERM', 'EACCES'].includes((error as NodeJS.ErrnoException).code ?? '')) { t.skip('OS does not permit test symlinks'); return; } throw error; }
  await assert.rejects(service.read('linked/secret.txt'), /symlinks/);
  await assert.rejects(service.write('linked/secret.txt', 'changed'), /symlinks/);
  assert.deepEqual(await service.list(), []);
  assert.equal(await fs.readFile(path.join(outside, 'secret.txt'), 'utf8'), 'outside');
});
test('Google connection uses single-use state and PKCE; vault encrypts tokens and refreshes on expiry', async t => {
  const root = await fixture(t), calls: { url: string; body: string; authorization: string | null }[] = [];
  const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input), body = String(init?.body ?? '');
    calls.push({ url, body, authorization: new Headers(init?.headers).get('Authorization') });
    if (url.endsWith('/token')) return Response.json(body.includes('grant_type=refresh_token') ? { access_token: 'refreshed-access-secret', expires_in: 3600 } : { access_token: 'initial-access-secret', refresh_token: 'refresh-secret', expires_in: 0, scope: 'gmail.readonly calendar.events' });
    return Response.json({ messages: [{ id: 'mail1' }] });
  }) as typeof fetch;
  const options = { clientId: 'test-client', clientSecret: 'client-secret', redirectUri: 'http://127.0.0.1:8787/oauth/google/callback', vaultPath: path.join(root, 'google.enc'), encryptionSecret: 'long-credential-encryption-secret-for-test', fetchImpl: fetcher };
  const connector = new GoogleConnector(options);
  const auth = connector.beginAuth(), url = new URL(auth.url);
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  assert.ok(url.searchParams.get('code_challenge'));
  await assert.rejects(connector.completeAuth('code', 'wrong-state'), /Invalid or expired/);
  await connector.completeAuth('code', auth.state);
  await assert.rejects(connector.completeAuth('replay', auth.state), /Invalid or expired/);
  const rawVault = await fs.readFile(options.vaultPath, 'utf8');
  assert.ok(!rawVault.includes('initial-access-secret') && !rawVault.includes('refresh-secret'));
  assert.equal((await connector.status()).connected, true);
  await connector.listMail('is:unread', 5);
  assert.ok(calls.some(call => call.body.includes('grant_type=refresh_token')));
  assert.equal(calls.at(-1)?.authorization, 'Bearer refreshed-access-secret');
  assert.ok(!JSON.stringify(await connector.status()).includes('refreshed-access-secret'));
  const restored = new GoogleConnector(options);
  assert.equal((await restored.status()).connected, true);
  await restored.disconnect();
  assert.equal((await restored.status()).connected, false);
});
test('Google writes reject MIME header injection before touching credentials', async t => {
  const connector = new GoogleConnector({ redirectUri: 'http://127.0.0.1:8787/oauth/google/callback', vaultPath: path.join(await fixture(t), 'google.enc'), encryptionSecret: 'long-credential-encryption-secret-for-test' });
  assert.throws(() => connector.beginAuth(), /GOOGLE_CLIENT_ID/);
  await assert.rejects(connector.sendMail({ to: 'person@example.com', subject: 'hello\r\nBcc: bad@example.com', body: 'text' }), /Invalid email/);
  await assert.rejects(connector.createEvent({ summary: 'test', start: '2026-11-10T10:00:00Z', end: '2026-11-10T09:00:00Z', timeZone: 'UTC' }), /Invalid calendar/);
});
