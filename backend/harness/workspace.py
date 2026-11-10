"""Confined artifact workspace and opt-in Docker script runner."""
from __future__ import annotations

import asyncio
import os
import re
import shutil
import time
import uuid
from pathlib import Path
from typing import Any

MAX_BYTES = 1024 * 1024
EXTENSIONS = {".md", ".txt", ".json", ".csv", ".html", ".py", ".js", ".mjs", ".css", ".svg"}
_RESERVED = re.compile(r"^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)", re.I)


def _retry_sharing_violation(operation):
    """Allow brief Windows scanner locks without retrying permission failures."""
    for attempt in range(6):
        try:
            return operation()
        except OSError as error:
            if getattr(error, "winerror", None) not in (32, 33) or attempt == 5:
                raise
            time.sleep(0.02 * (attempt + 1))


class WorkspaceService:
    """A confined artifact directory, not access to the user's home directory."""

    def __init__(self, root: Path, docker_enabled: bool = False, docker_image: str = "python:3.12-slim"):
        Path(root).mkdir(parents=True, exist_ok=True)
        self.root = Path(root).resolve(strict=True)
        self.docker_enabled = docker_enabled
        self.docker_image = docker_image

    @staticmethod
    def _relative(value: str, allow_empty: bool = False) -> str:
        if not isinstance(value, str) or (not value and not allow_empty) or len(value) > 500 or re.search(r"[\\:\x00-\x1f]", value):
            raise ValueError("Invalid workspace path")
        if not value and allow_empty:
            return ""
        pieces = value.split("/")
        if any(not p or p.startswith(".") or p.endswith(".") or p.endswith(" ") or _RESERVED.match(p) for p in pieces):
            raise ValueError("Hidden, reserved, or traversing paths are not allowed")
        return "/".join(pieces)

    def _checked(self, value: str, create_parents: bool = False, allow_empty: bool = False) -> Path:
        relative = self._relative(value, allow_empty)
        parts = relative.split("/") if relative else []
        current = self.root
        for index, part in enumerate(parts):
            current = current / part
            try:
                info = current.lstat()
                if current.is_symlink():
                    raise ValueError("Workspace symlinks are not allowed")
                if index < len(parts) - 1 and not current.is_dir():
                    raise ValueError("Workspace parent must be a directory")
            except FileNotFoundError:
                if index < len(parts) - 1:
                    if not create_parents:
                        raise
                    current.mkdir()
        resolved = current.resolve(strict=False)
        if resolved != self.root and self.root not in resolved.parents:
            raise ValueError("Path escapes workspace")
        return resolved

    async def list(self, path: str = "") -> list[dict[str, Any]]:
        directory = self._checked(path, allow_empty=True)
        def read_entries() -> list[dict[str, Any]]:
            result: list[dict[str, Any]] = []
            for entry in list(directory.iterdir())[:500]:
                if entry.name.startswith(".") or entry.is_symlink():
                    continue
                info = entry.lstat()
                if os.path.islink(entry):
                    continue
                result.append({"path": "/".join(filter(None, (path, entry.name))), "name": entry.name,
                               "directory": entry.is_dir(), "size": info.st_size})
            return result
        return await asyncio.to_thread(read_entries)

    async def read(self, path: str) -> dict[str, Any]:
        target = self._checked(path)
        if target.suffix.lower() not in EXTENSIONS:
            raise ValueError("Unsupported artifact type")
        def load() -> tuple[str, int]:
            with target.open("rb") as stream:
                info = os.fstat(stream.fileno())
                if not os.path.isfile(target) or info.st_size > MAX_BYTES:
                    raise ValueError("Artifact exceeds the 1 MiB limit")
                raw = stream.read(MAX_BYTES + 1)
            if len(raw) > MAX_BYTES:
                raise ValueError("Artifact exceeds the 1 MiB limit")
            return raw.decode("utf-8"), info.st_size
        content, size = await asyncio.to_thread(load)
        return {"path": path, "content": content, "size": size}

    async def write(self, path: str, content: str) -> dict[str, Any]:
        if not isinstance(content, str) or len(content.encode("utf-8")) > MAX_BYTES:
            raise ValueError("Artifact exceeds the 1 MiB limit")
        # Validate before deriving the extension; also excludes path injection.
        self._relative(path)
        if Path(path).suffix.lower() not in EXTENSIONS:
            raise ValueError("Unsupported artifact type")
        target = self._checked(path, create_parents=True)
        temporary = target.parent / f".write-{uuid.uuid4()}"
        data = content.encode("utf-8")
        def store() -> None:
            try:
                with temporary.open("xb") as stream:
                    stream.write(data)
                try:
                    os.chmod(temporary, 0o600)
                except OSError:
                    pass
                _retry_sharing_violation(lambda: os.replace(temporary, target))
            finally:
                try:
                    _retry_sharing_violation(temporary.unlink)
                except FileNotFoundError:
                    pass
        await asyncio.to_thread(store)
        return {"path": path, "size": len(data)}

    async def remove(self, path: str) -> None:
        target = self._checked(path)
        def unlink() -> None:
            info = target.lstat()
            if not target.is_file() or target.is_symlink():
                raise ValueError("Only regular workspace files can be removed")
            target.unlink()
        await asyncio.to_thread(unlink)

    async def save_skill(self, name: str, content: str) -> dict[str, Any]:
        if not re.fullmatch(r"[a-z0-9][a-z0-9-]{0,79}", name or ""):
            raise ValueError("Procedure name must use lowercase letters, numbers, and hyphens")
        return await self.write(f"skills/{name}.md", content)

    async def list_skills(self) -> list[dict[str, Any]]:
        try:
            return await self.list("skills")
        except FileNotFoundError:
            return []

    async def read_skill(self, name: str) -> dict[str, Any]:
        if not re.fullmatch(r"[a-z0-9][a-z0-9-]{0,79}", name or ""):
            raise ValueError("Invalid procedure name")
        return await self.read(f"skills/{name}.md")

    async def execute_script(self, request: dict[str, Any]) -> dict[str, Any]:
        if not self.docker_enabled:
            raise ValueError("Isolated script execution is disabled. Enable Docker explicitly in local settings.")
        if not isinstance(request, dict):
            raise ValueError("Invalid script request")
        language = request.get("language")
        if language not in ("python", "node"):
            raise ValueError("Unsupported script language")
        args = request.get("args", [])
        if not isinstance(args, list) or len(args) > 20 or any(not isinstance(arg, str) or len(arg) > 500 for arg in args):
            raise ValueError("Invalid script arguments")
        path = request.get("path")
        await self.read(path)
        expected = (".py",) if language == "python" else (".js", ".mjs")
        if not isinstance(path, str) or not path.endswith(expected):
            raise ValueError("Script extension does not match language")
        image = self.docker_image
        if language == "node" and image == "python:3.12-slim":
            image = "node:22-alpine"
        if not re.fullmatch(r"[a-zA-Z0-9][a-zA-Z0-9_./:@-]*", image):
            raise ValueError("Invalid Docker image")
        container = f"assistant-script-{uuid.uuid4()}"
        argv = ["run", "--rm", "--pull=never", "--name", container, "--network=none", "--read-only",
                "--memory=256m", "--cpus=1", "--pids-limit=64", "--cap-drop=ALL", "--security-opt=no-new-privileges",
                "--user=65534:65534", "--tmpfs=/tmp:rw,noexec,nosuid,size=32m", "--mount",
                f"type=bind,src={self.root},dst=/workspace,readonly", "--workdir=/workspace", image,
                "python" if language == "python" else "node", f"/workspace/{path}", *args]
        try:
            process = await asyncio.create_subprocess_exec("docker", *argv, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
        except (FileNotFoundError, OSError) as exc:
            raise RuntimeError("Docker is unavailable. Install Docker and preload the selected image; automatic image pulls are disabled.") from exc
        async def drain(stream: asyncio.StreamReader) -> bytes:
            kept = bytearray()
            while chunk := await stream.read(8192):
                if len(kept) < 65536:
                    kept.extend(chunk[:65536 - len(kept)])
            return bytes(kept)
        stdout_task = asyncio.create_task(drain(process.stdout))
        stderr_task = asyncio.create_task(drain(process.stderr))
        timed_out = False
        try:
            await asyncio.wait_for(process.wait(), timeout=30)
        except asyncio.TimeoutError:
            timed_out = True
            try:
                cleanup = await asyncio.create_subprocess_exec("docker", "rm", "-f", container,
                                                               stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.DEVNULL)
                await asyncio.wait_for(cleanup.wait(), timeout=2)
            except OSError:
                pass
            except asyncio.TimeoutError:
                try:
                    cleanup.kill()
                    await cleanup.wait()
                except (OSError, ProcessLookupError):
                    pass
            process.kill()
            await process.wait()
        stdout, stderr = await asyncio.gather(stdout_task, stderr_task)
        return {"exitCode": process.returncode, "stdout": stdout.decode("utf-8", "replace"),
                "stderr": stderr.decode("utf-8", "replace"), "timedOut": timed_out}
