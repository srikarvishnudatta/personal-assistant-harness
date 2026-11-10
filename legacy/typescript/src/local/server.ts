import { createServer, type IncomingMessage } from 'node:http';
import { readFile, realpath, stat } from 'node:fs/promises';
import { resolve, relative, extname, isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadLocalConfig } from './config.ts';
import { LocalRuntime } from './runtime.ts';
import { LocalStore } from './store.ts';

const MIME: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };

async function bodyOf(request: IncomingMessage): Promise<Buffer | undefined> {
  if (request.method === 'GET' || request.method === 'HEAD') return;
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > 65536) throw new Error('Request exceeds 64 KiB');
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

export async function startLocalServer() {
  const config = loadLocalConfig();
  const store = new LocalStore(resolve(config.dataDir, 'assistant.sqlite'));
  let runtime: LocalRuntime;
  try { store.claimRuntimeOwnership(); runtime = new LocalRuntime(config, { store }); }
  catch (error) { store.close(); throw error; }
  const staticRoot = resolve(config.root, 'dist');
  const server = createServer(async (incoming, outgoing) => {
    try {
      // No network-wide binding or arbitrary Host routing: this is a personal local service.
      const host = incoming.headers.host ?? '';
      if (![`127.0.0.1:${config.port}`, `localhost:${config.port}`].includes(host)) {
        outgoing.writeHead(403); outgoing.end('Invalid host'); return;
      }
      const url = new URL(incoming.url ?? '/', `http://${host}`);
      let response: Response;
      if (url.pathname.startsWith('/api/') || url.pathname === '/health' || url.pathname === '/oauth/google/callback') {
        const headers = new Headers();
        for (const [key, value] of Object.entries(incoming.headers)) if (value) headers.set(key, Array.isArray(value) ? value.join(', ') : value);
        const body = await bodyOf(incoming);
        response = await runtime.handle(new Request(url, { method: incoming.method, headers, body: body ? new Uint8Array(body).buffer : undefined }));
      } else {
        if (!['GET', 'HEAD'].includes(incoming.method ?? 'GET')) { outgoing.writeHead(405); outgoing.end(); return; }
        const decoded = decodeURIComponent(url.pathname);
        let path = resolve(staticRoot, `.${decoded}`);
        const rel = relative(staticRoot, path);
        if (rel.startsWith('..') || isAbsolute(rel)) { outgoing.writeHead(403); outgoing.end(); return; }
        try { if (!(await stat(path)).isFile()) path = resolve(staticRoot, 'index.html'); }
        catch { path = resolve(staticRoot, 'index.html'); }
        const physical = await realpath(path);
        const physicalRelative = relative(await realpath(staticRoot), physical);
        if (physicalRelative.startsWith('..') || isAbsolute(physicalRelative)) { outgoing.writeHead(403); outgoing.end(); return; }
        response = new Response(await readFile(physical), { headers: { 'Content-Type': MIME[extname(path)] ?? 'application/octet-stream', 'Cache-Control': extname(path) === '.html' ? 'no-cache' : 'public, max-age=3600' } });
      }
      outgoing.statusCode = response.status;
      response.headers.forEach((value, key) => outgoing.setHeader(key, value));
      outgoing.setHeader('X-Content-Type-Options', 'nosniff');
      outgoing.setHeader('Referrer-Policy', 'no-referrer');
      outgoing.setHeader('X-Frame-Options', 'DENY');
      outgoing.end(incoming.method === 'HEAD' ? undefined : Buffer.from(await response.arrayBuffer()));
    } catch (error) {
      const oversized = error instanceof Error && error.message.includes('64 KiB');
      outgoing.writeHead(oversized ? 413 : 503, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      outgoing.end(JSON.stringify({ error: oversized ? 'Request too large' : 'Local server request failed. Build the UI and inspect the local configuration.' }));
    }
  });
  try {
    await new Promise<void>((accept, reject) => { server.once('error', reject); server.listen(config.port, '127.0.0.1', accept); });
    await runtime.start();
  } catch (error) { if (server.listening) server.close(); await runtime.close(); throw error; }
  console.log(`Personal assistant ready at http://127.0.0.1:${config.port} (local only, gpt-6-luna).`);
  console.log('Enter HARNESS_TOKEN from .dev.vars in the UI. Secrets are never printed.');
  const stop = () => { server.close(); void runtime.close().finally(() => process.exit(0)); };
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  return { server, runtime };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  startLocalServer().catch(error => {
    const code = (error as NodeJS.ErrnoException).code;
    const ownership = error instanceof Error && error.message.startsWith('Another local assistant owns');
    console.error(ownership ? error.message : code === 'EADDRINUSE' ? 'Port is occupied. Stop Wrangler or set LOCAL_PORT in .dev.vars.' : `Unable to start local assistant${code ? ` (${code})` : ''}. Check settings, port access and npm install.`);
    process.exitCode = 1;
  });
}
