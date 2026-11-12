import json
import tempfile
import time
from pathlib import Path
from urllib.parse import parse_qs, urlsplit
from unittest.mock import AsyncMock

import httpx
from harness.core.config import Config
from harness.integrations.providers import ProviderRegistry, CredentialVault
from tests.offline_loop import OfflineAsyncCase


TOKEN='synthetic-authorized-token-123456'


class ProviderTests(OfflineAsyncCase):
    async def asyncSetUp(self):
        self.temp=tempfile.TemporaryDirectory(prefix='python-runtime-providers-',dir=Path.cwd())
        self.root=Path(self.temp.name); self.requests=[]
        self.config=Config(root=self.root,data_dir=self.root,token='synthetic-harness-token-123456',encryption_secret='synthetic-credential-secret-123456',
            spotify_client_id='test-client',mastodon_base_url='https://social.example.org',shopify_store='test-store.myshopify.com',homeassistant_base_url='http://192.168.1.20:8123')
        def handler(request):
            self.requests.append(request)
            path=request.url.path
            if path=='/api/auth.test': return httpx.Response(200,json=dict(ok=True,user_id='U123456',team_id='T123456',team='Test',user='Bot'))
            if path=='/api/conversations.list': return httpx.Response(200,json=dict(ok=True,channels=[dict(id='C123456',name='test')]))
            if path=='/api/conversations.history': return httpx.Response(200,json=dict(ok=True,messages=[dict(text='Synthetic reference data')],has_more=False))
            if path=='/api/chat.postMessage': return httpx.Response(200,json=dict(ok=True,channel='C123456',ts='123.456'))
            if path=='/api/v1/accounts/verify_credentials': return httpx.Response(200,json=dict(id='42',acct='test'))
            if path=='/api/v1/timelines/home': return httpx.Response(200,json=[dict(id='1',content='<b>Untrusted text</b>',url='https://social.example.org/@test/1')])
            if path=='/api/v1/statuses': return httpx.Response(200,json=dict(id='2',url='https://social.example.org/@test/2',visibility='private'))
            if path=='/api/token': return httpx.Response(200,json=dict(access_token='synthetic-spotify-access',refresh_token='synthetic-spotify-refresh',expires_in=3600,scope='user-read-private'))
            if path=='/v1/me': return httpx.Response(200,json=dict(id='spotify-user',display_name='Test'))
            if path=='/v1/me/player/currently-playing': return httpx.Response(204)
            if path=='/v1/me/tracks': return httpx.Response(200,json=dict(items=[]))
            if path=='/api/': return httpx.Response(200,json=dict(message='API running.'))
            if path=='/api/states/sensor.room_temperature': return httpx.Response(200,json=dict(entity_id='sensor.room_temperature',state='22',attributes={'secret':'not exposed'}))
            if path=='/api/2026-10/graphql.json':
                body=json.loads(request.content)
                return httpx.Response(200,json=dict(data=dict(shop=dict(name='Test shop')) if 'shop {' in body['query'] else dict(products=dict(nodes=[dict(title='Test product')]))))
            return httpx.Response(404,json=dict(error='unexpected endpoint'))
        self.client=httpx.AsyncClient(transport=httpx.MockTransport(handler))
        self.validator=AsyncMock()
        self.registry=ProviderRegistry(self.config,client=self.client,url_validator=self.validator)
    async def asyncTearDown(self):
        await self.registry.close();await self.client.aclose()
        for attempt in range(8):
            try:self.temp.cleanup();break
            except PermissionError:
                if attempt==7:raise
                import asyncio
                await asyncio.sleep(.05*(attempt+1))
    async def test_authorization_checks_identity_before_encrypted_storage(self):
        self.assertTrue((await self.registry.connect_token('slack',TOKEN))['connected'])
        raw=(self.root/'credentials/providers/slack.enc').read_text()
        self.assertNotIn(TOKEN,raw)
        status=next(p for p in await self.registry.status() if p['provider']=='slack')
        self.assertTrue(status['connected']);self.assertNotIn(TOKEN,json.dumps(status))
        await self.registry.disconnect('slack')
        self.assertFalse((self.root/'credentials/providers/slack.enc').exists())
    async def test_failed_auth_never_saves_or_overwrites_a_grant(self):
        await self.registry.connect_token('slack',TOKEN)
        connection=self.registry.vault.load('slack')['connectionId']
        failed=httpx.AsyncClient(transport=httpx.MockTransport(lambda r:httpx.Response(401)))
        self.registry.client=failed
        try:
            with self.assertRaisesRegex(ValueError,'401'):await self.registry.connect_token('slack','different-synthetic-token')
        finally:await failed.aclose();self.registry.client=self.client
        self.assertEqual(self.registry.vault.load('slack')['connectionId'],connection)
    async def test_read_is_bounded_and_no_generic_url_or_write_tool_exists(self):
        await self.registry.connect_token('slack',TOKEN)
        result=await self.registry.read('slack','history',dict(channel='C123456'))
        self.assertTrue(result['messages'])
        self.assertEqual(parse_qs(self.requests[-1].url.query.decode())['limit'],['15'])
        with self.assertRaisesRegex(ValueError,'Unsupported'):await self.registry.read('slack','chat.postMessage',{})
        with self.assertRaisesRegex(ValueError,'conversation ID'):await self.registry.read('slack','history',dict(channel='a name'))
    async def test_send_binding_rejects_reconnected_account_and_uses_exact_payload(self):
        await self.registry.connect_token('slack',TOKEN)
        payload=await self.registry.bind_write('slack.send',dict(channel='C123456',text='Exact synthetic message'))
        self.assertFalse(any(r.url.path=='/api/chat.postMessage' for r in self.requests))
        await self.registry.connect_token('slack','another-synthetic-token-12345')
        with self.assertRaisesRegex(ValueError,'account changed'):await self.registry.execute_write('slack.send',payload,'approval-id')
        payload=await self.registry.bind_write('slack.send',dict(channel='C123456',text='Exact synthetic message'))
        await self.registry.execute_write('slack.send',payload,'approval-id')
        self.assertFalse(json.loads(self.requests[-1].content)['mrkdwn'])
    async def test_mastodon_origin_guard_visibility_and_idempotency(self):
        await self.registry.connect_token('mastodon',TOKEN)
        self.validator.assert_awaited()
        with self.assertRaisesRegex(ValueError,'visibility'):await self.registry.bind_write('mastodon.publish',dict(text='Test'))
        payload=await self.registry.bind_write('mastodon.publish',dict(text='Synthetic test',visibility='private'))
        await self.registry.execute_write('mastodon.publish',payload,'exact-approval-id')
        self.assertEqual(self.requests[-1].headers['Idempotency-Key'],'exact-approval-id')
        self.config.mastodon_base_url='https://other.example.org'
        with self.assertRaisesRegex(ValueError,'origin changed'):await self.registry.read('mastodon','home',{})
    async def test_spotify_pkce_state_single_use_refresh_and_empty_playback(self):
        start=self.registry.start_spotify();params=parse_qs(urlsplit(start['url']).query)
        self.assertEqual(params['code_challenge_method'],['S256'])
        self.assertEqual(params['redirect_uri'],['http://127.0.0.1:8787/oauth/spotify/callback'])
        state=params['state'][0]
        await self.registry.complete_spotify('synthetic-code',state)
        with self.assertRaisesRegex(ValueError,'state'):await self.registry.complete_spotify('synthetic-code',state)
        record=self.registry.vault.load('spotify');record['expiresAt']=time.time()-1;self.registry.vault.save('spotify',record)
        self.assertEqual(await self.registry.read('spotify','currently_playing',{}),{})
        self.assertTrue(any(b'grant_type=refresh_token' in r.content for r in self.requests))
    async def test_device_reads_are_exact_and_omit_attributes(self):
        await self.registry.connect_token('homeassistant',TOKEN)
        result=await self.registry.read('homeassistant','states',dict(entityId='sensor.room_temperature'))
        self.assertNotIn('attributes',result)
        with self.assertRaisesRegex(ValueError,'entityId'):await self.registry.read('homeassistant','states',{})
        with self.assertRaisesRegex(ValueError,'Unsupported'):await self.registry.read('homeassistant','call_service',{})
    async def test_commerce_query_is_a_fixed_graphql_read_without_checkout(self):
        await self.registry.connect_token('shopify',TOKEN)
        result=await self.registry.read('shopify','products',dict(query='Test product'))
        self.assertFalse(result['checkoutSupported'])
        self.assertEqual(self.requests[-1].headers['X-Shopify-Storefront-Access-Token'],TOKEN)
        self.assertNotIn('Authorization',self.requests[-1].headers)
        with self.assertRaisesRegex(ValueError,'Unsupported'):await self.registry.read('shopify','checkout',{})
    async def test_untrusted_provider_origins_and_unknown_providers_rejected(self):
        for value in ('https://user:password@evil.example','https://evil.example/path','http://evil.example'):
            self.config.mastodon_base_url=value
            with self.assertRaises(ValueError):self.registry.base('mastodon')
        self.config.homeassistant_base_url='http://169.254.169.254'
        with self.assertRaises(ValueError):self.registry.base('homeassistant')
        with self.assertRaises(ValueError):await self.registry.connect_token('../../bad',TOKEN)
