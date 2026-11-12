"""Dedicated, policy constrained Playwright browser for the harness."""
from __future__ import annotations

import asyncio
import base64
import importlib
import ipaddress
import os
import re
import socket
import uuid
from pathlib import Path
from typing import Any, Callable
from urllib.parse import urlsplit

TIMEOUT = 20_000
PROFILE_MARKER = ".personal-assistant-profile"
PROFILE_ID = "personal-assistant-harness/browser-profile/v1"


def is_public_browser_address(address: str) -> bool:
    """Return true only for ordinary globally routable addresses."""
    try:
        ip = ipaddress.ip_address(address.strip().strip("[]").split("%")[0])
    except ValueError:
        return False
    if isinstance(ip, ipaddress.IPv4Address):
        value = int(ip)
        a, b, c = (value >> 24, (value >> 16) & 255, (value >> 8) & 255)
        return not (
            a in (0, 10, 127) or a >= 224 or
            (a == 100 and 64 <= b <= 127) or (a == 169 and b == 254) or
            (a == 172 and 16 <= b <= 31) or
            (a == 192 and (b in (0, 168) or (b == 88 and c == 99))) or
            (a == 198 and (b in (18, 19) or (b == 51 and c == 100))) or
            (a == 203 and b == 0 and c == 113)
        )
    groups = ip.exploded.split(":")
    first, second = int(groups[0], 16), int(groups[1], 16)
    return first >= 0x2000 and first < 0x3fff and first != 0x2002 and not (
        first == 0x2001 and (second < 0x200 or second == 0x0db8)
    )


def validate_browser_url(value: str) -> str:
    if not isinstance(value, str) or len(value) > 4096:
        raise ValueError("Browser URL must be a string up to 4096 characters")
    if re.search(r'[\x00-\x20\\]', value):
        raise ValueError('Ambiguous browser URL characters are blocked')
    try:
        parsed = urlsplit(value)
        # Accessing .port/.hostname validates malformed authority syntax.
        host = parsed.hostname
        _ = parsed.port
    except ValueError as exc:
        raise ValueError("Provide a complete public HTTP or HTTPS URL") from exc
    if parsed.scheme.lower() not in ("http", "https") or not parsed.netloc or not host:
        raise ValueError("Provide a complete public HTTP or HTTPS URL")
    if parsed.username is not None or parsed.password is not None:
        raise ValueError("Credentials are not allowed in browser URLs")
    hostname = host.lower().rstrip(".")
    if re.fullmatch(r'(?:0x[0-9a-f]+|[0-9]+)(?:\.(?:0x[0-9a-f]+|[0-9]+))*', hostname) and not _is_ip(hostname):
        raise ValueError('Ambiguous numeric browser destinations are blocked')
    if not hostname or "%" in hostname or (":" not in hostname and not _is_ip(hostname) and
            ("." not in hostname or re.search(r"(?:^|\.)(localhost|local|internal|lan|home|test|invalid)$", hostname))):
        raise ValueError("Local and internal browser destinations are blocked")
    if _is_ip(hostname) and not is_public_browser_address(hostname):
        raise ValueError("Private and reserved browser destinations are blocked")
    return value


def _is_ip(host: str) -> bool:
    try:
        ipaddress.ip_address(host.strip("[]"))
        return True
    except ValueError:
        return False


async def assert_public_browser_url(
    value: str,
    address_lookup: Callable[[str], Any] | None = None,
) -> str:
    """Validate syntax and fail closed if any DNS result is non-public."""
    validate_browser_url(value)
    host = urlsplit(value).hostname or ""
    host = host.rstrip(".")
    if _is_ip(host):
        return value

    try:
        if address_lookup is None:
            rows = await asyncio.wait_for(asyncio.to_thread(socket.getaddrinfo, host, None, 0, socket.SOCK_STREAM), timeout=5)
            addresses = [row[4][0] for row in rows]
        else:
            result = address_lookup(host)
            if hasattr(result, "__await__"):
                result = await asyncio.wait_for(result, timeout=5)
            addresses = [item["address"] if isinstance(item, dict) else str(item) for item in result]
    except Exception as exc:
        code = getattr(exc, "errno", None) or getattr(exc, "code", None) or "LOOKUP_FAILED"
        code = re.sub(r"[^A-Z0-9_]", "", str(code).upper())[:40]
        raise ValueError(
            f"Browser DNS validation failed for {host} ({code}). Navigation is blocked because its public destination cannot be verified."
        ) from exc
    if not addresses or any(not is_public_browser_address(item) for item in addresses):
        raise ValueError("Browser destination resolves to a private or reserved address")
    return value


class BrowserService:
    """One isolated persistent browser profile, never the everyday browser profile."""

    def __init__(self, profile_dir: Path, executable_path: str | None = None, channel: str | None = None):
        self.profile_dir = Path(profile_dir).expanduser().resolve()
        if self.profile_dir.name != "browser-profile" or ".assistant" not in self.profile_dir.parts:
            raise ValueError("Dedicated browser profile must be an .assistant/browser-profile directory")
        self.executable_path = executable_path
        self.channel = channel
        self.context: Any = None
        self._playwright: Any = None
        self.visible = False
        self._lock = asyncio.Lock()
        self._page_ids: dict[int, str] = {}
        self.last_error: str | None = None
        self.mutations = 0

    def _configure_page(self, page: Any) -> None:
        self._page_ids[id(page)] = str(uuid.uuid4())
        page.on("dialog", lambda dialog: asyncio.create_task(dialog.dismiss()))
        page.on("download", lambda download: asyncio.create_task(download.cancel()))

    def _page(self, tab_id: str) -> Any:
        if self.context is None:
            raise ValueError("Browser tab is missing or closed")
        for page in self.context.pages:
            if self._page_ids.get(id(page)) == tab_id and not page.is_closed():
                return page
        raise ValueError("Browser tab is missing or closed")

    async def status(self) -> dict[str, Any]:
        try:
            importlib.util.find_spec("playwright.async_api")
            installed = importlib.util.find_spec("playwright") is not None
        except (ImportError, ValueError):
            installed = False
        result: dict[str, Any] = {
            "available": installed, "active": self.context is not None,
            "visible": self.visible and self.context is not None,
            "manualControl": self.visible and self.context is not None,
            "profile": "dedicated", "browser": "chromium",
        }
        if self.last_error:
            result["error"] = self.last_error
        return result

    async def _launch_internal(self, visible: bool = False) -> None:
        if self.context is not None and self.visible == visible:
            return
        if self.context is not None:
            await self.context.close()
            self.context = None
        if self._playwright is not None:
            await self._playwright.stop()
            self._playwright = None
        self.profile_dir.mkdir(parents=True, exist_ok=True)
        marker = self.profile_dir / PROFILE_MARKER
        entries = list(self.profile_dir.iterdir())
        if entries and not marker.exists():
            raise ValueError("Refusing to use an existing unmarked browser profile")
        if marker.exists():
            if marker.is_symlink() or marker.read_text(encoding="utf-8").strip() != PROFILE_ID:
                raise ValueError("Browser profile ownership marker is invalid")
        else:
            marker.write_text(PROFILE_ID, encoding="utf-8")
        try:
            from playwright.async_api import async_playwright
        except ImportError as exc:
            self.last_error = "Install playwright to enable the dedicated browser"
            raise RuntimeError(self.last_error) from exc
        try:
            self._playwright = await async_playwright().start()
            options: dict[str, Any] = {
                "headless": not visible, "accept_downloads": False,
                "service_workers": "block", "viewport": {"width": 1365, "height": 900},
                "timeout": TIMEOUT,
            }
            if self.executable_path:
                options["executable_path"] = self.executable_path
            else:
                options["channel"] = self.channel or ("msedge" if os.name == "nt" else "chromium")
            self.context = await self._playwright.chromium.launch_persistent_context(str(self.profile_dir), **options)
            self.visible = visible
            self.last_error = None
            self.context.set_default_timeout(TIMEOUT)
            self.context.set_default_navigation_timeout(TIMEOUT)
            await self.context.route("**/*", self._route_request)
            route_ws = getattr(self.context, "route_web_socket", None)
            if route_ws:
                await route_ws("**/*", self._close_websocket)
            self.context.on("page", self._configure_page)
            for page in self.context.pages:
                self._configure_page(page)
        except Exception as exc:
            if self.context is not None:
                try:
                    await self.context.close()
                except Exception:
                    pass
            self.context = None
            if self._playwright is not None:
                try:
                    await self._playwright.stop()
                except Exception:
                    pass
                self._playwright = None
            reason = re.search(r"EACCES|EPERM|ENOENT|executable doesn't exist|Timeout", str(exc), re.I)
            self.last_error = f"Dedicated Chromium could not start{f' ({reason.group(0)})' if reason else ''}. Check the browser installation, profile lock, and process permissions; configure BROWSER_EXECUTABLE_PATH if needed."
            raise RuntimeError(self.last_error) from exc

    async def _route_request(self, route: Any) -> None:
        try:
            await assert_public_browser_url(route.request.url)
            if route.request.method not in ("GET", "HEAD", "OPTIONS") and not self.mutations and not self.visible:
                await route.abort("blockedbyclient")
                return
            await route.continue_()
        except Exception:
            try:
                await route.abort("blockedbyclient")
            except Exception:
                pass

    async def _close_websocket(self, socket: Any) -> None:
        await socket.close()

    async def launch(self, visible: bool = False) -> dict[str, Any]:
        async with self._lock:
            await self._launch_internal(visible)
            return await self.status()

    async def tabs(self) -> list[dict[str, str]]:
        async with self._lock:
            if self.context is None:
                return []
            result = []
            for page in self.context.pages:
                try:
                    title = await page.title()
                except Exception:
                    title = ""
                result.append({"id": self._page_ids[id(page)], "url": page.url, "title": title})
            return result

    async def navigate(self, url: str) -> dict[str, Any]:
        async with self._lock:
            await assert_public_browser_url(url)
            await self._launch_internal(self.visible if self.context is not None else False)
            page = await self.context.new_page()
            try:
                response = await page.goto(url, wait_until="domcontentloaded", timeout=TIMEOUT)
                await assert_public_browser_url(page.url)
                return {"id": self._page_ids[id(page)], "url": page.url, "title": await page.title(),
                        "status": response.status if response else None}
            except Exception:
                await page.close()
                raise

    async def snapshot(self, tab_id: str) -> dict[str, Any]:
        async with self._lock:
            page = self._page(tab_id)
            await assert_public_browser_url(page.url)
            content = await page.locator("body").inner_text(timeout=TIMEOUT)
            elements = await page.locator("a,button,input,textarea,select,[role=button],[role=link]").evaluate_all("""nodes => {
              const selector = e => { if (e.id) return `#${CSS.escape(e.id)}`; const a=[]; let n=e;
                while(n && n.tagName!=='HTML'){const same=n.parentElement?[...n.parentElement.children].filter(x=>x.tagName===n.tagName):[n];
                  a.unshift(`${n.tagName.toLowerCase()}:nth-of-type(${same.indexOf(n)+1})`);n=n.parentElement;} return a.join(' > '); };
              return nodes.filter(n=>n.getClientRects().length>0).slice(0,150).map(n=>({selector:selector(n),tag:n.tagName.toLowerCase(),
                role:n.getAttribute('role'),name:(n.getAttribute('aria-label')||n.getAttribute('placeholder')||n.textContent||'').trim().slice(0,180),
                href:n.getAttribute('href'),type:n.getAttribute('type')}));
            }""")
            return {"tabId": tab_id, "url": page.url, "title": await page.title(), "text": content[:24000],
                    "truncated": len(content) > 24000, "elements": elements, "untrustedContent": True}

    async def close_tab(self, tab_id: str) -> None:
        async with self._lock:
            await self._page(tab_id).close()

    async def screenshot(self, tab_id: str) -> dict[str, str]:
        async with self._lock:
            page = self._page(tab_id)
            await assert_public_browser_url(page.url)
            data = await page.screenshot(type="png", full_page=False, timeout=TIMEOUT)
            return {"tabId": tab_id, "mimeType": "image/png", "base64": base64.b64encode(data).decode("ascii")}

    async def click(self, tab_id: str, selector: str) -> dict[str, str]:
        async with self._lock:
            if self.visible:
                raise ValueError("Browser is under manual control. Resume headless mode before automatic actions.")
            if not selector or len(selector) > 2000:
                raise ValueError("Invalid browser selector")
            page = self._page(tab_id)
            await assert_public_browser_url(page.url)
            self.mutations += 1
            try:
                await page.locator(selector).click(timeout=TIMEOUT)
            finally:
                self.mutations -= 1
            return {"tabId": tab_id, "url": page.url, "title": await page.title()}

    async def fill(self, tab_id: str, selector: str, value: str) -> dict[str, Any]:
        async with self._lock:
            if self.visible:
                raise ValueError("Browser is under manual control. Resume headless mode before automatic actions.")
            if not selector or len(selector) > 2000 or not isinstance(value, str) or len(value) > 12000:
                raise ValueError("Invalid browser form input")
            page = self._page(tab_id)
            await assert_public_browser_url(page.url)
            field = page.locator(selector)
            if (await field.get_attribute("type") or "").lower() == "password":
                raise ValueError("Enter passwords manually in the visible dedicated browser")
            self.mutations += 1
            try:
                await field.fill(value, timeout=TIMEOUT)
            finally:
                self.mutations -= 1
            return {"tabId": tab_id, "filled": True}

    async def close(self) -> dict[str, bool]:
        async with self._lock:
            if self.context is not None:
                await self.context.close()
            self.context = None
            if self._playwright is not None:
                await self._playwright.stop()
                self._playwright = None
            self._page_ids.clear()
            return {"active": False}
