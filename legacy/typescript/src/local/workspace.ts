import { promises as fs, mkdirSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';

const MAX_BYTES = 1024 * 1024;
const EXTENSIONS = new Set(['.md', '.txt', '.json', '.csv', '.html', '.py', '.js', '.mjs', '.css', '.svg']);

export interface WorkspaceEntry { path: string; name: string; directory: boolean; size: number }
export interface ScriptRequest { path: string; language: 'python' | 'node'; args?: string[] }
export interface ScriptResult { exitCode: number | null; stdout: string; stderr: string; timedOut: boolean }

/** This is a confined artifact directory, not access to the user's home directory. */
export class WorkspaceService {
  readonly root: string;
  private options: { dockerEnabled?: boolean; dockerImage?: string };
  constructor(root: string, options: { dockerEnabled?: boolean; dockerImage?: string } = {}) {
    mkdirSync(root, { recursive: true });
    this.root = realpathSync(root);
    this.options = options;
  }
  private relative(input: string, allowEmpty = false): string {
    if (typeof input !== 'string' || (!input && !allowEmpty) || input.length > 500 || /[\\:\x00-\x1f]/.test(input) || path.isAbsolute(input))
      throw new Error('Invalid workspace path');
    if (!input && allowEmpty) return '';
    const pieces = input.split('/');
    if (pieces.some(piece => !piece || piece.startsWith('.') || piece.endsWith('.') || piece.endsWith(' ') || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(piece)))
      throw new Error('Hidden, reserved, or traversing paths are not allowed');
    return pieces.join('/');
  }
  private async checked(input: string, createParents = false, allowEmpty = false): Promise<string> {
    const relative = this.relative(input, allowEmpty);
    let current = this.root;
    const parts = relative ? relative.split('/') : [];
    for (let index = 0; index < parts.length; index++) {
      current = path.join(current, parts[index]!);
      try {
        const stat = await fs.lstat(current);
        if (stat.isSymbolicLink()) throw new Error('Workspace symlinks are not allowed');
        if (index < parts.length - 1 && !stat.isDirectory()) throw new Error('Workspace parent must be a directory');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        if (index < parts.length - 1) {
          if (!createParents) throw error;
          await fs.mkdir(current);
        }
      }
    }
    const resolved = path.resolve(current);
    if (resolved !== this.root && !resolved.startsWith(this.root + path.sep)) throw new Error('Path escapes workspace');
    return resolved;
  }
  async list(relative = ''): Promise<WorkspaceEntry[]> {
    const directory = await this.checked(relative, false, true);
    const entries = await fs.readdir(directory, { withFileTypes: true });
    const result: WorkspaceEntry[] = [];
    for (const entry of entries.slice(0, 500)) {
      if (entry.name.startsWith('.') || entry.isSymbolicLink()) continue;
      const stat = await fs.lstat(path.join(directory, entry.name));
      if (stat.isSymbolicLink()) continue;
      result.push({ path: [relative, entry.name].filter(Boolean).join('/'), name: entry.name, directory: entry.isDirectory(), size: stat.size });
    }
    return result;
  }
  async read(relative: string): Promise<{ path: string; content: string; size: number }> {
    const target = await this.checked(relative);
    if (!EXTENSIONS.has(path.extname(target).toLowerCase())) throw new Error('Unsupported artifact type');
    const handle = await fs.open(target, 'r');
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > MAX_BYTES) throw new Error('Artifact exceeds the 1 MiB limit');
      const content = await handle.readFile('utf8');
      if (Buffer.byteLength(content) > MAX_BYTES) throw new Error('Artifact exceeds the 1 MiB limit');
      return { path: relative, content, size: stat.size };
    } finally { await handle.close(); }
  }
  async write(relative: string, content: string): Promise<{ path: string; size: number }> {
    if (typeof content !== 'string' || Buffer.byteLength(content) > MAX_BYTES) throw new Error('Artifact exceeds the 1 MiB limit');
    if (!EXTENSIONS.has(path.extname(relative).toLowerCase())) throw new Error('Unsupported artifact type');
    const target = await this.checked(relative, true);
    const temporary = path.join(path.dirname(target), `.write-${randomUUID()}`);
    await fs.writeFile(temporary, content, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    try { await fs.rename(temporary, target); }
    catch (error) { await fs.unlink(temporary).catch(() => {}); throw error; }
    return { path: relative, size: Buffer.byteLength(content) };
  }
  async saveSkill(name: string, content: string) {
    if (!/^[a-z0-9][a-z0-9-]{0,79}$/.test(name)) throw new Error('Procedure name must use lowercase letters, numbers, and hyphens');
    // These are user-reviewed assistant procedures, not executable plugins.
    return this.write(`skills/${name}.md`, content);
  }
  /** Only a single validated regular file, never recursive deletion. */
  async remove(relative: string): Promise<void> {
    const target = await this.checked(relative);
    const stat = await fs.lstat(target);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Only regular workspace files can be removed');
    await fs.unlink(target);
  }
  async listSkills(): Promise<WorkspaceEntry[]> { return this.list('skills').catch(error => { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }); }
  async readSkill(name: string) {
    if (!/^[a-z0-9][a-z0-9-]{0,79}$/.test(name)) throw new Error('Invalid procedure name');
    return this.read(`skills/${name}.md`);
  }
  async executeScript(request: ScriptRequest): Promise<ScriptResult> {
    if (!this.options.dockerEnabled) throw new Error('Isolated script execution is disabled. Enable Docker explicitly in local settings.');
    if (request.language !== 'python' && request.language !== 'node') throw new Error('Unsupported script language');
    if (!Array.isArray(request.args ?? []) || (request.args ?? []).length > 20 || (request.args ?? []).some(arg => typeof arg !== 'string' || arg.length > 500)) throw new Error('Invalid script arguments');
    await this.read(request.path);
    const expected = request.language === 'python' ? '.py' : ['.js', '.mjs'];
    if (typeof expected === 'string' ? !request.path.endsWith(expected) : !expected.some(ext => request.path.endsWith(ext))) throw new Error('Script extension does not match language');
    const image = this.options.dockerImage || (request.language === 'python' ? 'python:3.12-alpine' : 'node:22-alpine');
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_./:@-]*$/.test(image)) throw new Error('Invalid Docker image');
    const container = `assistant-script-${randomUUID()}`;
    const args = ['run', '--rm', '--pull=never', '--name', container, '--network=none', '--read-only', '--memory=256m', '--cpus=1', '--pids-limit=64', '--cap-drop=ALL', '--security-opt=no-new-privileges', '--user=65534:65534', '--tmpfs=/tmp:rw,noexec,nosuid,size=32m', '--mount', `type=bind,src=${this.root},dst=/workspace,readonly`, '--workdir=/workspace', image, request.language === 'python' ? 'python' : 'node', `/workspace/${request.path}`, ...(request.args ?? [])];
    return new Promise((resolve, reject) => {
      const child = spawn('docker', args, { shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '', stderr = '', timedOut = false;
      const append = (current: string, data: Buffer) => (current + data.toString('utf8')).slice(0, 65536);
      child.stdout.on('data', data => { stdout = append(stdout, data); });
      child.stderr.on('data', data => { stderr = append(stderr, data); });
      const timer = setTimeout(() => {
        timedOut = true;
        const cleanup = spawn('docker', ['rm', '-f', container], { shell: false, windowsHide: true, stdio: 'ignore' });
        cleanup.on('error', () => {});
        child.kill();
      }, 30000);
      child.on('error', () => { clearTimeout(timer); reject(new Error('Docker is unavailable. Install Docker and preload the selected image; automatic image pulls are disabled.')); });
      child.on('close', exitCode => { clearTimeout(timer); resolve({ exitCode, stdout, stderr, timedOut }); });
    });
  }
}
