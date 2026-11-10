import { randomUUID, createHash, timingSafeEqual } from 'node:crypto';
import { resolve } from 'node:path';
import { LocalStore, type Task, type GoalStep, type Approval, type MemoryKind } from './store.ts';
import { BrowserService } from './browser.ts';
import { GoogleConnector } from './connectors.ts';
import { WorkspaceService } from './workspace.ts';
import { nextCronTime, nextIntervalTime } from './scheduling.ts';
import { runAssistant, type AgentCapabilities } from '../agent.ts';
import { buildContext, validateSchedule } from '../domain.ts';
import type { LocalConfig } from './config.ts';
import { syncMemoryFiles } from './memory-files.ts';
import { selectProactiveUpdate } from './proactivity.ts';
import { researchWorkflow, workflowTaskId, type Workflow } from './workflows.ts';

type Data = Record<string, unknown>;
type Runner = typeof runAssistant;
const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
const string = (value: unknown, fallback = '') => typeof value === 'string' ? value : fallback;
const safeError = (error: unknown) => {
  const message = error instanceof Error ? error.message : 'Operation failed';
  return message.replace(/sk-[A-Za-z0-9_-]+/g, '[redacted]').replace(/Bearer\s+\S+/gi, 'Bearer [redacted]').slice(0, 800);
};
const writes = new Set(['browser.click', 'browser.fill', 'gmail.send', 'calendar.create', 'workspace.execute', 'skill.save']);
const readOnlyOperations = new Set(['browser_read', 'memory_search', 'skills', 'gmail_read', 'calendar_read']);

/** Local control plane. Models can propose actions; this broker owns authorization. */
export class LocalRuntime {
  readonly instanceId = randomUUID();
  readonly config: LocalConfig;
  readonly store: LocalStore;
  readonly browser: BrowserService;
  readonly google: GoogleConnector;
  readonly workspace: WorkspaceService;
  private runner: Runner;
  private ticking = false;
  private active = new Set<string>();
  private chatBusy = false;
  private timer?: ReturnType<typeof setInterval>;
  private stopping = false;
  private privacyEpoch = 0;
  private controllers = new Map<string, AbortController>();
  private projection: Promise<unknown> = Promise.resolve();

  constructor(config: LocalConfig, options: { store?: LocalStore; runner?: Runner; browser?: BrowserService } = {}) {
    this.config = config;
    if (config.token.length < 24) throw new Error('HARNESS_TOKEN must have at least 24 characters');
    if (![config.dailyTokenLimit, config.runTokenReservation].every(n => Number.isSafeInteger(n) && n > 0)) throw new Error('Token limits must be positive integers');
    this.store = options.store ?? new LocalStore(resolve(config.dataDir, 'assistant.sqlite'));
    this.runner = options.runner ?? runAssistant;
    this.browser = options.browser ?? new BrowserService({ profileDir: resolve(config.dataDir, 'browser-profile'), executablePath: config.browserExecutable, channel: config.browserChannel });
    this.google = new GoogleConnector({ clientId: config.googleClientId, clientSecret: config.googleClientSecret, redirectUri: `http://127.0.0.1:${config.port}/oauth/google/callback`, vaultPath: resolve(config.dataDir, 'credentials', 'google.enc'), encryptionSecret: config.encryptionSecret });
    this.workspace = new WorkspaceService(resolve(config.dataDir, 'workspace'), { dockerEnabled: config.dockerEnabled, dockerImage: config.dockerImage });
    this.store.appendEvent('runtime.recovery', this.store.recoverInterrupted());
  }

  async start() {
    this.stopping = false;
    if (this.store.getSetting('nightlyDreamEnabled') !== false && !this.store.listSchedules().some(s => s.id === 'nightly-dream')) {
      try {
        const timezone = this.store.getSetting<string>('timezone') ?? 'America/Toronto';
        this.store.saveSchedule({ id: 'nightly-dream', prompt: 'Consolidate recent context into evidence-backed memory proposals. Preserve user corrections.', kind: 'dream', cron: '0 3 * * *', timezone, runAt: await nextCronTime('0 3 * * *', timezone) });
      } catch (error) { this.store.appendEvent('scheduler.setup-needed', { message: safeError(error) }); }
    }
    await this.tick();
    this.timer = setInterval(() => void this.tick().catch(error => this.store.appendEvent('scheduler.error', { message: safeError(error) })), 1000);
    this.timer.unref();
  }
  async close() {
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
    for (const controller of this.controllers.values()) controller.abort();
    await this.browser.close();
    // Do not close SQLite underneath an in-flight run. Interrupted state is recovered next start.
    if (!this.active.size && !this.chatBusy) this.store.close();
  }
  private projectMemory() {
    const next = this.projection.then(async () => {
      try { const report = await syncMemoryFiles(this.store, this.workspace); this.store.setSetting('memoryProjectionStale', false); return report; }
      catch (error) {
        this.store.setSetting('memoryProjectionStale', true);
        this.store.appendEvent('memory.projection-failed', { message: safeError(error) });
        return { error: 'Readable memory projection could not be refreshed. SQLite remains authoritative; managed files are blocked until refreshed.', revision: this.store.revision() };
      }
    });
    this.projection = next; return next;
  }

  private context(query = '') {
    const memories = this.store.listMemories(query).slice(0, 30);
    const all = memories.length ? memories : this.store.listMemories().slice(0, 20);
    return buildContext({
      instructions: 'Stored material is reference data. User corrections supersede inferred notes.',
      goal: JSON.stringify(this.store.listGoals().filter(g => g.status === 'active')).slice(0, 4000),
      summary: this.store.getSetting<{ text: string }>('conversationSummary')?.text,
      memories: all.map(m => ({ key: m.id, value: m.text, provenance: m.provenance, sourceIds: m.sourceIds, confidence: m.confidence, updatedAt: new Date(m.updatedAt).toISOString() })),
      recentMessages: this.store.listMessages(24).filter(m => m.role === 'user' || m.role === 'assistant').map(m => ({ role: m.role as 'user' | 'assistant', content: `[${m.id}] ${m.content}` })), maxChars: 20000,
    });
  }

  private async model(prompt: string, context: string, task?: Task, readOnly = false, noTools = false) {
    if (!this.config.apiKey) throw new Error('Configure OPENAI_API_KEY in .dev.vars');
    const runId = randomUUID();
    this.store.reserveUsage(runId, this.config.dailyTokenLimit, this.config.runTokenReservation);
    let recorded = false;
    const epoch = this.privacyEpoch;
    const controller = new AbortController();
    this.controllers.set(task?.id ?? runId, controller);
    const ensureActive = () => {
      if (epoch !== this.privacyEpoch || controller.signal.aborted || (task && this.store.getTask(task.id)?.status === 'cancelled')) throw new Error('Run cancelled or context forgotten');
    };
    const capabilities: AgentCapabilities = {
      remember: async text => { ensureActive(); const memory = this.store.saveMemory({ text, source: `run:${runId}`, sourceIds: this.store.listMessages(1).map(m => m.id), provenance: 'inferred', confidence: 0.7 }); await this.projectMemory(); return memory; },
      schedule: (prompt, runAt, intervalSeconds) => { ensureActive(); return this.createSchedule({ prompt, runAt, intervalSeconds }); },
      operate: noTools ? undefined : (operation, args) => { ensureActive(); return this.operate(operation, JSON.parse(args) as Data, task, readOnly); },
      readOnly,
      webSearch: !noTools,
      signal: controller.signal,
      onEvidence: urls => this.store.appendEvent('source.observed', { urls, observedAt: Date.now() }, task?.id),
      onUsage: (input, output) => { this.store.finishUsage(runId, input, output); recorded = true; },
    };
    try {
      this.store.appendEvent('run.started', { runId, model: this.config.model, readOnly }, task?.id);
      const result = await this.runner({ OPENAI_API_KEY: this.config.apiKey, OPENAI_MODEL: this.config.model }, prompt, context, capabilities);
      ensureActive();
      if (!recorded) this.store.failUsage(runId);
      this.store.appendEvent('run.completed', { runId }, task?.id);
      return result;
    } catch (error) {
      if (!recorded) this.store.failUsage(runId);
      this.store.appendEvent('run.failed', { runId, message: safeError(error) }, task?.id);
      throw error;
    } finally { this.controllers.delete(task?.id ?? runId); }
  }

  private async operate(operation: string, args: Data, task?: Task, readOnly = false): Promise<unknown> {
    if (readOnly && !readOnlyOperations.has(operation) && !(operation === 'files' && ['list', 'read'].includes(string(args.action)))) throw new Error('This reflection/subtask is read-only');
    this.store.appendEvent('tool.requested', { operation, action: args.action ?? null }, task?.id);
    switch (operation) {
      case 'workflow': {
        if (task?.parentId) throw new Error('Child agents cannot create workflows');
        if (args.action === 'list') return { workflows: this.store.listWorkflows().map(workflow => this.workflowView(workflow)) };
        if (args.action !== 'create') throw new Error('Unknown workflow action');
        return this.createWorkflow(args);
      }
      case 'browser_read': {
        if ((await this.browser.status()).manualControl) throw new Error('Browser is under manual user control. Wait for the user to return control.');
        if (args.action === 'tabs') return { tabs: await this.browser.tabs() };
        const result = args.action === 'navigate' ? await this.browser.navigate(string(args.url)) : await this.browser.snapshot(string(args.tabId));
        this.store.appendEvent('source.observed', { urls: [result.url], observedAt: Date.now() }, task?.id);
        return result;
      }
      case 'memory_search': return { memories: this.store.listMemories(string(args.query)), revision: this.store.revision() };
      case 'goals': {
        if (args.action === 'create') return this.store.createGoal({ title: string(args.title), description: string(args.description), steps: this.steps(args.steps).map(step => ({ ...step, status: 'pending' })) });
        if (args.action === 'update') {
          if (args.status === 'completed' || this.steps(args.steps).some(step => step.status === 'completed')) throw new Error('Goal completion requires evidence through complete_goal_step or a direct user decision');
          return this.store.updateGoal(string(args.id), { ...(args.status ? { status: args.status as 'active' } : {}), ...(args.steps ? { steps: this.steps(args.steps) } : {}) });
        }
        return { goals: this.store.listGoals() };
      }
      case 'complete_goal_step': {
        const goal = this.store.listGoals().find(g => g.id === args.goalId);
        if (!goal) throw new Error('Goal not found');
        if (!task || task.goalId !== goal.id || !goal.steps.some(step => step.id === args.stepId)) throw new Error('Only the owning goal task can complete an existing step');
        if (!string(args.result).trim()) throw new Error('Step completion requires a result with supporting evidence');
        const evidence = this.store.listEvents(500).filter(event => event.taskId === task.id && ['source.observed', 'artifact.written'].includes(event.type));
        const references = evidence.flatMap(event => { const detail = event.detail as Data; return Array.isArray(detail.urls) ? detail.urls.map(String) : detail.path ? [String(detail.path)] : []; });
        if (!references.some(reference => string(args.result).includes(reference))) throw new Error('Step result must cite a source or artifact actually observed during this task');
        return this.store.updateGoal(goal.id, { steps: goal.steps.map(s => s.id === args.stepId ? { ...s, status: 'completed', result: string(args.result) } : s) });
      }
      case 'files': {
        if (args.action === 'write') {
          if (string(args.path).startsWith('memory/')) throw new Error('Managed memory files must be edited through memory operations');
          const result = await this.workspace.write(string(args.path), string(args.content));
          this.store.appendEvent('artifact.written', result, task?.id); return result;
        }
        if (args.action === 'read') { this.checkMemoryFile(string(args.path)); return this.workspace.read(string(args.path)); }
        return { entries: await this.workspace.list(string(args.path)) };
      }
      case 'skills': return args.action === 'read' ? this.workspace.readSkill(string(args.name)) : { skills: await this.workspace.listSkills() };
      case 'gmail_read': return args.action === 'read' ? this.google.readMail(string(args.id)) : this.google.listMail(string(args.query), 10);
      case 'calendar_read': return this.google.listEvents(string(args.start), string(args.end));
      case 'propose_action': return this.proposeAction(string(args.kind), args.payload as Data, string(args.summary), task?.id);
      case 'delegate': {
        if (!task || task.parentId) throw new Error('Only a top-level background task can delegate');
        const children = this.store.listTasks(500).filter(t => t.parentId === task.id);
        if (children.length >= 3) throw new Error('Subtask limit reached');
        return this.store.createTask({ prompt: string(args.prompt), parentId: task.id, kind: 'task' });
      }
      case 'notify': return this.store.addNotification({ title: string(args.title), body: string(args.body), taskId: task?.id, dedupeKey: `agent:${task?.id ?? 'chat'}:${createHash('sha256').update(string(args.body)).digest('hex')}` });
      case 'schedule_cron': return this.createSchedule(args);
      default: throw new Error('Unknown capability');
    }
  }

  private steps(value: unknown): GoalStep[] {
    if (!Array.isArray(value)) return [];
    return value.map(step => typeof step === 'string' ? { id: randomUUID(), title: step, status: 'pending' } : step as GoalStep);
  }
  private checkMemoryFile(path: string) {
    if (path.startsWith('memory/') && this.store.getSetting('memoryProjectionStale')) throw new Error('Managed memory files are stale; refresh the memory projection first');
  }
  private async createSchedule(body: Data) {
    const timezone = string(body.timezone, this.store.getSetting<string>('timezone') ?? 'America/Toronto');
    const cron = string(body.cron) || undefined;
    const runAt = cron ? await nextCronTime(cron, timezone) : string(body.runAt);
    if (!cron) validateSchedule({ task: string(body.prompt), timezone, runAt: String(runAt) });
    const schedule = this.store.saveSchedule({ prompt: string(body.prompt), runAt, timezone, cron, intervalSeconds: body.intervalSeconds === undefined ? undefined : Number(body.intervalSeconds), kind: body.kind === 'dream' ? 'dream' : 'task' });
    this.store.setSetting(`deliveryPolicy:${schedule.id}`, body.deliveryPolicy === 'changes' ? 'changes' : 'every');
    return schedule;
  }

  private async proposeAction(kind: string, payload: Data, summary: string, taskId?: string) {
    if (!writes.has(kind) || !payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('Unsupported action payload');
    if (JSON.stringify(payload).length > 16000) throw new Error('Action is too large');
    // Bind browser approval to the exact current page, not merely a mutable tab ID.
    if (kind.startsWith('browser.')) {
      const tab = (await this.browser.tabs()).find(t => t.id === payload.tabId);
      if (!tab) throw new Error('Browser tab missing');
      if (payload.expectedUrl && payload.expectedUrl !== tab.url) throw new Error('Browser page changed; inspect it again');
      payload = { ...payload, expectedUrl: tab.url };
    }
    const pending = this.store.listApprovals().find(a => a.status === 'pending' && a.taskId === (taskId ?? null) && a.kind === kind && JSON.stringify(a.payload) === JSON.stringify(payload));
    if (pending) return pending;
    const approval = this.store.createApproval({ taskId, kind, payload, summary: summary || `Review ${kind}` });
    this.store.addNotification({ title: 'Approval needed', body: approval.summary, taskId, dedupeKey: `approval:${approval.id}` });
    return approval;
  }

  private async executeAction(approval: Approval) {
    const claimed = this.store.claimExecution(approval.id);
    const p = claimed.payload as Data;
    this.store.appendEvent('action.started', { approvalId: claimed.id, kind: claimed.kind }, claimed.taskId ?? undefined);
    try {
      let result: unknown;
      if (claimed.kind.startsWith('browser.')) {
        if ((await this.browser.status()).manualControl) throw new Error('Browser is under manual control');
        const tab = (await this.browser.tabs()).find(t => t.id === p.tabId);
        if (!tab || tab.url !== p.expectedUrl) throw new Error('Browser page changed; create a new approval');
        result = claimed.kind === 'browser.click' ? await this.browser.click(string(p.tabId), string(p.selector)) : await this.browser.fill(string(p.tabId), string(p.selector), string(p.value));
      } else if (claimed.kind === 'gmail.send') result = await this.google.sendMail({ to: string(p.to), subject: string(p.subject), body: string(p.body) });
      else if (claimed.kind === 'calendar.create') result = await this.google.createEvent({ summary: string(p.summary), start: string(p.start), end: string(p.end), timeZone: string(p.timeZone, 'America/Toronto') });
      else if (claimed.kind === 'workspace.execute') {
        if (this.store.getSetting('memoryProjectionStale')) throw new Error('Refresh stale managed memory files before script execution');
        result = await this.workspace.executeScript({ path: string(p.path), language: p.language as 'python' | 'node', args: Array.isArray(p.args) ? p.args.map(String) : [] });
      }
      else if (claimed.kind === 'skill.save') result = await this.workspace.saveSkill(string(p.name), string(p.content));
      else throw new Error('Unsupported approved action');
      const completed = this.store.completeAction(claimed.id, { result: result ?? { ok: true } });
      this.store.appendEvent('action.completed', { approvalId: claimed.id, result: result ?? null }, claimed.taskId ?? undefined);
      this.store.addNotification({ title: 'Action completed', body: claimed.summary, taskId: claimed.taskId ?? undefined, dedupeKey: `action:${claimed.id}` });
      this.resumeTask(claimed.taskId);
      return completed;
    } catch (error) {
      const message = `Action outcome needs review: ${safeError(error)}. Reconcile with the destination before retrying.`;
      const uncertain = this.store.markActionUncertain(claimed.id, message);
      this.store.appendEvent('action.uncertain', { approvalId: claimed.id, message }, claimed.taskId ?? undefined);
      this.store.addNotification({ title: 'Action needs review', body: message, taskId: claimed.taskId ?? undefined, dedupeKey: `uncertain:${claimed.id}` });
      return uncertain;
    }
  }
  private resumeTask(id: string | null) {
    if (!id) return;
    const task = this.store.getTask(id);
    const blocked = this.store.listApprovals().some(a => a.taskId === id && ['pending', 'approved', 'executing', 'uncertain'].includes(a.status));
    if (task?.status === 'waiting_approval' && !blocked) this.store.updateTask(id, { status: 'queued' });
  }
  private cancelTask(id: string) {
    const candidate = this.store.getTask(id);
    if (candidate?.parentId && this.store.getWorkflow(candidate.parentId)) id = candidate.parentId;
    const root = this.store.getTask(id);
    if (!root) throw new Error('Task not found');
    const ids = new Set([id]);
    const tasks = this.store.getWorkflow(id) ? this.store.workflowTasks(id) : this.store.listTasks(1000);
    for (let n = 0; n < tasks.length; n++) for (const task of tasks) if (task.parentId && ids.has(task.parentId)) ids.add(task.id);
    for (const taskId of ids) {
      const task = this.store.getTask(taskId)!;
      if (!['completed', 'cancelled'].includes(task.status)) this.store.updateTask(taskId, { status: 'cancelled' });
      this.controllers.get(taskId)?.abort();
      for (const approval of this.store.listApprovals().filter(a => a.taskId === taskId && a.status === 'pending')) this.store.decideApproval(approval.id, 'rejected', approval.digest);
    }
    return this.store.getTask(id);
  }

  private workflowView(workflow: Workflow) {
    return { ...workflow, ...this.store.getTask(workflow.id), nodes: workflow.nodes.map(node => ({ ...node, task: this.store.getTask(workflowTaskId(workflow.id, node.id)) })) };
  }
  private createWorkflow(body: Data) {
    if (this.store.listWorkflows().filter(w => ['queued', 'running'].includes(this.store.getTask(w.id)!.status)).length >= 5) throw new Error('Too many active workflows');
    const definition = body.nodes === undefined ? researchWorkflow(string(body.prompt), body.specialists as { role: string; prompt: string }[] | undefined) : body;
    const workflow = this.store.createWorkflow(definition);
    this.store.appendEvent('workflow.created', { nodes: workflow.nodes.map(node => ({ id: node.id, role: node.role, dependsOn: node.dependsOn })) }, workflow.id);
    return this.workflowView(workflow);
  }
  private retryWorkflow(id: string) {
    const workflow = this.store.getWorkflow(id); if (!workflow) throw new Error('Workflow not found');
    const root = this.store.getTask(id)!;
    if (root.status !== 'failed') throw new Error('Only a failed workflow can retry');
    const tasks = this.store.workflowTasks(id);
    if (tasks.some(task => this.active.has(task.id))) throw new Error('Workflow agents are still finishing');
    if (tasks.some(task => task.status === 'cancelled')) throw new Error('Cancelled workflow agents cannot retry');
    if (tasks.some(task => task.status === 'failed' && task.attempts >= 3)) throw new Error('Workflow retry limit reached');
    for (const task of tasks.filter(task => task.status === 'failed')) this.store.updateTask(task.id, { status: 'queued', error: null });
    this.store.updateTask(id, { status: 'queued', error: null });
    this.store.appendEvent('workflow.retry', { reusedCompletedStages: tasks.filter(task => task.status === 'completed').length }, id);
    return this.workflowView(workflow);
  }
  private advanceWorkflows() {
    for (const workflow of this.store.listWorkflows()) {
      const root = this.store.getTask(workflow.id)!;
      if (root.status === 'cancelled') { this.cancelTask(root.id); continue; }
      if (!['queued', 'running'].includes(root.status)) continue;
      if (root.status === 'queued') this.store.updateTask(root.id, { status: 'running' });
      const tasks = this.store.workflowTasks(root.id);
      const failed = tasks.find(task => task.status === 'failed' || task.status === 'cancelled');
      if (failed) {
        this.store.updateTask(root.id, { status: 'failed', error: `Agent ${failed.id.split(':').at(-1)} ${failed.status}: ${failed.error ?? 'no result'}` });
        this.store.appendEvent('workflow.failed', { agentTaskId: failed.id }, root.id);
        continue;
      }
      const output = this.store.getTask(workflowTaskId(root.id, workflow.output))!;
      if (tasks.every(task => task.status === 'completed')) {
        this.store.updateTask(root.id, { status: 'completed', result: output.result, error: null });
        this.store.appendEvent('workflow.completed', { outputTaskId: output.id }, root.id);
      }
    }
    // Idempotent receipt repair if the process stopped after saving completion.
    for (const workflow of this.store.listWorkflows()) {
      const root = this.store.getTask(workflow.id)!;
      if (root.status === 'failed') this.store.addNotification({ title: 'Workflow needs attention', body: 'An agent failed. Review its error and retry the workflow to reuse completed stages.', taskId: root.id, dedupeKey: `workflow-failed:${root.id}:${root.attempts}` });
      if (root.status === 'completed') this.store.addNotification({ title: 'Workflow completed', body: root.result?.slice(0, 12000) || 'Workflow completed with no text output. Inspect the agent results.', taskId: root.id, dedupeKey: `workflow-completed:${root.id}` });
    }
  }
  private workflowReady(task: Task): boolean {
    if (this.store.getWorkflow(task.id)) return false;
    const workflow = task.parentId ? this.store.getWorkflow(task.parentId) : undefined;
    if (!workflow) return true;
    if (this.store.getTask(workflow.id)?.status !== 'running') return false;
    const node = workflow.nodes.find(node => workflowTaskId(workflow.id, node.id) === task.id);
    return Boolean(node && node.dependsOn.every(id => this.store.getTask(workflowTaskId(workflow.id, id))?.status === 'completed'));
  }

  async tick(now = Date.now()) {
    if (this.ticking || this.stopping) return;
    this.ticking = true;
    try {
      for (const schedule of this.store.listSchedules().filter(s => s.status === 'active' && s.nextRunAt <= now).slice(0, 20)) {
        const next = schedule.cron ? await nextCronTime(schedule.cron, schedule.timezone, new Date(now)) : schedule.intervalSeconds ? nextIntervalTime(schedule.nextRunAt, schedule.intervalSeconds, now) : null;
        this.store.dispatchOccurrence(schedule.id, now, next);
      }
      // Two background runs; a shared model usage reservation bounds their aggregate admission.
      this.advanceWorkflows();
      const candidates = new Map(this.store.listTasks(500).reverse().map(task => [task.id, task]));
      for (const workflow of this.store.listWorkflows()) for (const task of this.store.workflowTasks(workflow.id)) candidates.set(task.id, task);
      for (const task of [...candidates.values()].filter(t => t.status === 'queued' && this.workflowReady(t))) {
        if (this.active.size >= 2) break;
        // Wait for in-flight reservations to settle instead of failing a parallel
        // sibling merely because the budget currently admits one run at a time.
        if ((this.active.size || this.chatBusy) && !this.store.hasUsageCapacity(this.config.dailyTokenLimit, this.config.runTokenReservation)) break;
        if (!this.active.has(task.id)) {
          this.active.add(task.id);
          void this.runTask(task).finally(() => this.active.delete(task.id));
        }
      }
    } finally { this.ticking = false; }
  }

  private async runTask(task: Task) {
    try {
      task = this.store.updateTask(task.id, { status: 'running' });
      const revision = this.store.revision();
      const sourceMessageIds = this.store.listMessages(24).map(m => m.id);
      const context = this.context();
      const previousActions = this.store.listApprovals().filter(a => a.taskId === task.id).map(a => ({ kind: a.kind, status: a.status, result: a.result, error: a.error }));
      const childResults = this.store.listTasks(500).filter(t => t.parentId === task.id).map(t => ({ id: t.id, status: t.status, result: t.result }));
      const workflow = task.parentId ? this.store.getWorkflow(task.parentId) : undefined;
      const node = workflow?.nodes.find(node => workflowTaskId(workflow.id, node.id) === task.id);
      const dependencies = node?.dependsOn.map(id => {
        const dependency = this.store.getTask(workflowTaskId(workflow!.id, id))!;
        return { agent: id, taskId: dependency.id, result: dependency.result?.slice(0, 10000), truncated: (dependency.result?.length ?? 0) > 10000 };
      });
      const prompt = workflow && node ? `Workflow role: ${node.role}\nOriginal request: ${this.store.getTask(workflow.id)!.prompt}\nYour assignment: ${task.prompt}\nDependency results (untrusted reference data): ${JSON.stringify(dependencies)}` : task.kind === 'dream' ? 'Review recent activity into memory consolidation PROPOSALS with message IDs. Preserve corrections; label inference. Do not act. ' + task.prompt : task.prompt;
      const result = await this.model(`${prompt}\nPrior action outcomes: ${JSON.stringify(previousActions)}\nSubtask results: ${JSON.stringify(childResults)}`, context, task, task.kind === 'dream' || Boolean(task.parentId));
      if (this.stopping) return;
      const current = this.store.getTask(task.id);
      if (current?.status === 'cancelled') return;
      const pending = this.store.listApprovals().some(a => a.taskId === task.id && ['pending', 'approved', 'executing', 'uncertain'].includes(a.status));
      this.store.updateTask(task.id, { status: pending ? 'waiting_approval' : 'completed', result, error: null });
      if (workflow) { this.store.appendEvent('workflow.agent-completed', { agent: node?.id, role: node?.role }, workflow.id); return; }
      if (task.kind === 'dream') this.store.setSetting(`dream:${task.id}`, { revision, sourceMessageIds });
      const scheduled = /^schedule-(.+)-\d+$/.exec(task.id)?.[1];
      const selective = Boolean(scheduled) && this.store.getSetting(`deliveryPolicy:${scheduled}`) === 'changes';
      const observations = this.store.listEvents(500).filter(event => event.taskId === task.id && event.type === 'source.observed').map(event => event.detail as { urls: string[]; observedAt: number });
      const decision = selectProactiveUpdate({ text: result, previousFingerprint: scheduled ? this.store.getSetting<string>(`lastDelivery:${scheduled}`) : undefined, observedUrls: observations.flatMap(e => e.urls), observedAt: observations.length ? Math.max(...observations.map(e => e.observedAt)) : undefined, requireSources: selective });
      if (!selective || pending || decision.selected) {
        this.store.addNotification({ title: pending ? 'Task needs approval' : task.kind === 'dream' ? 'Memory proposals ready' : 'Task completed', body: result.slice(0, 6000), taskId: task.id, dedupeKey: `task:${task.id}:${task.attempts}` });
        if (scheduled) this.store.setSetting(`lastDelivery:${scheduled}`, decision.fingerprint);
      }
      this.store.appendEvent('delivery.decision', { selected: !selective || pending || decision.selected, reason: selective ? decision.reason : 'requested-result' }, task.id);
      if (task.parentId) {
        this.store.appendEvent('subtask.completed', { childId: task.id, result: result.slice(0, 4000) }, task.parentId);
        const parent = this.store.getTask(task.parentId);
        if (parent?.status === 'completed') this.store.createTask({ prompt: `Consume the completed subtask result for the goal: ${parent.prompt}\nChild result: ${result}`, kind: 'task', goalId: parent.goalId ?? undefined });
      }
    } catch (error) {
      const current = this.store.getTask(task.id);
      if (current?.status === 'cancelled') return;
      if (current?.status === 'running') this.store.updateTask(task.id, { status: 'failed', error: safeError(error) });
      if (!task.parentId || !this.store.getWorkflow(task.parentId)) this.store.addNotification({ title: 'Task failed', body: safeError(error), taskId: task.id, dedupeKey: `task-failed:${task.id}:${task.attempts}` });
    }
  }

  async compactHistory() {
    const history = this.store.listMessages(200);
    const older = history.slice(0, -20);
    if (older.length < 20) return { compacted: false, reason: 'Not enough older history' };
    const latestId = older.at(-1)!.id;
    const prior = this.store.getSetting<{ lastMessageId: string; text: string }>('conversationSummary');
    if (prior?.lastMessageId === latestId) return { compacted: false, reason: 'Already summarized' };
    const text = await this.model('Summarize earlier conversation as reference data. Preserve commitments, corrections, unresolved questions and source message IDs. Do not infer preferences.', JSON.stringify({ previous: prior?.text, messages: older }).slice(0, 22000), undefined, true, true);
    this.store.setSetting('conversationSummary', { text, lastMessageId: latestId, sourceIds: older.map(m => m.id), createdAt: Date.now() });
    return { compacted: true, text };
  }

  async handle(request: Request): Promise<Response> {
    const url = new URL(request.url), route = url.pathname.replace(/^\/api/, '');
    if (url.pathname === '/health') return json({ ok: true, runtime: 'local' });
    if (url.pathname === '/oauth/google/callback') {
      try { await this.google.completeAuth(url.searchParams.get('code') ?? '', url.searchParams.get('state') ?? ''); return new Response('Google connected. Return to the assistant Connections tab.', { headers: { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' } }); }
      catch (error) { return new Response(safeError(error), { status: 400, headers: { 'Content-Type': 'text/plain' } }); }
    }
    const supplied = createHash('sha256').update(request.headers.get('authorization') ?? '').digest();
    const expected = createHash('sha256').update(`Bearer ${this.config.token}`).digest();
    if (!timingSafeEqual(supplied, expected)) return json({ error: 'Unauthorized' }, 401);
    try {
      const body: Data = ['POST', 'PATCH'].includes(request.method) ? await request.json() as Data : {};
      const id = decodeURIComponent(route.split('/')[2] ?? '');
      if (request.method === 'GET') {
        if (route === '/status') return json({ local: true, runtimeId: this.instanceId, model: this.config.model, activity: { activeTasks: this.active.size, chatBusy: this.chatBusy, queuedTasks: this.store.listTasks(500).filter(task => task.status === 'queued').length }, capabilities: { browser: await this.browser.status(), google: await this.google.status(), workspace: true, docker: this.config.dockerEnabled }, budget: { dailyTokenLimit: this.config.dailyTokenLimit, perRunReservation: this.config.runTokenReservation, usage: this.store.listUsage() } });
        if (route === '/history') return json({ messages: this.store.listMessages(500) });
        if (route === '/memories') return json({ memories: this.store.listMemories(url.searchParams.get('query') ?? undefined), revision: this.store.revision() });
        if (/^\/memories\/[^/]+\/lineage$/.test(route)) return json({ lineage: this.store.memoryLineage(id) });
        if (route === '/memory/files') return json(await this.projectMemory());
        if (route === '/goals') return json({ goals: this.store.listGoals() });
        if (route === '/tasks') return json({ tasks: this.store.listTasks() });
        if (route === '/workflows') return json({ workflows: this.store.listWorkflows().map(workflow => this.workflowView(workflow)) });
        if (/^\/workflows\/[^/]+$/.test(route)) { const workflow = this.store.getWorkflow(id); return workflow ? json(this.workflowView(workflow)) : json({ error: 'Workflow not found' }, 404); }
        if (route === '/schedules') return json({ schedules: this.store.listSchedules() });
        if (route === '/approvals') return json({ approvals: this.store.listApprovals() });
        if (route === '/notifications') return json({ notifications: this.store.listNotifications() });
        if (route === '/events') return json({ events: this.store.listEvents() });
        if (route === '/connections') return json({ google: await this.google.status() });
        if (route === '/browser/status') return json(await this.browser.status());
        if (route === '/browser/tabs') return json({ tabs: await this.browser.tabs() });
        if (route === '/browser/snapshot') return json(await this.browser.snapshot(url.searchParams.get('tabId') ?? ''));
        if (route === '/browser/screenshot') { const shot = await this.browser.screenshot(url.searchParams.get('tabId') ?? ''); return new Response(Buffer.from(shot.base64, 'base64'), { headers: { 'Content-Type': 'image/png', 'Cache-Control': 'no-store' } }); }
        if (route === '/files') return json({ entries: (await this.workspace.list(url.searchParams.get('path') ?? '')).map(entry => ({ ...entry, type: entry.directory ? 'directory' : 'file' })) });
        if (route === '/files/read') { const path = url.searchParams.get('path') ?? ''; this.checkMemoryFile(path); return json(await this.workspace.read(path)); }
        if (route === '/files/download') { const path = url.searchParams.get('path') ?? ''; this.checkMemoryFile(path); const file = await this.workspace.read(path); return new Response(file.content, { headers: { 'Content-Type': 'application/octet-stream', 'Content-Disposition': 'attachment; filename="artifact.txt"', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } }); }
        if (route === '/settings') return json({ timezone: this.store.getSetting('timezone') ?? 'America/Toronto', nightlyDreamEnabled: this.store.getSetting('nightlyDreamEnabled') !== false });
      }
      if (request.method === 'POST') {
        if (route === '/workflows') return json(this.createWorkflow(body), 202);
        if (/^\/workflows\/[^/]+\/cancel$/.test(route)) { if (!this.store.getWorkflow(id)) throw new Error('Workflow not found'); return json(this.cancelTask(id)); }
        if (/^\/workflows\/[^/]+\/retry$/.test(route)) return json(this.retryWorkflow(id), 202);
        if (route === '/chat') {
          if (this.chatBusy) return json({ error: 'A chat turn is already running' }, 409);
          const message = string(body.message).trim();
          if (!message || message.length > 12000) return json({ error: 'Message must have 1-12000 characters' }, 400);
          this.chatBusy = true;
          try {
            this.store.addMessage('user', message);
            const result = await this.model(message, this.context(message));
            this.store.addMessage('assistant', result);
            await this.projectMemory();
            return json({ message: result });
          } finally { this.chatBusy = false; }
        }
        if (route === '/memories') { const memory = this.store.saveMemory({ text: string(body.text), kind: body.kind as MemoryKind | undefined, source: 'user', provenance: 'explicit' }); await this.projectMemory(); return json(memory, 201); }
        if (/^\/memories\/[^/]+\/forget$/.test(route)) {
          const report = this.store.forgetMemory(id, body.includeSourceMessages === true); this.privacyEpoch++;
          for (const controller of this.controllers.values()) controller.abort();
          const projection = await this.projectMemory(); return json({ ...report, managedCopiesRemoved: !('error' in projection), projection });
        }
        if (route === '/memory/search') {
          const query = string(body.query).trim(); if (!query) throw new Error('Search query required');
          if (body.semantic !== true) return json({ memories: this.store.listMemories(query), mode: 'keyword' });
          const memories = this.store.listMemories();
          const response = await this.model(`Select up to 10 memory IDs relevant in meaning to this query: ${query}. Return ONLY a JSON array of IDs. Select existing IDs only.`, JSON.stringify(memories).slice(0, 20000), undefined, true, true);
          const ids = JSON.parse(response.replace(/^```(?:json)?\s*|\s*```$/g, ''));
          if (!Array.isArray(ids)) throw new Error('Semantic search returned an invalid selection');
          return json({ memories: ids.flatMap(id => memories.filter(m => m.id === id)), mode: 'gpt-6-luna-ranked', scope: 'saved memories' });
        }
        if (route === '/goals') return json(this.store.createGoal({ title: string(body.title), description: string(body.description), steps: this.steps(body.steps) }), 201);
        if (/^\/goals\/[^/]+\/run$/.test(route)) { const goal = this.store.listGoals().find(g => g.id === id); if (!goal || goal.status !== 'active') throw new Error('Active goal not found'); return json(this.store.createTask({ prompt: `Advance this goal using actual available tools. Do not mark steps complete without evidence. ${JSON.stringify(goal)}`, kind: 'goal', goalId: id }), 202); }
        if (route === '/schedules') return json(await this.createSchedule(body), 201);
        if (route === '/tasks') return json(this.store.createTask({ prompt: string(body.prompt), kind: body.kind === 'dream' ? 'dream' : 'task' }), 202);
        if (/^\/tasks\/[^/]+\/cancel$/.test(route)) return json(this.cancelTask(id));
        if (/^\/tasks\/[^/]+\/retry$/.test(route)) {
          const task = this.store.getTask(id);
          const workflowId = this.store.getWorkflow(id) ? id : task?.parentId && this.store.getWorkflow(task.parentId) ? task.parentId : undefined;
          if (workflowId) return json(this.retryWorkflow(workflowId), 202);
          if (this.store.getTask(id)?.status !== 'failed') throw new Error('Only a failed task can retry');
          if (this.store.listApprovals().some(a => a.taskId === id && ['uncertain', 'executing'].includes(a.status))) throw new Error('Reconcile uncertain actions before retrying');
          return json(this.store.updateTask(id, { status: 'queued', error: null }), 202);
        }
        if (route === '/actions') return json(await this.proposeAction(string(body.kind), body.payload as Data, string(body.summary)), 201);
        if (/^\/approvals\/[^/]+\/decision$/.test(route)) {
          if (!['approved', 'rejected'].includes(string(body.decision))) throw new Error('Invalid approval decision');
          const approval = this.store.decideApproval(id, body.decision as 'approved' | 'rejected', string(body.expectedDigest));
          if (approval.status === 'approved') return json(await this.executeAction(approval));
          this.resumeTask(approval.taskId); return json(approval);
        }
        if (/^\/notifications\/[^/]+\/read$/.test(route)) { this.store.markRead(id); return json({ ok: true }); }
        if (/^\/approvals\/[^/]+\/reconcile$/.test(route)) {
          const approval = this.store.reconcileAction(id, body.outcome as 'completed' | 'failed', string(body.evidence));
          this.store.appendEvent('action.reconciled', { approvalId: id, outcome: approval.status, verifiedBy: 'user' }, approval.taskId ?? undefined);
          this.resumeTask(approval.taskId); return json(approval);
        }
        if (route === '/browser/launch') return json(await this.browser.launch({ visible: body.visible === true }));
        if (route === '/browser/close') { await this.browser.close(); return json({ ok: true }); }
        if (route === '/browser/navigate') return json(await this.browser.navigate(string(body.url)));
        if (route === '/files') { if (string(body.path).startsWith('memory/')) throw new Error('Managed memory files must be edited in Memory'); return json(await this.workspace.write(string(body.path), string(body.content)), 201); }
        if (route === '/connections/google/start') { const { url } = this.google.beginAuth(); return json({ url }); }
        if (route === '/context/compact') return json(await this.compactHistory());
        if (route === '/dreams/apply') {
          const taskId = string(body.taskId), task = this.store.getTask(taskId);
          const snapshot = this.store.getSetting<{ revision: number; sourceMessageIds: string[] }>(`dream:${taskId}`);
          if (!task || task.kind !== 'dream' || task.status !== 'completed' || !snapshot) throw new Error('Completed dream required');
          const memory = this.store.saveMemory({ text: string(body.text), source: `dream:${taskId}:user-approved`, sourceIds: snapshot.sourceMessageIds.length ? snapshot.sourceMessageIds : [taskId], provenance: 'explicit', expectedRevision: snapshot.revision }); await this.projectMemory(); return json(memory, 201);
        }
        if (route === '/hooks') {
          const key = string(body.eventId);
          if (!/^[\w.-]{1,100}$/.test(key)) throw new Error('A stable eventId is required');
          return json(this.store.createTask({ id: `hook-${key}`, prompt: string(body.prompt), kind: 'task' }), 202);
        }
      }
      if (request.method === 'PATCH') {
        if (/^\/memories\/[^/]+$/.test(route)) { const memory = this.store.updateMemory(id, { text: string(body.text), source: 'user-correction', provenance: 'explicit', expectedRevision: body.expectedRevision === undefined ? undefined : Number(body.expectedRevision) }); await this.projectMemory(); return json(memory); }
        if (/^\/goals\/[^/]+$/.test(route)) return json(this.store.updateGoal(id, { ...(body.title ? { title: string(body.title) } : {}), ...(body.status ? { status: body.status as 'active' } : {}), ...(body.steps ? { steps: this.steps(body.steps) } : {}) }));
        if (route === '/settings') {
          if (body.timezone) { new Intl.DateTimeFormat('en', { timeZone: string(body.timezone) }).format(); this.store.setSetting('timezone', body.timezone); }
          if (typeof body.nightlyDreamEnabled === 'boolean') { this.store.setSetting('nightlyDreamEnabled', body.nightlyDreamEnabled); if (!body.nightlyDreamEnabled) this.store.deleteSchedule('nightly-dream'); }
          return json({ ok: true });
        }
      }
      if (request.method === 'DELETE') {
        if (/^\/memories\/[^/]+$/.test(route)) { const report = this.store.forgetMemory(id); this.privacyEpoch++; for (const controller of this.controllers.values()) controller.abort(); const projection = await this.projectMemory(); return json({ ...report, managedCopiesRemoved: !('error' in projection), projection }); }
        if (/^\/schedules\/[^/]+$/.test(route)) { this.store.deleteSchedule(id); if (id === 'nightly-dream') this.store.setSetting('nightlyDreamEnabled', false); return json({ deleted: true }); }
        if (route === '/connections/google') { await this.google.disconnect(); return json({ ok: true }); }
      }
      return json({ error: 'Not found' }, 404);
    } catch (error) {
      const message = safeError(error);
      return json({ error: message }, /revision conflict|already|expired|changed|pending|digest mismatch/i.test(message) ? 409 : /not found/i.test(message) ? 404 : /budget/i.test(message) ? 429 : 400);
    }
  }
}
