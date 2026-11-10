// Process launcher only. All agent behavior lives in backend/harness/*.py.
import { existsSync } from 'node:fs';
import { delimiter, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const localPython = resolve(root, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
const executable = process.env.PYTHON_EXECUTABLE || (existsSync(localPython) ? localPython : 'python');
const commands = {
  server: ['-m', 'harness.server'],
  test: ['-m', 'unittest', 'discover', '-s', 'backend/tests', '-v'],
  check: ['-m', 'compileall', '-q', 'backend'],
  model: ['-m', 'harness.smoke_model'],
  browser: ['-m', 'harness.smoke_browser'],
  network: ['-m', 'harness.network_doctor'],
  knowledge: ['-m', 'harness.smoke_knowledge'],
};
const operation = process.argv[2];
if (!(operation in commands)) throw new Error('Unknown Python command');
const child = spawn(executable, [...commands[operation], ...process.argv.slice(3)], {
  cwd: root, stdio: 'inherit', shell: false,
  env: { ...process.env, PYTHONPATH: [resolve(root, 'backend'), root, process.env.PYTHONPATH].filter(Boolean).join(delimiter), PYTHONUNBUFFERED: '1' },
});
child.on('error', () => { console.error('Python could not start. Install Python 3.12+ and the dependencies in requirements.txt.'); process.exitCode = 1; });
child.on('exit', code => { process.exitCode = code ?? 1; });
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => {
  // Windows console signals already reach the child. Avoid force-terminating it
  // before Python can checkpoint and release its SQLite ownership lease.
  if (process.platform !== 'win32') child.kill(signal);
});
