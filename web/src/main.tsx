import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { Theme } from '@astryxdesign/core/theme';
import { Button } from '@astryxdesign/core/Button';
import { TextInput } from '@astryxdesign/core/TextInput';
import { neutralTheme } from '@astryxdesign/theme-neutral/built';
import './style.css';

type View = 'Chat' | 'Memory' | 'Schedules' | 'Tasks';
type Item = Record<string, unknown>;
type Message = { role: string; content: string; id?: string };
const views: View[] = ['Chat', 'Memory', 'Schedules', 'Tasks'];
const icons = ['✳', '◈', '◷', '☷'];
const descriptions: Record<View, string> = {
  Chat: 'A little context. A clear next step.',
  Memory: 'What your assistant knows, and why it knows it.',
  Schedules: 'Set something in motion. Come back when it matters.',
  Tasks: 'Follow the work happening in the background.',
};

function collection(value: unknown, key: string): Item[] {
  if (Array.isArray(value)) return value as Item[];
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const list = record[key] ?? record.items;
    if (Array.isArray(list)) return list as Item[];
  }
  return [];
}
function text(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value == null) return '';
  return JSON.stringify(value);
}
function timestamp(value: unknown): string {
  if (!value) return 'Not recorded';
  const date = new Date(typeof value === 'number' ? value : String(value));
  return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString();
}
function repeatLabel(item: Item): string {
  const seconds = item.intervalSeconds ?? item.interval_seconds;
  return seconds ? `Every ${Number(seconds) / 60} min` : 'One time';
}
function Empty({ title, children }: { title: string; children: ReactNode }) {
  return <div className="empty"><span className="empty-symbol" aria-hidden="true">✳</span><h2>{title}</h2><p>{children}</p></div>;
}

function App() {
  const [view, setView] = useState<View>('Chat');
  const [token, setToken] = useState(() => sessionStorage.getItem('harness-token') ?? '');
  const [tokenDraft, setTokenDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [messages, setMessages] = useState<Message[]>([]);
  const [items, setItems] = useState<Item[]>([]);
  const [input, setInput] = useState('');
  const [schedulePrompt, setSchedulePrompt] = useState('');
  const [runAt, setRunAt] = useState('');
  const [interval, setInterval] = useState('');
  const [memoryText, setMemoryText] = useState('');
  const [taskPrompt, setTaskPrompt] = useState('');
  const [reviewingTask, setReviewingTask] = useState('');
  const [reviewText, setReviewText] = useState('');
  const endRef = useRef<HTMLDivElement>(null);
  const generation = useRef(0);

  async function api(path: string, body?: unknown, method = body === undefined ? 'GET' : 'POST') {
    const response = await fetch(`/api${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const raw = await response.text();
    let data: unknown;
    try { data = raw ? JSON.parse(raw) : {}; } catch { throw new Error('The server returned an unreadable response.'); }
    if (!response.ok) {
      const detail = data && typeof data === 'object' ? (data as Item).error : null;
      throw new Error(text(detail) || `Request failed (${response.status}).`);
    }
    return data;
  }

  async function refresh() {
    const current = ++generation.current;
    setLoading(true);
    setError('');
    try {
      const key = ({ Chat: 'history', Memory: 'memories', Schedules: 'schedules', Tasks: 'tasks' } as const)[view];
      const data = await api(`/${key}`);
      if (current !== generation.current) return;
      if (view === 'Chat') {
        setMessages(collection(data, 'messages').map(item => ({
          id: text(item.id), role: text(item.role), content: text(item.content ?? item.text),
        })));
      } else setItems(collection(data, key));
    } catch (cause) {
      if (current === generation.current) setError(cause instanceof Error ? cause.message : 'Could not load your assistant.');
    } finally { if (current === generation.current) setLoading(false); }
  }

  useEffect(() => {
    setItems([]);
    if (token) void refresh();
    return () => { generation.current++; };
  }, [view, token]);
  useEffect(() => { endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' }); }, [messages.length, busy]);

  async function action(operation: () => Promise<void>) {
    if (busy) return;
    setBusy(true); setError('');
    try { await operation(); } catch (cause) { setError(cause instanceof Error ? cause.message : 'Something went wrong. Try again.'); }
    finally { setBusy(false); }
  }
  function connect(event: FormEvent) {
    event.preventDefault();
    const value = tokenDraft.trim();
    if (!value) return;
    sessionStorage.setItem('harness-token', value); setToken(value); setTokenDraft('');
  }
  function disconnect() {
    generation.current++; sessionStorage.removeItem('harness-token'); setToken(''); setMessages([]); setItems([]); setError('');
  }
  async function send(event: FormEvent) {
    event.preventDefault();
    const message = input.trim();
    if (!message || busy) return;
    await action(async () => {
      await api('/chat', { message });
      setInput('');
      await refresh();
    });
  }
  async function createSchedule(event: FormEvent) {
    event.preventDefault();
    await action(async () => {
      if (!schedulePrompt.trim() || !runAt) throw new Error('Add a task and its first run time.');
      const intervalSeconds = interval ? Number(interval) * 60 : undefined;
      if (intervalSeconds !== undefined && (!Number.isFinite(intervalSeconds) || intervalSeconds < 60)) throw new Error('The repeat interval must be at least one minute.');
      await api('/schedules', { prompt: schedulePrompt.trim(), runAt: new Date(runAt).toISOString(), intervalSeconds });
      setSchedulePrompt(''); setRunAt(''); setInterval(''); await refresh();
    });
  }

  return <Theme theme={neutralTheme}><div className="app-shell">
    <aside className="sidebar">
      <a className="brand" href="#" onClick={event => { event.preventDefault(); setView('Chat'); }}><span className="brand-symbol">✳</span><span>Personal<span className="brand-sub">HARNESS</span></span></a>
      <div className="workspace-label">YOUR WORKSPACE</div>
      <nav aria-label="Main navigation">{views.map((name, index) => <button key={name} className={`nav-item ${view === name ? 'active' : ''}`} onClick={() => setView(name)} aria-current={view === name ? 'page' : undefined}><span aria-hidden="true">{icons[index]}</span>{name}{name === 'Chat' && <span className="nav-shortcut">01</span>}</button>)}</nav>
      <div className="sidebar-note"><span className="small-orbit" aria-hidden="true">◌</span><strong>Room to think.</strong><p>Context that carries forward.<br />Work that keeps moving.</p></div>
      <div className="account"><span className={`connection-dot ${token ? 'connected' : ''}`} /><div><strong>Personal workspace</strong><small>{token ? 'Connected this session' : 'Not connected'}</small></div>{token && <button onClick={disconnect} className="disconnect" aria-label="Disconnect workspace">↗</button>}</div>
    </aside>
    <main className="main">
      <header className="topbar"><span>Workspace <span className="slash">/</span> <strong>{view}</strong></span><span className="top-status"><span className="connection-dot" />PRIVATE PREVIEW</span></header>
      <div className="content">
        <div className="page-heading"><div><div className="eyebrow">YOUR PERSONAL ASSISTANT</div><h1>{view === 'Chat' ? 'What’s on your mind?' : view}</h1><p>{descriptions[view]}</p></div>{token && <Button label="Refresh" variant="secondary" isDisabled={loading || busy} onClick={() => void refresh()} />}</div>
        {!token ? <section className="connect-panel"><div className="connect-art" aria-hidden="true"><div className="orbit orbit-one" /><div className="orbit orbit-two" /><span>✳</span></div><div><div className="eyebrow">MAKE YOURSELF AT HOME</div><h2>One place for what’s next.</h2><p>Connect your assistant to start a conversation, keep useful context, and put recurring work on a schedule.</p><form onSubmit={connect} className="connect-form"><TextInput label="Workspace access token" type="password" value={tokenDraft} onChange={setTokenDraft} placeholder="Enter your private access token" /><Button label="Connect workspace" variant="primary" onClick={() => { const value = tokenDraft.trim(); if (value) { sessionStorage.setItem('harness-token', value); setToken(value); setTokenDraft(''); } }} /></form><small>Your token stays in this browser tab’s session. Disconnect to remove it.</small></div></section> : <>
          {error && <div className="error" role="alert"><strong>Couldn’t complete that.</strong><span>{error}</span><Button label="Dismiss" variant="ghost" onClick={() => setError('')} /></div>}
          {loading && <div className="loading" role="status">Loading your {view.toLowerCase()}…</div>}
          {view === 'Chat' && <section className="chat-panel"><div className="conversation" role="log" aria-label="Conversation" aria-live="polite">{messages.length === 0 && !loading ? <><Empty title="Start with anything.">An idea to explore. A task to untangle.<br />A little help with your day.</Empty><div className="prompt-grid">{['Help me plan my week', 'What do you remember about me?', 'Help me break down a goal'].map(prompt => <button key={prompt} className="prompt-card" onClick={() => setInput(prompt)}>{prompt}<span>↗</span></button>)}</div></> : messages.map((message, i) => <article key={message.id || i} className={`message ${message.role === 'user' ? 'user-message' : 'assistant-message'}`}><span className="message-avatar" aria-hidden="true">{message.role === 'user' ? 'Y' : '✳'}</span><div><div className="message-author">{message.role === 'user' ? 'You' : 'Assistant'}</div><p>{message.content}</p></div></article>)}{busy && <div className="thinking" role="status">✳ Thinking through it…</div>}<div ref={endRef} /></div><form onSubmit={send} className="composer"><label htmlFor="message" className="visually-hidden">Message your assistant</label><textarea id="message" value={input} onChange={event => setInput(event.target.value)} placeholder="Tell me what you’re working on…" rows={2} maxLength={12000} disabled={busy} onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void send(event); } }} /><div className="composer-footer"><span>Enter to send · Shift + Enter for a new line</span><Button label={busy ? 'Working…' : 'Send message'} variant="primary" isDisabled={busy || !input.trim()} onClick={() => void send({ preventDefault() {} } as FormEvent)} /></div></form><div className="privacy-note">Your context stays in your personal workspace. Review and edit it in Memory.</div></section>}
          {view === 'Memory' && <><section className="section-card"><div className="section-heading"><h2>Keep something in mind</h2><span className="pill">Explicit memory</span></div><form onSubmit={event => { event.preventDefault(); void action(async () => { if (!memoryText.trim()) return; await api('/memories', { text: memoryText.trim() }); setMemoryText(''); await refresh(); }); }} className="inline-form"><TextInput label="Fact or preference" value={memoryText} onChange={setMemoryText} placeholder="I prefer short, visual explanations" /><Button label="Save memory" variant="primary" isDisabled={busy || !memoryText.trim()} onClick={() => void action(async () => { await api('/memories', { text: memoryText.trim() }); setMemoryText(''); await refresh(); })} /></form></section><section className="record-list">{!items.length && !loading && <Empty title="A fresh start.">Useful facts and preferences will appear here.<br />You can review or remove them whenever you like.</Empty>}{items.map((item, index) => <article className="record" key={text(item.id) || index}><span className="record-icon">◈</span><div className="record-body"><p>{text(item.content ?? item.text)}</p><div className="record-meta"><span className="pill">{text(item.provenance ?? item.source ?? 'Memory')}</span><span>{timestamp(item.updatedAt ?? item.createdAt ?? item.updated_at ?? item.created_at)}</span></div>{Boolean(item.source) && <small>Source: {text(item.source)}</small>}</div><Button label="Forget" variant="ghost" isDisabled={busy} onClick={() => void action(async () => { await api(`/memories/${encodeURIComponent(text(item.id))}`, undefined, 'DELETE'); await refresh(); })} /></article>)}</section></>}
          {view === 'Schedules' && <><section className="section-card"><div className="section-heading"><h2>Make time for it</h2><span className="pill">Runs while you’re away</span></div><form onSubmit={createSchedule} className="schedule-form"><TextInput label="What should your assistant do?" value={schedulePrompt} onChange={setSchedulePrompt} placeholder="Review my active goals and suggest a next step" /><div className="form-columns"><label className="native-field">First run · your local time<input type="datetime-local" value={runAt} onChange={event => setRunAt(event.target.value)} required /></label><label className="native-field">Repeat every · minutes, optional<input type="number" min="1" value={interval} onChange={event => setInterval(event.target.value)} placeholder="Leave blank for one time" /></label></div><div className="form-actions"><small>Repeating schedules use a fixed interval.</small><Button label="Create schedule" variant="primary" isDisabled={busy || !schedulePrompt.trim() || !runAt} onClick={() => void createSchedule({ preventDefault() {} } as FormEvent)} /></div></form></section><section className="record-list">{!items.length && !loading && <Empty title="Nothing on the clock yet.">Add a one-time task or a recurring check-in above.</Empty>}{items.map((item, index) => <article className="record" key={text(item.id) || index}><span className="record-icon">◷</span><div className="record-body"><p>{text(item.prompt)}</p><div className="record-meta"><span className="pill">{repeatLabel(item)}</span><span>Next: {timestamp(item.nextRunAt ?? item.runAt ?? item.next_run_at)}</span></div></div><Button label="Remove" variant="ghost" isDisabled={busy} onClick={() => void action(async () => { await api(`/schedules/${encodeURIComponent(text(item.id))}`, undefined, 'DELETE'); await refresh(); })} /></article>)}</section></>}
          {view === 'Tasks' && <><section className="section-card"><div className="section-heading"><h2>Keep the work moving</h2><Button label="Run a dream" variant="secondary" isDisabled={busy} onClick={() => void action(async () => { await api('/tasks', { kind: 'dream', prompt: 'Consolidate recent activity into evidence-backed memories.' }); await refresh(); })} /></div><p className="section-description">Start background work, or run a dream to consolidate recent context into useful memories.</p><div className="inline-form"><TextInput label="Background task" value={taskPrompt} onChange={setTaskPrompt} placeholder="Review my saved context and suggest priorities" /><Button label="Start task" variant="primary" isDisabled={busy || !taskPrompt.trim()} onClick={() => void action(async () => { await api('/tasks', { kind: 'task', prompt: taskPrompt.trim() }); setTaskPrompt(''); await refresh(); })} /></div></section><section className="record-list">{!items.length && !loading && <Empty title="A clear slate.">Background tasks and dream results will appear here.</Empty>}{items.map((item, index) => <article className="record task-record" key={text(item.id) || index}><span className="record-icon">{item.kind === 'dream' ? '☾' : '☷'}</span><div className="record-body"><div className="task-heading"><p>{text(item.prompt ?? item.kind ?? 'Task')}</p><span className={`pill status-${text(item.status)}`}>{text(item.status)}</span></div><div className="record-meta"><span>{text(item.kind ?? 'task')}</span><span>{timestamp(item.createdAt ?? item.created_at)}</span></div>{Boolean(item.result) && <details><summary>View result</summary><pre>{text(item.result)}</pre></details>}{item.kind === 'dream' && item.status === 'completed' && Boolean(item.result) && <div className="dream-review"><Button label="Review memory proposal" variant="secondary" onClick={() => { setReviewingTask(text(item.id)); setReviewText(text(item.result)); }} />{reviewingTask === text(item.id) && <div className="review-form"><label className="native-field">Edit the memory to keep<textarea value={reviewText} onChange={event => setReviewText(event.target.value)} rows={5} maxLength={8000} /></label><p>This saves your reviewed text as a memory. If context changed since the dream, run a new dream before applying.</p><Button label="Save reviewed memory" variant="primary" isDisabled={busy || !reviewText.trim()} onClick={() => void action(async () => { await api('/dreams/apply', { taskId: text(item.id), text: reviewText.trim() }); setReviewingTask(''); setReviewText(''); await refresh(); })} /></div>}</div>}{Boolean(item.error) && <p className="task-error">{text(item.error)}</p>}</div></article>)}</section></>}
        </>}
        <footer className="page-footer"><span>Built around your context.</span>{token && <button className="footer-disconnect" onClick={disconnect}>Disconnect</button>}<span>Personal Harness <span className="footer-star">✳</span></span></footer>
      </div>
    </main>
  </div></Theme>;
}

createRoot(document.getElementById('root')!).render(<App />);

