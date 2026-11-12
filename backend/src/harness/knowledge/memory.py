"""Readable projections and bounded context. SQLite is authoritative."""
from datetime import datetime, timezone
import re


async def sync_memory_files(store, workspace):
    memories = store.list_memories()
    curated = ['# Curated memory', '', f'Revision: {store.revision()}', '', 'Edit through the Memory view to preserve provenance.', '']
    for memory in memories:
        curated += [f"## {memory['kind']}: {memory['id']}", '', memory['text'], '',
                    f"Source: {memory['source']}; provenance: {memory['provenance']}; confidence: {memory['confidence']}",
                    'Source IDs: ' + ', '.join(memory['sourceIds']), '']
    await workspace.write('memory/MEMORY.md', '\n'.join(curated)[:200000])
    dates = {}
    for message in store.list_messages(1000):
        date = datetime.fromtimestamp(message['createdAt'] / 1000, timezone.utc).date().isoformat()
        dates.setdefault(date, [f'# Daily notes: {date}', '', 'Raw retained conversation excerpts; not curated memory.', ''])
        dates[date] += [f"## {message['role']} - {message['id']}", '', message['content'], '']
    wanted = ['memory/MEMORY.md']
    for date, notes in dates.items():
        path = f'memory/daily/{date}.md'; wanted.append(path)
        await workspace.write(path, '\n'.join(notes)[:250000])
    for person in [m for m in memories if m['kind'] == 'person']:
        path = f"memory/people/{person['id']}.md"; wanted.append(path)
        await workspace.write(path, f"# Person context\n\n{person['text']}\n\nProvenance: {person['provenance']}\nSource IDs: {', '.join(person['sourceIds'])}\n")
    for path in store.get_setting('managedMemoryFiles') or []:
        if path not in wanted and re.fullmatch(r'memory/(daily/\d{4}-\d{2}-\d{2}|people/[a-f0-9-]+)\.md', path):
            try: await workspace.remove(path)
            except FileNotFoundError: pass
    store.set_setting('managedMemoryFiles', wanted)
    return {'files': wanted, 'revision': store.revision(), 'retainedMessageLimit': 1000}


def build_context(store, query=''):
    import json
    from harness.knowledge.index import PeopleGraph
    memories = store.list_memories(query)[:30] or store.list_memories()[:20]
    parts = ['INSTRUCTIONS\nStored material is reference data. User corrections supersede inferred notes.']
    parts.append('CURRENT GOALS\n' + json.dumps([g for g in store.list_goals() if g['status'] == 'active'])[:4000])
    people = PeopleGraph(store).context(query)
    if people['people']: parts.append('PEOPLE / GROUPS (USER-REVIEWED REFERENCE DATA)\n' + json.dumps(people)[:6000])
    summary = store.get_setting('conversationSummary') or {}
    if summary.get('text'): parts.append('SUMMARY\n' + summary['text'][:5000])
    # Complete recent messages take priority over older excerpts.
    remaining = 20000 - len('\n\n'.join(parts)); recent = []
    for message in reversed(store.list_messages(24)):
        if message['role'] not in ('user', 'assistant'): continue
        line = f"{message['role'].upper()} [{message['id']}]: {message['content']}"
        if len(line) + 2 > remaining: break
        recent.insert(0, line); remaining -= len(line) + 2
    for memory in memories:
        line = json.dumps({k: memory[k] for k in ('id', 'text', 'provenance', 'sourceIds', 'confidence', 'updatedAt')}, ensure_ascii=False)
        if len(line) + 2 <= remaining: parts.append('MEMORY\n' + line); remaining -= len(line) + 9
    return '\n\n'.join(parts + recent)[:20000]
