"""Local settings; credentials never appear in status output."""
from dataclasses import dataclass
import os
from pathlib import Path
import re


@dataclass
class Config:
    root: Path
    data_dir: Path
    port: int = 8787
    token: str = ''
    api_key: str = ''
    model: str = 'gpt-6-luna'
    google_client_id: str = ''
    google_client_secret: str = ''
    encryption_secret: str = ''
    browser_executable: str | None = None
    browser_channel: str | None = None
    docker_enabled: bool = False
    docker_image: str = 'python:3.12-slim'
    daily_token_limit: int = 200000
    run_token_reservation: int = 100000
    spotify_client_id: str = ''
    mastodon_base_url: str = ''
    shopify_store: str = ''
    homeassistant_base_url: str = ''


def load_config(root: Path | str | None = None) -> Config:
    root = Path(root or Path.cwd()).resolve()
    values = {}
    path = root / '.dev.vars'
    if path.exists():
        for line in path.read_text(encoding='utf-8-sig').splitlines():
            match = re.fullmatch(r'\s*([A-Z][A-Z0-9_]*)\s*=\s*(.*?)\s*', line)
            if match:
                value = match[2]
                values[match[1]] = value[1:-1] if len(value) >= 2 and value[0] in '\'"' and value[-1] == value[0] else value
    def get(key, fallback=''):
        return os.environ.get(key, values.get(key, fallback))
    if get('OPENAI_MODEL', 'gpt-6-luna') != 'gpt-6-luna':
        raise ValueError('Only gpt-6-luna is permitted. Correct OPENAI_MODEL.')
    port = int(get('LOCAL_PORT', '8787'))
    if not 1024 <= port <= 65535:
        raise ValueError('LOCAL_PORT must be between 1024 and 65535')
    return Config(root=root, data_dir=(root / get('ASSISTANT_DATA_DIR', '.assistant')).resolve(), port=port,
                  token=get('HARNESS_TOKEN'), api_key=get('OPENAI_API_KEY'),
                  google_client_id=get('GOOGLE_CLIENT_ID'), google_client_secret=get('GOOGLE_CLIENT_SECRET'),
                  encryption_secret=get('CREDENTIAL_KEY', get('HARNESS_TOKEN')),
                  browser_executable=get('BROWSER_EXECUTABLE_PATH') or None, browser_channel=get('BROWSER_CHANNEL') or None,
                  docker_enabled=get('ENABLE_DOCKER_EXECUTION') == 'true', docker_image=get('DOCKER_IMAGE', 'python:3.12-slim'),
                  daily_token_limit=int(get('DAILY_TOKEN_LIMIT', '200000')), run_token_reservation=int(get('RUN_TOKEN_RESERVATION', '100000')),
                  spotify_client_id=get('SPOTIFY_CLIENT_ID'), mastodon_base_url=get('MASTODON_BASE_URL'),
                  shopify_store=get('SHOPIFY_STORE'), homeassistant_base_url=get('HOME_ASSISTANT_BASE_URL'))
