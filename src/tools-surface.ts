// ─────────────────────────────────────────────────────────────────────────────
// BrainLLM — shared helpers for the read-only surface modules
//
// Surface tools are dual-mode reads: `<surface>` reads a note in full,
// `<surface>_recall` skims/searches within the surface. Writes go through the
// universal tools (remember / revise / resolve / forget / connect).
// ─────────────────────────────────────────────────────────────────────────────

import { TriliumClient, type Note, relationSnippet, type RelationEdge } from "./trilium.js";
import { toText, getSection, LARGE_NOTE_CHARS } from "./normalize.js";

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

export interface FullRead {
  id: string;
  title: string;
  kind?: string;
  content: string;
  relations?: RelationEdge[];
  /** section reads only */
  section?: string;
  matched?: boolean;
  headingCount?: number;
  subsections?: string[];
  available?: string[];
  size?: number;
  hint?: string;
}

/** Read a note in full, or ONE section of it.
 *
 *  The sectioned read is the counterpart to revise(section=), and it closes the
 *  asymmetry that made big notes unreadable: every write tool could target a
 *  heading and no read tool could, so seeing one section meant reading the whole
 *  note. A Current State note grew 53k → 108k characters across five sessions
 *  and at one point could not be returned at all — the notes carrying the most
 *  were the ones the brain could least afford to open.
 *
 *  Matching goes through the same locateSection() contract that section= writes
 *  use, so a heading name that reads also writes. */
export async function readFull(
  trilium: TriliumClient,
  id: string,
  opts: { section?: string; occurrence?: number } = {}
): Promise<FullRead> {
  const [note, content] = await Promise.all([trilium.getNote(id), trilium.getNoteContent(id).catch(() => "")]);
  const relations = relationSnippet(note);
  const base = { id, title: note.title, kind: labelOf(note, "noteType"), ...(relations ? { relations } : {}) };

  if (!opts.section) {
    return {
      ...base,
      content,
      ...(content.length >= LARGE_NOTE_CHARS
        ? { size: content.length, hint: `${Math.round(content.length / 1000)}k characters. Read one section at a time with section="<heading>" — outline(${id}) lists them.` }
        : {}),
    };
  }

  const found = getSection(content, opts.section, opts.occurrence ?? 1);
  if (!found.matched) {
    return {
      ...base, content: "", section: opts.section, matched: false, available: found.available,
      hint: `No "${opts.section}" heading at h2/h3/h4. available= lists the note's real heading texts — re-target from there rather than falling back to a whole-note read.`,
    };
  }
  return {
    ...base,
    content: found.content,
    section: opts.section,
    matched: true,
    headingCount: found.headingCount,
    ...(found.subsections?.length ? { subsections: found.subsections } : {}),
    ...(found.headingCount && found.headingCount > 1 && !opts.occurrence
      ? { hint: `${found.headingCount} headings share that text — this is the FIRST. Pass occurrence= (1-${found.headingCount}) to read another.` }
      : {}),
  };
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
