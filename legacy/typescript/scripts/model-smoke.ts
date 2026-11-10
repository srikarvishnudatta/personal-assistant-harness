import assert from 'node:assert/strict';
import { loadLocalConfig } from '../src/local/config.ts';
import { runAssistant } from '../src/agent.ts';

const config = loadLocalConfig();
try {
  if (!config.apiKey) throw new Error('OPENAI_API_KEY is missing from .dev.vars');
  console.log('Testing GPT-6 Luna through the Agents SDK (one short API call, no personal context or tools).');
  let usage: { inputTokens: number; outputTokens: number } | undefined;
  const unavailable = async (): Promise<never> => { throw new Error('Tools are disabled for this connectivity test'); };
  const result = await runAssistant(
    { OPENAI_API_KEY: config.apiKey, OPENAI_MODEL: config.model },
    'Reply with exactly MODEL_SMOKE_OK and nothing else.',
    'Connectivity test only. No personal context.',
    { readOnly: true, maxTurns: 1, remember: unavailable, schedule: unavailable, signal: AbortSignal.timeout(45000), onUsage: (inputTokens, outputTokens) => { usage = { inputTokens, outputTokens }; } },
  );
  assert.equal(result.trim(), 'MODEL_SMOKE_OK', 'Model responded, but the expected connectivity marker was not returned');
  console.log('GPT-6 Luna connection and response passed.');
  if (usage) console.log('Reported token usage:', JSON.stringify(usage));
} catch (error) {
  let message = error instanceof Error ? error.message : 'Unknown failure';
  for (const secret of [config.apiKey, config.token, config.encryptionSecret]) if (secret) message = message.replaceAll(secret, '[redacted]');
  message = message.replace(/sk-[A-Za-z0-9_-]+/g, '[redacted]').replace(/Bearer\s+\S+/gi, 'Bearer [redacted]');
  const status = (error as { status?: number }).status;
  console.error(`Model smoke test failed${status ? ` (HTTP ${status})` : ''}:`, message.slice(0, 800));
  process.exitCode = 1;
}
