# Implementation plan

## Goal

Build a personal assistant on Cloudflare Workers using the OpenAI Agents SDK. It should retain useful context, maintain explicit goals and tasks, perform scheduled work, and periodically consolidate memory. The assistant's state persists even when no process is running.

The first version is a developer-operated, single-user service. A Muse-like experience is the product direction, not a claim that its proprietary backend has been reproduced.

## Milestones

| Phase | Deliverable | Completion criteria |
|---|---|---|
| 1. Runnable foundation | Worker API, ASTRYX React UI shell, per-user Durable Object, SQLite schema, SDK adapter, Workflow entry point | Type checking, domain tests, UI/Worker bundle validation; local chat and persisted history with a real key |
| 2. Context and memory | Bounded context builder, provenance, memory revisions, correction/deletion API | Explicit and inferred information remain distinguishable; concurrent writes cannot silently overwrite newer memory |
| 3. Scheduled execution | One-shot and interval schedules, alarm dispatch, durable task records | Client can close before a due task; task and result remain inspectable; retry/cancel behavior is tested |
| 4. Dreams | Background synthesis of a bounded activity snapshot into proposed memory changes | Dreams cite input events, preserve corrections, use version checks, and cannot perform external actions |
| 5. Personal integrations | Authenticated email/calendar/search/file tools and reusable skill recipes | Least-privilege credentials, tool authorization, request budgets, and safe failures |
| 6. Approvals and delivery | Paused task state, exact action review, resume, notifications | Approval is bound to a specific action; stale approval cannot authorize changed parameters; results reach the user |
| 7. Public product readiness | User login, OAuth lifecycle, tenant isolation, operational controls | Identity comes from verified credentials; deletion/export, retention, observability, and abuse controls are exercised |

Phases can overlap, but deployment should not be described as production-ready before the relevant completion criteria have evidence.

## Initial implementation scope

The initial repository contains configuration, API routing, per-user persistence, bounded agent calls, basic schedules and background task handling, domain checks, an ASTRYX React UI shell in `web/`, and setup documentation. Full timezone-aware cron, connector OAuth, and notification delivery remain follow-up work. The UI is built with Vite and served by Worker assets; build it before starting Wrangler. `npm run dev:ui` supplies a separate UI development server that proxies API calls to Wrangler on port 8787.

Use direct Durable Object alarms for the initial scheduler. Introduce a scheduler library only when its behavior and operational benefits justify the extra dependency. Store explicit UTC instants and interval durations initially; later store IANA timezones and recurrence rules for local-time schedules.

## Explicit state and recovery

Tasks should follow a documented state machine: queued > running > completed/failed, with waiting-for-approval and cancelled paths added when those features exist. Store the task ID, triggering event, schedule occurrence, timestamps, attempt information, and terminal result.

Do not mistake an SDK session for durable execution. Workflow stages need persisted inputs and outputs. Retrying a whole agent run may repeat tool actions: externally visible writes require stable operation IDs, idempotency support where available, and reconciliation when a provider's outcome is uncertain.

Schedule dispatch must account for failure between recording an occurrence and creating its Workflow. Test crashes on both sides of that boundary. Catch-up policy, overlap policy, cancellation, and duplicate suppression need explicit semantics rather than accidental behavior.

## Memory and dreams

- Keep source events and durable memories separate.
- Attach evidence, timestamps, scope, and explicit/inferred status to memory. The initial runtime classifies model-extracted memories as inferred; manually entered memories and user-approved dream text are explicit.
- Treat tentative intentions as tentative; do not promote them to recurring instructions.
- Build a bounded prompt from recent messages, summary, relevant memories, and current task state.
- Run dreams against a fixed input snapshot and publish updates with an optimistic revision check.
- Preserve an audit trail and allow inspection, correction, deletion, and export.
- Track deletion through derived summaries and retrieval indexes as these are introduced.

Dreams should initially improve memory only. They can propose a follow-up, but proposals do not independently authorize sending messages, creating purchases, or enrolling the user in recurring tasks.

## Security and cost boundaries

The initial bearer service token is suitable only for a trusted developer deployment. Before exposing clients publicly, implement user authentication and derive the assistant namespace on the server. Store provider credentials as secrets, redact sensitive traces, and keep credentials out of model context.

Each run needs maximum turns, bounded retrieved context, time limits, and an estimated/actual usage ledger. Each user needs a spending limit and concurrency policy. Stop or defer work when limits are reached, and show a useful task failure reason.

## Verification

1. Type check and build the Worker without deploying it.
2. Test meaningful state transitions, memory revisions, context bounds, and schedule validation.
3. Run local persistence, authentication, chat, and schedule smoke tests.
4. Test failed model calls, expired credentials, retries, cancellation, and concurrent memory updates.
5. Deploy only with working account access; verify bindings and secret configuration.
6. Use a small regression set to evaluate memory accuracy, inappropriate proactive actions, tool use, and cost before expanding autonomy.

## Repository and deployment status

Nineteen native Node tests passed during initialization: domain rules, gateway checks, and real-SQLite application integration with platform/model adapters substituted. Tests use Node 22.18+ TypeScript support without test-runner dependencies. Package installation failed with `ENOTFOUND registry.npmjs.org`; type checking, UI build, Worker bundling, and workerd/live SDK checks have not run. There is no lockfile yet: initial setup and CI must use `npm install` until one can be generated and committed; then CI should use `npm ci`.

GitHub repository creation was attempted but could not reach api.github.com, including from fresh PowerShell processes. The CLI also reported an invalid credential; DNS failure prevents confirming whether refreshed authentication is usable. Local Git initialization and the intended origin URL exist, but staging/committing failed because .git/index.lock and config writes were denied. The remote has not been created and the source has not been committed. Once writable Git metadata and network access are available, commit, create the private remote, and push. Cloudflare deployment likewise requires account access and configured secrets.
