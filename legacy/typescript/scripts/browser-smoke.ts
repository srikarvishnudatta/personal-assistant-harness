import assert from 'node:assert/strict';
import { loadLocalConfig } from '../src/local/config.ts';
import { BrowserService, validateBrowserUrl } from '../src/local/browser.ts';
import { resolve } from 'node:path';

const config = loadLocalConfig();
const target = process.argv[2] ?? 'https://example.com';
const browser = new BrowserService({ profileDir: resolve(config.dataDir, 'browser-profile'), executablePath: config.browserExecutable, channel: config.browserChannel });
try {
  const targetUrl = validateBrowserUrl(target);
  await browser.launch();
  console.log('Dedicated Chromium launched.');
  console.log('Checking public origin:', targetUrl.origin);
  const tab = await browser.navigate(target);
  assert.ok(tab.status !== null && tab.status >= 200 && tab.status < 400, `Navigation returned HTTP ${tab.status ?? 'unknown'}`);
  const page = await browser.snapshot(tab.id);
  assert.ok(page.text.trim().length > 0, 'Page snapshot contains no readable text');
  if (targetUrl.hostname === 'example.com' && targetUrl.pathname === '/') assert.match(page.text, /Example Domain/);
  const screenshot = await browser.screenshot(tab.id);
  assert.ok(screenshot.base64.length > 100);
  console.log('Public navigation, page snapshot and screenshot passed.');
} catch (error) {
  console.error('Browser smoke test failed:', error instanceof Error ? error.message : 'Unknown failure');
  process.exitCode = 1;
} finally { await browser.close(); }
