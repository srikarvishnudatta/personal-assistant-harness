"""Explicit, bounded provider adapters. Credentials never enter agent arguments."""
import asyncio
import base64
import hashlib
import ipaddress
import json
import os
import re
import secrets
import time
from pathlib import Path
from urllib.parse import urlencode, urlsplit

import httpx
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

from .browser import assert_public_browser_url
from .workspace import _retry_sharing_violation


CATALOG = {
    'slack': dict(label='Slack', category='communication', auth='installed app token', reads=['channels', 'history'], writes=['slack.send'], setup='Install a Slack app with channels:read, channels:history and chat:write as needed. Access is limited by membership/scopes.'),
    'mastodon': dict(label='Mastodon', category='social', auth='authorized account token', reads=['home'], writes=['mastodon.publish'], setup='Set MASTODON_BASE_URL to your HTTPS instance. Authorize a Mastodon app with read:accounts, read:statuses and write:statuses as needed.'),
    'spotify': dict(label='Spotify', category='media', auth='OAuth PKCE', reads=['currently_playing', 'saved_tracks'], writes=[], setup='Set SPOTIFY_CLIENT_ID and register the exact loopback callback. Spotify app/account eligibility and scopes apply.'),
    'shopify': dict(label='Shopify', category='commerce catalogue', auth='Storefront public access token', reads=['products'], writes=[], setup='Set SHOPIFY_STORE to your store-name.myshopify.com and supply its Storefront public access token. Product lookup only; no carts, payments or purchases.'),
    'homeassistant': dict(label='Home Assistant', category='devices', auth='long-lived account token', reads=['states'], writes=[], setup='Set HOME_ASSISTANT_BASE_URL to the exact trusted installation. Read-only entity states; no locks, alarms or device-control tools.'),
}
SPOTIFY_SCOPES = 'user-read-private user-read-currently-playing user-library-read'


class CredentialVault:
    def __init__(self, directory, secret):
        if len(secret) < 24: raise ValueError('Credential key must have at least 24 characters')
        self.directory = Path(directory); self.key = hashlib.sha256(secret.encode()).digest()
    def path(self, provider):
        if provider not in CATALOG: raise ValueError('Unknown provider')
        return self.directory / (provider + '.enc')
    def load(self, provider):
        path = self.path(provider)
        try:
            envelope = json.loads(path.read_text(encoding='utf-8'))
            raw = AESGCM(self.key).decrypt(base64.b64decode(envelope['iv']), base64.b64decode(envelope['sealed']), provider.encode())
            return json.loads(raw)
        except FileNotFoundError: return None
        except Exception: raise ValueError('Cannot unlock provider credentials; restore the original credential key') from None
    def save(self, provider, value):
        path = self.path(provider); path.parent.mkdir(parents=True, exist_ok=True)
        iv = secrets.token_bytes(12)
        sealed = AESGCM(self.key).encrypt(iv, json.dumps(value).encode(), provider.encode())
        temporary = path.with_name(path.name + '.' + secrets.token_hex(8) + '.tmp')
        try:
            with temporary.open('x', encoding='utf-8') as stream:
                os.chmod(temporary, 0o600)
                stream.write(json.dumps({'iv': base64.b64encode(iv).decode(), 'sealed': base64.b64encode(sealed).decode()}))
                stream.flush(); os.fsync(stream.fileno())
            _retry_sharing_violation(lambda: os.replace(temporary, path))
        finally:
            try: _retry_sharing_violation(temporary.unlink)
            except FileNotFoundError: pass
    def remove(self, provider):
        try: _retry_sharing_violation(self.path(provider).unlink)
        except FileNotFoundError: pass


class ProviderRegistry:
    def __init__(self, config, client=None, url_validator=None):
        self.config = config; self.vault = CredentialVault(config.data_dir / 'credentials' / 'providers', config.encryption_secret or config.token)
        self.client = client; self.owns_client = client is None
        self.validate_url = url_validator or assert_public_browser_url
        self.pending = {}; self.lock = asyncio.Lock()
    async def close(self):
        if self.owns_client and self.client: await self.client.aclose()
    def base(self, provider):
        if provider == 'slack': return 'https://slack.com'
        if provider == 'spotify': return 'https://api.spotify.com'
        if provider == 'shopify':
            host = self.config.shopify_store
            if not re.fullmatch(r'[a-z0-9][a-z0-9-]{0,62}\.myshopify\.com', host): raise ValueError('Set SHOPIFY_STORE to a store-name.myshopify.com host')
            return 'https://' + host
        value = self.config.mastodon_base_url if provider == 'mastodon' else self.config.homeassistant_base_url if provider == 'homeassistant' else ''
        part = urlsplit(value)
        if not part.hostname or part.username or part.password or part.query or part.fragment or part.path not in ('', '/'):
            raise ValueError('Configure a trusted provider origin without a path or credentials')
        if part.scheme != 'https' and not (provider == 'homeassistant' and part.scheme == 'http'):
            raise ValueError('Provider requires HTTPS; only explicitly configured Home Assistant may use HTTP')
        if provider == 'homeassistant':
            try: address = ipaddress.ip_address(part.hostname)
            except ValueError: address = None
            if address and (address.is_link_local or address.is_unspecified or address.is_multicast): raise ValueError('Invalid Home Assistant address')
        return value.rstrip('/')
    async def status(self):
        result = []
        for provider, definition in CATALOG.items():
            configured = True
            try: self.base(provider)
            except ValueError: configured = False
            if provider == 'spotify': configured = bool(self.config.spotify_client_id)
            record = await asyncio.to_thread(self.vault.load, provider)
            result.append(dict(provider=provider, **definition, configured=configured, connected=bool(record),
                identity=record.get('identity') if record else None, verifiedAt=record.get('verifiedAt') if record else None,
                connectionId=record.get('connectionId') if record else None,
                statusMeaning='Stored authorization last verified at verifiedAt; not a live permission check'))
        return result
    async def _http(self, method, url, token=None, headers=None, **kwargs):
        if not self.client: self.client = httpx.AsyncClient(timeout=20, follow_redirects=False, trust_env=False)
        headers = dict(headers or {})
        if token: headers['Authorization'] = 'Bearer ' + token
        async with self.client.stream(method, url, headers=headers, **kwargs) as response:
            if response.status_code == 429: raise ValueError('Provider rate limited the request; wait before retrying')
            if not 200 <= response.status_code < 300: raise ValueError(f'Provider request failed ({response.status_code}); check authorization and scopes')
            if response.status_code == 204: return {}
            raw = bytearray()
            async for chunk in response.aiter_bytes():
                raw.extend(chunk)
                if len(raw) > 1024 * 1024: raise ValueError('Provider response exceeds 1 MiB')
        try: value = json.loads(raw)
        except Exception: raise ValueError('Provider returned invalid JSON') from None
        if isinstance(value, dict) and value.get('ok') is False: raise ValueError('Provider rejected operation; check membership and scopes')
        # Defend against an upstream accidentally echoing an access token.
        if token: value = json.loads(json.dumps(value).replace(token, '[redacted]'))
        return value
    async def _request(self, provider, method, path, record, **kwargs):
        base = self.base(provider)
        if record.get('origin') != base: raise ValueError('Provider origin changed; reconnect before using credentials')
        if provider == 'mastodon': await self.validate_url(base)
        headers = kwargs.pop('headers', {})
        token = record['access_token']
        if provider == 'shopify': headers['X-Shopify-Storefront-Access-Token'] = token; token = None
        try: result = await self._http(method, base + path, token, headers, **kwargs)
        except httpx.HTTPError: raise ValueError('Provider network request failed; check connectivity and authorization') from None
        return json.loads(json.dumps(result).replace(record['access_token'], '[redacted]'))
    async def _identity(self, provider, record):
        if provider == 'slack':
            data = await self._request(provider, 'POST', '/api/auth.test', record)
            if not data.get('user_id') or not data.get('team_id'): raise ValueError('Provider returned no account identity')
            return {'id': data['team_id'] + ':' + data['user_id'], 'label': str(data.get('team', '')) + ' / ' + str(data.get('user', ''))}
        if provider == 'mastodon':
            data = await self._request(provider, 'GET', '/api/v1/accounts/verify_credentials', record)
            if not data.get('id'): raise ValueError('Provider returned no account identity')
            return {'id': str(data['id']), 'label': data.get('acct', '')}
        if provider == 'spotify':
            data = await self._request(provider, 'GET', '/v1/me', record)
            if not data.get('id'): raise ValueError('Provider returned no account identity')
            return {'id': str(data['id']), 'label': data.get('display_name', '')}
        if provider == 'homeassistant':
            await self._request(provider, 'GET', '/api/', record)
            return {'id': record['origin'], 'label': 'Trusted installation (token permissions apply)'}
        data = await self._request(provider, 'POST', '/api/2026-10/graphql.json', record, json={'query': '{ shop { name } }'})
        if data.get('errors') or not data.get('data', {}).get('shop'): raise ValueError('Storefront authorization failed')
        return {'id': record['origin'], 'label': data['data']['shop']['name']}
    async def connect_token(self, provider, token):
        if provider not in CATALOG or provider == 'spotify': raise ValueError('Use the supported provider authorization flow')
        if not isinstance(token, str) or not re.fullmatch(r'[A-Za-z0-9._~+/=-]{12,4096}',token): raise ValueError('Invalid access token')
        record = dict(access_token=token, origin=self.base(provider), connectionId=secrets.token_hex(16), verifiedAt=int(time.time()*1000))
        record['identity'] = await self._identity(provider, record)
        await asyncio.to_thread(self.vault.save, provider, record)
        return {'connected': True, 'identity': record['identity']}
    async def disconnect(self, provider):
        async with self.lock: await asyncio.to_thread(self.vault.remove, provider)
        return {'connected': False, 'localCredentialsRemoved': True, 'remoteGrantRevoked': False}
    def start_spotify(self):
        if not self.config.spotify_client_id: raise ValueError('Set SPOTIFY_CLIENT_ID first')
        now_ = time.time(); self.pending = {k:v for k,v in self.pending.items() if v[1] > now_}
        if len(self.pending) >= 10: raise ValueError('Too many pending authorization requests')
        state, verifier = secrets.token_urlsafe(32), secrets.token_urlsafe(48)
        self.pending[state] = (verifier, now_+600)
        challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).rstrip(b'=').decode()
        return {'url': 'https://accounts.spotify.com/authorize?' + urlencode(dict(client_id=self.config.spotify_client_id,
            response_type='code', redirect_uri=self.redirect_uri, scope=SPOTIFY_SCOPES, state=state, code_challenge_method='S256', code_challenge=challenge))}
    @property
    def redirect_uri(self): return f'http://127.0.0.1:{self.config.port}/oauth/spotify/callback'
    async def complete_spotify(self, code, state):
        pending = self.pending.pop(state, None)
        if not pending or pending[1] < time.time() or not code or len(code) > 4096: raise ValueError('Invalid or expired Spotify OAuth state')
        data = await self._http('POST', 'https://accounts.spotify.com/api/token', data=dict(client_id=self.config.spotify_client_id,
            grant_type='authorization_code', redirect_uri=self.redirect_uri, code=code, code_verifier=pending[0]))
        if not data.get('access_token'): raise ValueError('Spotify returned no access token')
        record = dict(access_token=data['access_token'], refresh_token=data.get('refresh_token'), expiresAt=time.time()+float(data.get('expires_in', 3600)),
            origin=self.base('spotify'), clientId=self.config.spotify_client_id, scopes=data.get('scope', ''), connectionId=secrets.token_hex(16), verifiedAt=int(time.time()*1000))
        record['identity'] = await self._identity('spotify', record)
        await asyncio.to_thread(self.vault.save, 'spotify', record)
        return {'connected': True}
    async def _record(self, provider):
        if provider not in CATALOG: raise ValueError('Unknown provider')
        async with self.lock:
            record = await asyncio.to_thread(self.vault.load, provider)
            if not record: raise ValueError('Provider is not connected')
            if provider == 'spotify':
                if record.get('clientId') != self.config.spotify_client_id: raise ValueError('Spotify client changed; reconnect')
                if record.get('expiresAt', 0) < time.time()+30:
                    if not record.get('refresh_token'): raise ValueError('Reconnect Spotify to renew authorization')
                    data = await self._http('POST', 'https://accounts.spotify.com/api/token', data=dict(grant_type='refresh_token',
                        refresh_token=record['refresh_token'], client_id=self.config.spotify_client_id))
                    if not data.get('access_token'): raise ValueError('Spotify refresh failed')
                    record.update(access_token=data['access_token'], refresh_token=data.get('refresh_token', record['refresh_token']), expiresAt=time.time()+float(data.get('expires_in',3600)))
                    await asyncio.to_thread(self.vault.save, provider, record)
            return record
    async def read(self, provider, action, args):
        if provider not in CATALOG or action not in CATALOG[provider]['reads']: raise ValueError('Unsupported provider read')
        record = await self._record(provider)
        if provider == 'slack':
            path = '/api/conversations.list' if action == 'channels' else '/api/conversations.history'
            params = {'limit': 15}
            if action == 'history':
                channel = args.get('channel', '')
                if not re.fullmatch(r'[CDG][A-Z0-9]{5,30}', channel): raise ValueError('An exact Slack conversation ID is required')
                params['channel'] = channel
            result = await self._request(provider, 'GET', path, record, params=params)
            return {k: result[k] for k in ('channels', 'messages', 'has_more', 'response_metadata') if k in result}
        if provider == 'mastodon':
            posts = await self._request(provider, 'GET', '/api/v1/timelines/home', record, params={'limit': 15})
            return {'posts': [{k:p.get(k) for k in ('id','url','content','created_at','visibility')} for p in posts[:15]], 'contentIsUntrustedHTML': True}
        if provider == 'spotify':
            path = '/v1/me/tracks' if action == 'saved_tracks' else '/v1/me/player/currently-playing'
            return await self._request(provider, 'GET', path, record, params={'limit': 15} if action == 'saved_tracks' else {})
        if provider == 'homeassistant':
            entity = args.get('entityId')
            if not isinstance(entity, str) or not re.fullmatch(r'[a-z_]+\.[a-z0-9_]{1,100}', entity): raise ValueError('Supply one exact entityId; bulk device discovery is not exposed')
            state = await self._request(provider, 'GET', '/api/states/' + entity, record)
            return {k:state.get(k) for k in ('entity_id', 'state', 'last_changed', 'last_updated')}
        query = args.get('query', '')
        if not isinstance(query, str) or len(query) > 500: raise ValueError('Invalid product query')
        document = 'query($q:String!){products(first:10,query:$q){nodes{id title handle onlineStoreUrl availableForSale priceRange{minVariantPrice{amount currencyCode}}}}}'
        result = await self._request(provider, 'POST', '/api/2026-10/graphql.json', record, json={'query':document,'variables':{'q':query}})
        if result.get('errors'): raise ValueError('Storefront product query failed')
        return {'products': result.get('data', {}).get('products', {}).get('nodes', []), 'observedAt': int(time.time()*1000), 'checkoutSupported': False}
    async def bind_write(self, kind, payload):
        provider = kind.split('.')[0]
        if provider not in CATALOG or kind not in CATALOG[provider]['writes']: raise ValueError('Unsupported provider write')
        allowed = {'channel','text'} if provider == 'slack' else {'text','visibility'}
        if set(payload) - allowed: raise ValueError('Unsupported provider payload fields')
        message = payload.get('text')
        if not isinstance(message,str) or not message.strip() or len(message)>4000: raise ValueError('Message must have 1-4000 characters')
        if provider == 'slack' and not re.fullmatch(r'[CDG][A-Z0-9]{5,30}', str(payload.get('channel',''))): raise ValueError('Resolve an exact Slack conversation ID first')
        if provider == 'mastodon' and payload.get('visibility') not in ('public','unlisted','private','direct'): raise ValueError('Choose explicit post visibility')
        record = await self._record(provider)
        return {**payload, 'connectionId': record['connectionId'], 'account': record['identity'], 'origin': record['origin']}
    async def execute_write(self, kind, payload, approval_id):
        provider = kind.split('.')[0]; record = await self._record(provider)
        if payload.get('connectionId') != record['connectionId'] or payload.get('account') != record['identity'] or payload.get('origin') != record['origin']:
            raise ValueError('Provider account changed; create a new approval')
        if kind == 'slack.send':
            result = await self._request(provider, 'POST', '/api/chat.postMessage', record, json=dict(channel=payload['channel'],
                text=payload['text'], mrkdwn=False, unfurl_links=False, unfurl_media=False))
            return {k:result.get(k) for k in ('ok','channel','ts')}
        if kind == 'mastodon.publish':
            result = await self._request(provider, 'POST', '/api/v1/statuses', record,
                headers={'Idempotency-Key': approval_id}, json=dict(status=payload['text'], visibility=payload['visibility']))
            return {k:result.get(k) for k in ('id','url','visibility')}
        raise ValueError('Unsupported provider write')
