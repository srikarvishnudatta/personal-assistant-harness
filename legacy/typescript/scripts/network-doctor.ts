import { lookup, Resolver } from 'node:dns/promises';

// Diagnostic only: no alternate DNS server, proxy change or validation bypass.
const targets = ['example.com', 'api.openai.com', 'registry.npmjs.org'];
const resolver = new Resolver({ timeout: 1500, tries: 1 });
type Check = { hostname: string; method: string; ok: boolean; count?: number; code?: string };
async function check(hostname: string, method: string, resolve: () => Promise<unknown[]>): Promise<Check> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const addresses = await Promise.race([resolve(), new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(Object.assign(new Error('timeout'), { code: 'TIMEOUT' })), 5000);
    })]);
    return { hostname, method, ok: true, count: addresses.length };
  } catch (error) { return { hostname, method, ok: false, code: (error as NodeJS.ErrnoException).code ?? 'UNKNOWN' }; }
  finally { if (timer) clearTimeout(timer); }
}
console.log('Node:', process.version);
console.log('Configured DNS server count:', resolver.getServers().length);
console.log('Proxy environment flags (values hidden):', ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY'].filter(key => process.env[key] || process.env[key.toLowerCase()]).join(', ') || 'none');
const results = await Promise.all(targets.flatMap(hostname => [
  check(hostname, 'OS lookup', () => lookup(hostname, { all: true, verbatim: true })),
  check(hostname, 'DNS A', () => resolver.resolve4(hostname)),
  check(hostname, 'DNS AAAA', () => resolver.resolve6(hostname)),
]));
resolver.cancel();
for (const result of results) console.log(`${result.hostname.padEnd(22)} ${result.method.padEnd(10)} ${result.ok ? `OK (${result.count} address records)` : `FAILED (${result.code})`}`);
const failed = results.filter(result => result.method === 'OS lookup' && !result.ok);
if (failed.length) {
  console.log('\nThe browser public-address check cannot proceed for these OS lookup failures.');
  console.log('Run this command in the SAME ordinary terminal as npm run dev.');
  console.log('A successful browser page or npm installation does not verify Node can resolve every target.');
  console.log('If DNS A/AAAA succeeds but OS lookup fails, inspect local resolver/network policy; no fallback is enabled.');
  process.exitCode = 1;
} else console.log('\nOS lookups succeeded. Retry npm run test:browser for navigation and screenshot verification.');
