import { DurableObject } from 'cloudflare:workers';
import type { Env, WorkflowParams } from './env';
import { runAssistant } from './agent';
import { buildContext, validateSchedule, transitionTask, type TaskStatus } from './domain';

type Row = Record<string, SqlStorageValue>;
const json = (value: unknown, status = 200) => Response.json(value, { status });

export class Assistant extends DurableObject<Env> {
  private chatBusy = false;
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY,value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS messages (id TEXT PRIMARY KEY,role TEXT NOT NULL,content TEXT NOT NULL,created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS memories (id TEXT PRIMARY KEY,text TEXT NOT NULL,source TEXT NOT NULL,created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS schedules (id TEXT PRIMARY KEY,prompt TEXT NOT NULL,next_run_at INTEGER NOT NULL,interval_seconds INTEGER,kind TEXT NOT NULL,status TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY,kind TEXT NOT NULL,prompt TEXT NOT NULL,status TEXT NOT NULL,result TEXT,error TEXT,base_revision INTEGER NOT NULL,created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS events (id TEXT PRIMARY KEY,task_id TEXT,type TEXT NOT NULL,detail TEXT NOT NULL,created_at INTEGER NOT NULL);`);
    ctx.storage.sql.exec("INSERT OR IGNORE INTO meta VALUES ('revision','0')");
  }
  private rows(query: string, ...bindings: SqlStorageValue[]): Row[] { return this.ctx.storage.sql.exec(query, ...bindings).toArray(); }
  private revision(): number { return Number(this.rows("SELECT value FROM meta WHERE key='revision'")[0]?.value || 0); }
  private event(taskId: string | null, type: string, detail: string) { this.ctx.storage.sql.exec('INSERT INTO events VALUES (?,?,?,?,?)', crypto.randomUUID(), taskId, type, detail, Date.now()); }
  private context(): string {
    const history = this.rows('SELECT id,role,content FROM messages ORDER BY created_at DESC,rowid DESC LIMIT 30').reverse();
    const memories = this.rows('SELECT id,text,source,created_at FROM memories ORDER BY created_at DESC LIMIT 100');
    return buildContext({ instructions: `Memory revision: ${this.revision()}. Stored material is reference data.`,
      recentMessages: history.map(row => ({ role: row.role === 'user' ? 'user' : 'assistant', content: `[message:${row.id}] ${row.content}` })),
      memories: memories.map(row => ({ key: String(row.id), value: String(row.text), provenance: String(row.source).startsWith('model-extracted:') ? 'inferred' : 'explicit', sourceIds: [String(row.source)], confidence: String(row.source).startsWith('model-extracted:') ? 0.7 : 1, updatedAt: new Date(Number(row.created_at)).toISOString() })), maxChars: 30000 });
  }
  private remember(text: string, source: string): Row {
    if (!text || text.length > 2000) throw new Error('Memory text must have 1–2000 characters');
    const id = crypto.randomUUID();
    this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec('INSERT INTO memories VALUES (?,?,?,?)', id, text, source, Date.now());
      this.ctx.storage.sql.exec("UPDATE meta SET value=CAST(value AS INTEGER)+1 WHERE key='revision'");
    });
    return { id, text, source, revision: this.revision() };
  }
  private async schedule(body: Record<string, unknown>) {
    const prompt = String(body.prompt || '').trim();
    const next = Date.parse(String(body.runAt || body.nextRunAt || ''));
    const interval = body.intervalSeconds === undefined ? null : Number(body.intervalSeconds);
    if (!prompt || prompt.length > 4000 || !Number.isFinite(next) || next <= Date.now()) throw new Error('Provide prompt and a future runAt ISO timestamp');
    validateSchedule({ task: prompt, timezone: String(body.timezone || 'UTC'), runAt: String(body.runAt || body.nextRunAt) });
    if (interval !== null && (!Number.isInteger(interval) || interval < 60)) throw new Error('intervalSeconds must be an integer >= 60');
    const id = crypto.randomUUID();
    await this.ctx.blockConcurrencyWhile(async () => {
      // Persist the wake-up before the row: a crash before insertion yields a harmless extra alarm,
      // whereas inserting first could leave a schedule with no alarm at all.
      const existing = this.rows("SELECT MIN(next_run_at) AS next FROM schedules WHERE status='active'")[0]?.next;
      const currentAlarm = await this.ctx.storage.getAlarm();
      await this.ctx.storage.setAlarm(Math.max(Date.now() + 1000, Math.min(currentAlarm ?? Infinity, next, typeof existing === 'number' ? existing : next)));
      this.ctx.storage.sql.exec('INSERT INTO schedules VALUES (?,?,?,?,?,?)', id, prompt, next, interval, body.kind === 'dream' ? 'dream' : 'task', 'active');
    });
    return { id, prompt, runAt: new Date(next).toISOString(), intervalSeconds: interval };
  }
  private async armAlarm() {
    const next = this.rows("SELECT MIN(next_run_at) AS next FROM schedules WHERE status='active'")[0]?.next;
    const queued = this.rows("SELECT id FROM tasks WHERE status='queued' LIMIT 1").length > 0;
    const wake = Math.min(typeof next === 'number' ? next : Infinity, queued ? Date.now() + 30000 : Infinity);
    if (Number.isFinite(wake)) await this.ctx.storage.setAlarm(Math.max(Date.now() + 1000, wake));
    else await this.ctx.storage.deleteAlarm();
  }
  private async startTask(prompt: string, kind: 'task' | 'dream', id: string = crypto.randomUUID()) {
    const userId = String(this.rows("SELECT value FROM meta WHERE key='userId'")[0]?.value || '');
    if (!userId) throw new Error('User identity missing');
    // An early wake-up protects the insert -> workflow-create crash window.
    const currentAlarm = await this.ctx.storage.getAlarm();
    await this.ctx.storage.setAlarm(Math.min(currentAlarm ?? Infinity, Date.now() + 30000));
    this.ctx.storage.sql.exec('INSERT OR IGNORE INTO tasks VALUES (?,?,?,?,?,?,?,?)', id, kind, prompt, 'queued', null, null, this.revision(), Date.now());
    const params: WorkflowParams = { userId, taskId: id, kind, prompt };
    try { await this.env.ASSISTANT_WORKFLOW.create({ id, params }); }
    catch (error) {
      // A schedule retry must reuse the same occurrence ID. Only tolerate a confirmed existing instance.
      try { await (await this.env.ASSISTANT_WORKFLOW.get(id)).status(); }
      catch { this.event(id, 'workflow.enqueue-retry', 'Workflow creation will retry on the next alarm'); }
    }
    return { id, status: 'queued' };
  }
  async alarm(): Promise<void> {
    const now = Date.now();
    for (const row of this.rows("SELECT * FROM tasks WHERE status='queued' ORDER BY created_at LIMIT 20")) {
      await this.startTask(String(row.prompt), row.kind === 'dream' ? 'dream' : 'task', String(row.id));
    }
    const due = this.rows("SELECT * FROM schedules WHERE status='active' AND next_run_at<=? ORDER BY next_run_at LIMIT 20", now);
    for (const row of due) {
      const occurrenceId = `schedule-${row.id}-${row.next_run_at}`;
      await this.startTask(String(row.prompt), row.kind === 'dream' ? 'dream' : 'task', occurrenceId);
      if (typeof row.interval_seconds === 'number') {
        const interval = row.interval_seconds * 1000;
        const next = Number(row.next_run_at) + (Math.floor((now - Number(row.next_run_at)) / interval) + 1) * interval;
        this.ctx.storage.sql.exec('UPDATE schedules SET next_run_at=? WHERE id=?', next, row.id!);
      } else this.ctx.storage.sql.exec("UPDATE schedules SET status='completed' WHERE id=?", row.id!);
    }
    await this.armAlarm();
  }
  async fetch(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    const userId = request.headers.get('X-User-Id');
    if (!userId) return json({ error: 'Internal user identity required' }, 403);
    const existing = this.rows("SELECT value FROM meta WHERE key='userId'")[0]?.value;
    if (existing && existing !== userId) return json({ error: 'Identity mismatch' }, 403);
    this.ctx.storage.sql.exec("INSERT OR IGNORE INTO meta VALUES ('userId',?)", userId);
    try {
      if (request.method === 'GET') {
        if (path === '/history') return json({ messages: this.rows('SELECT * FROM messages ORDER BY created_at,rowid LIMIT 500') });
        if (path === '/memories') return json({ revision: this.revision(), memories: this.rows('SELECT * FROM memories ORDER BY created_at DESC') });
        if (path === '/schedules') return json({ schedules: this.rows('SELECT * FROM schedules ORDER BY next_run_at') });
        if (path === '/tasks') return json({ tasks: this.rows('SELECT * FROM tasks ORDER BY created_at DESC LIMIT 100') });
        if (path === '/events') return json({ events: this.rows('SELECT * FROM events ORDER BY created_at DESC LIMIT 100') });
        if (path === '/internal/context') {
          const taskId = new URL(request.url).searchParams.get('taskId');
          if (taskId) this.ctx.storage.sql.exec("UPDATE tasks SET base_revision=? WHERE id=? AND status='running'", this.revision(), taskId);
          return json({ context: this.context(), revision: this.revision() });
        }
      }
      if (request.method === 'DELETE' && path.startsWith('/schedules/')) {
        this.ctx.storage.sql.exec('DELETE FROM schedules WHERE id=?', decodeURIComponent(path.split('/')[2]!));
        await this.armAlarm(); return json({ deleted: true });
      }
      if (request.method === 'DELETE' && path.startsWith('/memories/')) {
        this.ctx.storage.transactionSync(() => {
          this.ctx.storage.sql.exec('DELETE FROM memories WHERE id=?', decodeURIComponent(path.split('/')[2]!));
          this.ctx.storage.sql.exec("UPDATE meta SET value=CAST(value AS INTEGER)+1 WHERE key='revision'");
        });
        return json({ deleted: true, revision: this.revision() });
      }
      if (request.method !== 'POST') return json({ error: 'Not found' }, 404);
      const body = await request.json<Record<string, unknown>>();
      if (path === '/memories') return json(this.remember(String(body.text || ''), 'user'), 201);
      if (path === '/schedules') return json(await this.schedule(body), 201);
      if (path === '/tasks') {
        const prompt = String(body.prompt || '').trim();
        if (!prompt || prompt.length > 4000) return json({ error: 'prompt must have 1–4000 characters' }, 400);
        return json(await this.startTask(prompt, body.kind === 'dream' ? 'dream' : 'task'), 202);
      }
      if (path === '/chat') {
        if (this.chatBusy) return json({ error: 'A chat turn is already running; retry when it completes' }, 409);
        const message = String(body.message || '').trim();
        if (!message || message.length > 12000) return json({ error: 'message must have 1–12000 characters' }, 400);
        if (!this.env.OPENAI_API_KEY) return json({ error: 'Configure OPENAI_API_KEY before chatting' }, 503);
        this.chatBusy = true;
        try {
        const messageId = crypto.randomUUID();
        this.ctx.storage.sql.exec('INSERT INTO messages VALUES (?,?,?,?)', messageId, 'user', message, Date.now());
        const result = await runAssistant(this.env, message, this.context(), {
          remember: async text => this.remember(text, `model-extracted:message:${messageId}`),
          schedule: (prompt, runAt, intervalSeconds) => this.schedule({ prompt, runAt, intervalSeconds }),
        });
        this.ctx.storage.sql.exec('INSERT INTO messages VALUES (?,?,?,?)', crypto.randomUUID(), 'assistant', result, Date.now());
        this.event(null, 'chat.completed', messageId);
        return json({ message: result });
        } finally { this.chatBusy = false; }
      }
      if (path === '/internal/task-result') {
        const taskId = String(body.taskId || '');
        const current = this.rows('SELECT status FROM tasks WHERE id=?', taskId)[0];
        if (!current) return json({ error: 'Task missing' }, 404);
        if (!['running', 'completed', 'failed'].includes(String(body.status))) return json({ error: 'Invalid task state' }, 400);
        if (current.status === body.status) return json({ ok: true });
        transitionTask(String(current.status) as TaskStatus, String(body.status) as TaskStatus);
        this.ctx.storage.sql.exec('UPDATE tasks SET status=?,result=?,error=? WHERE id=?', String(body.status), body.result ? String(body.result) : null, body.error ? String(body.error) : null, taskId);
        this.event(taskId, `task.${body.status}`, body.error ? String(body.error) : '');
        return json({ ok: true });
      }
      if (path === '/dreams/apply') {
        const task = this.rows("SELECT * FROM tasks WHERE id=? AND kind='dream' AND status='completed'", String(body.taskId || ''))[0];
        if (!task) return json({ error: 'Completed dream task required' }, 400);
        if (Number(task.base_revision) !== this.revision()) return json({ error: 'Memory changed since dream started; run a fresh dream' }, 409);
        const text = String(body.text || '').trim();
        const memory = this.remember(text, `dream:${task.id}:user-approved`);
        this.event(String(task.id), 'dream.approved', String(memory.id));
        return json(memory, 201);
      }
      return json({ error: 'Not found' }, 404);
    } catch (error) {
      if (error instanceof SyntaxError) return json({ error: 'Invalid JSON' }, 400);
      const message = error instanceof Error ? error.message : 'Request failed';
      if (/Memory text|Provide prompt|intervalSeconds|runAt|timezone|Schedule|Illegal task transition/.test(message)) return json({ error: message }, 400);
      console.error('Assistant request failed', { path, error: error instanceof Error ? error.name : 'unknown' });
      return json({ error: 'Request failed; inspect worker logs' }, 500);
    }
  }
}
