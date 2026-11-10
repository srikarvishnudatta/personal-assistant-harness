"""No-I/O loop for isolated unit tests with fake model/HTTP transports.

This loop cannot register sockets or run the application server. Polling permits
threaded temporary-file work without opening asyncio's loopback wakeup socket.
Real browser/API/model acceptance tests use the normal production event loop.
"""
import asyncio
import selectors
import time
import unittest
import tempfile


class RetryTemporaryDirectory(tempfile.TemporaryDirectory):
    """Windows scanners can briefly hold a just-closed fixture file."""
    def cleanup(self):
        for attempt in range(8):
            try: return super().cleanup()
            except PermissionError as error:
                if getattr(error,'winerror',None) not in (32,33) or attempt==7: raise
                time.sleep(.05*(attempt+1))


class _NoIOSelector(selectors.BaseSelector):
    def register(self, *args, **kwargs): raise RuntimeError('Offline tests cannot register network I/O')
    def unregister(self, *args, **kwargs): raise RuntimeError('Offline tests cannot register network I/O')
    def select(self, timeout=None):
        time.sleep(min(0.01, max(0, timeout if timeout is not None else 0.01)))
        return []
    def get_map(self): return {}
    def close(self): pass


class OfflineLoop(asyncio.SelectorEventLoop):
    def __init__(self): super().__init__(selector=_NoIOSelector())
    def _make_self_pipe(self): self._ssock = self._csock = None
    def _close_self_pipe(self): pass
    def _write_to_self(self): pass


class OfflineAsyncCase(unittest.IsolatedAsyncioTestCase):
    def _setupAsyncioRunner(self): self._asyncioRunner = asyncio.Runner(debug=True, loop_factory=OfflineLoop)
