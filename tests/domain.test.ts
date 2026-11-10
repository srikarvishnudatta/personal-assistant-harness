import test from "node:test";
import assert from "node:assert/strict";
import { applyMemoryRevision, buildContext, transitionTask, validateSchedule, type MemoryCandidate } from "../src/domain.ts";

const candidate: MemoryCandidate = {
  key: "workout_time", value: "Morning", provenance: "explicit", sourceIds: ["message-1"], confidence: 1,
};

test("memory updates require the current revision and preserve the original snapshot", () => {
  const original = { revision: 2, memories: [] };
  assert.throws(() => applyMemoryRevision(original, 1, [candidate]), /conflict/);
  const updated = applyMemoryRevision(original, 2, [candidate], "2026-11-10T00:00:00Z");
  assert.equal(updated.revision, 3);
  assert.equal(updated.memories.length, 1);
  assert.equal(original.memories.length, 0);
});

test("dream inference cannot overwrite an explicit preference", () => {
  const initial = applyMemoryRevision({ revision: 0, memories: [] }, 0, [candidate]);
  const next = applyMemoryRevision(initial, 1, [{ ...candidate, value: "Evening", provenance: "inferred" }]);
  assert.equal(next.memories[0]?.value, "Morning");
  assert.throws(() => applyMemoryRevision(initial, 1, [{ ...candidate, sourceIds: [] }]), /source/);
});

test("memory writes reject unsupported confidence, provenance and duplicate keys", () => {
  const snapshot = { revision: 0, memories: [] };
  assert.throws(() => applyMemoryRevision(snapshot, 0, [{ ...candidate, confidence: Number.NaN }]), /confidence/);
  assert.throws(() => applyMemoryRevision(snapshot, 0, [{ ...candidate, provenance: "unknown" as MemoryCandidate["provenance"] }]), /provenance/);
  assert.throws(() => applyMemoryRevision(snapshot, 0, [candidate, candidate]), /Duplicate/);
  assert.deepEqual(snapshot, { revision: 0, memories: [] });
});

test("task lifecycle blocks completion without execution and mutation after completion", () => {
  assert.equal(transitionTask("queued", "running"), "running");
  assert.equal(transitionTask("waiting_approval", "queued"), "queued");
  assert.throws(() => transitionTask("queued", "completed"), /Illegal/);
  assert.throws(() => transitionTask("completed", "running"), /Illegal/);
});

test("context prioritizes instructions, goal and recent complete messages within budget", () => {
  const text = buildContext({
    instructions: "Be useful.", goal: "Plan a run.", maxChars: 200,
    summary: "x".repeat(300), memories: [],
    recentMessages: [{ role: "user", content: "x".repeat(300) }, { role: "user", content: "Tomorrow morning." }],
  });
  assert.ok(text.length <= 200);
  assert.match(text, /Be useful/);
  assert.match(text, /Tomorrow morning/);
  assert.doesNotMatch(text, /EARLIER SUMMARY/);
  assert.throws(() => buildContext({ instructions: "x".repeat(500), maxChars: 128, memories: [], recentMessages: [] }), /exceed/);
});

test("context includes source-labelled inferred memories without changing their classification", () => {
  const text = buildContext({ instructions: "Be useful.", memories: [{ ...candidate, provenance: "inferred", updatedAt: "2026-11-10" }], recentMessages: [] });
  assert.match(text, /reference data; inferred; sources: message-1/);
});

test("schedule validates timezone, cron ranges and mutually exclusive trigger", () => {
  validateSchedule({ task: "Review goals", timezone: "America/Toronto", cron: "0 9 * * 1-5" });
  assert.throws(() => validateSchedule({ task: "Check", timezone: "Invalid/Timezone", cron: "0 9 * * *" }), /timezone/);
  assert.throws(() => validateSchedule({ task: "Check", timezone: "UTC", cron: "60 9 * * *" }), /range/);
  assert.throws(() => validateSchedule({ task: "Check", timezone: "UTC", cron: "*/0 * * * *" }), /range/);
  assert.throws(() => validateSchedule({ task: "Check", timezone: "UTC", cron: "0 9 * * *", runAt: "2099-01-01T00:00:00Z" }), /exactly one/);
  assert.throws(() => validateSchedule({ task: "Check", timezone: "UTC", runAt: "2099-01-01T09:00:00" }), /offset/);
  assert.throws(() => validateSchedule({ task: "Check", timezone: "UTC", runAt: "2000-01-01T00:00:00Z" }), /future/);
  assert.throws(() => validateSchedule({ task: "Check", timezone: "UTC", runAt: "2099-02-30T00:00:00Z" }), /invalid calendar/);
  assert.throws(() => validateSchedule({ task: "Check", timezone: "UTC", runAt: "2099-01-01T24:00:00Z" }), /invalid calendar/);
});

test("schedule rejects reversed ranges, non-numeric extensions and missing triggers", () => {
  for (const cron of ["0 9 * * 5-1", "0 9 * JAN *", "0 9 * * 7", "0 9 * * * *"]) {
    assert.throws(() => validateSchedule({ task: "Check", timezone: "UTC", cron }));
  }
  assert.throws(() => validateSchedule({ task: "Check", timezone: "UTC" }), /exactly one/);
  validateSchedule({ task: "Check", timezone: "UTC", cron: "*/15 9-17 * * 1,3,5" });
  validateSchedule({ task: "Check", timezone: "UTC", runAt: "2099-01-01T09:00:00-05:00" });
});
