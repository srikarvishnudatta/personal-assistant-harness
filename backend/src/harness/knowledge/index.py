"""Full retained-history retrieval, sourced people graph and durable repairs."""
import json
import re
import time
import uuid
import hashlib


def now(): return int(time.time() * 1000)
def uid(): return str(uuid.uuid4())
def required(value, field, limit):
    if not isinstance(value, str) or not value.strip() or len(value) > limit:
        raise ValueError(f'{field} must have 1-{limit} characters')
    return value.strip()


def initialize_knowledge(db):
    db.executescript('''
    CREATE VIRTUAL TABLE IF NOT EXISTS history_index USING fts5(message_id UNINDEXED,role UNINDEXED,content,created_at UNINDEXED,tokenize='unicode61');
    CREATE TRIGGER IF NOT EXISTS history_added AFTER INSERT ON messages BEGIN
      INSERT INTO history_index(rowid,message_id,role,content,created_at) VALUES(new.rowid,new.id,new.role,new.content,new.created_at); END;
    CREATE TRIGGER IF NOT EXISTS history_removed AFTER DELETE ON messages BEGIN
      DELETE FROM history_index WHERE rowid=old.rowid; END;
    CREATE TRIGGER IF NOT EXISTS history_changed AFTER UPDATE ON messages BEGIN
      DELETE FROM history_index WHERE rowid=old.rowid;
      INSERT INTO history_index(rowid,message_id,role,content,created_at) VALUES(new.rowid,new.id,new.role,new.content,new.created_at); END;
    INSERT INTO history_index(rowid,message_id,role,content,created_at)
      SELECT m.rowid,m.id,m.role,m.content,m.created_at FROM messages m
      WHERE NOT EXISTS(SELECT 1 FROM history_index i WHERE i.rowid=m.rowid);
    CREATE TABLE IF NOT EXISTS people_nodes(id TEXT PRIMARY KEY,name TEXT NOT NULL,kind TEXT NOT NULL,aliases TEXT NOT NULL,context TEXT NOT NULL,source_ids TEXT NOT NULL,revision INTEGER NOT NULL,updated_at INTEGER NOT NULL,needs_review INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS people_edges(id TEXT PRIMARY KEY,source TEXT NOT NULL,target TEXT NOT NULL,label TEXT NOT NULL,source_ids TEXT NOT NULL,created_at INTEGER NOT NULL,needs_review INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS people_versions(id TEXT PRIMARY KEY,node_id TEXT NOT NULL,snapshot TEXT NOT NULL,created_at INTEGER NOT NULL);
    CREATE TRIGGER IF NOT EXISTS people_removed AFTER DELETE ON people_nodes BEGIN
      DELETE FROM people_edges WHERE source=old.id OR target=old.id;
      DELETE FROM people_versions WHERE node_id=old.id; END;
    CREATE TABLE IF NOT EXISTS repairs(id TEXT PRIMARY KEY,kind TEXT NOT NULL,subject TEXT NOT NULL,description TEXT NOT NULL,status TEXT NOT NULL,resolution TEXT,evidence TEXT NOT NULL,revision INTEGER NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS freshness_reports(id TEXT PRIMARY KEY,task_id TEXT,report TEXT NOT NULL,created_at INTEGER NOT NULL);
    ''')
    if 'needs_review' not in {r[1] for r in db.execute('PRAGMA table_info(people_nodes)')}:
        db.execute('ALTER TABLE people_nodes ADD COLUMN needs_review INTEGER NOT NULL DEFAULT 0')
    if 'needs_review' not in {r[1] for r in db.execute('PRAGMA table_info(people_edges)')}:
        db.execute('ALTER TABLE people_edges ADD COLUMN needs_review INTEGER NOT NULL DEFAULT 0')


def invalidate_knowledge(db, memory_id):
    """A corrected source cannot silently keep feeding old graph context."""
    db.execute("DELETE FROM settings WHERE key IN ('conversationSummary','alignmentSynthesis')")
    for row in db.execute('SELECT * FROM people_nodes').fetchall():
        if {memory_id,'memory:'+memory_id}.intersection(json.loads(row['source_ids'])):
            db.execute('UPDATE people_nodes SET needs_review=1,revision=revision+1,updated_at=? WHERE id=?',(now(),row['id']))
            updated=db.execute('SELECT * FROM people_nodes WHERE id=?',(row['id'],)).fetchone()
            db.execute('INSERT INTO people_versions VALUES(?,?,?,?)',(uid(),row['id'],json.dumps(PeopleGraph.node(updated)),now()))
    for edge in db.execute('SELECT id,source_ids FROM people_edges').fetchall():
        if {memory_id,'memory:'+memory_id}.intersection(json.loads(edge['source_ids'])):
            db.execute('UPDATE people_edges SET needs_review=1 WHERE id=?',(edge['id'],))


class HistoryIndex:
    def __init__(self, store): self.store = store

    def status(self):
        return {'indexedMessages': self.store.db.execute('SELECT count(*) FROM history_index').fetchone()[0],
                'scope': 'all retained local messages', 'engine': 'SQLite FTS5 + optional GPT-6 Luna expansion/ranking',
                'vectorEmbeddings': False}

    def search(self, query, expansions=(), limit=20):
        required(query, 'Query', 1000)
        terms = re.findall(r'\w+', query, re.UNICODE)[:30]
        for phrase in list(expansions)[:12]:
            if isinstance(phrase, str): terms.extend(re.findall(r'\w+', phrase, re.UNICODE)[:5])
        terms = list(dict.fromkeys(t.lower() for t in terms if len(t) > 1))[:60]
        if not terms: return []
        expression = ' OR '.join('"' + t.replace('"', '""') + '"' for t in terms)
        rows = self.store.db.execute('''SELECT message_id,role,created_at,content,
            snippet(history_index,2,'[',']',' … ',56) AS excerpt,bm25(history_index) AS score
            FROM history_index WHERE history_index MATCH ? ORDER BY score LIMIT ?''',
            (expression, max(1, min(40, int(limit))))).fetchall()
        return [dict(id=r['message_id'], role=r['role'], createdAt=int(r['created_at']), excerpt=r['excerpt'], score=r['score'],
            _digest=hashlib.sha256(r['content'].encode()).hexdigest()) for r in rows]

    def validate_results(self, results):
        # Re-read current text after a model await: a concurrent forget must win.
        answer = []
        for result in results:
            row = self.store.db.execute('SELECT content FROM messages WHERE id=?', (result['id'],)).fetchone()
            if row and hashlib.sha256(row['content'].encode()).hexdigest()==result['_digest']:
                answer.append({k:v for k,v in result.items() if k!='_digest'})
        return answer


class PeopleGraph:
    def __init__(self, store): self.store = store

    def _sources(self, sources):
        if not isinstance(sources, list) or not 1 <= len(sources) <= 30 or any(not isinstance(s, str) for s in sources):
            raise ValueError('Supply 1-30 source IDs')
        for source in sources:
            if source == 'user': continue
            key = source.removeprefix('message:').removeprefix('memory:')
            if not any(self.store.db.execute(f'SELECT 1 FROM {table} WHERE id=?', (key,)).fetchone() for table in ('messages', 'memories')):
                raise ValueError('Unknown source ID; use an existing message/memory ID or user for a direct entry')
        return list(dict.fromkeys(sources))

    @staticmethod
    def node(row):
        return dict(id=row['id'], name=row['name'], kind=row['kind'], aliases=json.loads(row['aliases']),
            context=row['context'], sourceIds=json.loads(row['source_ids']), provenance='user-reviewed',
            revision=row['revision'], updatedAt=row['updated_at'], needsReview=bool(row['needs_review']))

    def get(self, id_):
        row = self.store.db.execute('SELECT * FROM people_nodes WHERE id=?', (id_,)).fetchone()
        if not row: raise ValueError('Person/group not found')
        return self.node(row)

    def list(self, query=''):
        query = str(query)[:1000].lower()
        rows = self.store.db.execute('SELECT * FROM people_nodes WHERE instr(lower(name||aliases||context),?)>0 ORDER BY updated_at DESC LIMIT 200', (query,)).fetchall()
        nodes = [self.node(r) for r in rows]; ids = {n['id'] for n in nodes}
        edges = [dict(id=r['id'], source=r['source'], target=r['target'], label=r['label'], sourceIds=json.loads(r['source_ids']), needsReview=bool(r['needs_review']))
                 for r in self.store.db.execute('SELECT * FROM people_edges ORDER BY created_at DESC LIMIT 1000')
                 if r['source'] in ids and r['target'] in ids]
        return {'people': nodes, 'relationships': edges, 'limit': 200}

    def save(self, body, id_=None):
        name = required(body.get('name'), 'Name', 160); kind = body.get('kind', 'person')
        context = body.get('context', ''); aliases = body.get('aliases', [])
        if kind not in ('person', 'group') or not isinstance(context, str) or len(context) > 6000:
            raise ValueError('Invalid person/group context')
        if not isinstance(aliases, list) or len(aliases) > 20 or any(not isinstance(a, str) or not a.strip() or len(a) > 160 for a in aliases):
            raise ValueError('Invalid aliases')
        sources = self._sources(body.get('sourceIds', ['user']))
        def save():
            previous = self.get(id_) if id_ else None
            if previous and body.get('expectedRevision') != previous['revision']: raise ValueError('People revision conflict')
            key = id_ or uid(); revision = previous['revision'] + 1 if previous else 1
            self.store.db.execute('''INSERT INTO people_nodes(id,name,kind,aliases,context,source_ids,revision,updated_at) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET
                name=excluded.name,kind=excluded.kind,aliases=excluded.aliases,context=excluded.context,
                source_ids=excluded.source_ids,revision=excluded.revision,updated_at=excluded.updated_at,needs_review=0''',
                (key, name, kind, json.dumps(aliases), context, json.dumps(sources), revision, now()))
            node = self.get(key)
            self.store.db.execute('INSERT INTO people_versions VALUES(?,?,?,?)', (uid(), key, json.dumps(node), now()))
            return node
        return self.store._tx(save)

    def relate(self, body):
        source, target = body.get('source'), body.get('target')
        if source == target: raise ValueError('A relationship needs two distinct nodes')
        self.get(source); self.get(target)
        label = required(body.get('label'), 'Relationship', 120)
        sources = self._sources(body.get('sourceIds', ['user']))
        key = uid()
        self.store.db.execute('INSERT INTO people_edges(id,source,target,label,source_ids,created_at) VALUES(?,?,?,?,?,?)', (key, source, target, label, json.dumps(sources), now()))
        return {'id': key, 'source': source, 'target': target, 'label': label, 'sourceIds': sources}

    def remove(self, id_):
        self.get(id_); self.store.db.execute('DELETE FROM people_nodes WHERE id=?', (id_,))

    def lineage(self, id_):
        self.get(id_)
        return [json.loads(r[0]) for r in self.store.db.execute('SELECT snapshot FROM people_versions WHERE node_id=? ORDER BY created_at,rowid', (id_,))]

    def context(self, query):
        terms = {w.casefold() for w in re.findall(r'\w+', query) if len(w) > 2}
        graph = self.list(); graph['people']=[n for n in graph['people'] if not n['needsReview']]
        eligible={n['id'] for n in graph['people']}
        graph['relationships']=[e for e in graph['relationships'] if not e['needsReview'] and e['source'] in eligible and e['target'] in eligible]
        nodes = []
        for node in graph['people']:
            names = [node['name'], *node['aliases']]
            if any(terms & {w.casefold() for w in re.findall(r'\w+', name)} for name in names): nodes.append(node)
        ids = {n['id'] for n in nodes}
        edges = [e for e in graph['relationships'] if e['source'] in ids or e['target'] in ids][:20]
        related = {e[k] for e in edges for k in ('source', 'target')}
        return {'people': [n for n in graph['people'] if n['id'] in ids | related][:12], 'relationships': edges}


class RepairQueue:
    def __init__(self, store): self.store = store
    @staticmethod
    def record(r):
        return dict(id=r['id'], kind=r['kind'], subject=r['subject'], description=r['description'], status=r['status'],
            resolution=r['resolution'], evidence=json.loads(r['evidence']), revision=r['revision'], createdAt=r['created_at'], updatedAt=r['updated_at'])
    def list(self): return [self.record(r) for r in self.store.db.execute('SELECT * FROM repairs ORDER BY updated_at DESC LIMIT 200')]
    def create(self, kind, subject, description):
        if kind not in ('correction', 'freshness', 'task', 'relationship', 'other'): raise ValueError('Invalid repair kind')
        subject = required(subject, 'Subject', 300); description = required(description, 'Description', 6000)
        old = self.store.db.execute("SELECT * FROM repairs WHERE kind=? AND subject=? AND status IN ('open','reviewing')", (kind, subject)).fetchone()
        if old: return self.record(old)
        key, stamp = uid(), now()
        self.store.db.execute('INSERT INTO repairs VALUES(?,?,?,?,?,?,?,?,?,?)', (key, kind, subject, description, 'open', None, '[]', 1, stamp, stamp))
        return self.record(self.store.db.execute('SELECT * FROM repairs WHERE id=?',(key,)).fetchone())
    def transition(self, id_, body):
        def work():
            row = self.store.db.execute('SELECT * FROM repairs WHERE id=?', (id_,)).fetchone()
            if not row: raise ValueError('Repair not found')
            old = self.record(row); status = body.get('status')
            if body.get('expectedRevision') != old['revision']: raise ValueError('Repair revision conflict')
            allowed = {'open': {'reviewing', 'dismissed'}, 'reviewing': {'resolved', 'dismissed', 'open'}, 'resolved': {'open'}, 'dismissed': {'open'}}
            if status not in allowed[old['status']]: raise ValueError('Invalid repair transition')
            resolution = required(body.get('resolution'), 'Resolution or review note', 4000)
            evidence = body.get('evidence', [])
            if not isinstance(evidence, list) or len(evidence) > 20 or any(not isinstance(e, str) or not e.strip() or len(e) > 1000 for e in evidence): raise ValueError('Invalid repair evidence')
            if status == 'resolved' and not evidence: raise ValueError('Resolution requires evidence references')
            for reference in evidence:
                if reference.startswith(('https://','http://')):
                    from harness.integrations.browser import validate_browser_url
                    validate_browser_url(reference)
                    continue  # Owner-attested URL, not automatically fetched or fact-verified.
                prefix, _, key = reference.partition(':')
                table = {'message':'messages','memory':'memories','task':'tasks','report':'freshness_reports'}.get(prefix)
                if not table or not self.store.db.execute(f'SELECT 1 FROM {table} WHERE id=?',(key,)).fetchone():
                    raise ValueError('Repair evidence must reference an existing message, memory, task, report, or a public HTTP URL')
            self.store.db.execute('UPDATE repairs SET status=?,resolution=?,evidence=?,revision=revision+1,updated_at=? WHERE id=?',
                (status, resolution, json.dumps(evidence), now(), id_))
            return self.record(self.store.db.execute('SELECT * FROM repairs WHERE id=?', (id_,)).fetchone())
        return self.store._tx(work)


def forget_knowledge(db, memory, phrases, source_ids=()):
    """Remove graph copies by provenance and exact text; FTS follows message triggers."""
    sources = {memory['id'], 'memory:' + memory['id'], *source_ids}
    for row in db.execute('SELECT * FROM people_nodes').fetchall():
        versions = [r[0] for r in db.execute('SELECT snapshot FROM people_versions WHERE node_id=?', (row['id'],))]
        version_sources = {s for version in versions for s in json.loads(version).get('sourceIds',[])}
        if sources.intersection(set(json.loads(row['source_ids'])) | version_sources) or any(p and p in row['name'] + row['context'] + row['aliases'] + ''.join(versions) for p in phrases):
            db.execute('DELETE FROM people_nodes WHERE id=?', (row['id'],))
    for row in db.execute('SELECT id,source_ids,label FROM people_edges').fetchall():
        if sources.intersection(json.loads(row['source_ids'])) or any(p and p in row['label'] for p in phrases): db.execute('DELETE FROM people_edges WHERE id=?', (row['id'],))
    for source in sources:
        db.execute('DELETE FROM repairs WHERE instr(subject||evidence,?)>0',(source,))
    for phrase in phrases:
        db.execute('DELETE FROM repairs WHERE instr(subject||description||coalesce(resolution,\'\')||evidence,?)>0', (phrase,))
        db.execute('DELETE FROM freshness_reports WHERE instr(report,?)>0', (phrase,))
