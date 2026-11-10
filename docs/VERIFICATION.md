# Verification ledger

## Python migration — current runtime

The user also passed `test:local -- --verify-restart` against the restarted
Python server: memory, chat, the completed scheduled task and its inbox result
survived. Temporary memory and schedule fixtures were removed; synthetic
chat/task audit records were retained. An initial attempt could not reach the
local API; the subsequent successful retry establishes the restart gate.

The user passed the Python HTTP acceptance checks from their normal terminal:
`test:local` verified authentication, rejected unauthenticated access, saved
memory/source lineage, actual memory-search tool use in chat, one-shot scheduled
execution, duplicate suppression and inbox receipt. `test:approvals` verified
pending/rejected browser actions remain blocked, digest mismatch rejection,
one approved public-page click and replay blocking. `test:workflows` verified
specialists, verifier and synthesizer consume dependency results, persisted
checkpoints, one attempt per agent and one final inbox result. Synthetic audit
records remain. The subsequent restart verification recorded above passed and
removed the temporary local memory/schedule fixtures.

The user subsequently passed both live Python smoke gates in a normal
PowerShell terminal: GPT-6 Luna via the Python Agents SDK returned the expected
marker (226 input tokens, 8 output tokens), and Python Playwright launched the
dedicated Chromium profile, navigated to `https://playwright.dev`, read a page
snapshot and captured a screenshot. FastAPI/Uvicorn then reported successful
startup on `http://127.0.0.1:8787`. Python local/restart, approval and workflow
HTTP acceptance checks were subsequently passed as recorded above.

Retry validation on November 10, 2026 (UTC): 61 Python tests ran, with 60
passing and one Windows symlink test skipped. TypeScript and Python compilation
passed. Artifact writes now retry brief Windows sharing violations, with a
regression test. The React build passed into
`.assistant/python-build-validation`; replacing the existing `dist/index.html`
was denied by the restricted host. Python Playwright installation remains
blocked in this terminal (pip returned no matching distribution), so repeat
live Python acceptance from a normal terminal after installing requirements.

The active service is now Python/FastAPI and OpenAI Agents SDK for Python.
`npm run dev`, `npm test`, `test:model`, `test:browser` and network diagnostics
launch Python. React/Astryx and the HTTP acceptance clients remain frontend/test
code. The retired backend and its tests are isolated in `legacy/typescript`.
Cloudflare deployment commands are disabled until hosted Python integration is
implemented.

Python checks cover actual SDK tool schemas, workflow validation, Toronto DST,
real SQLite, memory provenance/forgetting, approval claims and replay, encrypted
Google vault compatibility with mock HTTP, confined files, browser policies,
parallel dependency joins, retries, cancellation and scheduled execution. Runtime
tests use injected models/browsers and an offline event loop that prohibits
network I/O; it is never used by the application server or live smoke commands.

A closed synthetic database created by the Node implementation was copied into
a Python-created file and resumed. Memory/chat survived and a completed stage
was reused. The restricted test host denied writes when reopening the original
Node-created file directly; that direct in-place handover remains a normal-user
terminal acceptance check. No live assistant database or credentials were
modified by these tests.

Python dependency installation was blocked in the restricted terminal. The user
subsequently ran the Python model, browser, local/restart, approval and workflow
acceptance checks successfully in their normal terminal, as recorded above.
Historical results below describe the retired TypeScript runtime separately.

## TypeScript baseline — historical results

- TypeScript validation has passed after local server/UI integration.
- The component suite has 62 tests: 61 passed, 1 skipped in the last full run.
  The skipped symlink test is blocked by Windows test-symlink permissions.
- Tests exercise real SQLite, memory lineage and forgetting, queued schedules,
  approvals/rejection/replay, stale browser URL checks, uncertain outcomes,
  restart recovery, Google token encryption/refresh (mock HTTP), workspace
  confinement and delivery-selection rules.
- The expanded Astryx frontend compiled in an isolated output directory:
  `npm run build -- --outDir ../.assistant/build-validation`.
  The normal output directory was locked by a running process, so that build
  did not replace the UI served by the existing dev server.
- The new Node server reached its ready log on port 8788. Port 8787 was occupied
  by a previous server. Browser access to the restricted-session listener timed
  out; a terminal localhost request also failed. This is not a completed live UI test.
- GPT-6 Luna connection and response passed in the user's normal terminal
  (222 input tokens, 8 output tokens). The earlier restricted-session attempt
  failed with a connection error.
- `playwright-core` and `cron-parser` were subsequently installed from the user's
  terminal. The real cron parser passed timezone/DST tests for Toronto. The browser
  smoke test passed in the user's normal terminal against `https://playwright.dev`:
  launch, navigation, readable snapshot and screenshot. The default `example.com`
  target fails local OS DNS lookup; the DNS guard remains enabled.
- Google OAuth has not been completed. Client configuration and real account
  consent are required. Mock connector tests are not evidence of an active account.
- No VM was created, no Cloudflare deployment was performed, and no real email,
  calendar write, purchase or script execution was performed during verification.

## Live acceptance sequence

1. Stop the older dev server. Run `npm install`, `npm run check`, `npm test`,
   `npm run build`, then `npm run dev` in a normal local terminal.
2. Connect with the existing local access token. Send a short chat and confirm
   the actual model response, usage ledger and persisted history after restart.
3. Save/correct a memory, inspect Lineage, refresh readable memory exports, and
   verify a dream cannot apply against a newer revision.
4. Start the dedicated browser, navigate to a public test page, inspect text and
   screenshot, then test visible/manual takeover and retained login separately.
5. Propose a harmless browser click. Verify it does not run before approval,
   runs once after approval, rejects a changed page, and records its outcome.
6. Schedule a one-shot task, close the UI, leave the server running, reopen and
   confirm task execution and inbox receipt independently. Repeat across restart.
7. Complete Google consent, verify a bounded read, then create a draft action
   proposal. Send/create only after reviewing the exact destination and payload.

## Limits still under review

- The configured token reservation is admission control, not an exact dollar cap
  or a proof of worst-case model cost. Hosted tool fees are additional.
- Browser request interception is not an operating-system network boundary;
  GET side effects and DNS races remain limitations. Some sites need manual use.
- Readable memory projections can fail to overwrite files under the restricted
  filesystem. SQLite remains authoritative; stale managed files are blocked and
  forgetting reports incomplete projection refresh rather than hiding it.
- Forgetting covers recorded claims, exact known copies and optional known
  source messages. It cannot guarantee removal of paraphrases or backups.
- Source-observation gates do not prove every factual statement true.
- Inbox/desktop notices while open are not push delivery when the app is closed.
- The expanded local implementation has not yet been ported to the Cloudflare
  adapter, and is not presented as Muse parity or production-ready.

## User-terminal browser result

The user ran `npm run test:browser` in their normal PowerShell terminal:
Chromium launched successfully, then the OS-level public-address lookup for
`example.com` returned `ENOTFOUND` before page navigation. Thus launch is now
verified outside the agent sandbox; navigation/snapshot/screenshot remain open.
The `doctor:network` command compares OS lookup and configured-resolver DNS
queries for the browser, OpenAI and npm targets, with no networking changes.
The DNS guard now reports a useful error and its failure/private-answer behavior
is covered by six browser-policy tests. TypeScript validation passes.

The user's network doctor showed `example.com` failing OS lookup while direct
configured-resolver A/AAAA queries succeeded. OpenAI and npm resolved through
all tested methods. This establishes a target/resolver-path difference, not its
cause. The smoke test now accepts a public target without changing the policy;
The user subsequently ran `npm run test:browser -- https://playwright.dev` and
reported success for launch, public navigation, readable snapshot and screenshot.
That browser smoke gate is now verified from their normal terminal. It does not
prove persistent login, arbitrary sites, manual takeover or consequential actions.

The next isolated live gate is `npm run test:model`: one short GPT-6 Luna call
with tools disabled and no personal context. The user ran it successfully:
222 input tokens and 8 output tokens were reported. Model connection/response
is now verified from their normal terminal.

Next is `npm run test:local` against the running Node API. It requires an idle
queue, creates synthetic memory/schedule fixtures, checks a real memory-search
tool call in chat, waits for scheduled execution, and verifies inbox receipt.
Its second phase (`--verify-restart`) requires a new runtime instance and checks
on-disk persistence before cleaning up only its known temporary memory/schedule.
It intentionally retains synthetic chat/task audit records. The user completed
both phases successfully, including restart persistence for memory, chat,
completed scheduled task and inbox result. Temporary memory and schedule were
removed; synthetic chat/task audit records remain.

The user passed `npm run test:approvals` against the running local server.
It selects an observed public Playwright documentation link, verifies pending and
rejected proposals do not navigate, rejects a wrong digest, approves one click,
and checks replay rejection plus a single execution receipt. No model calls or
account writes are made. The public tab and synthetic approval/audit records
remain for inspection. The user reported that pending/rejected proposals left
the page unchanged, a wrong digest was rejected, the approved click completed
once, and replay was blocked. This verifies that public-navigation flow; it
does not verify account writes, browser login persistence or manual takeover.

Next local acceptance checks are visible/manual browser control and dedicated
login persistence across browser relaunch. Use the Browser UI to open the
dedicated window, sign in manually to a chosen account, return control to the
assistant, then close/reopen the dedicated browser and check the session.
Credentials must stay in that browser; do not paste them into chat or files.
Google connector acceptance separately requires OAuth client configuration and
consent. Cloudflare deployment remains deferred.

Local startup now claims SQLite process ownership before recovery. A second
updated server cannot take a live state directory, even if given a different
port. A new component test verifies exclusion and release after a clean shutdown.
Google disconnect also retries transient Windows credential-file locks briefly;
if deletion still fails it reports failure instead of claiming disconnection.

## Workflow agents

Workflow DAG validation, parallel specialist execution, dependency joins,
verification/synthesis ordering, chat creation, read-only enforcement, retry
reuse/limits, cancellation, restart checkpoint recovery, receipt repair and
exact-copy memory forgetting passed with real SQLite and an injected model
runner. The Workflows Astryx UI compiled into
`.assistant/workflow-build-validation`. A subsequent normal `npm run build`
also passed and updated the UI served from `dist`.

`npm run test:workflows` is ready for the running updated local server. It uses
four short real GPT-6 Luna calls with synthetic data, checks each dependency
result, one attempt per stage and one final inbox receipt. The user ran this
gate successfully: specialists completed, verifier and synthesizer consumed
their dependency results, each agent ran once, and one final inbox result was
recorded. This validates the synthetic four-agent live flow; failure/restart
cases remain covered by component tests with an injected runner.
Cloudflare's original workflow adapter has
not been expanded to support these local agent graphs.
