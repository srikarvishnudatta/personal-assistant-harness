import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

const SCOPES = ['https://www.googleapis.com/auth/gmail.readonly', 'https://www.googleapis.com/auth/gmail.send', 'https://www.googleapis.com/auth/calendar.events'];
interface Tokens { access_token: string; refresh_token?: string; expires_at: number; scope: string }
interface ConnectorOptions { clientId?: string; clientSecret?: string; redirectUri: string; vaultPath: string; encryptionSecret: string; fetchImpl?: typeof fetch }

/** Raw endpoints follow Google's web-server OAuth flow; secrets never leave this class. */
export class GoogleConnector {
  private options: ConnectorOptions;
  private fetcher: typeof fetch;
  private pending = new Map<string, { verifier: string; expiresAt: number }>();
  private refreshInFlight?: Promise<Tokens>;
  constructor(options: ConnectorOptions) {
    this.options = options;
    this.fetcher = options.fetchImpl ?? fetch;
    if (options.encryptionSecret.length < 24) throw new Error('Connector encryption secret must have at least 24 characters');
  }
  private configured() { return Boolean(this.options.clientId && this.options.clientSecret); }
  private key() { return createHash('sha256').update(this.options.encryptionSecret).digest(); }
  private async load(): Promise<Tokens | null> {
    try {
      const envelope = JSON.parse(await fs.readFile(this.options.vaultPath, 'utf8')) as { iv: string; tag: string; encrypted: string };
      const decipher = createDecipheriv('aes-256-gcm', this.key(), Buffer.from(envelope.iv, 'base64'));
      decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
      const plaintext = Buffer.concat([decipher.update(Buffer.from(envelope.encrypted, 'base64')), decipher.final()]);
      return JSON.parse(plaintext.toString('utf8')) as Tokens;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw new Error('Cannot unlock saved Google credentials. Restore the original credential key or reconnect Google.');
    }
  }
  private async save(tokens: Tokens): Promise<void> {
    const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', this.key(), iv);
    const encrypted = Buffer.concat([cipher.update(JSON.stringify(tokens), 'utf8'), cipher.final()]);
    const body = JSON.stringify({ version: 1, iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), encrypted: encrypted.toString('base64') });
    await fs.mkdir(path.dirname(this.options.vaultPath), { recursive: true, mode: 0o700 });
    const temporary = `${this.options.vaultPath}.${randomBytes(6).toString('hex')}.tmp`;
    await fs.writeFile(temporary, body, { mode: 0o600, flag: 'wx' });
    await fs.rename(temporary, this.options.vaultPath);
  }
  async status() {
    const tokens = await this.load();
    return { provider: 'google', configured: this.configured(), connected: Boolean(tokens), scopes: tokens?.scope.split(' ').filter(Boolean) ?? [], redirectUri: this.options.redirectUri };
  }
  beginAuth(): { url: string; state: string } {
    if (!this.configured()) throw new Error('Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET before connecting Google.');
    const redirect = new URL(this.options.redirectUri);
    if (redirect.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(redirect.hostname)) throw new Error('Local Google OAuth requires a loopback HTTP redirect URI');
    for (const [state, value] of this.pending) if (value.expiresAt < Date.now()) this.pending.delete(state);
    const state = randomBytes(32).toString('base64url'), verifier = randomBytes(48).toString('base64url');
    this.pending.set(state, { verifier, expiresAt: Date.now() + 10 * 60 * 1000 });
    const parameters = new URLSearchParams({ client_id: this.options.clientId!, redirect_uri: this.options.redirectUri, response_type: 'code', scope: SCOPES.join(' '), state, access_type: 'offline', prompt: 'consent', include_granted_scopes: 'true', code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256' });
    return { url: `https://accounts.google.com/o/oauth2/v2/auth?${parameters}`, state };
  }
  private async tokenRequest(parameters: URLSearchParams): Promise<Record<string, unknown>> {
    const response = await this.fetcher('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: parameters, signal: AbortSignal.timeout(20000) });
    if (!response.ok) throw new Error(`Google authorization failed (${response.status}); reconnect the account.`);
    const data = await response.json() as Record<string, unknown>;
    if (typeof data.access_token !== 'string') throw new Error('Google returned no access token');
    return data;
  }
  async completeAuth(code: string, state: string): Promise<{ connected: true }> {
    const record = this.pending.get(state);
    this.pending.delete(state);
    if (!record || record.expiresAt < Date.now() || !code || code.length > 4096) throw new Error('Invalid or expired OAuth state. Start Google connection again.');
    const data = await this.tokenRequest(new URLSearchParams({ client_id: this.options.clientId!, client_secret: this.options.clientSecret!, redirect_uri: this.options.redirectUri, grant_type: 'authorization_code', code, code_verifier: record.verifier }));
    const prior = await this.load();
    await this.save({ access_token: String(data.access_token), refresh_token: typeof data.refresh_token === 'string' ? data.refresh_token : prior?.refresh_token, expires_at: Date.now() + Number(data.expires_in ?? 3600) * 1000, scope: typeof data.scope === 'string' ? data.scope : SCOPES.join(' ') });
    return { connected: true };
  }
  private async access(): Promise<string> {
    const tokens = await this.load();
    if (!tokens) throw new Error('Google is not connected');
    if (tokens.expires_at > Date.now() + 60000) return tokens.access_token;
    if (!tokens.refresh_token) throw new Error('Google authorization expired; reconnect the account');
    if (!this.refreshInFlight) {
      this.refreshInFlight = (async () => {
        const data = await this.tokenRequest(new URLSearchParams({ client_id: this.options.clientId!, client_secret: this.options.clientSecret!, grant_type: 'refresh_token', refresh_token: tokens.refresh_token! }));
        const refreshed: Tokens = { ...tokens, access_token: String(data.access_token), refresh_token: typeof data.refresh_token === 'string' ? data.refresh_token : tokens.refresh_token, scope: typeof data.scope === 'string' ? data.scope : tokens.scope, expires_at: Date.now() + Number(data.expires_in ?? 3600) * 1000 };
        await this.save(refreshed); return refreshed;
      })().finally(() => { this.refreshInFlight = undefined; });
    }
    return (await this.refreshInFlight).access_token;
  }
  private async api(url: string, options: RequestInit = {}) {
    const response = await this.fetcher(url, { ...options, headers: { Authorization: `Bearer ${await this.access()}`, 'Content-Type': 'application/json', ...options.headers }, signal: AbortSignal.timeout(20000) });
    if (!response.ok) throw new Error(`Google API request failed (${response.status})`);
    return response.json() as Promise<Record<string, unknown>>;
  }
  async listMail(query = '', maxResults = 10) {
    if (query.length > 2000) throw new Error('Mail query is too long');
    const parameters = new URLSearchParams({ q: query, maxResults: String(Math.max(1, Math.min(25, Math.floor(maxResults)))) });
    return this.api(`https://gmail.googleapis.com/gmail/v1/users/me/messages?${parameters}`);
  }
  async readMail(id: string) {
    if (!/^[a-zA-Z0-9_-]{1,100}$/.test(id)) throw new Error('Invalid mail ID');
    const message = await this.api(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}?format=full`);
    const payload = message.payload as Record<string, unknown> | undefined;
    const headers = ((payload?.headers ?? []) as { name: string; value: string }[]).filter(header => ['from', 'to', 'subject', 'date'].includes(header.name.toLowerCase()));
    const pieces: string[] = [];
    const walk = (part: Record<string, unknown>, depth = 0) => {
      if (depth > 10 || pieces.join('').length > 30000) return;
      if (part.mimeType === 'text/plain') {
        const data = (part.body as { data?: string } | undefined)?.data;
        if (data) pieces.push(Buffer.from(data, 'base64url').toString('utf8').slice(0, 30000));
      }
      for (const child of (part.parts ?? []) as Record<string, unknown>[]) walk(child, depth + 1);
    };
    if (payload) walk(payload);
    return { id: message.id, threadId: message.threadId, snippet: message.snippet, headers, body: pieces.join('\n').slice(0, 30000) };
  }
  async listEvents(start: string, end: string) {
    if (![start, end].every(value => /(?:Z|[+-]\d{2}:\d{2})$/.test(value)) || !Number.isFinite(Date.parse(start)) || !Number.isFinite(Date.parse(end)) || Date.parse(start) >= Date.parse(end)) throw new Error('Provide a valid calendar time range with UTC offsets');
    const query = new URLSearchParams({ timeMin: new Date(start).toISOString(), timeMax: new Date(end).toISOString(), singleEvents: 'true', orderBy: 'startTime', maxResults: '50' });
    return this.api(`https://www.googleapis.com/calendar/v3/calendars/primary/events?${query}`);
  }
  /** Caller MUST bind this payload to a user-approved action before invocation. */
  async sendMail(input: { to: string; subject: string; body: string }) {
    if (!/^[^\s<>@,;]+@[^\s<>@,;]+\.[^\s<>@,;]+$/.test(input.to) || /[\r\n]/.test(input.to + input.subject) || input.subject.length > 500 || input.body.length > 50000) throw new Error('Invalid email recipient, subject, or body');
    const words: string[] = [];
    let group = '';
    for (const character of input.subject) {
      if (Buffer.byteLength(group + character) > 42) { words.push(`=?UTF-8?B?${Buffer.from(group).toString('base64')}?=`); group = ''; }
      group += character;
    }
    words.push(`=?UTF-8?B?${Buffer.from(group).toString('base64')}?=`);
    const subject = words.join('\r\n ');
    const raw = Buffer.from(`To: ${input.to}\r\nSubject: ${subject}\r\nMIME-Version: 1.0\r\nContent-Type: text/plain; charset=UTF-8\r\nContent-Transfer-Encoding: base64\r\n\r\n${Buffer.from(input.body).toString('base64').match(/.{1,76}/g)?.join('\r\n') ?? ''}`).toString('base64url');
    return this.api('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', { method: 'POST', body: JSON.stringify({ raw }) });
  }
  /** Caller MUST bind this payload to a user-approved action before invocation. */
  async createEvent(input: { summary: string; start: string; end: string; timeZone: string }) {
    if (!input.summary.trim() || input.summary.length > 500 || ![input.start, input.end].every(value => /(?:Z|[+-]\d{2}:\d{2})$/.test(value)) || !Number.isFinite(Date.parse(input.start)) || !Number.isFinite(Date.parse(input.end)) || Date.parse(input.end) <= Date.parse(input.start)) throw new Error('Invalid calendar event');
    try { new Intl.DateTimeFormat('en', { timeZone: input.timeZone }); } catch { throw new Error('Invalid calendar timezone'); }
    return this.api('https://www.googleapis.com/calendar/v3/calendars/primary/events', { method: 'POST', body: JSON.stringify({ summary: input.summary, start: { dateTime: new Date(input.start).toISOString(), timeZone: input.timeZone }, end: { dateTime: new Date(input.end).toISOString(), timeZone: input.timeZone } }) });
  }
  async disconnect() {
    const tokens = await this.load();
    this.pending.clear();
    for (let attempt = 0; ; attempt++) {
      try { await fs.unlink(this.options.vaultPath); break; }
      catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === 'ENOENT') break;
        if (!['EBUSY', 'EPERM'].includes(code ?? '') || attempt >= 4) throw new Error('Saved Google credentials could not be removed. A file lock or permission issue must be resolved before disconnect can be confirmed.');
        await new Promise(resolve => setTimeout(resolve, 50 * (attempt + 1)));
      }
    }
    let revoked = false;
    if (tokens) {
      try { const response = await this.fetcher('https://oauth2.googleapis.com/revoke', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token: tokens.refresh_token ?? tokens.access_token }), signal: AbortSignal.timeout(10000) }); revoked = response.ok; } catch { /* Local credentials are removed even when offline. */ }
    }
    return { connected: false, revoked };
  }
}
