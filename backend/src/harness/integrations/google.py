"""Google Gmail and Calendar connector using Google's raw HTTP APIs.

Credentials are stored in a small AES-GCM envelope compatible with the local
TypeScript connector's version-1 vault format.
"""
from __future__ import annotations

import asyncio
import base64
import binascii
import hashlib
import json
import os
import re
import secrets
import tempfile
import time
from datetime import datetime, timezone
from email.header import Header
from pathlib import Path
from typing import Any
from urllib.parse import urlencode, urlparse
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

import httpx
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

SCOPES = [
    "https://www.googleapis.com/auth/gmail.readonly",
    "https://www.googleapis.com/auth/gmail.send",
    "https://www.googleapis.com/auth/calendar.events",
]
_STATE_TTL = 600
_ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,100}$")
_EMAIL_RE = re.compile(r"^[^\s<>@,;]+@[^\s<>@,;]+\.[^\s<>@,;]+$")


class GoogleConnector:
    """Google OAuth/Gmail/Calendar client. ``begin_auth`` is synchronous;
    every operation that performs I/O is asynchronous.

    ``http_client`` can be supplied for tests/custom transports. The connector
    does not close an injected client; internally-created clients are closed by
    ``disconnect``.
    """

    def __init__(self, client_id: str | None, client_secret: str | None,
                 redirect_uri: str, vault_path: Path, encryption_secret: str,
                 http_client: httpx.AsyncClient | None = None,
                 transport: httpx.AsyncBaseTransport | None = None):
        if len(encryption_secret) < 24:
            raise ValueError("Connector encryption secret must have at least 24 characters")
        self.client_id = client_id
        self.client_secret = client_secret
        self.redirect_uri = redirect_uri
        self.vault_path = Path(vault_path)
        self._key = hashlib.sha256(encryption_secret.encode("utf-8")).digest()
        self._client = http_client or httpx.AsyncClient(transport=transport, timeout=20.0)
        self._owns_client = http_client is None
        self._pending: dict[str, tuple[str, float]] = {}
        self._refresh_lock = asyncio.Lock()

    def _configured(self) -> bool:
        return bool(self.client_id and self.client_secret)

    async def _load(self) -> dict[str, Any] | None:
        try:
            envelope = json.loads(await asyncio.to_thread(self.vault_path.read_text, "utf-8"))
            iv = base64.b64decode(envelope["iv"], validate=True)
            tag = base64.b64decode(envelope["tag"], validate=True)
            encrypted = base64.b64decode(envelope["encrypted"], validate=True)
            if len(iv) != 12 or len(tag) != 16:
                raise ValueError("bad envelope")
            plaintext = AESGCM(self._key).decrypt(iv, encrypted + tag, None)
            tokens = json.loads(plaintext.decode("utf-8"))
            if not isinstance(tokens, dict) or not isinstance(tokens.get("access_token"), str):
                raise ValueError("bad credential payload")
            return tokens
        except FileNotFoundError:
            return None
        except Exception as exc:
            raise RuntimeError("Cannot unlock saved Google credentials. Restore the original credential key or reconnect Google.") from exc

    async def _save(self, tokens: dict[str, Any]) -> None:
        iv = secrets.token_bytes(12)
        sealed = AESGCM(self._key).encrypt(iv, json.dumps(tokens, separators=(",", ":")).encode("utf-8"), None)
        envelope = {"version": 1, "iv": base64.b64encode(iv).decode(),
                    "tag": base64.b64encode(sealed[-16:]).decode(),
                    "encrypted": base64.b64encode(sealed[:-16]).decode()}
        body = json.dumps(envelope, separators=(",", ":"))
        await asyncio.to_thread(self._atomic_write, body)

    def _atomic_write(self, body: str) -> None:
        self.vault_path.parent.mkdir(parents=True, exist_ok=True)
        fd, name = tempfile.mkstemp(prefix=self.vault_path.name + ".", suffix=".tmp", dir=self.vault_path.parent)
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as f:
                os.chmod(name, 0o600)
                f.write(body)
                f.flush()
                os.fsync(f.fileno())
            os.replace(name, self.vault_path)
        finally:
            try:
                os.unlink(name)
            except FileNotFoundError:
                pass

    async def status(self) -> dict[str, Any]:
        tokens = await self._load()
        return {"provider": "google", "configured": self._configured(),
                "connected": bool(tokens),
                "scopes": [s for s in str(tokens.get("scope", "")).split() if s] if tokens else [],
                "redirectUri": self.redirect_uri}

    def begin_auth(self) -> dict[str, str]:
        if not self._configured():
            raise RuntimeError("Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET before connecting Google.")
        redirect = urlparse(self.redirect_uri)
        if redirect.scheme != "http" or redirect.hostname not in ("127.0.0.1", "localhost", "::1"):
            raise RuntimeError("Local Google OAuth requires a loopback HTTP redirect URI")
        now = time.time()
        self._pending = {s: p for s, p in self._pending.items() if p[1] >= now}
        state = secrets.token_urlsafe(32)
        verifier = secrets.token_urlsafe(48)
        self._pending[state] = (verifier, now + _STATE_TTL)
        challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).rstrip(b"=").decode()
        params = {"client_id": self.client_id, "redirect_uri": self.redirect_uri,
                  "response_type": "code", "scope": " ".join(SCOPES), "state": state,
                  "access_type": "offline", "prompt": "consent", "include_granted_scopes": "true",
                  "code_challenge": challenge, "code_challenge_method": "S256"}
        return {"url": "https://accounts.google.com/o/oauth2/v2/auth?" + urlencode(params), "state": state}

    async def _token_request(self, data: dict[str, str]) -> dict[str, Any]:
        response = await self._client.post("https://oauth2.googleapis.com/token", data=data)
        if not response.is_success:
            raise RuntimeError(f"Google authorization failed ({response.status_code}); reconnect the account.")
        payload = response.json()
        if not isinstance(payload.get("access_token"), str):
            raise RuntimeError("Google returned no access token")
        return payload

    async def complete_auth(self, code: str, state: str) -> dict[str, bool]:
        record = self._pending.pop(state, None)
        if not record or record[1] < time.time() or not code or len(code) > 4096:
            raise ValueError("Invalid or expired OAuth state. Start Google connection again.")
        data = await self._token_request({"client_id": self.client_id or "", "client_secret": self.client_secret or "",
              "redirect_uri": self.redirect_uri, "grant_type": "authorization_code", "code": code,
              "code_verifier": record[0]})
        prior = await self._load()
        await self._save({"access_token": data["access_token"],
              "refresh_token": data.get("refresh_token") or (prior or {}).get("refresh_token"),
              "expires_at": time.time() * 1000 + float(data.get("expires_in", 3600)) * 1000,
              "scope": data.get("scope") if isinstance(data.get("scope"), str) else " ".join(SCOPES)})
        return {"connected": True}

    async def _access(self) -> str:
        tokens = await self._load()
        if not tokens:
            raise RuntimeError("Google is not connected")
        if float(tokens.get("expires_at", 0)) > time.time() * 1000 + 60_000:
            return tokens["access_token"]
        if not tokens.get("refresh_token"):
            raise RuntimeError("Google authorization expired; reconnect the account")
        async with self._refresh_lock:
            # Another caller may have refreshed while this caller waited.
            current = await self._load() or tokens
            if float(current.get("expires_at", 0)) > time.time() * 1000 + 60_000:
                return current["access_token"]
            data = await self._token_request({"client_id": self.client_id or "", "client_secret": self.client_secret or "",
                    "grant_type": "refresh_token", "refresh_token": current["refresh_token"]})
            refreshed = {**current, "access_token": data["access_token"],
                         "refresh_token": data.get("refresh_token") or current["refresh_token"],
                         "scope": data.get("scope") if isinstance(data.get("scope"), str) else current.get("scope", ""),
                         "expires_at": time.time() * 1000 + float(data.get("expires_in", 3600)) * 1000}
            await self._save(refreshed)
            return refreshed["access_token"]

    async def _api(self, url: str, *, method: str = "GET", json_body: Any = None) -> dict[str, Any]:
        response = await self._client.request(method, url, json=json_body,
             headers={"Authorization": f"Bearer {await self._access()}", "Content-Type": "application/json"})
        if not response.is_success:
            raise RuntimeError(f"Google API request failed ({response.status_code})")
        result = response.json()
        return result if isinstance(result, dict) else {}

    async def list_mail(self, query: str = "", max_results: int = 10) -> dict[str, Any]:
        if len(query) > 2000:
            raise ValueError("Mail query is too long")
        count = max(1, min(25, int(max_results)))
        return await self._api("https://gmail.googleapis.com/gmail/v1/users/me/messages?" + urlencode({"q": query, "maxResults": count}))

    async def read_mail(self, id: str) -> dict[str, Any]:
        if not _ID_RE.fullmatch(id):
            raise ValueError("Invalid mail ID")
        message = await self._api(f"https://gmail.googleapis.com/gmail/v1/users/me/messages/{id}?format=full")
        payload = message.get("payload")
        wanted = {"from", "to", "subject", "date"}
        headers = [h for h in (payload or {}).get("headers", []) if str(h.get("name", "")).lower() in wanted]
        pieces: list[str] = []
        size = 0
        def walk(part: dict[str, Any], depth: int = 0) -> None:
            nonlocal size
            if depth > 10 or size >= 30000:
                return
            if part.get("mimeType") == "text/plain":
                data = (part.get("body") or {}).get("data")
                if data:
                    try:
                        decoded = base64.urlsafe_b64decode(data + "=" * (-len(data) % 4)).decode("utf-8", errors="replace")
                        piece = decoded[:30000-size]
                        pieces.append(piece); size += len(piece)
                    except (ValueError, binascii.Error):
                        pass
            for child in part.get("parts", []) or []:
                walk(child, depth + 1)
        if payload:
            walk(payload)
        return {"id": message.get("id"), "threadId": message.get("threadId"), "snippet": message.get("snippet"),
                "headers": headers, "body": "\n".join(pieces)[:30000]}

    @staticmethod
    def _parse_time(value: str) -> datetime | None:
        if not re.search(r"(?:Z|[+-]\d{2}:\d{2})$", value):
            return None
        try:
            result = datetime.fromisoformat(value.replace("Z", "+00:00"))
            return result if result.tzinfo else None
        except ValueError:
            return None

    async def list_events(self, start: str, end: str) -> dict[str, Any]:
        s, e = self._parse_time(start), self._parse_time(end)
        if not s or not e or s >= e:
            raise ValueError("Provide a valid calendar time range with UTC offsets")
        params = {"timeMin": s.astimezone(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z"),
                  "timeMax": e.astimezone(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z"),
                  "singleEvents": "true", "orderBy": "startTime", "maxResults": "50"}
        return await self._api("https://www.googleapis.com/calendar/v3/calendars/primary/events?" + urlencode(params))

    async def send_mail(self, input: dict[str, Any]) -> dict[str, Any]:
        to, subject, body = input.get("to", ""), input.get("subject", ""), input.get("body", "")
        if not isinstance(to, str) or not _EMAIL_RE.fullmatch(to) or not isinstance(subject, str) or not isinstance(body, str) or "\r" in to + subject or "\n" in to + subject or len(subject) > 500 or len(body) > 50000:
            raise ValueError("Invalid email recipient, subject, or body")
        # RFC 2047 encodes long/non-ASCII subjects without permitting header injection.
        encoded_subject = Header(subject, "utf-8", maxlinelen=42).encode(linesep="\r\n ")
        body64 = base64.b64encode(body.encode("utf-8")).decode("ascii")
        wrapped = "\r\n".join(body64[i:i+76] for i in range(0, len(body64), 76))
        raw_message = (f"To: {to}\r\nSubject: {encoded_subject}\r\nMIME-Version: 1.0\r\n"
                       "Content-Type: text/plain; charset=UTF-8\r\nContent-Transfer-Encoding: base64\r\n\r\n" + wrapped)
        raw = base64.urlsafe_b64encode(raw_message.encode("utf-8")).rstrip(b"=").decode("ascii")
        return await self._api("https://gmail.googleapis.com/gmail/v1/users/me/messages/send", method="POST", json_body={"raw": raw})

    async def create_event(self, input: dict[str, Any]) -> dict[str, Any]:
        summary, start, end, zone = (input.get(k, "") for k in ("summary", "start", "end", "timeZone"))
        s, e = self._parse_time(start) if isinstance(start, str) else None, self._parse_time(end) if isinstance(end, str) else None
        if not isinstance(summary, str) or not summary.strip() or len(summary) > 500 or not s or not e or e <= s:
            raise ValueError("Invalid calendar event")
        try:
            ZoneInfo(zone)
        except (ZoneInfoNotFoundError, TypeError):
            raise ValueError("Invalid calendar timezone") from None
        to_rfc3339 = lambda dt: dt.astimezone(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")
        payload = {"summary": summary, "start": {"dateTime": to_rfc3339(s), "timeZone": zone},
                   "end": {"dateTime": to_rfc3339(e), "timeZone": zone}}
        return await self._api("https://www.googleapis.com/calendar/v3/calendars/primary/events", method="POST", json_body=payload)

    async def disconnect(self) -> dict[str, bool]:
        tokens = await self._load()
        self._pending.clear()
        for attempt in range(5):
            try:
                await asyncio.to_thread(self.vault_path.unlink)
                break
            except FileNotFoundError:
                break
            except OSError as exc:
                # Windows commonly maps a sharing violation to winerror 32;
                # on POSIX the matching transient file-busy error is EBUSY.
                if not isinstance(exc, PermissionError) and getattr(exc, "winerror", None) not in (5, 32) and getattr(exc, "errno", None) not in (13, 16):
                    raise
                if attempt == 4:
                    raise RuntimeError("Saved Google credentials could not be removed. A file lock or permission issue must be resolved before disconnect can be confirmed.") from None
                await asyncio.sleep(.05 * (attempt + 1))
        revoked = False
        if tokens:
            try:
                response = await self._client.post("https://oauth2.googleapis.com/revoke",
                    data={"token": tokens.get("refresh_token") or tokens["access_token"]}, timeout=10.0)
                revoked = response.is_success
            except Exception:
                pass
        return {"connected": False, "revoked": revoked}

    async def close(self) -> None:
        """Release resources at runtime shutdown without changing credentials."""
        if self._owns_client:
            await self._client.aclose()
