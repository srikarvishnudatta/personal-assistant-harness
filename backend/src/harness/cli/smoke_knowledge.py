"""Live local acceptance without account writes or provider credentials."""
import asyncio
import json
import secrets

import httpx

from harness.core.config import load_config


async def main():
    config=load_config(); base=f'http://127.0.0.1:{config.port}'
    marker='KnowledgeSmoke'+secrets.token_hex(6)
    async with httpx.AsyncClient(base_url=base,headers={'Authorization':'Bearer '+config.token},timeout=180,trust_env=False) as client:
        async def api(method,path,body=None):
            response=await client.request(method,'/api'+path,json=body) if body is not None else await client.request(method,'/api'+path)
            if response.status_code>=400: raise ValueError(f'{path}: HTTP {response.status_code}')
            return response.json()
        status=await api('GET','/status')
        if status.get('backend')!='python': raise ValueError('Updated Python server required; restart npm run dev')
        if status.get('activity',{}).get('activeTasks') or status.get('activity',{}).get('chatBusy') or status.get('activity',{}).get('queuedTasks'):
            raise ValueError('Wait until chat and the background queue are idle')
        print('Testing knowledge expansion with synthetic fixtures. Three short model runs are expected; no provider account writes.')
        memory=None; nodes=[]
        try:
            memory=await api('POST','/memories',dict(text=marker+' synthetic test preference'))
            person=await api('POST','/people',dict(name=marker,context='Synthetic test record',sourceIds=[memory['id']]))
            nodes.append(person['id'])
            group=await api('POST','/people',dict(name=marker+' group',kind='group'));nodes.append(group['id'])
            await api('POST','/people/relationships',dict(source=person['id'],target=group['id'],label='test member of'))
            await api('PATCH','/people/'+person['id'],dict(name=marker,context='Synthetic corrected context',sourceIds=[memory['id']],expectedRevision=person['revision']))
            lineage=await api('GET','/people/'+person['id']+'/lineage')
            assert len(lineage['lineage'])==2,'Graph lineage missing'
            print('People/group relationship, source provenance and revision history passed.')
            await api('POST','/chat',dict(message='Connectivity fixture: reply briefly with '+marker+'. Do not save memory, schedule work or invoke tools.'))
            result=await api('POST','/history/search',dict(query=marker,semantic=False))
            assert result['messages'],'Indexed synthetic conversation was not found'
            result=await api('POST','/history/search',dict(query=marker,semantic=True))
            assert result['messages'],'Semantic history retrieval found no synthetic marker'
            print('Full-history index and GPT-6 Luna expanded/ranked retrieval passed.')
            repair=await api('POST','/repairs',dict(kind='other',subject=marker,description='Synthetic repair acceptance record'))
            repair=await api('PATCH','/repairs/'+repair['id'],dict(status='reviewing',resolution='Reviewing synthetic fixture',expectedRevision=repair['revision']))
            repair=await api('PATCH','/repairs/'+repair['id'],dict(status='resolved',resolution='Verified synthetic memory and graph',evidence=['memory:'+memory['id']],expectedRevision=repair['revision']))
            assert repair['status']=='resolved','Repair transition failed'
            report=await api('POST','/freshness/verify',dict(text=marker+' has no source citation'))
            assert report['selected'] is False,'Unsourced update was not held'
            providers=await api('GET','/connections')
            assert {p['provider'] for p in providers['providers']}=={'slack','mastodon','spotify','shopify','homeassistant'}
            assert all('access_token' not in p for p in providers['providers']),'Provider status exposed credentials'
            print('Repair review/evidence, unsourced-update hold and credential-free provider catalogue passed.')
        finally:
            for node in nodes:
                response=await client.delete('/api/people/'+node)
                if response.status_code not in (200,404): print('A synthetic graph fixture needs manual cleanup:',node)
            if memory:
                await api('POST','/memories/'+memory['id']+'/forget',dict(includeSourceMessages=False))
        print('Temporary graph/memory fixtures removed. Synthetic chat and source-review audit records may remain.')


if __name__=='__main__':
    try: asyncio.run(main())
    except Exception as error: raise SystemExit('Knowledge smoke test failed: '+str(error)[:500]) from None
