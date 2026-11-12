import json
import os
import tempfile
import unittest
import time
from pathlib import Path

from harness.persistence.store import LocalStore, canonical_json


class StoreTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(dir=Path.cwd())
        self.path = str(Path(self.tmp.name) / 'assistant.sqlite')
        self.store = LocalStore(self.path)

    def tearDown(self):
        self.store.close()
        for attempt in range(8):
            try: self.tmp.cleanup(); break
            except PermissionError:
                if attempt == 7: raise
                time.sleep(0.05 * (attempt + 1))

    def test_live_runtime_ownership_is_exclusive_and_clean_close_releases_it(self):
        second = LocalStore(self.path)
        try:
            self.store.claim_runtime_ownership()
            with self.assertRaisesRegex(RuntimeError, 'Another local assistant owns'):
                second.claim_runtime_ownership()
            self.store.close()
            second.claim_runtime_ownership()
        finally: second.close()

    def test_schema_reopens_and_keeps_camel_case_records(self):
        task = self.store.create_task({'prompt': 'persist this'})
        self.store.close()
        self.store = LocalStore(self.path)
        got = self.store.get_task(task['id'])
        self.assertEqual(got['prompt'], 'persist this')
        self.assertIn('createdAt', got)
        cols = {r['name'] for r in self.store._rows('PRAGMA table_info(tasks)')}
        self.assertIn('created_at', cols)

    def test_task_transitions_and_recovery(self):
        task = self.store.create_task({'prompt': 'work'})
        running = self.store.update_task(task['id'], {'status': 'running'})
        self.assertEqual(running['attempts'], 1)
        with self.assertRaisesRegex(ValueError, 'Illegal task transition'):
            self.store.update_task(task['id'], {'status': 'queued'})
        recovered = self.store.recover_interrupted()
        self.assertEqual(recovered['requeued'], 1)
        self.assertEqual(self.store.get_task(task['id'])['status'], 'queued')

    def test_memory_revision_lineage_and_explicit_protection(self):
        m = self.store.save_memory({'text':'Prefers tea','source':'message:m1','provenance':'explicit'})
        updated = self.store.update_memory(m['id'], {'text':'Prefers green tea'})
        self.assertEqual(updated['sourceIds'], ['message:m1'])
        self.assertEqual(len(self.store.memory_lineage(m['id'])), 2)
        with self.assertRaisesRegex(ValueError, 'Inference cannot replace explicit'):
            self.store.update_memory(m['id'], {'provenance':'inferred'})
        self.assertEqual(self.store.revision(), 2)

    def test_approval_digest_and_exactly_once_claim(self):
        a = self.store.create_approval({'kind':'write','payload':{'z':1,'a':'✓'},'summary':'Write item'})
        self.assertEqual(len(a['digest']), 64)
        self.store.decide_approval(a['id'], 'approved', a['digest'])
        self.assertEqual(self.store.claim_execution(a['id'])['status'], 'executing')
        with self.assertRaisesRegex(ValueError, 'already claimed'):
            self.store.claim_execution(a['id'])

    def test_forget_redacts_managed_copies_and_removes_known_source(self):
        message = self.store.add_message('user', 'I prefer oolong tea')
        memory = self.store.save_memory({'text':'oolong tea','source':'message:'+message['id'],'provenance':'explicit'})
        task = self.store.create_task({'prompt':'remember oolong tea'})
        result = self.store.forget_memory(memory['id'], True)
        self.assertFalse(result['rawHistoryRetained'])
        self.assertEqual(self.store.list_memories(), [])
        self.assertEqual(self.store.get_task(task['id'])['prompt'], 'remember [forgotten]')
        self.assertEqual(self.store.list_messages(), [])

    def test_memory_patch_validation_and_nested_savepoint(self):
        memory = self.store.save_memory({'text':'likes tea','source':'chat','provenance':'inferred'})
        for patch in ({'text':' '}, {'kind':'unknown'}, {'confidence':2}, {'sourceIds':[]}):
            with self.subTest(patch=patch), self.assertRaises(ValueError):
                self.store.update_memory(memory['id'], patch)
        def outer():
            try:
                self.store._tx(lambda: (self.store.db.execute("INSERT INTO settings VALUES ('temporary','null')"), (_ for _ in ()).throw(ValueError('rollback inner'))))
            except ValueError:
                pass
            self.store.db.execute("INSERT INTO settings VALUES ('survives','true')")
        self.store._tx(outer)
        self.assertIsNone(self.store.get_setting('temporary'))
        self.assertTrue(self.store.get_setting('survives'))

    def test_js_canonical_json_numbers_and_idempotent_close(self):
        self.assertEqual(canonical_json({'a': 1.0, 'b': -0.0, 'c': 1e-6, 'd': 1e21}),
                         '{"a":1,"b":0,"c":0.000001,"d":1e+21}')
        self.store.close()
        self.store.close()

    def test_goal_step_validation_and_forget_redaction(self):
        with self.assertRaisesRegex(ValueError, 'Invalid task kind'):
            self.store.create_task({'prompt':'bad kind','kind':'other'})
        goal = self.store.create_goal({'title':'trip','steps':[{'id':'s1','title':'Visit Kyoto','status':'pending','result':'Visit Kyoto'}]})
        with self.assertRaisesRegex(ValueError, 'Invalid goal status'):
            self.store.update_goal(goal['id'], {'status':'unknown'})
        memory = self.store.save_memory({'text':'Kyoto','source':'note','provenance':'explicit'})
        self.store.forget_memory(memory['id'])
        step = self.store.list_goals()[0]['steps'][0]
        self.assertEqual(step['title'], 'Visit [forgotten]')
        self.assertEqual(step['result'], 'Visit [forgotten]')


if __name__ == '__main__':
    unittest.main()
