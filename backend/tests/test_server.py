"""HTTP boundary and lifecycle tests; all state is confined to temp dirs."""
import tempfile
import unittest
from pathlib import Path

import httpx
from fastapi.responses import JSONResponse

from tests.offline_loop import OfflineAsyncCase
from harness.core.config import Config
from harness.api.server import MAX_REQUEST_BYTES, RequestGuards, create_app


class FakeRuntime:
    instances = []

    def __init__(self, config, store=None):
        self.store = store
        self.started = False
        self.closed = False
        self.calls = []
        self.__class__.instances.append(self)

    async def start(self):
        self.started = True

    async def close(self):
        self.closed = True

    async def dispatch(self, method, path, body, query):
        self.calls.append((method, path, body, query))
        return JSONResponse({"method": method, "path": path, "body": body, "query": query})


class ServerTests(OfflineAsyncCase):
    async def asyncSetUp(self):
        self.tmp = tempfile.TemporaryDirectory(dir=Path.cwd())
        self.root = Path(self.tmp.name)
        self.config = Config(root=self.root, data_dir=self.root / ".assistant", port=8787,
                             token="x" * 32)
        self.dist = self.root / "frontend" / "dist"
        self.dist.mkdir(parents=True)
        (self.dist / "index.html").write_text("<h1>Local assistant</h1>", encoding="utf-8")
        (self.dist / "app.js").write_text("console.log('ok')", encoding="utf-8")
        FakeRuntime.instances.clear()
        self.app = create_app(self.config, FakeRuntime)
        self.lifespan = self.app.router.lifespan_context(self.app)
        await self.lifespan.__aenter__()
        self.transport = httpx.ASGITransport(app=self.app)
        self.client = httpx.AsyncClient(transport=self.transport, base_url="http://127.0.0.1:8787")

    async def asyncTearDown(self):
        await self.client.aclose()
        if self.lifespan is not None:
            await self.lifespan.__aexit__(None, None, None)
        from harness.workspace.files import _retry_sharing_violation
        _retry_sharing_violation(self.tmp.cleanup)

    async def test_api_only_mode_does_not_serve_frontend(self):
        self.config.serve_frontend = False
        app = create_app(self.config, FakeRuntime)
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app),
                                     base_url="http://127.0.0.1:8787") as client:
            self.assertEqual((await client.get("/")).status_code, 404)
            self.assertEqual((await client.get("/health")).status_code, 200)

    async def test_auth_public_paths_and_lifecycle(self):
        self.assertEqual((await self.client.get("/health")).status_code, 200)
        self.assertEqual((await self.client.get("/api/status")).status_code, 401)
        good = await self.client.get("/api/status", headers={"Authorization": f"Bearer {self.config.token}"})
        self.assertEqual(good.status_code, 200)
        await self.client.delete("/api/tasks/123", headers={"Authorization": f"Bearer {self.config.token}"})
        callback = await self.client.get("/oauth/google/callback?code=c&state=s")
        self.assertEqual(callback.status_code, 200)
        runtime = FakeRuntime.instances[-1]
        self.assertTrue(runtime.started)
        self.assertIn(("DELETE", "/api/tasks/123", {}, {}), runtime.calls)
        self.assertEqual(runtime.calls[-1], ("GET", "/oauth/google/callback", {}, {"code": "c", "state": "s"}))
        await self.lifespan.__aexit__(None, None, None)
        self.assertTrue(runtime.closed)
        self.lifespan = None

    async def test_host_rejects_non_loopback_and_wrong_port(self):
        self.assertEqual((await self.client.get("/health", headers={"Host": "evil.example:8787"})).status_code, 400)
        self.assertEqual((await self.client.get("/health", headers={"Host": "127.0.0.1:8788"})).status_code, 400)
        self.assertEqual((await self.client.get("/health", headers={"Host": "localhost:8787"})).status_code, 200)

    async def test_body_size_limit_and_security_headers(self):
        response = await self.client.post("/api/run", content=b"x" * (MAX_REQUEST_BYTES + 1),
                                          headers={"Authorization": f"Bearer {self.config.token}"})
        self.assertEqual(response.status_code, 413)
        normal = await self.client.get("/health")
        self.assertEqual(normal.headers["x-content-type-options"], "nosniff")
        self.assertEqual(normal.headers["x-frame-options"], "DENY")
        self.assertEqual(normal.headers["referrer-policy"], "no-referrer")
        self.assertEqual(normal.headers["cache-control"], "no-store")

    async def test_chunked_body_limit_stops_before_route_dispatch(self):
        called = False
        async def app(scope, receive, send):
            nonlocal called
            called = True
        chunks = [b"a" * 40_000, b"b" * 30_000]
        async def receive():
            part = chunks.pop(0)
            return {"type": "http.request", "body": part, "more_body": bool(chunks)}
        sent = []
        async def send(message):
            sent.append(message)
        scope = {"type": "http", "method": "POST", "headers": [(b"host", b"127.0.0.1:8787")]}
        await RequestGuards(app, 8787)(scope, receive, send)
        self.assertFalse(called)
        self.assertEqual(sent[0]["status"], 413)

    async def test_static_fallback_and_confined_file_resolution(self):
        (self.root / "secret.txt").write_text("secret", encoding="utf-8")
        self.assertIn("Local assistant", (await self.client.get("/")).text)
        self.assertEqual((await self.client.get("/nested/client/route")).status_code, 200)
        self.assertIn("console.log", (await self.client.get("/app.js")).text)
        escaped = await self.client.get("/%2e%2e/secret.txt")
        self.assertNotIn("secret", escaped.text)
        self.assertIn(escaped.status_code, (200, 404))

    async def test_no_cors_headers_are_added(self):
        response = await self.client.get("/health", headers={"Origin": "https://attacker.example"})
        self.assertNotIn("access-control-allow-origin", response.headers)


if __name__ == "__main__":
    unittest.main()
