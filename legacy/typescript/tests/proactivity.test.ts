import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resultFingerprint, selectProactiveUpdate } from '../src/local/proactivity.ts';

test('proactivity skips unchanged results and sources not observed during execution', () => {
  assert.equal(selectProactiveUpdate({ text: 'No changes', previousFingerprint: resultFingerprint('No changes'), observedUrls: [] }).reason, 'unchanged');
  const text = 'Update from https://example.com/news';
  assert.equal(selectProactiveUpdate({ text, observedUrls: [], observedAt: Date.now() }).selected, false);
  assert.equal(selectProactiveUpdate({ text, observedUrls: ['https://example.com/news'], observedAt: Date.now() - 11 * 60000 }).selected, false);
  assert.equal(selectProactiveUpdate({ text, observedUrls: ['https://example.com/news'], observedAt: Date.now() }).selected, true);
  assert.equal(selectProactiveUpdate({ text: 'An uncited research claim', observedUrls: [], requireSources: true }).selected, false);
});
