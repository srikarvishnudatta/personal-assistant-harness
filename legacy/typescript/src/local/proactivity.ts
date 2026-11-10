import { createHash } from 'node:crypto';

export function resultFingerprint(text: string) {
  return createHash('sha256').update(text.trim().replace(/\s+/g, ' ')).digest('hex');
}

/** Deterministic delivery gate. This verifies source observation, not truth of every claim. */
export function selectProactiveUpdate(input: { text: string; previousFingerprint?: string; observedUrls: string[]; observedAt?: number; now?: number; requireSources?: boolean }) {
  const now = input.now ?? Date.now();
  const fingerprint = resultFingerprint(input.text);
  if (!input.text.trim()) return { selected: false, reason: 'empty', fingerprint };
  if (fingerprint === input.previousFingerprint) return { selected: false, reason: 'unchanged', fingerprint };
  const claimedUrls = input.text.match(/https?:\/\/[^\s<>"\])]+/g)?.map(url => url.replace(/[.,;:!?]+$/, '')) ?? [];
  if (input.requireSources && !claimedUrls.length) return { selected: false, reason: 'no-source-evidence', fingerprint };
  if (claimedUrls.length && (!input.observedAt || now - input.observedAt > 10 * 60 * 1000)) return { selected: false, reason: 'sources-need-fresh-verification', fingerprint };
  const observed = new Set(input.observedUrls);
  if (claimedUrls.some(url => !observed.has(url))) return { selected: false, reason: 'unobserved-source-link', fingerprint };
  return { selected: true, reason: 'new-result', fingerprint };
}
