"""Loopback-only HTTP server for the local assistant harness."""
from __future__ import annotations

import hmac
import inspect
import json
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Callable

from fastapi import FastAPI, Request
from fastapi.responses import FileResponse, JSONResponse, Response
from starlette.types import ASGIApp, Message, Receive, Scope, Send

from .config import Config, load_config

MAX_REQUEST_BYTES = 64 * 1024
PUBLIC_PATHS = frozenset(("/health", "/oauth/google/callback"))


class RequestGuards:
    """Validate loopback Host, cap streamed bodies, and add baseline headers."""

    def __init__(self, app: ASGIApp, port: int):
        self.app = app
        self.allowed_hosts = {f"127.0.0.1:{port}", f"localhost:{port}"}

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        headers = {k.lower(): v for k, v in scope.get("headers", [])}
        host = headers.get(b"host", b"").decode("latin-1").lower().rstrip(".")
        if host not in self.allowed_hosts:
            await self._respond(send, 400, b'{"detail":"Invalid Host header"}', "application/json")
            return
        length = headers.get(b"content-length")
        if length:
            try:
                too_large = int(length) > MAX_REQUEST_BYTES
            except ValueError:
                too_large = True
            if too_large:
                await self._respond(send, 413, b'{"detail":"Request body too large"}', "application/json")
                return

        # Requests without a body do not need to be consumed before routing.
        # This also avoids waiting on a client disconnect after a bodyless GET.
        if scope.get("method") in ("GET", "HEAD", "OPTIONS") and not headers.get(b"transfer-encoding"):
            async def safe_send(message: Message) -> None:
                if message["type"] == "http.response.start":
                    response_headers = list(message.get("headers", []))
                    present = {k.lower() for k, _ in response_headers}
                    for key, value in ((b"x-content-type-options", b"nosniff"),
                                       (b"x-frame-options", b"DENY"),
                                       (b"referrer-policy", b"no-referrer"),
                                       (b"cache-control", b"no-store")):
                        if key not in present:
                            response_headers.append((key, value))
                    message = {**message, "headers": response_headers}
                await send(message)
            await self.app(scope, receive, safe_send)
            return

        # Buffer at most the configured limit before any route can act on the
        # request. This also covers chunked requests with no Content-Length.
        parts: list[bytes] = []
        total = 0
        while True:
            message = await receive()
            if message["type"] != "http.request":
                break
            part = message.get("body", b"")
            total += len(part)
            if total > MAX_REQUEST_BYTES:
                await self._respond(send, 413, b'{"detail":"Request body too large"}', "application/json")
                return
            parts.append(part)
            if not message.get("more_body", False):
                break

        buffered = b"".join(parts)
        delivered = False

        async def limited_receive() -> Message:
            nonlocal delivered
            if not delivered:
                delivered = True
                return {"type": "http.request", "body": buffered, "more_body": False}
            return {"type": "http.request", "body": b"", "more_body": False}

        async def guarded_send(message: Message) -> None:
            if message["type"] == "http.response.start":
                response_headers = list(message.get("headers", []))
                present = {k.lower() for k, _ in response_headers}
                for key, value in ((b"x-content-type-options", b"nosniff"),
                                   (b"x-frame-options", b"DENY"),
                                   (b"referrer-policy", b"no-referrer"),
                                   (b"cache-control", b"no-store")):
                    if key not in present:
                        response_headers.append((key, value))
                message = {**message, "headers": response_headers}
            await send(message)

        await self.app(scope, limited_receive, guarded_send)

    @staticmethod
    async def _respond(send: Send, status: int, body: bytes, media_type: str) -> None:
        await send({"type": "http.response.start", "status": status,
                    "headers": [(b"content-type", media_type.encode()),
                                (b"content-length", str(len(body)).encode()),
                                (b"cache-control", b"no-store"),
                                (b"x-content-type-options", b"nosniff"),
                                (b"x-frame-options", b"DENY"),
                                (b"referrer-policy", b"no-referrer")]})
        await send({"type": "http.response.body", "body": body})


def _response(value) -> Response:
    response = value if isinstance(value, Response) else JSONResponse(value)
    response.headers.setdefault("Cache-Control", "no-store")
    return response


def create_app(config: Config | None = None, runtime_factory: Callable | None = None) -> FastAPI:
    config = config or load_config()
    # Lazy import lets configuration and static-serving tools load without the
    # runtime's optional integrations initialized at module import time.
    if runtime_factory is None:
        from .runtime import Runtime
        runtime_factory = Runtime

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        store = None
        runtime = None
        try:
            from .store import LocalStore
            store = LocalStore(config.data_dir / "assistant.sqlite")
            store.claim_runtime_ownership()
            runtime = runtime_factory(config, store=store)
            app.state.runtime = runtime
            result = runtime.start()
            if inspect.isawaitable(result):
                await result
            yield
        finally:
            try:
                if runtime is not None:
                    close = runtime.close()
                    if inspect.isawaitable(close):
                        await close
            finally:
                if store is not None:
                    store.close()
                app.state.runtime = None

    app = FastAPI(lifespan=lifespan, docs_url=None, redoc_url=None, openapi_url=None)
    app.add_middleware(RequestGuards, port=config.port)

    @app.get("/health")
    async def health():
        return {"ok": True, "backend": "python", "runtime": "local"}

    @app.api_route("/oauth/google/callback", methods=["GET"])
    async def google_callback(request: Request):
        runtime = getattr(request.app.state, "runtime", None)
        if runtime is None:
            return _response(JSONResponse({"error": "Service unavailable"}, status_code=503))
        return _response(await runtime.dispatch("GET", request.url.path, {}, dict(request.query_params)))

    @app.api_route("/api/{path:path}", methods=["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"])
    @app.api_route("/api", methods=["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"])
    async def api(request: Request, path: str = ""):
        if not _authorized(request, config.token):
            return _response(JSONResponse({"error": "Unauthorized"}, status_code=401,
                                          headers={"WWW-Authenticate": "Bearer"}))
        runtime = getattr(request.app.state, "runtime", None)
        if runtime is None:
            return _response(JSONResponse({"error": "Service unavailable"}, status_code=503))
        try:
            raw = await request.body() if request.method in ("POST", "PUT", "PATCH") else b""
            body = json.loads(raw) if raw else {}
        except Exception:
            return _response(JSONResponse({"error": "Invalid JSON body"}, status_code=400))
        if not isinstance(body, dict):
            return _response(JSONResponse({"error": "JSON body must be an object"}, status_code=400))
        return _response(await runtime.dispatch(request.method, request.url.path, body,
                                                 dict(request.query_params)))

    static_root = (config.root / "dist").resolve()

    @app.api_route("/{asset_path:path}", methods=["GET", "HEAD"])
    async def static_file(request: Request, asset_path: str = ""):
        candidate = (static_root / (asset_path or "index.html")).resolve()
        try:
            candidate.relative_to(static_root)
        except ValueError:
            return Response(status_code=404, headers={"Cache-Control": "no-store"})
        if not candidate.is_file():
            candidate = (static_root / "index.html").resolve()
            try:
                candidate.relative_to(static_root)
            except ValueError:
                return Response(status_code=404, headers={"Cache-Control": "no-store"})
        if not candidate.is_file():
            return Response(status_code=404, headers={"Cache-Control": "no-store"})
        return FileResponse(candidate, headers={"Cache-Control": "no-store"})

    return app


def _authorized(request: Request, token: str) -> bool:
    value = request.headers.get("authorization", "")
    prefix, separator, supplied = value.partition(" ")
    return bool(token and separator and prefix.lower() == "bearer" and
                hmac.compare_digest(supplied.encode("utf-8"), token.encode("utf-8")))


def main() -> None:
    import uvicorn
    config = load_config()
    uvicorn.run(create_app(config), host="127.0.0.1", port=config.port,
                reload=False, workers=1, access_log=False)


if __name__ == "__main__":
    main()
