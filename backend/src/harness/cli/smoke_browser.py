"""Live Python Playwright acceptance against an explicitly chosen public URL."""
import asyncio
import sys
from urllib.parse import urlsplit
from harness.integrations.browser import BrowserService, validate_browser_url
from harness.core.config import load_config


async def main():
    config = load_config(); target = sys.argv[1] if len(sys.argv) > 1 else 'https://playwright.dev'
    validate_browser_url(target)
    browser = BrowserService(config.data_dir / 'browser-profile', executable_path=config.browser_executable, channel=config.browser_channel)
    try:
        await browser.launch(); print('Dedicated Chromium launched through Python Playwright.')
        print('Checking public origin:', urlsplit(target).netloc)
        tab = await browser.navigate(target)
        assert tab['status'] and 200 <= tab['status'] < 400, 'Public navigation did not succeed'
        page = await browser.snapshot(tab['id']); assert page['text'].strip(), 'Snapshot has no readable text'
        screenshot = await browser.screenshot(tab['id']); assert len(screenshot['base64']) > 100, 'Screenshot missing'
        print('Public navigation, page snapshot and screenshot passed.')
    except Exception as error: raise SystemExit('Browser smoke test failed: ' + str(error)[:800]) from None
    finally: await browser.close()


if __name__ == '__main__': asyncio.run(main())
