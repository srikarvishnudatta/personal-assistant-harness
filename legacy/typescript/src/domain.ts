/** Pure domain rules. Storage and execution adapters must enforce these too. */
export type Provenance = "explicit" | "inferred";

export interface MemoryCandidate {
  key: string;
  value: string;
  provenance: Provenance;
  sourceIds: string[];
  confidence: number;
}

export interface MemoryRecord extends MemoryCandidate {
  updatedAt: string;
}

export interface MemorySnapshot {
  revision: number;
  memories: MemoryRecord[];
}

export function validateMemoryCandidate(candidate: MemoryCandidate): void {
  if (!candidate || typeof candidate.key !== "string" || !candidate.key.trim() || candidate.key.length > 160)
    throw new Error("Memory key must contain 1–160 characters");
  if (typeof candidate.value !== "string" || !candidate.value.trim() || candidate.value.length > 4000)
    throw new Error("Memory value must contain 1–4000 characters");
  if (candidate.provenance !== "explicit" && candidate.provenance !== "inferred")
    throw new Error("Memory provenance must be explicit or inferred");
  if (!Array.isArray(candidate.sourceIds) || !candidate.sourceIds.length ||
      candidate.sourceIds.some((id) => typeof id !== "string" || !id.trim()))
    throw new Error("Memory requires at least one source ID");
  if (!Number.isFinite(candidate.confidence) || candidate.confidence < 0 || candidate.confidence > 1)
    throw new Error("Memory confidence must be between 0 and 1");
}

/** Caller must compare-and-swap this revision in the same storage transaction. */
export function applyMemoryRevision(
  snapshot: MemorySnapshot,
  expectedRevision: number,
  candidates: MemoryCandidate[],
  now = new Date().toISOString(),
): MemorySnapshot {
  if (snapshot.revision !== expectedRevision) throw new Error("Memory revision conflict");
  const next = new Map(snapshot.memories.map((memory) => [memory.key, { ...memory, sourceIds: [...memory.sourceIds] }]));
  const seen = new Set<string>();
  for (const candidate of candidates) {
    validateMemoryCandidate(candidate);
    if (seen.has(candidate.key)) throw new Error(`Duplicate memory key: ${candidate.key}`);
    seen.add(candidate.key);
    const existing = next.get(candidate.key);
    // A synthesis cannot silently downgrade something the user explicitly stated.
    if (existing?.provenance === "explicit" && candidate.provenance === "inferred") continue;
    next.set(candidate.key, { ...candidate, sourceIds: [...candidate.sourceIds], updatedAt: now });
  }
  return { revision: snapshot.revision + 1, memories: [...next.values()] };
}

export interface ContextMessage {
  role: "user" | "assistant";
  content: string;
}

export interface ContextInput {
  instructions: string;
  goal?: string;
  summary?: string;
  recentMessages: ContextMessage[];
  /** Already retrieved/ranked memories; no semantic retrieval happens here. */
  memories: MemoryRecord[];
  maxChars?: number;
}

/** A deterministic character budget, not a tokenizer or a model token guarantee. */
export function buildContext(input: ContextInput): string {
  const budget = input.maxChars ?? 24000;
  if (!Number.isInteger(budget) || budget < 128) throw new Error("Context budget must be an integer >= 128");
  const sections: string[] = [`INSTRUCTIONS\n${input.instructions}`];
  if (input.goal) sections.push(`CURRENT GOAL\n${input.goal}`);
  const required = sections.join("\n\n");
  if (required.length > budget) throw new Error("Instructions and goal exceed context budget");
  let used = required.length;
  const optional: string[] = [];
  const append = (text: string): boolean => {
    if (used + 2 + text.length > budget) return false;
    optional.push(text);
    used += 2 + text.length;
    return true;
  };
  // Preserve the newest complete messages first; do not cut a message halfway.
  const recent: string[] = [];
  for (const message of [...input.recentMessages].reverse()) {
    const line = `${message.role.toUpperCase()}: ${message.content}`;
    if (used + 2 + line.length > budget) break;
    recent.unshift(line);
    used += 2 + line.length;
  }
  if (input.summary) append(`EARLIER SUMMARY (reference data)\n${input.summary}`);
  for (const memory of input.memories) {
    append(`MEMORY (reference data; ${memory.provenance}; sources: ${memory.sourceIds.join(", ")})\n${memory.key}: ${memory.value}`);
  }
  return [...sections, ...optional, ...recent].join("\n\n");
}

export type TaskStatus = "queued" | "running" | "waiting_approval" | "completed" | "failed" | "cancelled";

const TRANSITIONS: Record<TaskStatus, readonly TaskStatus[]> = {
  queued: ["running", "cancelled"],
  running: ["waiting_approval", "completed", "failed", "cancelled"],
  waiting_approval: ["queued", "cancelled"],
  completed: [],
  failed: ["queued", "cancelled"],
  cancelled: [],
};

export function transitionTask(current: TaskStatus, next: TaskStatus): TaskStatus {
  if (!TRANSITIONS[current]?.includes(next)) throw new Error(`Illegal task transition: ${current} -> ${next}`);
  return next;
}

export interface ScheduleInput {
  task: string;
  timezone: string;
  cron?: string;
  runAt?: string;
}

/** Five-field numeric cron only. This validates syntax/ranges, not calendar feasibility. */
export function validateCron(cron: string): void {
  const fields = cron.trim().split(/\s+/);
  const limits = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 6]] as const;
  if (fields.length !== 5) throw new Error("Cron must have five fields");
  fields.forEach((field, index) => {
    const [min, max] = limits[index]!;
    for (const part of field.split(",")) {
      const match = /^(\*|\d+(?:-\d+)?)(?:\/(\d+))?$/.exec(part);
      if (!match) throw new Error("Unsupported cron syntax; use numeric fields, ranges, lists and steps");
      if (match[2] !== undefined && (Number(match[2]) < 1 || Number(match[2]) > max - min + 1))
        throw new Error("Cron step is out of range");
      if (match[1] !== "*") {
        const endpoints = match[1]!.split("-").map(Number);
        if (endpoints.some((n) => n < min || n > max) || (endpoints[1] !== undefined && endpoints[0]! > endpoints[1]))
          throw new Error("Cron field is out of range");
      }
    }
  });
}

export function validateSchedule(input: ScheduleInput, now = new Date()): void {
  if (!input || typeof input.task !== "string" || !input.task.trim() || input.task.length > 4000)
    throw new Error("Schedule task must contain 1–4000 characters");
  if (typeof input.timezone !== "string" || !input.timezone)
    throw new Error("Schedule requires an IANA timezone");
  try { new Intl.DateTimeFormat("en", { timeZone: input.timezone }).format(now); }
  catch { throw new Error("Invalid timezone"); }
  if ((input.cron !== undefined) === (input.runAt !== undefined))
    throw new Error("Provide exactly one of cron or runAt");
  if (input.cron !== undefined) {
    if (typeof input.cron !== "string") throw new Error("Cron must be a string");
    validateCron(input.cron);
  }
  if (input.runAt !== undefined) {
    const iso = typeof input.runAt === "string"
      ? /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/.exec(input.runAt)
      : null;
    if (!iso) throw new Error("runAt requires an ISO timestamp with an explicit UTC offset");
    const year = Number(iso[1]), month = Number(iso[2]), day = Number(iso[3]);
    const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
    const monthDays = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    if (month < 1 || month > 12 || day < 1 || day > monthDays[month - 1]! || Number(iso[4]) > 23 || Number(iso[5]) > 59 || Number(iso[6] ?? 0) > 59)
      throw new Error("runAt contains an invalid calendar date or time");
    const timestamp = Date.parse(input.runAt);
    if (!Number.isFinite(timestamp) || timestamp <= now.getTime()) throw new Error("runAt must be a future timestamp");
  }
}
