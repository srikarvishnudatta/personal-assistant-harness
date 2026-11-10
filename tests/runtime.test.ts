/** Runs real Assistant handlers and SQL with platform/model adapters substituted.
 * This verifies application behavior, not workerd or OpenAI SDK compatibility.
 * Requires Node 22.18+ (node:sqlite and native TypeScript stripping).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { DatabaseSync } from "node:sqlite";

const dataUrl = (source: string) => `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`;
const platformUrl = dataUrl("export class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }");
const modelUrl = dataUrl("export async function runAssistant(env, ...args) { return env.__runAssistant(...args); }");
const domainUrl = dataUrl(stripTypeScriptTypes(readFileSync(new URL("../src/domain.ts", import.meta.url), "utf8")));
let assistantSource = stripTypeScriptTypes(readFileSync(new URL("../src/assistant.ts", import.meta.url), "utf8"));
for (const [module, replacement] of [["cloudflare:workers", platformUrl], ["./agent", modelUrl], ["./domain", domainUrl]]) {
  assistantSource = assistantSource.replaceAll(`'${module}'`, JSON.stringify(replacement)).replaceAll(`"${module}"`, JSON.stringify(replacement));
}
const { Assistant } = await import(dataUrl(assistantSource));

function fixture() {
  const db = new DatabaseSync(":memory:");
  let alarm: number | null = null;
  let failCreate = false;
  const instances = new Map<string, unknown>();
  const creations: string[] = [];
  const context = {
    storage: {
      sql: { exec(query: string, ...bindings: (string | number | null)[]) {
        if (query.trim().split(";").filter(Boolean).length > 1) {
          db.exec(query);
          return { toArray: () => [] };
        }
        const statement = db.prepare(query);
        if (/^\s*(SELECT|WITH|PRAGMA)\b/i.test(query)) return { toArray: () => statement.all(...bindings) };
        statement.run(...bindings);
        return { toArray: () => [] };
      } },
      transactionSync<T>(callback: () => T): T {
        db.exec("BEGIN IMMEDIATE");
        try { const value = callback(); db.exec("COMMIT"); return value; }
        catch (error) { db.exec("ROLLBACK"); throw error; }
      },
      async getAlarm() { return alarm; },
      async setAlarm(timestamp: number) { alarm = timestamp; },
      async deleteAlarm() { alarm = null; },
    },
    async blockConcurrencyWhile<T>(callback: () => Promise<T>) { return callback(); },
  };
  const env = {
    OPENAI_API_KEY: "test-only-not-a-key",
    __runAssistant: async () => "Mock response",
    ASSISTANT_WORKFLOW: {
      async create({ id, params }: { id: string; params: unknown }) {
        creations.push(id);
        if (failCreate) throw new Error("Injected workflow outage");
        if (instances.has(id)) throw new Error("Workflow already exists");
        instances.set(id, params);
        return { id };
      },
      async get(id: string) {
        return { async status() {
          if (!instances.has(id)) throw new Error("Workflow missing");
          return { status: "queued" };
        } };
      },
    },
  };
  const assistant = new Assistant(context, env);
  const request = (path: string, method = "GET", body?: unknown, userId = "personal") => assistant.fetch(new Request(`https://assistant${path}`, {
    method, headers: { "X-User-Id": userId, "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body),
  })) as Promise<Response>;
  return { db, env, assistant, request, instances, creations, alarm: () => alarm, setFailure: (value: boolean) => { failCreate = value; } };
}

test("schedule creation arms an alarm and deleting the last schedule clears it", async (t) => {
  const f = fixture(); t.after(() => f.db.close());
  const runAt = new Date(Date.now() + 120000).toISOString();
  const created = await f.request("/schedules", "POST", { prompt: "Review goals", runAt });
  assert.equal(created.status, 201);
  const { id } = await created.json() as { id: string };
  assert.equal(f.alarm(), Date.parse(runAt));
  assert.equal((await f.request(`/schedules/${id}`, "DELETE")).status, 200);
  assert.equal(f.alarm(), null);
  assert.equal(f.db.prepare("SELECT COUNT(*) AS count FROM schedules").get()?.count, 0);
});

test("replayed scheduled occurrence reuses its task and workflow IDs", async (t) => {
  const f = fixture(); t.after(() => f.db.close());
  const created = await f.request("/schedules", "POST", { prompt: "Review goals", runAt: new Date(Date.now() + 120000).toISOString() });
  const { id } = await created.json() as { id: string };
  const occurrenceAt = Date.now() - 1000;
  f.db.prepare("UPDATE schedules SET next_run_at=? WHERE id=?").run(occurrenceAt, id);
  await f.assistant.alarm();
  // Simulate an alarm replay after workflow creation but before schedule advancement.
  f.db.prepare("UPDATE schedules SET status='active',next_run_at=? WHERE id=?").run(occurrenceAt, id);
  await f.assistant.alarm();
  assert.equal(f.instances.size, 1);
  assert.equal(f.db.prepare("SELECT COUNT(*) AS count FROM tasks").get()?.count, 1);
  assert.equal([...f.instances.keys()][0], `schedule-${id}-${occurrenceAt}`);
  assert.equal(f.db.prepare("SELECT status FROM schedules WHERE id=?").get(id)?.status, "completed");
});

test("workflow outage leaves a recoverable queued task and preserves its retry alarm", async (t) => {
  const f = fixture(); t.after(() => f.db.close());
  f.setFailure(true);
  const started = await f.request("/tasks", "POST", { prompt: "Research my goal" });
  assert.equal(started.status, 202);
  const { id } = await started.json() as { id: string };
  assert.equal(f.instances.size, 0);
  assert.equal(f.db.prepare("SELECT status FROM tasks WHERE id=?").get(id)?.status, "queued");
  const retryAlarm = f.alarm();
  assert.ok(retryAlarm !== null && retryAlarm <= Date.now() + 31000);
  await f.request("/schedules", "POST", { prompt: "Later", runAt: new Date(Date.now() + 86400000).toISOString() });
  assert.equal(f.alarm(), retryAlarm, "a later schedule must not displace outbox recovery");
  f.setFailure(false);
  await f.assistant.alarm();
  assert.equal(f.instances.size, 1);
  assert.deepEqual(f.creations, [id, id]);
});

test("dream approval rejects a stale memory revision and preserves newer user facts", async (t) => {
  const f = fixture(); t.after(() => f.db.close());
  const started = await f.request("/tasks", "POST", { prompt: "Review memory", kind: "dream" });
  const { id } = await started.json() as { id: string };
  assert.equal((await f.request("/internal/task-result", "POST", { taskId: id, status: "running" })).status, 200);
  assert.equal((await f.request(`/internal/context?taskId=${id}`)).status, 200);
  assert.equal((await f.request("/memories", "POST", { text: "I prefer evening workouts now." })).status, 201);
  assert.equal((await f.request("/internal/task-result", "POST", { taskId: id, status: "completed", result: "Morning workout proposal" })).status, 200);
  const applied = await f.request("/dreams/apply", "POST", { taskId: id, text: "I prefer mornings." });
  assert.equal(applied.status, 409);
  assert.equal(f.db.prepare("SELECT COUNT(*) AS count FROM memories").get()?.count, 1);
  assert.equal(f.db.prepare("SELECT text FROM memories").get()?.text, "I prefer evening workouts now.");
});

test("task callbacks are idempotent and cannot regress a completed task", async (t) => {
  const f = fixture(); t.after(() => f.db.close());
  const { id } = await (await f.request("/tasks", "POST", { prompt: "Review goal" })).json() as { id: string };
  const callback = (status: string, result?: string) => f.request("/internal/task-result", "POST", { taskId: id, status, result });
  assert.equal((await callback("completed")).status, 400, "queued task cannot skip execution");
  assert.equal((await callback("running")).status, 200);
  assert.equal((await callback("completed", "Original result")).status, 200);
  assert.equal((await callback("completed", "Duplicate result")).status, 200);
  assert.equal((await callback("running")).status, 400);
  assert.equal((await callback("failed")).status, 400);
  assert.equal(f.db.prepare("SELECT result FROM tasks WHERE id=?").get(id)?.result, "Original result");
  assert.equal(f.db.prepare("SELECT COUNT(*) AS count FROM events WHERE type='task.completed'").get()?.count, 1);
});

test("durable object rejects mismatched user identity", async (t) => {
  const f = fixture(); t.after(() => f.db.close());
  assert.equal((await f.request("/memories")).status, 200);
  assert.equal((await f.request("/memories", "GET", undefined, "someone-else")).status, 403);
});

test("concurrent chats are rejected while an existing turn awaits the model", async (t) => {
  const f = fixture(); t.after(() => f.db.close());
  let release!: (text: string) => void;
  let entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  f.env.__runAssistant = () => { entered(); return new Promise<string>(resolve => { release = resolve; }); };
  const first = f.request("/chat", "POST", { message: "First request" });
  await started;
  assert.equal((await f.request("/chat", "POST", { message: "Overlapping request" })).status, 409);
  release("First answer");
  assert.equal((await first).status, 200);
  assert.equal(f.db.prepare("SELECT COUNT(*) AS count FROM messages").get()?.count, 2);
});
