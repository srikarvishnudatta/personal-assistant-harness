import asyncio
import base64
import hashlib
import json
import tempfile
import time
import unittest
from pathlib import Path

import httpx
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

from harness.integrations.google import GoogleConnector, SCOPES
from tests.offline_loop import OfflineAsyncCase


SECRET = "test-encryption-secret-long-enough"


class GoogleConnectorTests(OfflineAsyncCase):
    def setUp(self):
        # Keep temp files under the checked-out workspace. The Windows
        # restricted temp container allows top-level file creation but denies
        # writes inside Python-created nested temp folders.
        self.temp = tempfile.TemporaryDirectory(dir=Path(__file__).parent)
        self.vault = Path(self.temp.name) / "google.json"
        self.requests = []

    def tearDown(self):
        self.temp.cleanup()

    def client(self, handler):
        async def async_handler(request):
            result = handler(request)
            if asyncio.iscoroutine(result):
                result = await result
            return result
        return httpx.AsyncClient(transport=httpx.MockTransport(async_handler))

    def seed_tokens(self, tokens):
        iv = bytes(range(12))
        sealed = AESGCM(hashlib.sha256(SECRET.encode()).digest()).encrypt(iv, json.dumps(tokens).encode(), None)
        self.vault.write_text(json.dumps({"version": 1, "iv": base64.b64encode(iv).decode(),
            "tag": base64.b64encode(sealed[-16:]).decode(), "encrypted": base64.b64encode(sealed[:-16]).decode()}))

    def connector(self, handler, **kwargs):
        client = self.client(handler)
        self.addAsyncCleanup(client.aclose)
        return GoogleConnector("client-id", "client-secret", "http://127.0.0.1/callback",
                               self.vault, SECRET, http_client=client, **kwargs)

    async def test_auth_pkce_state_single_use_and_compatible_vault(self):
        def handler(request):
            self.requests.append(request)
            return httpx.Response(200, json={"access_token": "access", "refresh_token": "refresh",
                                             "expires_in": 3600, "scope": " ".join(SCOPES)})
        c = self.connector(handler)
        auth = c.begin_auth()
        self.assertIn("code_challenge_method=S256", auth["url"])
        self.assertIn("gmail.readonly", auth["url"])
        self.assertEqual(await c.complete_auth("code-value", auth["state"]), {"connected": True})
        saved = json.loads(self.vault.read_text())
        self.assertEqual(set(saved), {"version", "iv", "tag", "encrypted"})
        self.assertEqual(await c.status(), {"provider": "google", "configured": True, "connected": True,
                                          "scopes": SCOPES, "redirectUri": "http://127.0.0.1/callback"})
        with self.assertRaisesRegex(ValueError, "Invalid or expired OAuth state"):
            await c.complete_auth("code-value", auth["state"])

    async def test_old_typescript_envelope_is_readable_and_mail_is_normalized(self):
        self.seed_tokens({"access_token": "old-access", "refresh_token": "refresh",
                          "expires_at": time.time() * 1000 + 600_000, "scope": "scope-a scope-b"})
        body = base64.urlsafe_b64encode(b"Hello, world").decode().rstrip("=")
        def handler(request):
            self.requests.append(request)
            return httpx.Response(200, json={"id": "m-1", "threadId": "t-1", "snippet": "Hi",
                "payload": {"headers": [{"name": "From", "value": "a@example.com"}, {"name": "X", "value": "no"}],
                            "mimeType": "multipart/alternative", "parts": [{"mimeType": "text/plain", "body": {"data": body}}]}})
        c = self.connector(handler)
        result = await c.read_mail("m-1")
        self.assertEqual(result, {"id": "m-1", "threadId": "t-1", "snippet": "Hi",
            "headers": [{"name": "From", "value": "a@example.com"}], "body": "Hello, world"})
        self.assertEqual(self.requests[0].headers["Authorization"], "Bearer old-access")

    async def test_refresh_is_serialized_and_mail_query_clamped(self):
        self.seed_tokens({"access_token": "old", "refresh_token": "refresh", "expires_at": 0, "scope": "s"})
        refreshes = 0
        def handler(request):
            nonlocal refreshes
            self.requests.append(request)
            if request.url.path.endswith("/token"):
                refreshes += 1
                time.sleep(.02)
                return httpx.Response(200, json={"access_token": "new", "expires_in": 3600})
            return httpx.Response(200, json={"messages": []})
        c = self.connector(handler)
        await asyncio.gather(c.list_mail("from:a@example.com", 100), c.list_mail("", 0))
        self.assertEqual(refreshes, 1)
        list_requests = [r for r in self.requests if r.url.path.endswith("/messages")]
        self.assertEqual(sorted(r.url.params["maxResults"] for r in list_requests), ["1", "25"])

    async def test_mail_sending_encodes_body_and_rejects_header_injection(self):
        self.seed_tokens({"access_token": "a", "expires_at": time.time() * 1000 + 999999, "scope": "s"})
        def handler(request):
            self.requests.append(request)
            return httpx.Response(200, json={"id": "sent"})
        c = self.connector(handler)
        self.assertEqual(await c.send_mail({"to": "a@example.com", "subject": "A subject", "body": "café\ntext"}), {"id": "sent"})
        raw = json.loads(self.requests[0].content)["raw"]
        message = base64.urlsafe_b64decode(raw + "=" * (-len(raw) % 4)).decode()
        self.assertIn(base64.b64encode("café\ntext".encode()).decode(), message)
        with self.assertRaisesRegex(ValueError, "Invalid email"):
            await c.send_mail({"to": "a@example.com", "subject": "ok\r\nBcc: victim@example.com", "body": "x"})

    async def test_unconfigured_and_disconnected_errors_are_clear(self):
        client = self.client(lambda request: httpx.Response(200, json={}))
        self.addAsyncCleanup(client.aclose)
        c = GoogleConnector(None, None, "http://localhost/callback", self.vault, SECRET, http_client=client)
        self.assertFalse((await c.status())["configured"])
        with self.assertRaisesRegex(RuntimeError, "Set GOOGLE_CLIENT_ID"):
            c.begin_auth()
        with self.assertRaisesRegex(RuntimeError, "Google is not connected"):
            await c.list_mail()

    async def test_calendar_validates_offset_and_timezone(self):
        self.seed_tokens({"access_token": "a", "expires_at": time.time() * 1000 + 999999, "scope": "s"})
        def handler(request):
            self.requests.append(request)
            return httpx.Response(200, json={"items": []})
        c = self.connector(handler)
        await c.list_events("2026-01-01T00:00:00Z", "2026-01-02T00:00:00Z")
        self.assertEqual(self.requests[0].url.params["maxResults"], "50")
        with self.assertRaisesRegex(ValueError, "UTC offsets"):
            await c.list_events("2026-01-01T00:00:00", "2026-01-02T00:00:00Z")
        with self.assertRaisesRegex(ValueError, "timezone"):
            await c.create_event({"summary": "Meet", "start": "2026-01-01T00:00:00Z",
                                  "end": "2026-01-01T01:00:00Z", "timeZone": "Invalid/Zone"})

    async def test_disconnect_removes_vault_and_attempts_revoke(self):
        self.seed_tokens({"access_token": "a", "refresh_token": "r", "expires_at": 0, "scope": "s"})
        def handler(request):
            self.requests.append(request)
            return httpx.Response(200)
        c = self.connector(handler)
        self.assertEqual(await c.disconnect(), {"connected": False, "revoked": True})
        self.assertFalse(self.vault.exists())
        self.assertEqual(self.requests[0].url.path, "/revoke")


if __name__ == "__main__":
    unittest.main()
