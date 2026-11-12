"""Generate the offline project guide from the checked-in documentation."""
from pathlib import Path
import json
import re

ROOT = Path(__file__).resolve().parents[1]
modules = {
    'server': ('API boundary', 'FastAPI serves the React build, checks loopback hosts and enforces request limits.'),
    'runtime': ('Coordinator', 'Chat, queue dispatch, tool operations, recovery, approval execution and inbox delivery.'),
    'agent': ('Model runner', 'OpenAI Agents SDK for Python; GPT-6 Luna only, bounded turns and usage callbacks.'),
    'store': ('Durable state', 'SQLite transactions, claims, revisions, workflow checkpoints, usage and audit.'),
    'workflows': ('Agent teams', 'Validated dependency graphs, parallel specialists, verifier and synthesis.'),
    'browser': ('Dedicated browser', 'Python Playwright, persistent assistant profile, public URL checks and manual takeover.'),
    'memory': ('Readable memory', 'Managed curated memory, daily notes and person notes projected from SQLite.'),
    'scheduling': ('Scheduling', 'One-shot, interval and timezone cron; missed-tick coalescing.'),
    'proactivity': ('Delivery policy', 'Repeat suppression and source-observation gates for selective updates.'),
    'connectors': ('Google services', 'OAuth PKCE, encrypted refresh tokens, Gmail and Calendar; real consent still required.'),
    'workspace': ('Files and execution', 'Confined artifacts and reviewed procedures; explicitly enabled Docker scripts.'),
    'config': ('Configuration', 'Local settings and model policy; secrets are excluded from status output.'),
    'knowledge': ('Knowledge services', 'All-history FTS indexing with Luna ranking, sourced people graph and durable repairs.'),
    'freshness': ('Claim support review', 'Per-source re-reading, fingerprints, bounded claim review and held-update repairs.'),
    'providers': ('Provider registry', 'Encrypted authorization, fixed provider operations and account-bound reviewed writes.'),
}
docs = {name: (ROOT / file).read_text(encoding='utf-8') for name, file in {
    'Read me': 'README.md', 'Architecture': 'docs/ARCHITECTURE.md',
    'Roadmap': 'docs/PLAN.md', 'Verification': 'docs/VERIFICATION.md',
    'Knowledge & providers': 'docs/KNOWLEDGE-AND-PROVIDERS.md',
}.items()}
runtime = (ROOT / 'backend/src/harness/api/routes.py').read_text(encoding='utf-8')
routes = sorted(set(re.findall(r"route == '([^']+)'", runtime)))
module_paths = {'config': 'backend/src/harness/core/config.py', 'server': 'backend/src/harness/api/server.py', 'frontend': 'backend/src/harness/api/frontend.py', 'runtime': 'backend/src/harness/application/runtime.py', 'agent': 'backend/src/harness/agents/runner.py', 'workflows': 'backend/src/harness/agents/workflows.py', 'store': 'backend/src/harness/persistence/store.py', 'knowledge': 'backend/src/harness/knowledge/index.py', 'memory': 'backend/src/harness/knowledge/memory.py', 'freshness': 'backend/src/harness/knowledge/freshness.py', 'proactivity': 'backend/src/harness/scheduling/proactivity.py', 'scheduling': 'backend/src/harness/scheduling/cron.py', 'browser': 'backend/src/harness/integrations/browser.py', 'connectors': 'backend/src/harness/integrations/google.py', 'providers': 'backend/src/harness/integrations/providers.py', 'workspace': 'backend/src/harness/workspace/files.py', 'smoke_model': 'backend/src/harness/cli/smoke_model.py', 'smoke_browser': 'backend/src/harness/cli/smoke_browser.py', 'smoke_knowledge': 'backend/src/harness/cli/smoke_knowledge.py', 'network_doctor': 'backend/src/harness/cli/network_doctor.py'}
payload = {'docs': docs, 'modules': modules, 'routes': routes, 'modulePaths': module_paths}
template = (ROOT / 'docs/project-guide.template.html').read_text(encoding='utf-8')
output = template.replace('__PROJECT_DATA__', json.dumps(payload, ensure_ascii=True).replace('<', '\\u003c'))
(ROOT / 'docs/project-guide.html').write_text(output, encoding='utf-8')
print('Generated docs/project-guide.html')
