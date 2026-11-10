import type { LocalStore } from './store.ts';
import type { WorkspaceService } from './workspace.ts';

/** Human-readable projections; SQLite remains authoritative. No model-written system prompt. */
export async function syncMemoryFiles(store: LocalStore, workspace: WorkspaceService) {
  const memories = store.listMemories();
  const curated = ['# Curated memory', '', `Revision: ${store.revision()}`, '', 'Edit memories through the Memory view so provenance and revisions stay consistent.', ''];
  for (const memory of memories) curated.push(`## ${memory.kind}: ${memory.id}`, '', memory.text, '', `Source: ${memory.source}; provenance: ${memory.provenance}; confidence: ${memory.confidence}`, `Source IDs: ${memory.sourceIds.join(', ')}`, '');
  const fullCurated = curated.join('\n');
  await workspace.write('memory/MEMORY.md', fullCurated.length > 200000 ? fullCurated.slice(0, 200000) + '\n\n[Projection truncated. Full records remain in SQLite.]' : fullCurated);
  const dates = new Map<string, string[]>();
  for (const message of store.listMessages(1000)) {
    const date = new Date(message.createdAt).toISOString().slice(0, 10);
    const notes = dates.get(date) ?? [`# Daily notes: ${date}`, '', 'Raw retained conversation excerpts; not curated memory.', ''];
    notes.push(`## ${message.role} · ${message.id}`, '', message.content, ''); dates.set(date, notes);
  }
  const wanted = new Set(['memory/MEMORY.md']);
  for (const [date, content] of dates) {
    const path = `memory/daily/${date}.md`; wanted.add(path);
    await workspace.write(path, content.join('\n').slice(0, 250000));
  }
  for (const person of memories.filter(m => m.kind === 'person')) {
    const path = `memory/people/${person.id}.md`; wanted.add(path);
    await workspace.write(path, `# Person context\n\n${person.text}\n\nProvenance: ${person.provenance}\nSource IDs: ${person.sourceIds.join(', ')}\n`);
  }
  // Delete only previously managed projections after regeneration. Never scan/delete arbitrary artifacts.
  const previous = store.getSetting<string[]>('managedMemoryFiles') ?? [];
  for (const path of previous) if (!wanted.has(path) && /^memory\/(daily\/\d{4}-\d{2}-\d{2}|people\/[a-f0-9-]+)\.md$/.test(path)) {
    await workspace.remove(path).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; });
  }
  store.setSetting('managedMemoryFiles', [...wanted]);
  return { files: [...wanted], revision: store.revision(), retainedMessageLimit: 1000 };
}
