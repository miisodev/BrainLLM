// BrainLLM — Memory surface (read). Threads + daily sessions.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { TriliumClient, type Note } from "./trilium.js";
import type { BrainLLMConfig } from "./config.js";
import { txt, skim, readFull, labelOf } from "./tools-surface.js";
import { toText, addendumIndex } from "./normalize.js";

export function registerMemoryTools(server: McpServer, trilium: TriliumClient, brainRef: { config: BrainLLMConfig }): void {
  const b = () => brainRef.config;

  server.tool(
    "memory",
    `Read a Memory note in full by id — a thread or a session. A thread book returns its
Context/Resolution plus a children index ({id, date, blocks[]}, newest first) instead of a
flat body — the day-to-day content lives in those [yyyy-mm-dd] children, not the book. Each
child is indexed by its ADDENDUM BLOCKS — marker, identification line, and lead — rather than a
slice from the top of the body, which on a record note is the header and therefore identical on
every child.

Pass date="yyyy-mm-dd" to resolve straight to that day's child in the same call, or call
memory() again with a child's id from the index. section="<heading>" reads one section instead
of the whole body — use it on long sessions and consolidated thread Contexts.`,
    {
      id: z.string(),
      date: z.string().optional().describe("Thread books only: resolve directly to this day's child note (yyyy-mm-dd)"),
      section: z.string().optional().describe("Read only this heading's section (h2/h3/h4), instead of the whole note"),
      occurrence: z.number().int().positive().optional().describe("section=: which same-text heading, 1-based (default: the first)"),
    },
    async ({ id, date, section, occurrence }) => {
      const note = await trilium.getNote(id).catch(() => null);
      if (!note || labelOf(note, "noteType") !== "thread") return txt(await readFull(trilium, id, { section, occurrence }));

      if (date) {
        const child = await trilium
          .searchNotes(`#noteType=threadEntry #created='${date}'`, { ancestorNoteId: id, fastSearch: true, limit: 1 })
          .catch(() => ({ results: [] as Note[] }));
        if (child.results[0]) return txt(await readFull(trilium, child.results[0].noteId, { section, occurrence }));
        return txt({ id, title: note.title, kind: "thread", note: `No entry for ${date}.` });
      }

      const children = await trilium
        .searchNotes("#noteType=threadEntry", {
          ancestorNoteId: id, fastSearch: true, limit: 200, orderBy: "dateCreated", orderDirection: "desc",
        })
        .catch(() => ({ results: [] as Note[] }));
      const entries = await Promise.all(
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
      const full = await readFull(trilium, id, { section, occurrence });
      return txt({ ...full, children: entries });
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
