"""Delivery selection verifies observed sources, not every factual claim."""
import hashlib
import re
import time


def select_update(text, previous_fingerprint=None, observed_urls=(), observed_at=None, require_sources=False, now=None):
    fingerprint = hashlib.sha256(re.sub(r'\s+', ' ', text.strip()).encode()).hexdigest()
    def result(selected, reason): return dict(selected=selected, reason=reason, fingerprint=fingerprint)
    if not text.strip(): return result(False, 'empty')
    if fingerprint == previous_fingerprint: return result(False, 'unchanged')
    urls = [url.rstrip('.,;:!?') for url in re.findall(r'https?://[^\s<>"\])]+', text)]
    if require_sources and not urls: return result(False, 'no-source-evidence')
    if urls and (not observed_at or (now or time.time() * 1000) - observed_at > 600000): return result(False, 'sources-need-fresh-verification')
    if any(url not in observed_urls for url in urls): return result(False, 'unobserved-source-link')
    return result(True, 'new-result')
