from __future__ import annotations

import tempfile
import unittest
import os
from unittest.mock import patch
from pathlib import Path

from backend.harness.browser import (
    BrowserService, PROFILE_ID, PROFILE_MARKER, assert_public_browser_url,
    is_public_browser_address, validate_browser_url,
)
from backend.harness.workspace import MAX_BYTES, WorkspaceService
from backend.tests.offline_loop import OfflineAsyncCase

_TEST_TEMP_ROOT = Path(__file__).resolve().parent


class BrowserPolicyTests(OfflineAsyncCase):
    def test_public_address_filter(self):
        self.assertTrue(is_public_browser_address("8.8.8.8"))
        for address in ("127.0.0.1", "10.1.2.3", "169.254.1.1", "192.168.0.2", "224.0.0.1", "::1", "2001:db8::1"):
            with self.subTest(address=address):
                self.assertFalse(is_public_browser_address(address))

    def test_url_syntax_and_literal_policy(self):
        self.assertEqual(validate_browser_url("https://example.com/path"), "https://example.com/path")
        for url in ("file:///etc/passwd", "http://localhost", "http://127.0.0.1", "https://user:pw@example.com"):
            with self.subTest(url=url), self.assertRaises(ValueError):
                validate_browser_url(url)

    def test_ambiguous_numeric_and_control_character_urls_are_blocked(self):
        for url in ('http://0x7f000001', 'http://2130706433', 'http://127.1', 'http://0177.0.0.1',
                    'https://public.example\\@127.0.0.1', 'https://playwright.dev/\n'):
            with self.subTest(url=url), self.assertRaises(ValueError): validate_browser_url(url)

    async def test_dns_fails_closed_on_mixed_public_and_private_results(self):
        async def lookup(_host):
            return [{"address": "8.8.8.8"}, {"address": "10.0.0.1"}]
        with self.assertRaisesRegex(ValueError, "private or reserved"):
            await assert_public_browser_url("https://example.com", lookup)

    async def test_dns_lookup_error_is_blocked(self):
        async def lookup(_host):
            raise OSError("offline")
        with self.assertRaisesRegex(ValueError, "DNS validation failed"):
            await assert_public_browser_url("https://example.com", lookup)

    def test_profile_path_requires_harness_owned_location(self):
        with tempfile.TemporaryDirectory(dir=_TEST_TEMP_ROOT) as folder:
            with self.assertRaisesRegex(ValueError, "Dedicated browser profile"):
                BrowserService(Path(folder) / "browser-profile")
            service = BrowserService(Path(folder) / ".assistant" / "browser-profile")
            self.assertTrue(service.profile_dir.name == "browser-profile")

    async def test_profile_marker_format_and_existing_profile_retention(self):
        with tempfile.TemporaryDirectory(dir=_TEST_TEMP_ROOT) as folder:
            profile = Path(folder) / ".assistant" / "browser-profile"
            profile.mkdir(parents=True)
            (profile / PROFILE_MARKER).write_text(PROFILE_ID, encoding="utf-8")
            service = BrowserService(profile)
            import builtins
            actual_import = builtins.__import__
            def without_playwright(name, *args, **kwargs):
                if name == "playwright.async_api":
                    raise ImportError("test stub")
                return actual_import(name, *args, **kwargs)
            with patch("builtins.__import__", side_effect=without_playwright):
                with self.assertRaisesRegex(RuntimeError, "Install playwright"):
                    await service.launch()
            self.assertEqual((profile / PROFILE_MARKER).read_text(encoding="utf-8"), PROFILE_ID)

    async def test_unmarked_existing_profile_is_refused(self):
        with tempfile.TemporaryDirectory(dir=_TEST_TEMP_ROOT) as folder:
            profile = Path(folder) / ".assistant" / "browser-profile"
            profile.mkdir(parents=True)
            (profile / "Preferences").write_text("not owned", encoding="utf-8")
            service = BrowserService(profile)
            with self.assertRaisesRegex(ValueError, "unmarked"):
                await service.launch()


class WorkspaceTests(OfflineAsyncCase):
    async def asyncSetUp(self):
        self.temp = tempfile.TemporaryDirectory(dir=_TEST_TEMP_ROOT)
        self.root = Path(self.temp.name) / "artifacts"
        self.service = WorkspaceService(self.root)

    async def asyncTearDown(self):
        self.temp.cleanup()

    async def test_write_read_list_and_remove(self):
        written = await self.service.write("notes/item.md", "hello")
        self.assertEqual(written, {"path": "notes/item.md", "size": 5})
        self.assertEqual((await self.service.read("notes/item.md"))["content"], "hello")
        self.assertEqual((await self.service.list("notes"))[0]["name"], "item.md")
        await self.service.remove("notes/item.md")
        self.assertEqual(await self.service.list("notes"), [])

    async def test_write_retries_transient_windows_sharing_violation(self):
        original_replace = os.replace
        locked = OSError("temporary scanner lock")
        locked.winerror = 32
        calls = 0
        def replace(source, target):
            nonlocal calls
            calls += 1
            if calls == 1:
                raise locked
            return original_replace(source, target)
        with patch("backend.harness.workspace.os.replace", side_effect=replace), patch("backend.harness.workspace.time.sleep"):
            await self.service.write("retry.txt", "saved")
        self.assertEqual(calls, 2)
        self.assertEqual((await self.service.read("retry.txt"))["content"], "saved")

    async def test_reserved_traversal_hidden_and_unsupported_paths_rejected(self):
        for path in ("../escape.txt", "folder/../escape.txt", ".secret.txt", "CON.txt", "bad-name ", "bad\\name.txt"):
            with self.subTest(path=path), self.assertRaises(ValueError):
                await self.service.write(path, "x")
        with self.assertRaisesRegex(ValueError, "Unsupported"):
            await self.service.write("artifact.exe", "x")

    async def test_size_limit_enforced(self):
        with self.assertRaisesRegex(ValueError, "1 MiB"):
            await self.service.write("large.txt", "x" * (MAX_BYTES + 1))

    async def test_symlink_is_rejected(self):
        outside = Path(self.temp.name) / "outside.txt"
        outside.write_text("secret", encoding="utf-8")
        link = self.root / "link.txt"
        try:
            link.symlink_to(outside)
        except (OSError, NotImplementedError):
            self.skipTest("symlinks are unavailable")
        with self.assertRaisesRegex(ValueError, "symlinks"):
            await self.service.read("link.txt")

    async def test_skills_are_user_reviewable_files(self):
        await self.service.save_skill("daily-review", "# Review")
        self.assertEqual((await self.service.read_skill("daily-review"))["content"], "# Review")
        self.assertEqual((await self.service.list_skills())[0]["path"], "skills/daily-review.md")
        with self.assertRaises(ValueError):
            await self.service.save_skill("Bad Name", "x")

    async def test_script_runner_requires_explicit_docker_opt_in(self):
        await self.service.write("task.py", "print('x')")
        with self.assertRaisesRegex(ValueError, "disabled"):
            await self.service.execute_script({"path": "task.py", "language": "python"})


if __name__ == "__main__":
    unittest.main()
