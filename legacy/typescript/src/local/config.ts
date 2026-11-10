import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/** Load only application settings; never return credential values in status APIs. */
export function loadLocalConfig(root = process.cwd()) {
  let file = '';
  try { file = readFileSync(resolve(root, '.dev.vars'), 'utf8'); } catch { /* Env-only configuration is supported. */ }
  const values: Record<string, string> = {};
  for (const line of file.split(/\r?\n/)) {
    const match = /^\s*([A-Z][A-Z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (match) values[match[1]!] = match[2]!.replace(/^(['"])(.*)\1$/, '$2');
  }
  const get = (key: string, fallback = '') => process.env[key] ?? values[key] ?? fallback;
  if (get('OPENAI_MODEL', 'gpt-6-luna') !== 'gpt-6-luna') throw new Error('Only gpt-6-luna is permitted. Correct OPENAI_MODEL.');
  const port = Number(get('LOCAL_PORT', '8787'));
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('LOCAL_PORT must be between 1024 and 65535');
  return {
    root, port, dataDir: resolve(root, get('ASSISTANT_DATA_DIR', '.assistant')),
    token: get('HARNESS_TOKEN'), apiKey: get('OPENAI_API_KEY'), model: 'gpt-6-luna' as const,
    googleClientId: get('GOOGLE_CLIENT_ID'), googleClientSecret: get('GOOGLE_CLIENT_SECRET'),
    encryptionSecret: get('CREDENTIAL_KEY', get('HARNESS_TOKEN')),
    browserExecutable: get('BROWSER_EXECUTABLE_PATH') || undefined,
    browserChannel: get('BROWSER_CHANNEL') || undefined,
    dockerEnabled: get('ENABLE_DOCKER_EXECUTION') === 'true',
    dockerImage: get('DOCKER_IMAGE', 'python:3.12-slim'),
    dailyTokenLimit: Number(get('DAILY_TOKEN_LIMIT', '200000')),
    runTokenReservation: Number(get('RUN_TOKEN_RESERVATION', '100000')),
  };
}
export type LocalConfig = ReturnType<typeof loadLocalConfig>;
