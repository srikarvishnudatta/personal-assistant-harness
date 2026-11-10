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
}
docs = {name: (ROOT / file).read_text(encoding='utf-8') for name, file in {
    'Read me': 'README.md', 'Architecture': 'docs/ARCHITECTURE.md',
    'Roadmap': 'docs/PLAN.md', 'Verification': 'docs/VERIFICATION.md',
}.items()}
runtime = (ROOT / 'backend/harness/runtime.py').read_text(encoding='utf-8')
routes = sorted(set(re.findall(r"route == '([^']+)'", runtime)))
payload = {'docs': docs, 'modules': modules, 'routes': routes}
template = (ROOT / 'docs/project-guide.template.html').read_text(encoding='utf-8')
output = template.replace('__PROJECT_DATA__', json.dumps(payload, ensure_ascii=True).replace('<', '\\u003c'))
(ROOT / 'docs/project-guide.html').write_text(output, encoding='utf-8')
print('Generated docs/project-guide.html')
