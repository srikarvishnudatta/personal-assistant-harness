# ASTRYX Personal Assistant Harness

A Cloudflare-native personal assistant built with the OpenAI Agents SDK for TypeScript. The goal is a persistent assistant that can chat, remember useful context, run scheduled work, and consolidate memory in background “dream” jobs.

This is an initial MVP, not a production-ready autonomous assistant. Its initial React UI shell lives in `web/` and uses ASTRYX components. Vite builds it into Worker-served assets. The control plane uses Workers, per-user Durable Objects with SQLite, and Workflows. Model inference runs through the OpenAI API.

## Start locally

Prerequisites: Node.js 22.18 or newer, npm, a Cloudflare account for deployment, and an OpenAI API key.

```powershell
npm install
Copy-Item .dev.vars.example .dev.vars
```

Set `OPENAI_API_KEY` and a long random `HARNESS_TOKEN` in `.dev.vars`. Keep this file private.

```powershell
npm run check
npm test
npm run build
npm run dev
```

Build before starting Wrangler: its asset binding expects `dist/` to exist. For UI development, keep Wrangler running on port 8787 and open a second terminal with `npm run dev:ui`; Vite proxies API requests to Wrangler.

The UI accepts the service token at runtime for this trusted personal deployment. Keep it private and use a deployment you control. This credential is not a substitute for public user authentication.

Use a terminal or API client to call the local Worker. For example:

```powershell
$headers = @{
  Authorization = "Bearer YOUR_HARNESS_TOKEN"
}
Invoke-RestMethod -Uri http://localhost:8787/api/chat -Method Post -Headers $headers -ContentType application/json -Body '{"message":"Help me plan my week."}'
```

`HARNESS_TOKEN` is a service credential. This is a trusted single-user/developer deployment; it is not public multi-user authentication. The gateway fixes the assistant namespace to `personal` and ignores caller-provided user IDs. Do not embed the token in a publicly served browser or mobile application. User login and server-derived identity are part of the implementation plan.

## API surface

Authenticated `/api/*` requests use `Authorization: Bearer <HARNESS_TOKEN>`. The gateway fixes the assistant namespace to `personal`; caller-provided user IDs do not select another namespace.

| Method | Route | Purpose |
|---|---|---|
| POST | `/api/chat` | Send `{ "message": "..." }` |
| GET | `/api/history` | Read stored conversation history |
| GET | `/api/memories` | Inspect durable memories |
| POST | `/api/memories` | Save an explicit memory with `{ "text": "..." }` |
| DELETE | `/api/memories/:id` | Delete a memory |
| GET | `/api/schedules` | Inspect schedules |
| POST | `/api/schedules` | Create a one-shot or interval task |
| GET | `/api/tasks` | Inspect background task state |
| POST | `/api/tasks` | Start `{ "prompt": "...", "kind": "task" }` or a `dream` |
| DELETE | `/api/schedules/:id` | Remove a future schedule |
| GET | `/api/events` | Inspect recent audit events |
| POST | `/api/dreams/apply` | Approve dream text with `{ "taskId": "...", "text": "..." }` |

Model-extracted memories are treated as inferred, even when they came from a user message. Manually saved memories and user-approved dream text are explicit. A dream produces a proposal; the apply endpoint checks that memory has not changed since its input snapshot before saving approved text.

Example schedule payload:

```json
{
  "prompt": "Review my active goals and suggest the next useful step.",
  "runAt": "2026-12-01T14:00:00Z",
  "intervalSeconds": 86400
}
```

Omit `intervalSeconds` for one-shot execution; recurring intervals must be at least 60 seconds. An interval of 86,400 seconds means every 24 hours, not a daylight-saving-aware local daily recurrence. Local-time cron and DST rules are a later milestone.

## Deploy

Review `wrangler.jsonc`, then authenticate Cloudflare and store secrets:

```powershell
npx wrangler login
npx wrangler secret put OPENAI_API_KEY
npx wrangler secret put HARNESS_TOKEN
npm run deploy
```

Deployment and live model calls consume provider resources. Tests and type checks do not establish that an undeployed project has working production bindings, credentials, or account entitlements. Verify `/api/history` with authentication and perform a chat and schedule smoke test after deployment.

## Design and next work

- [Implementation plan](docs/PLAN.md): milestones, completion criteria, and known gaps.
- [Architecture](docs/ARCHITECTURE.md): state ownership, execution, context, dreams, and scheduling.

The first milestone is one complete loop: request a task, persist it, run it while the client is closed, inspect the result, and use feedback in a later conversation. External tool actions, action approval workflows, delivery notifications, and unrestricted computer control remain follow-up work. The initial UI shell does not establish that these are implemented.

## Current verification status

Nineteen dependency-free native Node tests passed during initialization: domain rules, API gateway checks, and application integration tests using real SQLite with platform/model adapters substituted. `npm test` uses Node's built-in TypeScript support and test runner. Dependency installation was blocked by DNS resolution (`ENOTFOUND registry.npmjs.org`), so type checking, the UI build, Wrangler bundling, and workerd/live SDK tests have not run.

No lockfile has been generated yet. Use `npm install` initially; generate and commit the lockfile once registry access works, then switch CI to `npm ci`. GitHub DNS resolution failed even from fresh PowerShell processes, so the remote has not been created. The CLI also reports an invalid credential, which could not be independently verified while offline. Git staging/committing was blocked by denied .git lock/config writes; files remain local and uncommitted.
