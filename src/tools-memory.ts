// BrainLLM — Memory surface (read). Threads + daily sessions.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { TriliumClient, type Note, isCollectionThread } from "./trilium.js";
import type { BrainLLMConfig } from "./config.js";
import { txt, skim, readFull, labelOf, idParams, missingId } from "./tools-surface.js";
import { toText, addendumIndex } from "./normalize.js";

/** Day-children memory() indexes when the caller sets no limit. */
export const MEMORY_INDEX_DEFAULT = 30;
/** Without a limit, the index also stops once its entries pass this many
 *  characters: a thread's size lives in its entries' block summaries, not
 *  their count, so thirty busy days can still outgrow the tool-output ceiling. */
export const MEMORY_INDEX_CHAR_BUDGET = 24_000;

export function registerMemoryTools(server: McpServer, trilium: TriliumClient, brainRef: { config: BrainLLMConfig }): void {
  const b = () => brainRef.config;

  server.tool(
    "memory",
    `Read a Memory note by id — a thread or a session. A dated thread returns its Context and
Resolution plus an index of its [yyyy-mm-dd] children (newest first: the latest 30, fewer if their
index passes ~24k characters, unless limit= says otherwise; with the total count), each listed by its addendum blocks;
date="yyyy-mm-dd" resolves straight to one day. A collection thread returns its
Context plus its titled entries (alphabetical, with a lead). Read a child with memory(<child id>).
section="<heading>" reads one section.`,
    {
      ...idParams,
      date: z.string().optional().describe("Thread books only: resolve directly to this day's child note (yyyy-mm-dd)"),
      limit: z.number().int().positive().optional().describe("Dated threads: how many of the newest day-children to index (default 30)"),
      section: z.string().optional().describe("Read only this heading's section (h2/h3/h4), instead of the whole note"),
      occurrence: z.number().int().positive().optional().describe("section=: which same-text heading, 1-based (default: the first)"),
    },
    async ({ id: idArg, noteId, date, limit, section, occurrence }) => {
      const id = idArg ?? noteId;
      if (!id) return missingId("memory");
      const note = await trilium.getNote(id).catch(() => null);
      if (!note || labelOf(note, "noteType") !== "thread") return txt(await readFull(trilium, id, { section, occurrence }));

      // Collection threads: titled entries, alphabetical, each with a lead.
      if (isCollectionThread(note)) {
        const kids = await trilium
          .searchNotes("#noteType=threadEntry", { ancestorNoteId: id, fastSearch: true, limit: 500 })
          .catch(() => ({ results: [] as Note[] }));
        const entries = await Promise.all(
          kids.results
            .filter((c) => c.parentNoteIds.includes(id))
            .sort((a, z) => a.title.localeCompare(z.title))
            .map(async (c) => ({
              id: c.noteId,
              title: c.title,
              updated: labelOf(c, "updated") ?? c.dateModified.slice(0, 10),
              preview: toText(await trilium.getNoteContent(c.noteId).catch(() => ""), 160),
            }))
        );
        const full = await readFull(trilium, id, { section, occurrence });
        return txt({ ...full, shape: "collection", entries });
      }

      if (date) {
        const child = await trilium
          .searchNotes(`#noteType=threadEntry #created='${date}'`, { ancestorNoteId: id, fastSearch: true, limit: 1 })
          .catch(() => ({ results: [] as Note[] }));
        if (child.results[0]) return txt(await readFull(trilium, child.results[0].noteId, { section, occurrence }));
        return txt({ id, title: note.title, kind: "thread", note: `No entry for ${date}.` });
      }

      // Bounded by default: a busy thread's full index outgrew the tool-output
      // ceiling and the read refused outright, when the caller usually wanted
      // only the newest entries. The total says whether there is more.
      const shown = limit ?? MEMORY_INDEX_DEFAULT;
      const totalChildren = note.childNoteIds.length;
      const children = await trilium
        .searchNotes("#noteType=threadEntry", {
          ancestorNoteId: id, fastSearch: true, limit: shown, orderBy: "dateCreated", orderDirection: "desc",
        })
        .catch(() => ({ results: [] as Note[] }));
      const indexed = await Promise.all(
        children.results.map(async (c) => {
          const content = await trilium.getNoteContent(c.noteId).catch(() => "");
          const blocks = addendumIndex(content);
          return {
            id: c.noteId,
            date: labelOf(c, "created") ?? c.dateCreated.slice(0, 10),
            // Blocks when the child has them; the old top-of-body slice only as
            // a fallback for a child that predates the addendum structure.
            ...(blocks.length ? { blocks } : { preview: toText(content, 160) }),
          };
        })
      );
      // An explicit limit is the caller's call; the default also respects the budget.
      const entries: typeof indexed = [];
      let used = 0;
      for (const e of indexed) {
        const size = JSON.stringify(e).length;
        if (limit === undefined && entries.length && used + size > MEMORY_INDEX_CHAR_BUDGET) break;
        entries.push(e);
        used += size;
      }
      const full = await readFull(trilium, id, { section, occurrence });
      return txt({
        ...full,
        totalChildren,
        children: entries,
        ...(totalChildren > entries.length
          ? { more: `Showing the newest ${entries.length} of ${totalChildren} day-children. Pass limit= for more, or date= for one day.` }
          : {}),
      });
    }
  );

  server.tool(
    "memory_recall",
    "Skim Memory: active threads and recent sessions (ids + previews). An optional query filters threads by title.",
    { query: z.string().optional(), limit: z.number().optional() },
    async ({ query, limit }) => {
      const cfg = b();
      const [threadStubs, sessions] = await Promise.all([
        skim(trilium, cfg.memory.threads, { kind: "thread", query, limit: limit ?? 20 }),
        skim(trilium, cfg.memory.sessions, { kind: "session", limit: 7 }),
      ]);
      // A thread's own preview is now static Context/Goal text (the book never
      // changes day to day) — it never reflects real activity the way a
      // session/diary preview does. Enrich with the latest day-child's preview
      // so skimming threads still surfaces what's actually been happening.
      const threads = await Promise.all(
        threadStubs.map(async (t) => {
          const latest = await trilium
            .searchNotes("#noteType=threadEntry", {
              ancestorNoteId: t.id, fastSearch: true, limit: 1, orderBy: "dateCreated", orderDirection: "desc",
            })
            .catch(() => ({ results: [] as Note[] }));
          const child = latest.results[0];
          if (!child) return t;
          const date = labelOf(child, "created") ?? child.dateCreated.slice(0, 10);
          const content = await trilium.getNoteContent(child.noteId).catch(() => "");
          return { ...t, latestActivity: { date, preview: toText(content, 160) } };
        })
      );
      return txt({ threads, sessions });
    }
  );
}
