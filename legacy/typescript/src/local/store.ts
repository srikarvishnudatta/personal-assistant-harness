import { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { transitionTask, type TaskStatus } from '../domain.ts';
import { validateWorkflow, workflowTaskId, type Workflow } from './workflows.ts';

export type MemoryKind = 'preference' | 'project' | 'person' | 'goal' | 'commitment' | 'fact';
export interface Message { id: string; role: string; content: string; runId: string | null; createdAt: number }
export interface MemoryInput { text: string; kind?: MemoryKind; source: string; sourceIds?: string[]; provenance: 'explicit' | 'inferred'; confidence?: number; expectedRevision?: number }
export interface Memory extends Omit<MemoryInput, 'expectedRevision'> { id: string; kind: MemoryKind; confidence: number; sourceIds: string[]; createdAt: number; updatedAt: number }
export interface GoalStep { id: string; title: string; status: 'pending' | 'running' | 'completed' | 'blocked'; result?: string }
export interface Goal { id: string; title: string; description: string; status: 'active' | 'paused' | 'completed' | 'cancelled'; steps: GoalStep[]; createdAt: number; updatedAt: number }
export interface Task { id: string; prompt: string; kind: 'task' | 'dream' | 'goal'; parentId: string | null; goalId: string | null; status: TaskStatus; result: string | null; error: string | null; attempts: number; createdAt: number; updatedAt: number }
export interface TaskInput { id?: string; prompt: string; kind?: Task['kind']; parentId?: string; goalId?: string }
export interface ScheduleInput { id?: string; prompt: string; runAt: string | number; intervalSeconds?: number; cron?: string; timezone?: string; kind?: Task['kind'] }
export interface Schedule { id: string; prompt: string; nextRunAt: number; intervalSeconds: number | null; cron: string | null; timezone: string; kind: Task['kind']; status: 'active' | 'paused' | 'completed'; createdAt: number; updatedAt: number }
export type ApprovalStatus = 'pending' | 'approved' | 'rejected' | 'executing' | 'completed' | 'failed' | 'expired' | 'uncertain';
export interface ApprovalInput { taskId?: string; kind: string; payload: unknown; summary: string; expiresAt?: string | number }
export interface Approval { id: string; taskId: string | null; kind: string; payload: unknown; summary: string; digest: string; status: ApprovalStatus; expiresAt: number; result: unknown; error: string | null; createdAt: number; updatedAt: number }
export interface Notification { id: string; title: string; body: string; taskId: string | null; dedupeKey: string | null; readAt: number | null; createdAt: number }
export interface Event { id: string; type: string; taskId: string | null; detail: unknown; createdAt: number }
export interface Usage { runId: string; day: string; reservedTokens: number; inputTokens: number; outputTokens: number; status: 'reserved' | 'completed' | 'failed'; createdAt: number; updatedAt: number }
type Row = Record<string, unknown>;

/** Canonical JSON binds approvals to their complete immutable action. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value === 'object' && value && Object.getPrototypeOf(value) === Object.prototype) {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson((value as Row)[key])}`).join(',')}}`;
  }
  throw new Error('Value must contain finite JSON data only');
}
const required = (value: string, field: string, max = 12000) => {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new Error(`${field} must have 1-${max} characters`);
  return value.trim();
};
const limitValue = (value: number, max = 1000) => Math.min(max, Math.max(1, Math.floor(Number.isFinite(value) ? value : 100)));
const toTime = (value: string | number) => typeof value === 'number' ? value : Date.parse(value);
const parsed = (value: unknown) => value === null || value === undefined ? null : JSON.parse(String(value));
function assertNoCredentialKeys(value: unknown): void {
  if (Array.isArray(value)) { for (const item of value) assertNoCredentialKeys(item); return; }
  if (!value || typeof value !== 'object') return;
  for (const [key, nested] of Object.entries(value)) {
    if (/api.?key|password|secret|access.?token|refresh.?token/i.test(key)) throw new Error('Credentials must use the credential vault, not settings');
    assertNoCredentialKeys(nested);
  }
}

/** Local authoritative state. Synchronous transactions prevent check/write races. */
export class LocalStore {
  private readonly db: DatabaseSync;
  private runtimeLease?: string;
  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; PRAGMA secure_delete=ON;
      CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY,value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS runtime_owner (singleton INTEGER PRIMARY KEY CHECK(singleton=1),pid INTEGER NOT NULL,nonce TEXT NOT NULL);
      INSERT OR IGNORE INTO settings VALUES ('memory_revision','0');
      CREATE TABLE IF NOT EXISTS messages (id TEXT PRIMARY KEY,role TEXT NOT NULL,content TEXT NOT NULL,run_id TEXT,created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS memories (id TEXT PRIMARY KEY,text TEXT NOT NULL,kind TEXT NOT NULL,source TEXT NOT NULL,source_ids TEXT NOT NULL,provenance TEXT NOT NULL,confidence REAL NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS memory_versions (id TEXT PRIMARY KEY,memory_id TEXT NOT NULL,revision INTEGER NOT NULL,snapshot TEXT NOT NULL,supersedes TEXT,created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS goals (id TEXT PRIMARY KEY,title TEXT NOT NULL,description TEXT NOT NULL,status TEXT NOT NULL,steps TEXT NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY,prompt TEXT NOT NULL,kind TEXT NOT NULL,parent_id TEXT,goal_id TEXT,status TEXT NOT NULL,result TEXT,error TEXT,attempts INTEGER NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS workflows (id TEXT PRIMARY KEY,definition TEXT NOT NULL,created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS schedules (id TEXT PRIMARY KEY,prompt TEXT NOT NULL,next_run_at INTEGER NOT NULL,interval_seconds INTEGER,cron TEXT,timezone TEXT NOT NULL,kind TEXT NOT NULL,status TEXT NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS approvals (id TEXT PRIMARY KEY,task_id TEXT,kind TEXT NOT NULL,payload TEXT NOT NULL,summary TEXT NOT NULL,digest TEXT NOT NULL,status TEXT NOT NULL,expires_at INTEGER NOT NULL,result TEXT,error TEXT,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS notifications (id TEXT PRIMARY KEY,title TEXT NOT NULL,body TEXT NOT NULL,task_id TEXT,dedupe_key TEXT UNIQUE,read_at INTEGER,created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS events (id TEXT PRIMARY KEY,type TEXT NOT NULL,task_id TEXT,detail TEXT NOT NULL,created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS usage (run_id TEXT PRIMARY KEY,day TEXT NOT NULL,reserved_tokens INTEGER NOT NULL,input_tokens INTEGER NOT NULL,output_tokens INTEGER NOT NULL,status TEXT NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status,created_at);
      CREATE INDEX IF NOT EXISTS idx_schedules_due ON schedules(status,next_run_at);
      CREATE INDEX IF NOT EXISTS idx_usage_day ON usage(day);`);
  }
  claimRuntimeOwnership(): void {
    this.tx(() => {
      const owner = this.rows('SELECT pid,nonce FROM runtime_owner WHERE singleton=1')[0];
      if (owner && owner.nonce === this.runtimeLease) return;
      if (owner) {
        let alive = true;
        try { process.kill(Number(owner.pid), 0); }
        catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') alive = false; }
        if (alive) throw new Error('Another local assistant owns this state directory. Stop that server before starting a second one.');
      }
      const nonce = randomUUID();
      this.exec('INSERT INTO runtime_owner VALUES (1,?,?) ON CONFLICT(singleton) DO UPDATE SET pid=excluded.pid,nonce=excluded.nonce', process.pid, nonce);
      this.runtimeLease = nonce;
    });
  }
  close(): void {
    if (this.runtimeLease) this.exec('DELETE FROM runtime_owner WHERE singleton=1 AND pid=? AND nonce=?', process.pid, this.runtimeLease);
    this.db.close();
  }
  private rows(sql: string, ...bindings: (string | number | null)[]): Row[] { return this.db.prepare(sql).all(...bindings) as Row[]; }
  private exec(sql: string, ...bindings: (string | number | null)[]): void { this.db.prepare(sql).run(...bindings); }
  private tx<T>(work: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = work(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  revision(): number { return this.getSetting<number>('memory_revision') ?? 0; }
  private bumpRevision(): void { this.exec("UPDATE settings SET value=CAST(CAST(value AS INTEGER)+1 AS TEXT) WHERE key='memory_revision'"); }
  private checkRevision(expected?: number): void { if (expected !== undefined && expected !== this.revision()) throw new Error('Memory revision conflict'); }
  private recordMemoryVersion(memory: Memory) {
    const previous = this.rows('SELECT id FROM memory_versions WHERE memory_id=? ORDER BY revision DESC LIMIT 1', memory.id)[0];
    this.exec('INSERT INTO memory_versions VALUES (?,?,?,?,?,?)', randomUUID(), memory.id, this.revision(), canonicalJson(memory), previous ? String(previous.id) : null, Date.now());
  }
  memoryLineage(id: string) {
    return this.rows('SELECT * FROM memory_versions WHERE memory_id=? ORDER BY revision', id).map(row => ({ id: String(row.id), memoryId: String(row.memory_id), revision: Number(row.revision), snapshot: parsed(row.snapshot) as Memory, supersedes: row.supersedes as string | null, createdAt: Number(row.created_at) }));
  }
  getSetting<T = unknown>(key: string): T | undefined {
    const value = this.rows('SELECT value FROM settings WHERE key=?', key)[0]?.value;
    return value === undefined ? undefined : JSON.parse(String(value)) as T;
  }
  setSetting(key: string, value: unknown): void {
    required(key, 'Setting key', 200);
    if (key === 'memory_revision') throw new Error('Memory revision is managed internally');
    assertNoCredentialKeys({ [key]: value });
    this.exec('INSERT INTO settings VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', key, canonicalJson(value));
  }
  addMessage(role: string, content: string, runId?: string): Message {
    if (!['user', 'assistant', 'system', 'tool'].includes(role)) throw new Error('Invalid message role');
    const message = { id: randomUUID(), role, content: required(content, 'Message', 200000), runId: runId ?? null, createdAt: Date.now() };
    this.exec('INSERT INTO messages VALUES (?,?,?,?,?)', message.id, role, message.content, message.runId, message.createdAt);
    return message;
  }
  listMessages(limit = 100): Message[] {
    return this.rows('SELECT * FROM messages ORDER BY created_at DESC,rowid DESC LIMIT ?', limitValue(limit)).reverse().map(row => ({ id: String(row.id), role: String(row.role), content: String(row.content), runId: row.run_id as string | null, createdAt: Number(row.created_at) }));
  }
  private memory(row: Row): Memory {
    return { id: String(row.id), text: String(row.text), kind: row.kind as MemoryKind, source: String(row.source), sourceIds: parsed(row.source_ids), provenance: row.provenance as Memory['provenance'], confidence: Number(row.confidence), createdAt: Number(row.created_at), updatedAt: Number(row.updated_at) };
  }
  listMemories(query?: string): Memory[] {
    const rows = query?.trim() ? this.rows('SELECT * FROM memories WHERE instr(lower(text),lower(?))>0 ORDER BY updated_at DESC LIMIT 100', query.trim()) : this.rows('SELECT * FROM memories ORDER BY updated_at DESC,rowid DESC LIMIT 500');
    return rows.map(row => this.memory(row));
  }
  private validateMemory(input: MemoryInput): void {
    required(input.text, 'Memory', 4000); required(input.source, 'Memory source', 1000);
    if (!['explicit', 'inferred'].includes(input.provenance)) throw new Error('Invalid memory provenance');
    if (input.kind && !['preference', 'project', 'person', 'goal', 'commitment', 'fact'].includes(input.kind)) throw new Error('Invalid memory kind');
    if (input.confidence !== undefined && (!Number.isFinite(input.confidence) || input.confidence < 0 || input.confidence > 1)) throw new Error('Invalid memory confidence');
    if (input.sourceIds && (!input.sourceIds.length || input.sourceIds.some(source => typeof source !== 'string' || !source.trim()))) throw new Error('Invalid memory source IDs');
  }
  saveMemory(input: MemoryInput): Memory {
    this.validateMemory(input);
    return this.tx(() => {
      this.checkRevision(input.expectedRevision);
      const now = Date.now(); const id = randomUUID();
      this.exec('INSERT INTO memories VALUES (?,?,?,?,?,?,?,?,?)', id, input.text.trim(), input.kind ?? 'fact', input.source, JSON.stringify(input.sourceIds ?? [input.source]), input.provenance, input.confidence ?? (input.provenance === 'explicit' ? 1 : 0.7), now, now);
      this.bumpRevision();
      const memory = this.memory(this.rows('SELECT * FROM memories WHERE id=?', id)[0]!);
      this.recordMemoryVersion(memory);
      return memory;
    });
  }
  updateMemory(id: string, patch: Partial<MemoryInput>): Memory {
    return this.tx(() => {
      this.checkRevision(patch.expectedRevision);
      const row = this.rows('SELECT * FROM memories WHERE id=?', id)[0];
      if (!row) throw new Error('Memory not found');
      const current = this.memory(row); const next = { ...current, ...patch };
      this.validateMemory(next);
      if (current.provenance === 'explicit' && next.provenance === 'inferred') throw new Error('Inference cannot replace explicit memory');
      this.exec('UPDATE memories SET text=?,kind=?,source=?,source_ids=?,provenance=?,confidence=?,updated_at=? WHERE id=?', next.text.trim(), next.kind, next.source, JSON.stringify(patch.sourceIds ?? (patch.source ? [patch.source] : current.sourceIds)), next.provenance, next.confidence, Date.now(), id);
      this.bumpRevision(); const memory = this.memory(this.rows('SELECT * FROM memories WHERE id=?', id)[0]!);
      this.recordMemoryVersion(memory); return memory;
    });
  }
  deleteMemory(id: string, expectedRevision?: number): number {
    return this.tx(() => {
      this.checkRevision(expectedRevision);
      const result = this.db.prepare('DELETE FROM memories WHERE id=?').run(id);
      this.exec('DELETE FROM memory_versions WHERE memory_id=?', id);
      if (result.changes) this.bumpRevision();
      return this.revision();
    });
  }
  /** Forget managed derived copies; raw source messages are optional and reported. Not forensic erasure. */
  forgetMemory(id: string, includeSourceMessages = false) {
    return this.tx(() => {
      const row = this.rows('SELECT * FROM memories WHERE id=?', id)[0];
      if (!row) throw new Error('Memory not found');
      const memory = this.memory(row);
      const lineage = this.memoryLineage(id);
      const phrases = new Set([memory.text, ...lineage.map(v => v.snapshot.text)]);
      for (const phrase of phrases) if (this.rows("SELECT id FROM approvals WHERE status='executing' AND (instr(payload,?)>0 OR instr(result,?)>0)", phrase, phrase).length)
        throw new Error('Cannot forget a claim while a related action is executing; wait for the outcome');
      this.exec('DELETE FROM memories WHERE id=?', id);
      this.exec('DELETE FROM memory_versions WHERE memory_id=?', id);
      // Summaries and dream provenance are invalidated as a whole, not patched by the model.
      this.exec("DELETE FROM settings WHERE key IN ('conversationSummary','alignmentSynthesis') OR key LIKE 'dream:%'");
      for (const phrase of phrases) {
        if (!phrase) continue;
        for (const [table, columns] of [['tasks', ['prompt', 'result', 'error']], ['notifications', ['title', 'body']], ['goals', ['title', 'description']]] as const)
          for (const column of columns) this.exec(`UPDATE ${table} SET ${column}=replace(${column},?,'[forgotten]') WHERE instr(${column},?)>0`, phrase, phrase);
        // Drop structured audit copies rather than risk producing malformed JSON by replacement.
        for (const workflow of this.listWorkflows()) {
          const definition = { prompt: workflow.prompt.replaceAll(phrase, '[forgotten]'), output: workflow.output, nodes: workflow.nodes.map(node => ({ ...node, role: node.role.replaceAll(phrase, '[forgotten]'), prompt: node.prompt.replaceAll(phrase, '[forgotten]') })) };
          this.exec('UPDATE workflows SET definition=? WHERE id=?', canonicalJson(definition), workflow.id);
        }
        this.exec('DELETE FROM events WHERE instr(detail,?)>0', phrase);
        this.exec("UPDATE approvals SET status=CASE WHEN status IN ('pending','approved') THEN 'rejected' ELSE status END,payload='{}',result=NULL,summary='Memory-related action redacted',error='Referenced memory forgotten' WHERE instr(payload,?)>0 OR instr(result,?)>0", phrase, phrase);
        for (const goal of this.rows('SELECT id,steps FROM goals')) {
          const steps = parsed(goal.steps) as GoalStep[];
          const redacted = steps.map(step => ({ ...step, title: step.title.replaceAll(phrase, '[forgotten]'), ...(step.result ? { result: step.result.replaceAll(phrase, '[forgotten]') } : {}) }));
          this.exec('UPDATE goals SET steps=? WHERE id=?', canonicalJson(redacted), String(goal.id));
        }
        for (const duplicate of this.rows('SELECT id FROM memories WHERE text=?', phrase)) {
          this.exec('DELETE FROM memory_versions WHERE memory_id=?', String(duplicate.id));
          this.exec('DELETE FROM memories WHERE id=?', String(duplicate.id));
        }
        if (includeSourceMessages) this.exec("UPDATE messages SET content=replace(content,?,'[forgotten]') WHERE instr(content,?)>0", phrase, phrase);
      }
      let removedSourceMessages = 0;
      if (includeSourceMessages) for (const source of new Set([...memory.sourceIds, ...lineage.flatMap(v => v.snapshot.sourceIds)])) {
        const messageId = source.replace(/^message:/, '');
        removedSourceMessages += Number(this.db.prepare('DELETE FROM messages WHERE id=?').run(messageId).changes);
      }
      this.bumpRevision();
      return { revision: this.revision(), forgottenMemoryId: id, removedSourceMessages, rawHistoryRetained: !includeSourceMessages, managedCopiesRemoved: true, limitation: 'Exact recorded claim text and known source IDs only; unrelated paraphrases, backups and external copies are not guaranteed erased.' };
    });
  }
  private goal(row: Row): Goal { return { id: String(row.id), title: String(row.title), description: String(row.description), status: row.status as Goal['status'], steps: parsed(row.steps), createdAt: Number(row.created_at), updatedAt: Number(row.updated_at) }; }
  createGoal(input: { title: string; description?: string; steps?: GoalStep[] }): Goal {
    const now = Date.now(), id = randomUUID();
    this.validateSteps(input.steps ?? []);
    this.exec('INSERT INTO goals VALUES (?,?,?,?,?,?,?)', id, required(input.title, 'Goal title', 200), input.description ?? '', 'active', canonicalJson(input.steps ?? []), now, now);
    return this.goal(this.rows('SELECT * FROM goals WHERE id=?', id)[0]!);
  }
  listGoals(): Goal[] { return this.rows('SELECT * FROM goals ORDER BY updated_at DESC').map(row => this.goal(row)); }
  private validateSteps(steps: GoalStep[]): void {
    if (!Array.isArray(steps) || steps.length > 100) throw new Error('Invalid goal steps');
    const ids = new Set<string>();
    for (const step of steps) {
      required(step.id, 'Step ID', 200); required(step.title, 'Step title', 1000);
      if (ids.has(step.id) || !['pending', 'running', 'completed', 'blocked'].includes(step.status)) throw new Error('Invalid goal step');
      ids.add(step.id);
    }
  }
  updateGoal(id: string, patch: Partial<Pick<Goal, 'title' | 'description' | 'status' | 'steps'>>): Goal {
    const row = this.rows('SELECT * FROM goals WHERE id=?', id)[0]; if (!row) throw new Error('Goal not found');
    const next = { ...this.goal(row), ...patch };
    required(next.title, 'Goal title', 200); this.validateSteps(next.steps);
    if (!['active', 'paused', 'completed', 'cancelled'].includes(next.status)) throw new Error('Invalid goal status');
    this.exec('UPDATE goals SET title=?,description=?,status=?,steps=?,updated_at=? WHERE id=?', next.title, next.description, next.status, canonicalJson(next.steps), Date.now(), id);
    return this.goal(this.rows('SELECT * FROM goals WHERE id=?', id)[0]!);
  }
  private task(row: Row): Task { return { id: String(row.id), prompt: String(row.prompt), kind: row.kind as Task['kind'], parentId: row.parent_id as string | null, goalId: row.goal_id as string | null, status: row.status as TaskStatus, result: row.result as string | null, error: row.error as string | null, attempts: Number(row.attempts), createdAt: Number(row.created_at), updatedAt: Number(row.updated_at) }; }
  createTask(input: TaskInput): Task {
    const id = input.id ?? randomUUID();
    const existing = this.getTask(id);
    if (existing) { if (existing.prompt !== input.prompt || existing.kind !== (input.kind ?? 'task')) throw new Error('Task ID conflicts with another request'); return existing; }
    const now = Date.now();
    if (input.kind && !['task', 'dream', 'goal'].includes(input.kind)) throw new Error('Invalid task kind');
    this.exec('INSERT INTO tasks VALUES (?,?,?,?,?,?,?,?,?,?,?)', id, required(input.prompt, 'Task prompt', 12000), input.kind ?? 'task', input.parentId ?? null, input.goalId ?? null, 'queued', null, null, 0, now, now);
    return this.getTask(id)!;
  }
  getTask(id: string): Task | undefined { const row = this.rows('SELECT * FROM tasks WHERE id=?', id)[0]; return row ? this.task(row) : undefined; }
  createWorkflow(input: unknown): Workflow {
    const definition = validateWorkflow(input), id = `workflow-${randomUUID()}`, createdAt = Date.now();
    return this.tx(() => {
      this.createTask({ id, prompt: definition.prompt });
      for (const node of definition.nodes) this.createTask({ id: workflowTaskId(id, node.id), prompt: node.prompt, parentId: id });
      this.exec('INSERT INTO workflows VALUES (?,?,?)', id, canonicalJson(definition), createdAt);
      return { ...definition, id, createdAt };
    });
  }
  getWorkflow(id: string): Workflow | undefined {
    const row = this.rows('SELECT * FROM workflows WHERE id=?', id)[0];
    return row ? { ...parsed(row.definition), id: String(row.id), createdAt: Number(row.created_at) } as Workflow : undefined;
  }
  listWorkflows(): Workflow[] { return this.rows('SELECT id FROM workflows ORDER BY created_at DESC').map(row => this.getWorkflow(String(row.id))!); }
  workflowTasks(id: string): Task[] { return this.rows('SELECT * FROM tasks WHERE parent_id=? ORDER BY created_at,rowid', id).map(row => this.task(row)); }
  listTasks(limit = 100): Task[] { return this.rows('SELECT * FROM tasks ORDER BY created_at DESC,rowid DESC LIMIT ?', limitValue(limit)).map(row => this.task(row)); }
  updateTask(id: string, patch: Partial<Pick<Task, 'status' | 'result' | 'error' | 'attempts'>>): Task {
    return this.tx(() => {
      const current = this.getTask(id); if (!current) throw new Error('Task not found');
      if (patch.status && patch.status !== current.status) transitionTask(current.status, patch.status);
      if (['completed', 'cancelled'].includes(current.status) && (patch.result !== undefined || patch.error !== undefined)) throw new Error('Terminal task cannot be rewritten');
      const next = { ...current, ...patch };
      if (patch.status === 'running' && current.status !== 'running' && patch.attempts === undefined) next.attempts++;
      if (!Number.isInteger(next.attempts) || next.attempts < 0) throw new Error('Invalid attempt count');
      this.exec('UPDATE tasks SET status=?,result=?,error=?,attempts=?,updated_at=? WHERE id=?', next.status, next.result, next.error, next.attempts, Date.now(), id);
      return this.getTask(id)!;
    });
  }
  recoverInterrupted(maxAttempts = 3): { requeued: number; failed: number; uncertain: number } {
    return this.tx(() => {
      let requeued = 0, failed = 0;
      for (const row of this.rows("SELECT * FROM tasks WHERE status='running' AND id NOT IN (SELECT id FROM workflows)")) {
        const exhausted = Number(row.attempts) >= maxAttempts;
        this.exec('UPDATE tasks SET status=?,error=?,updated_at=? WHERE id=?', exhausted ? 'failed' : 'queued', exhausted ? 'Restart recovery exhausted retry limit' : 'Interrupted run requeued after restart', Date.now(), String(row.id));
        if (exhausted) failed++; else requeued++;
      }
      const uncertain = Number(this.db.prepare("UPDATE approvals SET status='uncertain',error='Process stopped during action; reconcile before retry',updated_at=? WHERE status='executing'").run(Date.now()).changes);
      // A possibly executed action must never cause its owning task to run again automatically.
      const held = Number(this.db.prepare("UPDATE tasks SET status='waiting_approval',error='An action outcome is uncertain; reconcile manually',updated_at=? WHERE id IN (SELECT task_id FROM approvals WHERE status='uncertain') AND status='queued'").run(Date.now()).changes);
      requeued = Math.max(0, requeued - held);
      return { requeued, failed, uncertain };
    });
  }
  private schedule(row: Row): Schedule { return { id: String(row.id), prompt: String(row.prompt), nextRunAt: Number(row.next_run_at), intervalSeconds: row.interval_seconds === null ? null : Number(row.interval_seconds), cron: row.cron as string | null, timezone: String(row.timezone), kind: row.kind as Task['kind'], status: row.status as Schedule['status'], createdAt: Number(row.created_at), updatedAt: Number(row.updated_at) }; }
  saveSchedule(input: ScheduleInput): Schedule {
    const id = input.id ?? randomUUID(), now = Date.now(), next = toTime(input.runAt);
    if (!Number.isFinite(next)) throw new Error('Invalid schedule timestamp');
    if (input.intervalSeconds !== undefined && (!Number.isInteger(input.intervalSeconds) || input.intervalSeconds < 60)) throw new Error('Schedule interval must be at least 60 seconds');
    if (input.cron && input.intervalSeconds !== undefined) throw new Error('Choose cron or interval, not both');
    if (input.kind && !['task', 'dream', 'goal'].includes(input.kind)) throw new Error('Invalid schedule kind');
    new Intl.DateTimeFormat('en', { timeZone: input.timezone ?? 'UTC' }).format();
    this.exec(`INSERT INTO schedules VALUES (?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET prompt=excluded.prompt,next_run_at=excluded.next_run_at,interval_seconds=excluded.interval_seconds,cron=excluded.cron,timezone=excluded.timezone,kind=excluded.kind,status='active',updated_at=excluded.updated_at`, id, required(input.prompt, 'Schedule prompt', 12000), next, input.intervalSeconds ?? null, input.cron ?? null, input.timezone ?? 'UTC', input.kind ?? 'task', 'active', now, now);
    return this.schedule(this.rows('SELECT * FROM schedules WHERE id=?', id)[0]!);
  }
  listSchedules(): Schedule[] { return this.rows('SELECT * FROM schedules ORDER BY next_run_at').map(row => this.schedule(row)); }
  updateSchedule(id: string, patch: Partial<Pick<Schedule, 'nextRunAt' | 'status'>>): Schedule {
    const row = this.rows('SELECT * FROM schedules WHERE id=?', id)[0]; if (!row) throw new Error('Schedule not found');
    const next = { ...this.schedule(row), ...patch };
    if (!Number.isFinite(next.nextRunAt) || !['active', 'paused', 'completed'].includes(next.status)) throw new Error('Invalid schedule update');
    this.exec('UPDATE schedules SET next_run_at=?,status=?,updated_at=? WHERE id=?', next.nextRunAt, next.status, Date.now(), id);
    return this.schedule(this.rows('SELECT * FROM schedules WHERE id=?', id)[0]!);
  }
  deleteSchedule(id: string): void { this.exec('DELETE FROM schedules WHERE id=?', id); }
  /** Recording the occurrence and advancing its schedule share one commit. */
  dispatchOccurrence(scheduleId: string, now: number, nextRunAt: number | null): Task | undefined {
    return this.tx(() => {
      const row = this.rows('SELECT * FROM schedules WHERE id=?', scheduleId)[0];
      if (!row) return undefined;
      const schedule = this.schedule(row);
      if (schedule.status !== 'active' || schedule.nextRunAt > now) return undefined;
      if (nextRunAt !== null && (!Number.isFinite(nextRunAt) || nextRunAt <= schedule.nextRunAt)) throw new Error('Next occurrence must advance the schedule');
      const task = this.createTask({ id: `schedule-${schedule.id}-${schedule.nextRunAt}`, prompt: schedule.prompt, kind: schedule.kind });
      this.exec('UPDATE schedules SET next_run_at=?,status=?,updated_at=? WHERE id=?', nextRunAt ?? schedule.nextRunAt, nextRunAt === null ? 'completed' : 'active', Date.now(), scheduleId);
      return task;
    });
  }
  private approval(row: Row): Approval { return { id: String(row.id), taskId: row.task_id as string | null, kind: String(row.kind), payload: parsed(row.payload), summary: String(row.summary), digest: String(row.digest), status: row.status as ApprovalStatus, expiresAt: Number(row.expires_at), result: parsed(row.result), error: row.error as string | null, createdAt: Number(row.created_at), updatedAt: Number(row.updated_at) }; }
  createApproval(input: ApprovalInput): Approval {
    const id = randomUUID(), now = Date.now(), expiresAt = input.expiresAt === undefined ? now + 3600000 : toTime(input.expiresAt);
    if (!Number.isFinite(expiresAt) || expiresAt <= now) throw new Error('Approval expiry must be in the future');
    const kind = required(input.kind, 'Action kind', 200), summary = required(input.summary, 'Action summary', 2000);
    const payload = canonicalJson(input.payload);
    const digest = createHash('sha256').update(canonicalJson({ kind, payload: input.payload, summary, taskId: input.taskId ?? null, expiresAt })).digest('hex');
    this.exec('INSERT INTO approvals VALUES (?,?,?,?,?,?,?,?,?,?,?,?)', id, input.taskId ?? null, kind, payload, summary, digest, 'pending', expiresAt, null, null, now, now);
    return this.getApproval(id)!;
  }
  getApproval(id: string): Approval | undefined { const row = this.rows('SELECT * FROM approvals WHERE id=?', id)[0]; return row ? this.approval(row) : undefined; }
  listApprovals(limit = 100): Approval[] { return this.rows('SELECT * FROM approvals ORDER BY created_at DESC,rowid DESC LIMIT ?', limitValue(limit)).map(row => this.approval(row)); }
  decideApproval(id: string, decision: 'approved' | 'rejected', expectedDigest: string): Approval {
    if (!['approved', 'rejected'].includes(decision)) throw new Error('Invalid approval decision');
    const current = this.getApproval(id); if (!current) throw new Error('Approval not found');
    if (current.digest !== expectedDigest) throw new Error('Approval digest mismatch');
    if (current.status !== 'pending') throw new Error('Approval is no longer pending');
    if (current.expiresAt <= Date.now()) { this.exec("UPDATE approvals SET status='expired',updated_at=? WHERE id=? AND status='pending'", Date.now(), id); throw new Error('Approval expired'); }
    const changed = this.db.prepare("UPDATE approvals SET status=?,updated_at=? WHERE id=? AND status='pending'").run(decision, Date.now(), id).changes;
    if (!changed) throw new Error('Approval is no longer pending');
    return this.getApproval(id)!;
  }
  claimExecution(id: string): Approval {
    const current = this.getApproval(id); if (!current) throw new Error('Approval not found');
    if (current.status !== 'approved') throw new Error('Action is not approved or already claimed');
    if (current.expiresAt <= Date.now()) { this.exec("UPDATE approvals SET status='expired',updated_at=? WHERE id=? AND status='approved'", Date.now(), id); throw new Error('Approval expired'); }
    const changed = this.db.prepare("UPDATE approvals SET status='executing',updated_at=? WHERE id=? AND status='approved'").run(Date.now(), id).changes;
    if (!changed) throw new Error('Action already claimed');
    return this.getApproval(id)!;
  }
  completeAction(id: string, outcome: { result?: unknown; error?: string }): Approval {
    const current = this.getApproval(id); if (!current || current.status !== 'executing') throw new Error('Action is not executing');
    this.exec("UPDATE approvals SET status=?,result=?,error=?,updated_at=? WHERE id=? AND status='executing'", outcome.error ? 'failed' : 'completed', outcome.result === undefined ? null : canonicalJson(outcome.result), outcome.error ?? null, Date.now(), id);
    return this.getApproval(id)!;
  }
  /** Network/process errors after dispatch do not prove the external write failed. */
  markActionUncertain(id: string, error: string): Approval {
    const current = this.getApproval(id);
    if (!current) throw new Error('Approval not found');
    if (current.status === 'uncertain') return current;
    if (current.status !== 'executing') throw new Error('Only an executing action can become uncertain');
    const changed = this.db.prepare("UPDATE approvals SET status='uncertain',error=?,updated_at=? WHERE id=? AND status='executing'").run(required(error, 'Action error', 4000), Date.now(), id).changes;
    if (!changed) throw new Error('Action is no longer executing');
    return this.getApproval(id)!;
  }
  reconcileAction(id: string, outcome: 'completed' | 'failed', result: string): Approval {
    const current = this.getApproval(id);
    if (!current || current.status !== 'uncertain') throw new Error('Only an uncertain action can be reconciled');
    if (!['completed', 'failed'].includes(outcome)) throw new Error('Invalid reconciliation outcome');
    const note = required(result, 'Reconciliation evidence', 4000);
    this.exec("UPDATE approvals SET status=?,result=?,error=?,updated_at=? WHERE id=? AND status='uncertain'", outcome, canonicalJson({ verifiedBy: 'user', note }), outcome === 'failed' ? 'User confirmed action did not complete' : null, Date.now(), id);
    return this.getApproval(id)!;
  }
  addNotification(input: { title: string; body: string; taskId?: string; dedupeKey?: string }): Notification {
    if (input.dedupeKey) { const existing = this.rows('SELECT * FROM notifications WHERE dedupe_key=?', input.dedupeKey)[0]; if (existing) return this.notification(existing); }
    const id = randomUUID();
    this.exec('INSERT INTO notifications VALUES (?,?,?,?,?,?,?)', id, required(input.title, 'Notification title', 300), required(input.body, 'Notification body', 12000), input.taskId ?? null, input.dedupeKey ?? null, null, Date.now());
    return this.notification(this.rows('SELECT * FROM notifications WHERE id=?', id)[0]!);
  }
  private notification(row: Row): Notification { return { id: String(row.id), title: String(row.title), body: String(row.body), taskId: row.task_id as string | null, dedupeKey: row.dedupe_key as string | null, readAt: row.read_at === null ? null : Number(row.read_at), createdAt: Number(row.created_at) }; }
  listNotifications(limit = 100): Notification[] { return this.rows('SELECT * FROM notifications ORDER BY created_at DESC,rowid DESC LIMIT ?', limitValue(limit)).map(row => this.notification(row)); }
  markRead(id: string): void { this.exec('UPDATE notifications SET read_at=COALESCE(read_at,?) WHERE id=?', Date.now(), id); }
  appendEvent(type: string, detail: unknown = {}, taskId?: string): Event {
    const event = { id: randomUUID(), type: required(type, 'Event type', 200), detail, taskId: taskId ?? null, createdAt: Date.now() };
    this.exec('INSERT INTO events VALUES (?,?,?,?,?)', event.id, event.type, event.taskId, canonicalJson(detail), event.createdAt); return event;
  }
  listEvents(limit = 100): Event[] { return this.rows('SELECT * FROM events ORDER BY created_at DESC,rowid DESC LIMIT ?', limitValue(limit)).map(row => ({ id: String(row.id), type: String(row.type), taskId: row.task_id as string | null, detail: parsed(row.detail), createdAt: Number(row.created_at) })); }
  private usage(row: Row): Usage { return { runId: String(row.run_id), day: String(row.day), reservedTokens: Number(row.reserved_tokens), inputTokens: Number(row.input_tokens), outputTokens: Number(row.output_tokens), status: row.status as Usage['status'], createdAt: Number(row.created_at), updatedAt: Number(row.updated_at) }; }
  reserveUsage(runId: string, limit: number, reserveTokens: number): Usage {
    if (!Number.isSafeInteger(limit) || limit < 1 || !Number.isSafeInteger(reserveTokens) || reserveTokens < 1) throw new Error('Invalid token budget');
    return this.tx(() => {
      if (this.rows('SELECT * FROM usage WHERE run_id=?', runId).length) throw new Error('Run usage already exists; use a distinct attempt ID');
      const now = Date.now(), day = new Date(now).toISOString().slice(0, 10);
      const used = Number(this.rows("SELECT COALESCE(SUM(CASE WHEN status='reserved' THEN reserved_tokens ELSE input_tokens+output_tokens END),0) AS used FROM usage WHERE day=?", day)[0]!.used);
      if (used + reserveTokens > limit) throw new Error('Daily token budget exceeded');
      this.exec('INSERT INTO usage VALUES (?,?,?,?,?,?,?,?)', required(runId, 'Run ID', 200), day, reserveTokens, 0, 0, 'reserved', now, now);
      return this.usage(this.rows('SELECT * FROM usage WHERE run_id=?', runId)[0]!);
    });
  }
  hasUsageCapacity(limit: number, reserveTokens: number): boolean {
    const day = new Date().toISOString().slice(0, 10);
    const used = Number(this.rows("SELECT COALESCE(SUM(CASE WHEN status='reserved' THEN reserved_tokens ELSE input_tokens+output_tokens END),0) AS used FROM usage WHERE day=?", day)[0]!.used);
    return used + reserveTokens <= limit;
  }
  finishUsage(runId: string, inputTokens: number, outputTokens: number): Usage {
    if (![inputTokens, outputTokens].every(value => Number.isSafeInteger(value) && value >= 0)) throw new Error('Invalid usage counts');
    const row = this.rows('SELECT * FROM usage WHERE run_id=?', runId)[0]; if (!row) throw new Error('Usage reservation missing');
    if (row.status !== 'reserved') throw new Error('Usage reservation already settled');
    this.exec("UPDATE usage SET input_tokens=?,output_tokens=?,status='completed',updated_at=? WHERE run_id=? AND status='reserved'", inputTokens, outputTokens, Date.now(), runId);
    return this.usage(this.rows('SELECT * FROM usage WHERE run_id=?', runId)[0]!);
  }
  /** Unknown usage retains the reservation conservatively; it is not refunded. */
  failUsage(runId: string): void {
    this.exec("UPDATE usage SET input_tokens=reserved_tokens,output_tokens=0,status='failed',updated_at=? WHERE run_id=? AND status='reserved'", Date.now(), runId);
  }
  listUsage(limit = 100): Usage[] { return this.rows('SELECT * FROM usage ORDER BY created_at DESC,rowid DESC LIMIT ?', limitValue(limit)).map(row => this.usage(row)); }
}
