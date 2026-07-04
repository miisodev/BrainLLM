// ─────────────────────────────────────────────────────────────────────────────
// BrainLLM — shared helpers for the read-only surface modules
//
// Surface tools are dual-mode reads: `<surface>` reads a note in full,
// `<surface>_recall` skims/searches within the surface. Writes go through the
// universal tools (remember / revise / resolve / forget / connect).
// ─────────────────────────────────────────────────────────────────────────────

import { TriliumClient, type Note, relationSnippet, type RelationEdge } from "./trilium.js";
import { toText } from "./normalize.js";

export const txt = (obj: unknown) => ({
  content: [{ type: "text" as const, text: typeof obj === "string" ? obj : JSON.stringify(obj, null, 2) }],
});

export const labelOf = (n: Note, name: string) =>
  n.attributes.find((a) => a.type === "label" && a.name === name)?.value;

export interface Stub {
  id: string;
  title: string;
  kind?: string;
  status?: string;
  updated: string;
  preview: string;
  relations?: RelationEdge[];
}

/** Skim a surface subtree → compact stubs with previews, newest first. */
export async function skim(
  trilium: TriliumClient,
  ancestorNoteId: string,
  opts: { query?: string; kind?: string; limit?: number; includeArchived?: boolean } = {}
): Promise<Stub[]> {
  const { query, kind, limit = 20, includeArchived = false } = opts;
  const clauses = [kind ? `#noteType=${kind}` : "#noteType"];
  if (query) clauses.push(`note.title *=* '${query.replace(/'/g, " ")}'`);
  const res = await trilium
    .searchNotes(clauses.join(" "), {
      ancestorNoteId,
      fastSearch: !query,
      limit,
      includeArchivedNotes: includeArchived,
      orderBy: "dateModified",
      orderDirection: "desc",
    })
    .catch(() => ({ results: [] as Note[] }));

  return Promise.all(
    res.results.slice(0, limit).map(async (n) => {
      const content = await trilium.getNoteContent(n.noteId).catch(() => "");
      const relations = relationSnippet(n);
      return {
        id: n.noteId, title: n.title, kind: labelOf(n, "noteType"), status: labelOf(n, "status") ?? undefined,
        updated: n.dateModified.slice(0, 10), preview: toText(content, 160), ...(relations ? { relations } : {}),
      };
    })
  );
}

/** Read a note in full (id + title + kind + content + relation snippet). */
export async function readFull(trilium: TriliumClient, id: string): Promise<{ id: string; title: string; kind?: string; content: string; relations?: RelationEdge[] }> {
  const [note, content] = await Promise.all([trilium.getNote(id), trilium.getNoteContent(id).catch(() => "")]);
  const relations = relationSnippet(note);
  return { id, title: note.title, kind: labelOf(note, "noteType"), content, ...(relations ? { relations } : {}) };
}

/** A short text preview of a note by id. */
export async function preview(trilium: TriliumClient, id: string, len = 200): Promise<string> {
  const content = await trilium.getNoteContent(id).catch(() => "");
  return toText(content, len);
}

/** A short text preview plus relation snippet — for singleton reads that want
 *  both without paying for the full content body (see readFull). */
export async function previewWithRelations(trilium: TriliumClient, id: string, len = 200): Promise<{ preview: string; relations?: RelationEdge[] }> {
  const [note, content] = await Promise.all([trilium.getNote(id).catch(() => null), trilium.getNoteContent(id).catch(() => "")]);
  const relations = note ? relationSnippet(note) : undefined;
  return { preview: toText(content, len), ...(relations ? { relations } : {}) };
}
