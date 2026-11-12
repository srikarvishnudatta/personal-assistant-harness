"""SQLite persistence compatible with the local TypeScript assistant store."""
import hashlib, json, os, sqlite3, time, uuid, re, sys
from decimal import Decimal
from pathlib import Path
from datetime import datetime, timezone
from harness.agents.workflows import validate_workflow, workflow_task_id
from harness.knowledge.index import initialize_knowledge, forget_knowledge, invalidate_knowledge

def _now(): return int(time.time()*1000)
def _id(): return str(uuid.uuid4())
def canonical_json(v):
    def check(x):
        if x is None or isinstance(x,(str,bool,int)): return
        if isinstance(x,float):
            if not __import__('math').isfinite(x): raise ValueError('Value must contain finite JSON data only')
            return
        if isinstance(x,list):
            for y in x: check(y)
            return
        if isinstance(x,dict):
            for k,y in x.items():
                if not isinstance(k,str): raise ValueError('Value must contain finite JSON data only')
                check(y)
            return
        raise ValueError('Value must contain finite JSON data only')
    def encode(x):
        if x is None: return 'null'
        if x is True: return 'true'
        if x is False: return 'false'
        if isinstance(x,str): return json.dumps(x,ensure_ascii=False,separators=(',',':'))
        if isinstance(x,int): return str(x)
        if isinstance(x,float):
            if x==0: return '0'
            raw=repr(x).lower()
            if 1e-6 <= abs(x) < 1e21:
                fixed=format(Decimal(raw),'f')
                return fixed.rstrip('0').rstrip('.') if '.' in fixed else fixed
            mantissa,_,exponent=raw.partition('e')
            if mantissa.endswith('.0'): mantissa=mantissa[:-2]
            exp=int(exponent)
            return f'{mantissa}e{"+" if exp>=0 else ""}{exp}'
        if isinstance(x,list): return '['+','.join(encode(y) for y in x)+']'
        if isinstance(x,dict): return '{'+','.join(encode(k)+':'+encode(x[k]) for k in sorted(x))+ '}'
        raise ValueError('Value must contain finite JSON data only')
    check(v); return encode(v)
def _time(v):
    if isinstance(v,(int,float)): return v
    return int(datetime.fromisoformat(v.replace('Z','+00:00')).timestamp()*1000)
def _req(v,field,maxlen=12000):
    if not isinstance(v,str) or not v.strip() or len(v)>maxlen: raise ValueError(f'{field} must have 1-{maxlen} characters')
    return v.strip()
def _pid_is_alive(pid):
    """Check process existence without ever terminating a process (including on Windows)."""
    if sys.platform == 'win32':
        import ctypes
        from ctypes import wintypes
        kernel32=ctypes.WinDLL('kernel32',use_last_error=True)
        kernel32.OpenProcess.argtypes=(wintypes.DWORD,wintypes.BOOL,wintypes.DWORD)
        kernel32.OpenProcess.restype=wintypes.HANDLE
        handle=kernel32.OpenProcess(0x1000,False,pid)  # PROCESS_QUERY_LIMITED_INFORMATION
        if not handle: return ctypes.get_last_error()==5  # inaccessible is conservatively treated as live
        try:
            code=wintypes.DWORD()
            if not kernel32.GetExitCodeProcess(handle,ctypes.byref(code)): return True
            return code.value==259  # STILL_ACTIVE
        finally: kernel32.CloseHandle(handle)
    try: os.kill(pid,0)
    except ProcessLookupError: return False
    except PermissionError: return True
    return True

class LocalStore:
    def __init__(self,path):
        if path != ':memory:': Path(path).parent.mkdir(parents=True,exist_ok=True)
        self.db=sqlite3.connect(path,isolation_level=None,timeout=5); self.db.row_factory=sqlite3.Row; self.runtime_lease=None; self._tx_depth=0; self._savepoint_id=0; self._closed=False
        self.db.executescript('''PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; PRAGMA secure_delete=ON;
        CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY,value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS runtime_owner(singleton INTEGER PRIMARY KEY CHECK(singleton=1),pid INTEGER NOT NULL,nonce TEXT NOT NULL);
        INSERT OR IGNORE INTO settings VALUES ('memory_revision','0');
        CREATE TABLE IF NOT EXISTS messages(id TEXT PRIMARY KEY,role TEXT NOT NULL,content TEXT NOT NULL,run_id TEXT,created_at INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS memories(id TEXT PRIMARY KEY,text TEXT NOT NULL,kind TEXT NOT NULL,source TEXT NOT NULL,source_ids TEXT NOT NULL,provenance TEXT NOT NULL,confidence REAL NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS memory_versions(id TEXT PRIMARY KEY,memory_id TEXT NOT NULL,revision INTEGER NOT NULL,snapshot TEXT NOT NULL,supersedes TEXT,created_at INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS goals(id TEXT PRIMARY KEY,title TEXT NOT NULL,description TEXT NOT NULL,status TEXT NOT NULL,steps TEXT NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS tasks(id TEXT PRIMARY KEY,prompt TEXT NOT NULL,kind TEXT NOT NULL,parent_id TEXT,goal_id TEXT,status TEXT NOT NULL,result TEXT,error TEXT,attempts INTEGER NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS workflows(id TEXT PRIMARY KEY,definition TEXT NOT NULL,created_at INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS schedules(id TEXT PRIMARY KEY,prompt TEXT NOT NULL,next_run_at INTEGER NOT NULL,interval_seconds INTEGER,cron TEXT,timezone TEXT NOT NULL,kind TEXT NOT NULL,status TEXT NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS approvals(id TEXT PRIMARY KEY,task_id TEXT,kind TEXT NOT NULL,payload TEXT NOT NULL,summary TEXT NOT NULL,digest TEXT NOT NULL,status TEXT NOT NULL,expires_at INTEGER NOT NULL,result TEXT,error TEXT,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS notifications(id TEXT PRIMARY KEY,title TEXT NOT NULL,body TEXT NOT NULL,task_id TEXT,dedupe_key TEXT UNIQUE,read_at INTEGER,created_at INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS events(id TEXT PRIMARY KEY,type TEXT NOT NULL,task_id TEXT,detail TEXT NOT NULL,created_at INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS usage(run_id TEXT PRIMARY KEY,day TEXT NOT NULL,reserved_tokens INTEGER NOT NULL,input_tokens INTEGER NOT NULL,output_tokens INTEGER NOT NULL,status TEXT NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL);
        CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status,created_at); CREATE INDEX IF NOT EXISTS idx_schedules_due ON schedules(status,next_run_at); CREATE INDEX IF NOT EXISTS idx_usage_day ON usage(day);''')
        initialize_knowledge(self.db)
    def close(self):
        if self._closed: return
        if self.runtime_lease: self.db.execute('DELETE FROM runtime_owner WHERE singleton=1 AND pid=? AND nonce=?',(os.getpid(),self.runtime_lease))
        self.db.close()
        self._closed=True
    def claim_runtime_ownership(self):
        def work():
            r=self.db.execute('SELECT pid,nonce FROM runtime_owner WHERE singleton=1').fetchone()
            if r and r['nonce']==self.runtime_lease: return
            if r:
                alive=True
                alive=_pid_is_alive(int(r['pid']))
                if alive: raise RuntimeError('Another local assistant owns this state directory. Stop that server before starting a second one.')
            self.runtime_lease=_id(); self.db.execute('INSERT INTO runtime_owner VALUES (1,?,?) ON CONFLICT(singleton) DO UPDATE SET pid=excluded.pid,nonce=excluded.nonce',(os.getpid(),self.runtime_lease))
        return self._tx(work)
    def _tx(self,fn):
        nested=self._tx_depth>0
        if nested:
            self._savepoint_id+=1; savepoint=f"sp_{self._savepoint_id}"; self.db.execute(f'SAVEPOINT {savepoint}')
        else:
            savepoint=None; self.db.execute('BEGIN IMMEDIATE')
        self._tx_depth+=1
        try:
            out=fn()
            if savepoint: self.db.execute(f'RELEASE SAVEPOINT {savepoint}')
            else: self.db.execute('COMMIT')
            return out
        except BaseException:
            if savepoint:
                self.db.execute(f'ROLLBACK TO SAVEPOINT {savepoint}'); self.db.execute(f'RELEASE SAVEPOINT {savepoint}')
            else: self.db.execute('ROLLBACK')
            raise
        finally: self._tx_depth-=1
    def _rows(self,q,*a): return self.db.execute(q,a).fetchall()
    def revision(self): return int(self.get_setting('memory_revision') or 0)
    def get_setting(self,key):
        r=self.db.execute('SELECT value FROM settings WHERE key=?',(key,)).fetchone(); return json.loads(r[0]) if r else None
    def set_setting(self,key,value):
        key=_req(key,'Setting key',200)
        if key=='memory_revision': raise ValueError('Memory revision is managed internally')
        if any(re.search(r'api.?key|password|secret|access.?token|refresh.?token',k,re.I) for k in [key,*_walk_keys(value)]): raise ValueError('Credentials must use the credential vault, not settings')
        self.db.execute('INSERT INTO settings VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',(key,canonical_json(value)))
    def _memory(self,r): return dict(id=r['id'],text=r['text'],kind=r['kind'],source=r['source'],sourceIds=json.loads(r['source_ids']),provenance=r['provenance'],confidence=r['confidence'],createdAt=r['created_at'],updatedAt=r['updated_at'])
    def _record_version(self,m):
        p=self.db.execute('SELECT id FROM memory_versions WHERE memory_id=? ORDER BY revision DESC LIMIT 1',(m['id'],)).fetchone()
        self.db.execute('INSERT INTO memory_versions VALUES (?,?,?,?,?,?)',(_id(),m['id'],self.revision(),canonical_json(m),p[0] if p else None,_now()))
    def memory_lineage(self,id): return [dict(id=r['id'],memoryId=r['memory_id'],revision=r['revision'],snapshot=json.loads(r['snapshot']),supersedes=r['supersedes'],createdAt=r['created_at']) for r in self._rows('SELECT * FROM memory_versions WHERE memory_id=? ORDER BY revision',id)]
    def list_memories(self,query=None):
        q=self._rows('SELECT * FROM memories WHERE instr(lower(text),lower(?))>0 ORDER BY updated_at DESC LIMIT 100',query.strip()) if query and query.strip() else self._rows('SELECT * FROM memories ORDER BY updated_at DESC,rowid DESC LIMIT 500')
        return [self._memory(r) for r in q]
    def delete_memory(self,id,expected_revision=None):
        def work():
            if expected_revision is not None and expected_revision!=self.revision(): raise ValueError('Memory revision conflict')
            self.db.execute('DELETE FROM memory_versions WHERE memory_id=?',(id,)); changed=self.db.execute('DELETE FROM memories WHERE id=?',(id,)).rowcount
            if changed: self.db.execute("UPDATE settings SET value=CAST(CAST(value AS INTEGER)+1 AS TEXT) WHERE key='memory_revision'")
            return self.revision()
        return self._tx(work)
    def add_message(self,role,content,run_id=None):
        if role not in ('user','assistant','system','tool'): raise ValueError('Invalid message role')
        m=dict(id=_id(),role=role,content=_req(content,'Message',200000),runId=run_id,createdAt=_now()); self.db.execute('INSERT INTO messages VALUES (?,?,?,?,?)',(m['id'],role,m['content'],run_id,m['createdAt'])); return m
    def list_messages(self,limit=100):
        return [dict(id=r['id'],role=r['role'],content=r['content'],runId=r['run_id'],createdAt=r['created_at']) for r in reversed(self._rows('SELECT * FROM messages ORDER BY created_at DESC,rowid DESC LIMIT ?',max(1,min(1000,limit))))]
    def save_memory(self,input):
        text=_req(input['text'],'Memory',4000); source=_req(input['source'],'Memory source',1000); prov=input['provenance']; kind=input.get('kind','fact'); conf=input.get('confidence',1 if prov=='explicit' else .7); ids=input.get('sourceIds',[source])
        if prov not in ('explicit','inferred') or kind not in ('preference','project','person','goal','commitment','fact') or not 0<=conf<=1 or not ids or any(not isinstance(x,str) or not x.strip() for x in ids): raise ValueError('Invalid memory')
        def work():
            if input.get('expectedRevision') is not None and input['expectedRevision']!=self.revision(): raise ValueError('Memory revision conflict')
            now=_now(); mid=_id(); self.db.execute('INSERT INTO memories VALUES (?,?,?,?,?,?,?,?,?)',(mid,text,kind,source,json.dumps(ids),prov,conf,now,now)); self.db.execute("UPDATE settings SET value=CAST(CAST(value AS INTEGER)+1 AS TEXT) WHERE key='memory_revision'"); m=self._memory(self.db.execute('SELECT * FROM memories WHERE id=?',(mid,)).fetchone()); self._record_version(m); return m
        return self._tx(work)
    def update_memory(self,id,patch):
        def work():
            if patch.get('expectedRevision') is not None and patch['expectedRevision']!=self.revision(): raise ValueError('Memory revision conflict')
            r=self.db.execute('SELECT * FROM memories WHERE id=?',(id,)).fetchone()
            if not r: raise ValueError('Memory not found')
            m=self._memory(r); n={**m,**patch}; n.pop('expectedRevision',None)
            n['text']=_req(n['text'],'Memory',4000); n['source']=_req(n['source'],'Memory source',1000)
            if n['provenance'] not in ('explicit','inferred'): raise ValueError('Invalid memory provenance')
            if n['kind'] not in ('preference','project','person','goal','commitment','fact'): raise ValueError('Invalid memory kind')
            if not isinstance(n['confidence'],(int,float)) or isinstance(n['confidence'],bool) or not __import__('math').isfinite(n['confidence']) or not 0<=n['confidence']<=1: raise ValueError('Invalid memory confidence')
            source_ids=patch.get('sourceIds',[patch['source']] if 'source' in patch else m['sourceIds'])
            if not isinstance(source_ids,list) or not source_ids or any(not isinstance(x,str) or not x.strip() for x in source_ids): raise ValueError('Invalid memory source IDs')
            if m['provenance']=='explicit' and n['provenance']=='inferred': raise ValueError('Inference cannot replace explicit memory')
            now=_now()
            invalidate_knowledge(self.db,id)
            self.db.execute('UPDATE memories SET text=?,kind=?,source=?,source_ids=?,provenance=?,confidence=?,updated_at=? WHERE id=?',(n['text'].strip(),n['kind'],n['source'],json.dumps(source_ids),n['provenance'],n['confidence'],now,id)); self.db.execute("UPDATE settings SET value=CAST(CAST(value AS INTEGER)+1 AS TEXT) WHERE key='memory_revision'"); m=self._memory(self.db.execute('SELECT * FROM memories WHERE id=?',(id,)).fetchone()); self._record_version(m); return m
        return self._tx(work)
    def forget_memory(self,id,include_source_messages=False):
        def work():
            r=self.db.execute('SELECT * FROM memories WHERE id=?',(id,)).fetchone()
            if not r: raise ValueError('Memory not found')
            m=self._memory(r); lineage=self.memory_lineage(id); phrases={m['text'],*(v['snapshot']['text'] for v in lineage)}
            forget_knowledge(self.db, m, phrases, m['sourceIds'] if include_source_messages else ())
            for p in phrases:
                if self._rows("SELECT id FROM approvals WHERE status='executing' AND (instr(payload,?)>0 OR instr(result,?)>0)",p,p): raise ValueError('Cannot forget a claim while a related action is executing; wait for the outcome')
            self.db.execute('DELETE FROM memories WHERE id=?',(id,)); self.db.execute('DELETE FROM memory_versions WHERE memory_id=?',(id,)); self.db.execute("DELETE FROM settings WHERE key IN ('conversationSummary','alignmentSynthesis') OR key LIKE 'dream:%'")
            for p in phrases:
                if not p: continue
                for table,cols in [('tasks',['prompt','result','error']),('notifications',['title','body']),('goals',['title','description'])]:
                    for c in cols: self.db.execute(f"UPDATE {table} SET {c}=replace({c},?,'[forgotten]') WHERE instr({c},?)>0",(p,p))
                for goal in self._rows('SELECT id,steps FROM goals'):
                    steps=json.loads(goal['steps'])
                    redacted=[]
                    for step in steps:
                        item={**step,'title':step['title'].replace(p,'[forgotten]')}
                        if step.get('result'): item['result']=step['result'].replace(p,'[forgotten]')
                        redacted.append(item)
                    self.db.execute('UPDATE goals SET steps=? WHERE id=?',(canonical_json(redacted),goal['id']))
                for w in self.list_workflows():
                    d={k:w[k] for k in ('prompt','output','nodes')}; d['prompt']=d['prompt'].replace(p,'[forgotten]'); d['nodes']=[{**n,'role':n['role'].replace(p,'[forgotten]'),'prompt':n['prompt'].replace(p,'[forgotten]')} for n in d['nodes']]; self.db.execute('UPDATE workflows SET definition=? WHERE id=?',(canonical_json(d),w['id']))
                self.db.execute('DELETE FROM events WHERE instr(detail,?)>0',(p,)); self.db.execute("UPDATE approvals SET status=CASE WHEN status IN ('pending','approved') THEN 'rejected' ELSE status END,payload='{}',result=NULL,summary='Memory-related action redacted',error='Referenced memory forgotten' WHERE instr(payload,?)>0 OR instr(result,?)>0",(p,p))
                for dup in self._rows('SELECT id FROM memories WHERE text=?',p): self.db.execute('DELETE FROM memory_versions WHERE memory_id=?',(dup[0],)); self.db.execute('DELETE FROM memories WHERE id=?',(dup[0],))
                if include_source_messages: self.db.execute("UPDATE messages SET content=replace(content,?,'[forgotten]') WHERE instr(content,?)>0",(p,p))
            removed=0
            if include_source_messages:
                for src in {*(m['sourceIds']),*(s for v in lineage for s in v['snapshot']['sourceIds'])}:
                    cur=self.db.execute('DELETE FROM messages WHERE id=?',(src.removeprefix('message:'),)); removed+=cur.rowcount
            self.db.execute("UPDATE settings SET value=CAST(CAST(value AS INTEGER)+1 AS TEXT) WHERE key='memory_revision'"); return dict(revision=self.revision(),forgottenMemoryId=id,removedSourceMessages=removed,rawHistoryRetained=not include_source_messages,managedCopiesRemoved=True,limitation='Exact recorded claim text and known source IDs only; unrelated paraphrases, backups and external copies are not guaranteed erased.')
        return self._tx(work)
    def create_task(self,input):
        id=input.get('id') or _id(); old=self.get_task(id)
        if input.get('kind') is not None and input['kind'] not in ('task','dream','goal'): raise ValueError('Invalid task kind')
        if old:
            if old['prompt']!=input['prompt'] or old['kind']!=input.get('kind','task'): raise ValueError('Task ID conflicts with another request')
            return old
        now=_now(); self.db.execute('INSERT INTO tasks VALUES (?,?,?,?,?,?,?,?,?,?,?)',(id,_req(input['prompt'],'Task prompt'),input.get('kind','task'),input.get('parentId'),input.get('goalId'),'queued',None,None,0,now,now)); return self.get_task(id)
    def _task(self,r): return dict(id=r['id'],prompt=r['prompt'],kind=r['kind'],parentId=r['parent_id'],goalId=r['goal_id'],status=r['status'],result=r['result'],error=r['error'],attempts=r['attempts'],createdAt=r['created_at'],updatedAt=r['updated_at'])
    def get_task(self,id):
        r=self.db.execute('SELECT * FROM tasks WHERE id=?',(id,)).fetchone(); return self._task(r) if r else None
    def list_tasks(self,limit=100): return [self._task(r) for r in self._rows('SELECT * FROM tasks ORDER BY created_at DESC,rowid DESC LIMIT ?',max(1,min(1000,limit)))]
    def update_task(self,id,patch):
        def work():
            t=self.get_task(id)
            if not t: raise ValueError('Task not found')
            allowed={'queued':['running','cancelled'],'running':['waiting_approval','completed','failed','cancelled'],'waiting_approval':['queued','cancelled'],'failed':['queued','cancelled'],'completed':[],'cancelled':[]}
            if patch.get('status') and patch['status']!=t['status'] and patch['status'] not in allowed[t['status']]: raise ValueError(f"Illegal task transition: {t['status']} -> {patch['status']}")
            if t['status'] in ('completed','cancelled') and any(k in patch for k in ('result','error')): raise ValueError('Terminal task cannot be rewritten')
            n={**t,**patch};
            if patch.get('status')=='running' and t['status']!='running' and 'attempts' not in patch: n['attempts']+=1
            if not isinstance(n['attempts'],int) or n['attempts']<0: raise ValueError('Invalid attempt count')
            self.db.execute('UPDATE tasks SET status=?,result=?,error=?,attempts=?,updated_at=? WHERE id=?',(n['status'],n['result'],n['error'],n['attempts'],_now(),id)); return self.get_task(id)
        return self._tx(work)
    def recover_interrupted(self,max_attempts=3):
        def work():
            requeued=failed=0
            for r in self._rows("SELECT * FROM tasks WHERE status='running' AND id NOT IN (SELECT id FROM workflows)"):
                exhausted=r['attempts']>=max_attempts; self.db.execute('UPDATE tasks SET status=?,error=?,updated_at=? WHERE id=?',('failed' if exhausted else 'queued','Restart recovery exhausted retry limit' if exhausted else 'Interrupted run requeued after restart',_now(),r['id'])); failed+=int(exhausted); requeued+=int(not exhausted)
            uncertain=self.db.execute("UPDATE approvals SET status='uncertain',error='Process stopped during action; reconcile before retry',updated_at=? WHERE status='executing'",(_now(),)).rowcount
            held=self.db.execute("UPDATE tasks SET status='waiting_approval',error='An action outcome is uncertain; reconcile manually',updated_at=? WHERE id IN (SELECT task_id FROM approvals WHERE status='uncertain') AND status='queued'",(_now(),)).rowcount
            return dict(requeued=max(0,requeued-held),failed=failed,uncertain=uncertain)
        return self._tx(work)
    def create_workflow(self,input):
        d=validate_workflow(input); id='workflow-'+_id(); now=_now()
        def work():
            self.create_task({'id':id,'prompt':d['prompt']})
            for n in d['nodes']: self.create_task({'id':workflow_task_id(id,n['id']),'prompt':n['prompt'],'parentId':id})
            self.db.execute('INSERT INTO workflows VALUES (?,?,?)',(id,canonical_json(d),now)); return {**d,'id':id,'createdAt':now}
        return self._tx(work)
    def get_workflow(self,id):
        r=self.db.execute('SELECT * FROM workflows WHERE id=?',(id,)).fetchone(); return {**json.loads(r['definition']),'id':id,'createdAt':r['created_at']} if r else None
    def list_workflows(self): return [self.get_workflow(r[0]) for r in self._rows('SELECT id FROM workflows ORDER BY created_at DESC')]
    def workflow_tasks(self,id): return [self._task(r) for r in self._rows('SELECT * FROM tasks WHERE parent_id=? ORDER BY created_at,rowid',id)]
    def save_schedule(self,input):
        id=input.get('id') or _id(); now=_now(); nxt=_time(input['runAt']); interval=input.get('intervalSeconds')
        if interval is not None and (not isinstance(interval,int) or interval<60): raise ValueError('Schedule interval must be at least 60 seconds')
        if input.get('cron') and interval is not None: raise ValueError('Choose cron or interval, not both')
        from zoneinfo import ZoneInfo
        ZoneInfo(input.get('timezone','UTC')); self.db.execute("INSERT INTO schedules VALUES (?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET prompt=excluded.prompt,next_run_at=excluded.next_run_at,interval_seconds=excluded.interval_seconds,cron=excluded.cron,timezone=excluded.timezone,kind=excluded.kind,status='active',updated_at=excluded.updated_at",(id,_req(input['prompt'],'Schedule prompt'),nxt,interval,input.get('cron'),input.get('timezone','UTC'),input.get('kind','task'),'active',now,now)); return self._schedule(self.db.execute('SELECT * FROM schedules WHERE id=?',(id,)).fetchone())
    def _schedule(self,r): return dict(id=r['id'],prompt=r['prompt'],nextRunAt=r['next_run_at'],intervalSeconds=r['interval_seconds'],cron=r['cron'],timezone=r['timezone'],kind=r['kind'],status=r['status'],createdAt=r['created_at'],updatedAt=r['updated_at'])
    def list_schedules(self): return [self._schedule(r) for r in self._rows('SELECT * FROM schedules ORDER BY next_run_at')]
    def update_schedule(self,id,patch):
        r=self.db.execute('SELECT * FROM schedules WHERE id=?',(id,)).fetchone()
        if not r: raise ValueError('Schedule not found')
        n={**self._schedule(r),**patch}; self.db.execute('UPDATE schedules SET next_run_at=?,status=?,updated_at=? WHERE id=?',(n['nextRunAt'],n['status'],_now(),id)); return self._schedule(self.db.execute('SELECT * FROM schedules WHERE id=?',(id,)).fetchone())
    def delete_schedule(self,id): self.db.execute('DELETE FROM schedules WHERE id=?',(id,))
    def dispatch_occurrence(self,schedule_id,now,next_run_at):
        def work():
            r=self.db.execute('SELECT * FROM schedules WHERE id=?',(schedule_id,)).fetchone()
            if not r: return None
            s=self._schedule(r)
            if s['status']!='active' or s['nextRunAt']>now: return None
            if next_run_at is not None and next_run_at<=s['nextRunAt']: raise ValueError('Next occurrence must advance the schedule')
            t=self.create_task({'id':f"schedule-{s['id']}-{s['nextRunAt']}",'prompt':s['prompt'],'kind':s['kind']}); self.db.execute('UPDATE schedules SET next_run_at=?,status=?,updated_at=? WHERE id=?',(next_run_at or s['nextRunAt'],'completed' if next_run_at is None else 'active',_now(),schedule_id)); return t
        return self._tx(work)
    def create_approval(self,input):
        id=_id(); now=_now(); expires=_time(input['expiresAt']) if input.get('expiresAt') is not None else now+3600000
        if expires<=now: raise ValueError('Approval expiry must be in the future')
        kind=_req(input['kind'],'Action kind',200); summary=_req(input['summary'],'Action summary',2000); payload=canonical_json(input['payload']); task=input.get('taskId')
        digest=hashlib.sha256(canonical_json(dict(kind=kind,payload=input['payload'],summary=summary,taskId=task,expiresAt=expires)).encode()).hexdigest()
        self.db.execute('INSERT INTO approvals VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',(id,task,kind,payload,summary,digest,'pending',expires,None,None,now,now)); return self.get_approval(id)
    def _approval(self,r): return dict(id=r['id'],taskId=r['task_id'],kind=r['kind'],payload=json.loads(r['payload']),summary=r['summary'],digest=r['digest'],status=r['status'],expiresAt=r['expires_at'],result=json.loads(r['result']) if r['result'] else None,error=r['error'],createdAt=r['created_at'],updatedAt=r['updated_at'])
    def get_approval(self,id):
        r=self.db.execute('SELECT * FROM approvals WHERE id=?',(id,)).fetchone(); return self._approval(r) if r else None
    def list_approvals(self,limit=100): return [self._approval(r) for r in self._rows('SELECT * FROM approvals ORDER BY created_at DESC,rowid DESC LIMIT ?',max(1,min(1000,limit)))]
    def decide_approval(self,id,decision,expected_digest):
        a=self.get_approval(id)
        if not a: raise ValueError('Approval not found')
        if decision not in ('approved','rejected'): raise ValueError('Invalid approval decision')
        if a['digest']!=expected_digest: raise ValueError('Approval digest mismatch')
        if a['status']!='pending': raise ValueError('Approval is no longer pending')
        if a['expiresAt']<=_now(): self.db.execute("UPDATE approvals SET status='expired',updated_at=? WHERE id=? AND status='pending'",(_now(),id)); raise ValueError('Approval expired')
        if not self.db.execute("UPDATE approvals SET status=?,updated_at=? WHERE id=? AND status='pending'",(decision,_now(),id)).rowcount: raise ValueError('Approval is no longer pending')
        return self.get_approval(id)
    def claim_execution(self,id):
        a=self.get_approval(id)
        if not a: raise ValueError('Approval not found')
        if a['status']!='approved': raise ValueError('Action is not approved or already claimed')
        if a['expiresAt']<=_now(): self.db.execute("UPDATE approvals SET status='expired',updated_at=? WHERE id=? AND status='approved'",(_now(),id)); raise ValueError('Approval expired')
        if not self.db.execute("UPDATE approvals SET status='executing',updated_at=? WHERE id=? AND status='approved'",(_now(),id)).rowcount: raise ValueError('Action already claimed')
        return self.get_approval(id)
    def complete_action(self,id,outcome):
        if not (a:=self.get_approval(id)) or a['status']!='executing': raise ValueError('Action is not executing')
        self.db.execute('UPDATE approvals SET status=?,result=?,error=?,updated_at=? WHERE id=?',('failed' if outcome.get('error') else 'completed',canonical_json(outcome['result']) if 'result' in outcome else None,outcome.get('error'),_now(),id)); return self.get_approval(id)
    def mark_action_uncertain(self,id,error):
        a=self.get_approval(id)
        if not a: raise ValueError('Approval not found')
        if a['status']=='uncertain': return a
        if a['status']!='executing': raise ValueError('Only an executing action can become uncertain')
        self.db.execute("UPDATE approvals SET status='uncertain',error=?,updated_at=? WHERE id=?",(_req(error,'Action error',4000),_now(),id)); return self.get_approval(id)
    def reconcile_action(self,id,outcome,result):
        a=self.get_approval(id)
        if not a or a['status']!='uncertain': raise ValueError('Only an uncertain action can be reconciled')
        if outcome not in ('completed','failed'): raise ValueError('Invalid reconciliation outcome')
        self.db.execute('UPDATE approvals SET status=?,result=?,error=?,updated_at=? WHERE id=?',(outcome,canonical_json({'verifiedBy':'user','note':_req(result,'Reconciliation evidence',4000)}),'User confirmed action did not complete' if outcome=='failed' else None,_now(),id)); return self.get_approval(id)
    def add_notification(self,input):
        key=input.get('dedupeKey')
        if key:
            r=self.db.execute('SELECT * FROM notifications WHERE dedupe_key=?',(key,)).fetchone()
            if r: return self._notification(r)
        id=_id(); self.db.execute('INSERT INTO notifications VALUES (?,?,?,?,?,?,?)',(id,_req(input['title'],'Notification title',300),_req(input['body'],'Notification body'),input.get('taskId'),key,None,_now())); return self._notification(self.db.execute('SELECT * FROM notifications WHERE id=?',(id,)).fetchone())
    def _notification(self,r): return dict(id=r['id'],title=r['title'],body=r['body'],taskId=r['task_id'],dedupeKey=r['dedupe_key'],readAt=r['read_at'],createdAt=r['created_at'])
    def list_notifications(self,limit=100): return [self._notification(r) for r in self._rows('SELECT * FROM notifications ORDER BY created_at DESC,rowid DESC LIMIT ?',max(1,min(1000,limit)))]
    def mark_read(self,id): self.db.execute('UPDATE notifications SET read_at=COALESCE(read_at,?) WHERE id=?',(_now(),id))
    def append_event(self,type,detail=None,task_id=None):
        e=dict(id=_id(),type=_req(type,'Event type',200),taskId=task_id,detail={} if detail is None else detail,createdAt=_now()); self.db.execute('INSERT INTO events VALUES (?,?,?,?,?)',(e['id'],e['type'],task_id,canonical_json(e['detail']),e['createdAt'])); return e
    def list_events(self,limit=100): return [dict(id=r['id'],type=r['type'],taskId=r['task_id'],detail=json.loads(r['detail']),createdAt=r['created_at']) for r in self._rows('SELECT * FROM events ORDER BY created_at DESC,rowid DESC LIMIT ?',max(1,min(1000,limit)))]
    def create_goal(self,input):
        title=_req(input['title'],'Goal title',200); steps=input.get('steps',[]); self._validate_steps(steps)
        now=_now(); id=_id(); self.db.execute('INSERT INTO goals VALUES (?,?,?,?,?,?,?)',(id,title,input.get('description',''),'active',canonical_json(steps),now,now)); return self._goal(self.db.execute('SELECT * FROM goals WHERE id=?',(id,)).fetchone())
    def _goal(self,r): return dict(id=r['id'],title=r['title'],description=r['description'],status=r['status'],steps=json.loads(r['steps']),createdAt=r['created_at'],updatedAt=r['updated_at'])
    def list_goals(self): return [self._goal(r) for r in self._rows('SELECT * FROM goals ORDER BY updated_at DESC')]
    def update_goal(self,id,patch):
        r=self.db.execute('SELECT * FROM goals WHERE id=?',(id,)).fetchone()
        if not r: raise ValueError('Goal not found')
        n={**self._goal(r),**patch}; _req(n['title'],'Goal title',200); self._validate_steps(n['steps'])
        if n['status'] not in ('active','paused','completed','cancelled'): raise ValueError('Invalid goal status')
        self.db.execute('UPDATE goals SET title=?,description=?,status=?,steps=?,updated_at=? WHERE id=?',(n['title'],n['description'],n['status'],canonical_json(n['steps']),_now(),id)); return self._goal(self.db.execute('SELECT * FROM goals WHERE id=?',(id,)).fetchone())
    def _validate_steps(self,steps):
        if not isinstance(steps,list) or len(steps)>100: raise ValueError('Invalid goal steps')
        ids=set()
        for step in steps:
            if not isinstance(step,dict): raise ValueError('Invalid goal step')
            sid=_req(step.get('id'),'Step ID',200); _req(step.get('title'),'Step title',1000)
            if sid in ids or step.get('status') not in ('pending','running','completed','blocked'): raise ValueError('Invalid goal step')
            ids.add(sid)
    def reserve_usage(self,run_id,limit,reserve_tokens):
        if not isinstance(limit,int) or limit<1 or not isinstance(reserve_tokens,int) or reserve_tokens<1: raise ValueError('Invalid token budget')
        def work():
            if self._rows('SELECT run_id FROM usage WHERE run_id=?',run_id): raise ValueError('Run usage already exists; use a distinct attempt ID')
            now=_now(); day=datetime.fromtimestamp(now/1000,timezone.utc).strftime('%Y-%m-%d')
            used=self.db.execute("SELECT COALESCE(SUM(CASE WHEN status='reserved' THEN reserved_tokens ELSE input_tokens+output_tokens END),0) FROM usage WHERE day=?",(day,)).fetchone()[0]
            if used+reserve_tokens>limit: raise ValueError('Daily token budget exceeded')
            self.db.execute('INSERT INTO usage VALUES (?,?,?,?,?,?,?,?)',(_req(run_id,'Run ID',200),day,reserve_tokens,0,0,'reserved',now,now)); return self._usage(self.db.execute('SELECT * FROM usage WHERE run_id=?',(run_id,)).fetchone())
        return self._tx(work)
    def _usage(self,r): return dict(runId=r['run_id'],day=r['day'],reservedTokens=r['reserved_tokens'],inputTokens=r['input_tokens'],outputTokens=r['output_tokens'],status=r['status'],createdAt=r['created_at'],updatedAt=r['updated_at'])
    def has_usage_capacity(self,limit,reserve_tokens):
        day=datetime.now(timezone.utc).strftime('%Y-%m-%d'); used=self.db.execute("SELECT COALESCE(SUM(CASE WHEN status='reserved' THEN reserved_tokens ELSE input_tokens+output_tokens END),0) FROM usage WHERE day=?",(day,)).fetchone()[0]; return used+reserve_tokens<=limit
    def finish_usage(self,run_id,input_tokens,output_tokens):
        if any(not isinstance(x,int) or x<0 for x in (input_tokens,output_tokens)): raise ValueError('Invalid usage counts')
        r=self.db.execute('SELECT * FROM usage WHERE run_id=?',(run_id,)).fetchone()
        if not r: raise ValueError('Usage reservation missing')
        if r['status']!='reserved': raise ValueError('Usage reservation already settled')
        self.db.execute("UPDATE usage SET input_tokens=?,output_tokens=?,status='completed',updated_at=? WHERE run_id=? AND status='reserved'",(input_tokens,output_tokens,_now(),run_id)); return self._usage(self.db.execute('SELECT * FROM usage WHERE run_id=?',(run_id,)).fetchone())
    def fail_usage(self,run_id): self.db.execute("UPDATE usage SET input_tokens=reserved_tokens,output_tokens=0,status='failed',updated_at=? WHERE run_id=? AND status='reserved'",(_now(),run_id))
    def list_usage(self,limit=100): return [self._usage(r) for r in self._rows('SELECT * FROM usage ORDER BY created_at DESC,rowid DESC LIMIT ?',max(1,min(1000,limit)))]

def _walk_keys(v):
    if isinstance(v,dict):
        for k,x in v.items(): yield k; yield from _walk_keys(x)
    elif isinstance(v,list):
        for x in v: yield from _walk_keys(x)
