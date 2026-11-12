"""Shared formatting, clock and credential-safe error helpers."""
import json
import re
import time

def now_ms(): return int(time.time() * 1000)
def text(value, fallback=''): return value if isinstance(value, str) else fallback
def dump(value): return json.dumps(value, ensure_ascii=False, separators=(',', ':'))
def safe_error(error):
    message = re.sub(r'sk-[A-Za-z0-9_-]+', '[redacted]', str(error) or type(error).__name__)
    return re.sub(r'Bearer\s+\S+', 'Bearer [redacted]', message, flags=re.I)[:800]
