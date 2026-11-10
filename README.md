# Personal Assistant Harness

Open [the interactive project guide](docs/project-guide.html) in a browser for
the architecture explorer, capability filters, workflow simulator, setup commands
and full embedded documentation. It works offline and makes no API calls.
Regenerate it after documentation changes with `python scripts/build-project-guide.py`.

A local-first personal assistant using **OpenAI Agents SDK for Python + GPT-6 Luna only**,
an **Astryx React UI**, persistent SQLite and a dedicated Chromium profile.
All active agent code is Python under `backend/harness`: the runner, tools,
workflow coordination, memory, dreams, scheduling, approvals, browser and
connectors. FastAPI serves the API and built React UI. Node is used for frontend
builds and thin command/test clients. The retired backend is in
`legacy/typescript` for reference; it is not part of the running app.
No VM is provisioned. Cloudflare deployment is deferred.

## Workflow agents

Open **Workflows**, enter a goal, and give 2–4 specialists separate assignments.
The runtime runs specialists in parallel (up to two background model calls at
once), waits for all their results, runs a verifier, then a synthesizer. One final
answer appears in Inbox; each stage's result and attempts remain inspectable.
Chat can also create this team using the `workflow` operation.
Concurrency can be lower when token reservations temporarily fill the daily
budget; queued siblings wait for capacity to be released.

All stages use GPT-6 Luna and read-only tools. They cannot send messages, change
files/memory, create approvals or spawn more agents. Verification is a model
review with source tools, not a guarantee that every claim is true.

SQLite stores the graph and stage checkpoints. Restart recovery preserves
completed stages. An explicit **Retry failed agents** reuses them and allows up
to three attempts per failed agent; a restarted interrupted call may incur
another model charge. Cancel stops running and queued agents. The server must
stay running for progress.

The authenticated API also accepts custom dependency graphs with 2–8 nodes:
`POST /api/workflows` with `{prompt,nodes:[{id,role,prompt,dependsOn}],output}`.
Dependencies must be acyclic, refer to existing nodes, and all contribute to the
output. Inspect with `GET /api/workflows/:id`; use POST to `/:id/cancel` or
`/:id/retry`. Default teams use `{prompt,specialists?:[{role,prompt}]}` instead.

After restarting the updated server, run `npm run test:workflows` in another
terminal. It makes four short real GPT-6 Luna calls using synthetic assignments
and checks stage results, attempts and one final receipt. Records remain for
inspection. Component tests use an injected runner; they do not prove live model
execution.

This is an implementation in progress. Implemented code, component tests,
live provider tests and production readiness are separate states. See
[the ordered plan](docs/PLAN.md) and [verification ledger](docs/VERIFICATION.md).

## Run locally

Use Python 3.12+ and Node 22.18+ (Node 24+ recommended). Stop the old server
with Ctrl+C before starting Python against the same state directory. From this
project directory, in a normal PowerShell terminal:

```powershell
npm install
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
if (!(Test-Path .dev.vars)) { Copy-Item .dev.vars.example .dev.vars }
```

Set `OPENAI_API_KEY` and a random `HARNESS_TOKEN` of at least 24 characters in
`.dev.vars`. Keep the existing token if you have encrypted Google credentials:
unless `CREDENTIAL_KEY` is explicitly configured, it also protects the vault.
The file, `.assistant/`, `.venv/`, Python bytecode and `node_modules/` are ignored
by Git. Existing SQLite records and the encrypted Google vault format are
preserved; the dedicated Chromium profile uses the same ownership marker.

```powershell
npm run check
npm test
npm run build
npm run dev
```

Open `http://127.0.0.1:8787` and enter the access token. It stays in the tab's
session storage, not the bundle. Stop any previous server on that port first,
or set `LOCAL_PORT=8788` in `.dev.vars`.

The runtime is loopback-only and intended for one trusted user. The server must
stay running for schedules and queued work. It does not keep working while the
computer sleeps. Public multiuser login and hosted push delivery are not built.

For UI development, `npm run dev:ui` proxies `/api` to port 8787.
`npm run dev` selects `.venv` automatically, or `PYTHON_EXECUTABLE` if set.
You can also run Python directly with `PYTHONPATH=backend` and
`python -m harness.server`. Cloudflare start/deploy commands report that hosted
Python service integration is deferred; they cannot deploy the retired backend.

## What is implemented

| Area | Current behavior |
| --- | --- |
| Agent loop | GPT-6 Luna, bounded turns/time, actual tool results, optional hosted web search, usage reservations |
| State | Disk SQLite messages, goals/steps, tasks, schedules, approvals, inbox and audit |
| Memory | Provenance, correction lineage, keyword and GPT-6 Luna ranked search over saved memories; summaries and versioned dream proposals |
| Readable memory | Managed `memory/MEMORY.md`, recent daily notes and person notes in the workspace; SQLite remains authoritative |
| Forget | Removes a saved claim, revision history and known exact derived copies; optionally removes known source messages; invalidates summaries |
| Browser | Separate persistent profile, public navigation, tabs, snapshots, screenshots, visible manual login, reviewed click/fill |
| Background | Durable queue, bounded subtasks, restart recovery, one-shot/interval/timezone cron, stable event-hook IDs |
| Delivery | Durable inbox, repeat suppression/source-observation gate for selective research schedules; desktop notices while Inbox is open |
| Actions | Exact immutable payload/digest/expiry, accept/reject, one execution claim, uncertain-outcome reconciliation |
| Google | OAuth PKCE and encrypted refresh tokens; Gmail search/read/send and Calendar list/create behind approval for writes |
| Workspace | Confined text/Markdown/CSV/JSON/HTML artifacts and reviewed procedures; optional Docker-only scripts |

There is no fallback to a different model. Model-based semantic ranking and
summary generation use GPT-6 Luna too. Token reservations are conservative
admission control, not a guaranteed dollar cap, and hosted search can incur
additional provider charges. Unknown usage remains reserved rather than refunded.

Forget is not forensic erasure: unrelated paraphrases, external copies and
backups may remain. Source chat is retained by default. If a readable projection
cannot refresh, it is marked stale and blocked from tool reads; the API reports
that managed copies could not all be refreshed.

## Dedicated browser

If Chromium launches but public navigation fails with `ENOTFOUND`, run
`npm run doctor:network` in the same terminal as the app. It checks Python's
OS DNS lookup and shows only proxy-setting names, never values.
It does not change DNS/proxy settings
or bypass private-address checks. A browser launch does not prove DNS or page
navigation works.

The smoke test accepts a public target, for example
`npm run test:browser -- https://playwright.dev`. It checks the HTTP response,
readable page snapshot and screenshot. The same public-address validation still
applies; a custom target is not a DNS fallback for a blocked destination.

Check the model connection separately with `npm run test:model`. It makes one
short GPT-6 Luna call with no tools or personal context and reports token usage
without printing credentials. Browser and model connectivity are separate gates.

With `npm run dev` running in another terminal and no other active tasks, run
`npm run test:local` for a live chat/memory/schedule/inbox check. It makes two
short model runs and retains synthetic fixtures for a persistence test. Restart
the server, then run `npm run test:local -- --verify-restart` to verify durable
state and clean up the temporary memory and schedule. Synthetic audit records
are retained; this test does not send email, write calendar events or buy anything.
If a first phase fails after creating fixtures, wait until the queue is idle and
use `npm run test:local -- --cleanup` to remove only its validated test fixtures.

Python Playwright drives a separate `.assistant/browser-profile`. On Windows it
defaults to installed Microsoft Edge. Set `BROWSER_CHANNEL` or
`BROWSER_EXECUTABLE_PATH` only for a browser installation you control; never
point the profile at your everyday Chrome/Edge data.
If using Playwright's bundled Chromium instead of installed Edge, install it
with `.\.venv\Scripts\python.exe -m playwright install chromium` and configure
`BROWSER_CHANNEL=chromium`.

Use Browser -> Start for headless automation, or Open manual window to log in.
Agent browser operations stop during manual control. Return control closes and
reopens the dedicated context; cookies persist, while tab IDs may change.

HTTP request policy blocks local/private destinations and unapproved ordinary
POST writes during headless browsing. It is not OS-level isolation: GET requests
can have side effects, sites may not work under these restrictions, and DNS
checks do not eliminate rebinding races. No arbitrary page-JavaScript tool is
exposed. Browser writes require approvals bound to the observed page URL.

## Google setup

Create a Google Cloud **web application** OAuth client, enable Gmail and
Calendar APIs, configure the consent screen/test users, and register:

```
http://127.0.0.1:8787/oauth/google/callback
```

Use your actual `LOCAL_PORT` if different. Put `GOOGLE_CLIENT_ID` and
`GOOGLE_CLIENT_SECRET` in `.dev.vars`, restart the server, and use Connections.
The UI presents the Google authorization link. Only a real completed consent
flow makes the connection active. Tokens are encrypted on disk and never
returned to the model or status APIs.

Requested scopes cover Gmail read/send and Calendar events. Sending email and
creating events still require a separate exact action approval inside the app.
Spotify, Instagram, Threads, WhatsApp, health and device connectors are not
implemented or activated by this Google connection.

## Files, procedures and execution

Artifacts are confined to `.assistant/workspace`. HTML is displayed as text or
downloaded as an attachment, never executed on the assistant's origin. Managed
memory exports are read-only through generic file operations; edit Memory instead.
Reusable procedures live in workspace `skills/` and require review before saving.
These are data/instructions, not permission grants or installed executable plugins.

No host-shell tool is exposed. Script execution is disabled unless
`ENABLE_DOCKER_EXECUTION=true`; it requires Docker and a preloaded image that
contains the requested interpreter. Containers have no network, a read-only
workspace mount and resource/time limits. Image pulls are not automatic. This
does not provide arbitrary persistent Linux processes, and no VM is required.

PDF/Office document generators, image/video/audio generation, commerce wallets,
side-chat messaging, full relationship graphs, all-history semantic indexing,
fully deferred tool schemas and background push delivery remain later work.
Image/video/audio providers also need a model-policy decision because the
current configuration permits GPT-6 Luna language-model calls exclusively.

## Key API routes

All `/api/*` routes require `Authorization: Bearer <HARNESS_TOKEN>`.

- Chat/history: `/chat`, `/history`.
- Memory: `/memories`, `/memories/:id/lineage`, `/memory/search`, `/memory/files`,
  `/memories/:id/forget`, `/context/compact`, `/dreams/apply`.
- Goals/tasks: `/goals`, `/goals/:id/run`, `/tasks`, `/tasks/:id/cancel`,
  `/tasks/:id/retry`.
- Scheduling/events: `/schedules`, `/hooks` with a stable `eventId`, `/events`.
- Actions: `/actions`, `/approvals/:id/decision` with `expectedDigest`,
  `/approvals/:id/reconcile` with checked outcome/evidence.
- Browser: `/browser/status`, `/browser/launch`, `/browser/close`, `/browser/tabs`,
  `/browser/navigate`, `/browser/snapshot`, `/browser/screenshot`.
- Files/connections: `/files`, `/files/read`, `/files/download`, `/connections`,
  `/connections/google/start`; `/notifications` and `/settings`.

Tests use real SQLite and test adapters for model/browser/provider behavior.
They do not establish live access to Google, OpenAI or Chromium.
