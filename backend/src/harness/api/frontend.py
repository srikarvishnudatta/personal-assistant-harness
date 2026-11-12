"""Optional static UI adapter; the API does not depend on frontend source code."""
from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.responses import FileResponse, Response


def mount_frontend(app: FastAPI, directory: Path) -> None:
    static_root = directory.resolve()

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
