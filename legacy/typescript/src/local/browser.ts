import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, basename } from 'node:path';

const TIMEOUT = 20_000;
const PROFILE_MARKER = '.personal-assistant-profile';
const PROFILE_ID = 'personal-assistant-harness/browser-profile/v1';

export interface BrowserOptions {
  profileDir: string;
  executablePath?: string;
  channel?: string;
  headless?: boolean;
}

export interface BrowserTab {
  id: string;
  url: string;
  title: string;
}

/** Conservative public-network policy. This is not a replacement for OS egress isolation. */
export function isPublicBrowserAddress(address: string): boolean {
  const literal = address.toLowerCase().replace(/^\[|\]$/g, '');
  if (isIP(literal) === 4) {
    const [a, b, c] = literal.split('.').map(Number);
    return !(a === 0 || a === 10 || a === 127 || a! >= 224 ||
      (a === 100 && b! >= 64 && b! <= 127) ||
      (a === 169 && b === 254) || (a === 172 && b! >= 16 && b! <= 31) ||
      (a === 192 && (b === 168 || b === 0 || (b === 88 && c === 99))) ||
      (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
      (a === 203 && b === 0 && c === 113));
  }
  if (isIP(literal) === 6) {
    // Only ordinary global-unicast addresses; block mapped IPv4, local, multicast,
    // transition mechanisms and documentation prefixes rather than guessing.
    const groups = literal.split(':');
    const first = parseInt(groups[0]!, 16);
    const second = parseInt(groups[1] || '0', 16);
    return first >= 0x2000 && first < 0x3fff && first !== 0x2002 &&
      !(first === 0x2001 && (second < 0x200 || second === 0xdb8));
  }
  return false;
}

/** Validates URL syntax and literal destinations without making a network request. */
export function validateBrowserUrl(input: string): URL {
  if (typeof input !== 'string' || input.length > 4096) throw new Error('Browser URL must be a string up to 4096 characters');
  let url: URL;
  try { url = new URL(input); } catch { throw new Error('Provide a complete public HTTP or HTTPS URL'); }
  if (!['https:', 'http:'].includes(url.protocol)) throw new Error('Only HTTP and HTTPS browser URLs are allowed');
  if (url.username || url.password) throw new Error('Credentials are not allowed in browser URLs');
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (!host || host.includes('%') || (!isIP(host) && (!host.includes('.') || /(?:^|\.)(localhost|local|internal|lan|home|test|invalid)$/.test(host))))
    throw new Error('Local and internal browser destinations are blocked');
  if (isIP(host) && !isPublicBrowserAddress(host)) throw new Error('Private and reserved browser destinations are blocked');
  return url;
}

export type BrowserAddressLookup = (hostname: string) => Promise<ReadonlyArray<{ address: string }>>;
export async function assertPublicBrowserUrl(input: string, addressLookup: BrowserAddressLookup = host => lookup(host, { all: true, verbatim: true })): Promise<URL> {
  const url = validateBrowserUrl(input);
  const host = url.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (!isIP(host)) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let addresses: ReadonlyArray<{ address: string }>;
    try {
      addresses = await Promise.race([
        addressLookup(host),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(Object.assign(new Error('DNS lookup timed out'), { code: 'TIMEOUT' })), 5000);
          timer.unref();
        }),
      ]);
    } catch (error) {
      const code = String((error as NodeJS.ErrnoException).code ?? 'LOOKUP_FAILED').replace(/[^A-Z0-9_]/g, '').slice(0, 40);
      throw new Error(`Browser DNS validation failed for ${host} (${code}). Navigation is blocked because its public destination cannot be verified. Run npm run doctor:network in the same terminal.`);
    } finally { if (timer) clearTimeout(timer); }
    if (!addresses.length || addresses.some(item => !isPublicBrowserAddress(item.address)))
      throw new Error('Browser destination resolves to a private or reserved address');
  }
  return url;
}

/** One browser profile owned by the harness, independent of everyday browser data.
 * The application must authorize click/fill operations before calling them.
 * Page content is untrusted data. This module exposes no page-script or shell tool.
 * HTTP interception reduces exposure; GET requests can still have side effects and
 * DNS checks cannot eliminate rebinding races without an external egress boundary.
 */
export class BrowserService {
  private context: any;
  private visible = false;
  private queue: Promise<unknown> = Promise.resolve();
  private pageIds = new WeakMap<object, string>();
  private lastError: string | undefined;
  private mutations = 0;
  private options: BrowserOptions;

  constructor(options: BrowserOptions) {
    const profileDir = resolve(options.profileDir);
    if (basename(profileDir) !== 'browser-profile' || !profileDir.split(/[\\/]/).includes('.assistant'))
      throw new Error('Dedicated browser profile must be an .assistant/browser-profile directory');
    this.options = { ...options, profileDir };
  }

  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation, operation);
    this.queue = result.catch(() => undefined);
    return result;
  }

  private async launchInternal(visible = !(this.options.headless ?? true)) {
    if (this.context && this.visible === visible) return;
    if (this.context) await this.context.close();
    this.context = undefined;
    await mkdir(this.options.profileDir, { recursive: true, mode: 0o700 });
    const markerPath = resolve(this.options.profileDir, PROFILE_MARKER);
    const entries = await readdir(this.options.profileDir);
    if (entries.length && !entries.includes(PROFILE_MARKER))
      throw new Error('Refusing to use an existing unmarked browser profile');
    if (entries.includes(PROFILE_MARKER) && (await readFile(markerPath, 'utf8')).trim() !== PROFILE_ID)
      throw new Error('Browser profile ownership marker is invalid');
    await writeFile(markerPath, PROFILE_ID, { mode: 0o600 });
    let playwright: any;
    try {
      const dependency = 'playwright-core';
      playwright = await import(dependency);
    } catch {
      this.lastError = 'Install playwright-core to enable the dedicated browser';
      throw new Error(this.lastError);
    }
    try {
      this.context = await playwright.chromium.launchPersistentContext(this.options.profileDir, {
        headless: !visible,
        ...(this.options.executablePath ? { executablePath: this.options.executablePath } :
          { channel: this.options.channel ?? (process.platform === 'win32' ? 'msedge' : 'chromium') }),
        acceptDownloads: false,
        serviceWorkers: 'block',
        viewport: { width: 1365, height: 900 },
        timeout: TIMEOUT,
      });
      this.visible = visible;
      this.lastError = undefined;
      this.context.setDefaultTimeout(TIMEOUT);
      this.context.setDefaultNavigationTimeout(TIMEOUT);
      await this.context.route('**/*', async (route: any) => {
        try {
          await assertPublicBrowserUrl(route.request().url());
          // A visible window is an explicit human takeover for login. The application
          // must refuse all agent browser tools until the operator resumes headless mode.
          if (!['GET', 'HEAD', 'OPTIONS'].includes(route.request().method()) && !this.mutations && !this.visible)
            return await route.abort('blockedbyclient');
          await route.continue();
        } catch { await route.abort('blockedbyclient').catch(() => undefined); }
      });
      // WebSocket transport can otherwise bypass HTTP route interception.
      if (typeof this.context.routeWebSocket === 'function') {
        await this.context.routeWebSocket('**/*', (socket: any) => socket.close());
      }
      this.context.on('page', (page: any) => this.configurePage(page));
      this.context.on('close', () => { this.context = undefined; });
      for (const page of this.context.pages()) this.configurePage(page);
    } catch (error) {
      if (this.context) await this.context.close().catch(() => undefined);
      this.context = undefined;
      const reason = /EACCES|EPERM|ENOENT|executable doesn't exist|Timeout/i.exec(error instanceof Error ? error.message : '')?.[0];
      this.lastError = `Dedicated Chromium could not start${reason ? ` (${reason})` : ''}. Check the browser installation, profile lock, and process permissions; configure BROWSER_EXECUTABLE_PATH if needed.`;
      throw new Error(this.lastError);
    }
  }

  private configurePage(page: any) {
    this.pageIds.set(page, crypto.randomUUID());
    page.on('dialog', (dialog: any) => dialog.dismiss().catch(() => undefined));
    page.on('download', (download: any) => download.cancel().catch(() => undefined));
  }

  private page(tabId: string): any {
    const page = this.context?.pages().find((item: any) => this.pageIds.get(item) === tabId);
    if (!page || page.isClosed()) throw new Error('Browser tab is missing or closed');
    return page;
  }

  async status() {
    let installed = true;
    try { const dependency = 'playwright-core'; await import(dependency); } catch { installed = false; }
    return { available: installed, active: Boolean(this.context), visible: this.visible && Boolean(this.context),
      manualControl: this.visible && Boolean(this.context),
      profile: 'dedicated', browser: 'chromium', ...(this.lastError ? { error: this.lastError } : {}) };
  }

  launch(options: { visible?: boolean } = {}) {
    return this.serial(async () => { await this.launchInternal(options.visible); return this.status(); });
  }

  tabs(): Promise<BrowserTab[]> {
    return this.serial(async () => {
      if (!this.context) return [];
      return Promise.all(this.context.pages().map(async (page: any) => ({
        id: this.pageIds.get(page)!, url: page.url(), title: await page.title().catch(() => ''),
      })));
    });
  }

  navigate(input: string) {
    return this.serial(async () => {
      const url = await assertPublicBrowserUrl(input);
      await this.launchInternal(this.context ? this.visible : undefined);
      const page = await this.context.newPage();
      try {
        const response = await page.goto(url.href, { waitUntil: 'domcontentloaded', timeout: TIMEOUT });
        await assertPublicBrowserUrl(page.url());
        return { id: this.pageIds.get(page)!, url: page.url(), title: await page.title(), status: response?.status() ?? null };
      } catch (error) { await page.close().catch(() => undefined); throw error; }
    });
  }

  snapshot(tabId: string) {
    return this.serial(async () => {
      const page = this.page(tabId);
      await assertPublicBrowserUrl(page.url());
      const content = await page.locator('body').innerText({ timeout: TIMEOUT });
      const elements = await page.locator('a,button,input,textarea,select,[role="button"],[role="link"]').evaluateAll((nodes: Element[]) => {
        function selector(element: Element): string {
          if (element.id) return `#${CSS.escape(element.id)}`;
          const parts: string[] = [];
          let current: Element | null = element;
          while (current && current.tagName !== 'HTML') {
            const tag = current.tagName.toLowerCase();
            const siblings = current.parentElement ? Array.from(current.parentElement.children).filter(item => item.tagName === current!.tagName) : [current];
            parts.unshift(`${tag}:nth-of-type(${siblings.indexOf(current) + 1})`);
            current = current.parentElement;
          }
          return parts.join(' > ');
        }
        return nodes.filter(node => node.getClientRects().length > 0).slice(0, 150).map(node => ({
          selector: selector(node), tag: node.tagName.toLowerCase(), role: node.getAttribute('role'),
          name: (node.getAttribute('aria-label') || node.getAttribute('placeholder') || node.textContent || '').trim().slice(0, 180),
          href: node.getAttribute('href'), type: node.getAttribute('type'),
        }));
      });
      return { tabId, url: page.url(), title: await page.title(), text: content.slice(0, 24000),
        truncated: content.length > 24000, elements, untrustedContent: true };
    });
  }

  screenshot(tabId: string): Promise<{ tabId: string; mimeType: string; base64: string }> {
    return this.serial(async () => {
      const page = this.page(tabId);
      await assertPublicBrowserUrl(page.url());
      const bytes = await page.screenshot({ type: 'png', fullPage: false, timeout: TIMEOUT });
      return { tabId, mimeType: 'image/png', base64: bytes.toString('base64') };
    });
  }

  /** Caller must bind approval to this exact tab, selector and action. */
  click(tabId: string, selector: string) {
    return this.serial(async () => {
      if (this.visible) throw new Error('Browser is under manual control. Resume headless mode before automatic actions.');
      if (!selector || selector.length > 2000) throw new Error('Invalid browser selector');
      const page = this.page(tabId);
      await assertPublicBrowserUrl(page.url());
      this.mutations++;
      try { await page.locator(selector).click({ timeout: TIMEOUT }); }
      finally { this.mutations--; }
      return { tabId, url: page.url(), title: await page.title() };
    });
  }

  /** Passwords/tokens should be entered by the user in the visible dedicated browser. */
  fill(tabId: string, selector: string, value: string) {
    return this.serial(async () => {
      if (this.visible) throw new Error('Browser is under manual control. Resume headless mode before automatic actions.');
      if (!selector || selector.length > 2000 || typeof value !== 'string' || value.length > 12000)
        throw new Error('Invalid browser form input');
      const page = this.page(tabId);
      await assertPublicBrowserUrl(page.url());
      const field = page.locator(selector);
      if ((await field.getAttribute('type'))?.toLowerCase() === 'password')
        throw new Error('Enter passwords manually in the visible dedicated browser');
      this.mutations++;
      try { await field.fill(value, { timeout: TIMEOUT }); }
      finally { this.mutations--; }
      return { tabId, filled: true };
    });
  }

  close() {
    return this.serial(async () => {
      if (this.context) await this.context.close();
      this.context = undefined;
      return { active: false };
    });
  }
}
