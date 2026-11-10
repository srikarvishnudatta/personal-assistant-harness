import json
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock

from harness.store import LocalStore
from harness.knowledge import HistoryIndex, PeopleGraph, RepairQueue
from harness.freshness import FreshnessVerifier, check_observations
from backend.tests.offline_loop import OfflineAsyncCase


class KnowledgeTests(unittest.TestCase):
    def setUp(self):
        self.store=LocalStore(':memory:'); self.index=HistoryIndex(self.store); self.people=PeopleGraph(self.store); self.repairs=RepairQueue(self.store)
    def tearDown(self): self.store.close()
    def test_index_covers_history_beyond_recent_limit_and_tracks_edit_delete(self):
        old=self.store.add_message('user','The bicycle requires a repaired derailleur.')
        for i in range(1005): self.store.add_message('assistant',f'Unrelated later message {i}')
        self.assertEqual(self.index.status()['indexedMessages'],1006)
        matches=self.index.search('bike', ['bicycle'])
        self.assertEqual(matches[0]['id'],old['id'])
        self.store.db.execute('UPDATE messages SET content=? WHERE id=?',('A corrected road bike note',old['id']))
        self.assertEqual(self.index.validate_results(matches),[])
        self.assertEqual(self.index.search('derailleur'),[])
        self.assertEqual(self.index.search('bike')[0]['id'],old['id'])
        self.store.db.execute('DELETE FROM messages WHERE id=?',(old['id'],))
        self.assertEqual(self.index.search('bike'),[])
    def test_index_backfills_legacy_messages(self):
        self.store.db.execute('DROP TRIGGER history_added')
        message=self.store.add_message('user','Legacy astronomy discussion')
        from harness.knowledge import initialize_knowledge
        initialize_knowledge(self.store.db)
        self.assertEqual(self.index.search('astronomy')[0]['id'],message['id'])
    def test_search_handles_fts_operators_as_data(self):
        self.store.add_message('user','A token with OR operators is data')
        self.index.search('"OR" - * NEAR ( token )')
    def test_graph_revision_sources_relationships_and_delete_cascade(self):
        message=self.store.add_message('user','Alex belongs to the running group')
        alex=self.people.save(dict(name='Alex',aliases=['Lex'],context='Running friend',sourceIds=[message['id']]))
        group=self.people.save(dict(name='Running club',kind='group'))
        self.people.relate(dict(source=alex['id'],target=group['id'],label='member of'))
        with self.assertRaisesRegex(ValueError,'revision conflict'):
            self.people.save(dict(name='Alex',expectedRevision=0),alex['id'])
        updated=self.people.save(dict(name='Alex',aliases=['Lex'],context='Corrected',expectedRevision=1),alex['id'])
        self.assertEqual(updated['revision'],2)
        self.assertEqual(len(self.people.lineage(alex['id'])),2)
        self.assertEqual(len(self.people.list()['relationships']),1)
        self.assertEqual(len(self.people.context('Ask Lex about running')['people']),2)
        self.people.remove(alex['id'])
        self.assertEqual(self.people.list()['relationships'],[])
        with self.assertRaisesRegex(ValueError,'source ID'):
            self.people.save(dict(name='Unknown',sourceIds=['missing']))
    def test_forget_removes_graph_lineage_and_fts_source(self):
        message=self.store.add_message('user','Synthetic personal claim')
        memory=self.store.save_memory(dict(text='Synthetic personal claim',source='user',sourceIds=[message['id']],provenance='explicit'))
        node=self.people.save(dict(name='Synthetic person',context='Synthetic personal claim',sourceIds=[memory['id']]))
        self.people.save(dict(name='Renamed',context='Different words',expectedRevision=1),node['id'])
        self.repairs.create('correction','Synthetic personal claim','Inspect this exact copy')
        self.store.forget_memory(memory['id'],True)
        self.assertEqual(self.people.list()['people'],[])
        self.assertEqual(self.repairs.list(),[])
        self.assertEqual(self.index.search('Synthetic personal claim'),[])
    def test_repairs_dedupe_revision_transitions_and_evidence(self):
        repair=self.repairs.create('task','task:example','Failure needs review')
        self.assertEqual(self.repairs.create('task','task:example','Same failure')['id'],repair['id'])
        with self.assertRaisesRegex(ValueError,'transition'):
            self.repairs.transition(repair['id'],dict(status='resolved',expectedRevision=1,resolution='Done',evidence=['https://example.org']))
        repair=self.repairs.transition(repair['id'],dict(status='reviewing',expectedRevision=1,resolution='Investigating'))
        with self.assertRaisesRegex(ValueError,'evidence'):
            self.repairs.transition(repair['id'],dict(status='resolved',expectedRevision=2,resolution='Done'))
        repair=self.repairs.transition(repair['id'],dict(status='resolved',expectedRevision=2,resolution='Checked source',evidence=['https://example.org/checked']))
        self.assertEqual(repair['status'],'resolved')

    def test_corrected_source_invalidates_old_summary_and_suppresses_graph_context(self):
        memory=self.store.save_memory(dict(text='Taylor works at Company A',source='user',provenance='explicit'))
        person=self.people.save(dict(name='Taylor',context='Works at Company A',sourceIds=[memory['id']]))
        self.store.set_setting('conversationSummary',{'text':'Old summary'})
        self.store.update_memory(memory['id'],dict(text='Taylor now works at Company B',source='user-correction',provenance='explicit'))
        self.assertIsNone(self.store.get_setting('conversationSummary'))
        self.assertTrue(self.people.get(person['id'])['needsReview'])
        self.assertEqual(self.people.context('Taylor')['people'],[])
        corrected=self.people.save(dict(name='Taylor',context='Works at Company B',sourceIds=[memory['id']],expectedRevision=2),person['id'])
        self.assertFalse(corrected['needsReview']);self.assertTrue(self.people.context('Taylor')['people'])


class FreshnessTests(OfflineAsyncCase):
    def test_each_source_must_be_fresh_and_not_future(self):
        now=1000000
        obs=[dict(url='old',observedAt=1000,excerpt='Old'),dict(url='new',observedAt=now,excerpt='New')]
        self.assertEqual(check_observations(['old','new'],obs,now=now),[{'url':'old','reason':'stale-source'}])
        self.assertEqual(check_observations(['new'],[dict(url='new',observedAt=now+10000,excerpt='Future')],now=now)[0]['reason'],'observation-in-future')
    async def asyncSetUp(self):
        self.store=LocalStore(':memory:')
        self.browser=SimpleNamespace(status=AsyncMock(return_value={'manualControl':False}),navigate=AsyncMock(return_value={'id':'own-tab','status':200}),snapshot=AsyncMock(return_value={'text':'Product documentation supports feature A.'}),close_tab=AsyncMock())
        self.model=AsyncMock(return_value=json.dumps({'complete':True,'claims':[dict(claim='Feature A exists',verdict='supported',sources=['https://docs.example.org/feature'],reason='Document describes A')]}))
        self.runtime=SimpleNamespace(store=self.store,browser=self.browser,model=self.model,privacy_epoch=0,repairs=RepairQueue(self.store))
        self.verifier=FreshnessVerifier(self.runtime)
    async def asyncTearDown(self): self.store.close()
    async def test_supported_review_has_source_hash_and_closes_only_own_tab(self):
        report=await self.verifier.verify('Feature A exists. https://docs.example.org/feature')
        self.assertTrue(report['selected']);self.assertTrue(report['sources'][0]['contentHash'])
        self.browser.close_tab.assert_awaited_once_with('own-tab')
        self.assertIsNone(report['sources'][0]['publishedAt'])
    async def test_failed_read_or_unsupported_claim_holds_and_opens_repair(self):
        self.browser.snapshot.side_effect=ValueError('not accessible')
        report=await self.verifier.verify('Feature A exists. https://docs.example.org/feature')
        self.assertFalse(report['selected']);self.model.assert_not_awaited()
        self.assertEqual(self.runtime.repairs.list()[0]['status'],'open')
    async def test_incomplete_or_fabricated_citation_cannot_pass(self):
        self.model.return_value=json.dumps({'complete':True,'claims':[dict(claim='X',verdict='supported',sources=['https://different.example.org'],reason='X')]})
        self.assertFalse((await self.verifier.verify('Feature A https://docs.example.org/feature'))['selected'])
    async def test_forget_during_verification_does_not_persist_report(self):
        async def forgotten(*args,**kwargs):
            self.runtime.privacy_epoch+=1
            return json.dumps({'complete':False,'claims':[]})
        self.model.side_effect=forgotten
        with self.assertRaisesRegex(ValueError,'forgotten'):
            await self.verifier.verify('Feature A https://docs.example.org/feature')
        self.assertEqual(self.store.db.execute('SELECT count(*) FROM freshness_reports').fetchone()[0],0)
