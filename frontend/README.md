# Frontend

Standalone React/Astryx app. Run npm commands inside this directory, or use
`npm --prefix frontend ...` from the repository root. Dependencies and build
output belong here; there is no root npm project.

```bash
npm ci
npm run dev
npm run check
npm run build
```

The backend starts separately with `uv run --directory backend harness-server`
from the repository root. Vite proxies `/api`, `/oauth` and `/health` to
`http://127.0.0.1:8787`. Set `HARNESS_API_ORIGIN` in the Vite process to override
that address. The static build uses same-origin API requests and is served by
the backend's optional static adapter. Enter the access token in the UI.

```text
src/
  app/          App shell, navigation and session wiring
  api/          HTTP client and shared API types
  components/   Shared presentation components
  features/     Chat, memory, workflows, browser, approvals and other screens
  hooks/        Resource loading and action state
  lib/          Formatting and session utilities
  styles/       Global styles
  main.tsx      React entry point
tests/
  acceptance/   Live HTTP clients and server configuration for smoke checks
```

`npm run check` checks application and acceptance-client types. With the API
running, `npm run test:local`, `npm run test:approvals` and
`npm run test:workflows` perform live acceptance checks. They may make model
calls; the approval check performs one explicitly approved public-page click.
Configuration is read from the repository root `.dev.vars`, never Vite's bundle.
No provider writes are made by these smoke checks.
