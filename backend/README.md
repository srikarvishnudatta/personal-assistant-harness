# Backend

Python/FastAPI service packaged from `src/harness/`. Dependencies live in
`pyproject.toml`; the root uv workspace and `uv.lock` manage the shared `.venv`.
No root npm project, requirements files or manual `PYTHONPATH` are needed.

From the repository root:

```bash
uv sync --all-packages --locked
uv run --directory backend playwright install chromium
uv run --directory backend harness-server
```

From this directory, use `uv run harness-server`. Configuration and data always
resolve from the checkout root (`.dev.vars`, `.assistant/`), or `HARNESS_ROOT`
when explicitly set. Configure `.dev.vars` using the root example. The optional
static adapter serves `frontend/dist`; set `SERVE_FRONTEND=false` for API-only
mode, or `FRONTEND_DIST_DIR` to override the build directory.

```text
src/harness/
  api/           HTTP guards, route dispatch and optional frontend adapter
  application/   Runtime coordination, queues and action lifecycle
  agents/        Capability contracts, tools, SDK runner and workflow graphs
  core/          Configuration and shared callback/error utilities
  persistence/   SQLite state and transaction boundaries
  knowledge/     History index, people graph, memory projections and freshness
  scheduling/    Cron/interval calculations and proactive delivery policy
  integrations/  Dedicated browser, Google and other provider connections
  workspace/     Confined artifact files and optional Docker execution
  cli/           Model/browser/knowledge smoke checks and network diagnostics
tests/           Unit, component and HTTP tests with isolated fixtures
```

From the repository root:

```bash
uv run --directory backend python -m unittest discover -s tests -t . -v
uv run --directory backend python -m compileall -q src
uv run --directory backend python -m harness.cli.smoke_model
uv run --directory backend python -m harness.cli.smoke_browser https://playwright.dev
uv run --directory backend python -m harness.cli.network_doctor
```

Unit/component tests use injected models/transports. The legacy SQLite migration
fixture test additionally uses Node 22.18+; normal backend execution does not.
Smoke commands use real services and may incur model usage. Change dependencies
with `uv add --package personal-assistant-harness-backend <package>` and commit
both the manifest and root lockfile.
