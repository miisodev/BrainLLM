// ─────────────────────────────────────────────────────────────────────────────
// BrainLLM — Master surface (read)
//
// Surface tools are read-only and dual-mode: `master` reads a singleton in full,
// `master_recall` skims all three. Writes/edits go through the universal tools
// (remember / revise / forget). Master is three fixed singletons.
// ─────────────────────────────────────────────────────────────────────────────

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { TriliumClient, relationSnippet, type RelationEdge } from "./trilium.js";
import type { BrainLLMConfig } from "./config.js";
import { toText } from "./normalize.js";
import { readFull } from "./tools-surface.js";

const txt = (obj: unknown) => ({
  content: [{ type: "text" as const, text: typeof obj === "string" ? obj : JSON.stringify(obj, null, 2) }],
});

const AREAS = ["biography", "goals", "preferences"] as const;

export function registerMasterTools(server: McpServer, trilium: TriliumClient, brainRef: { config: BrainLLMConfig }): void {
  const b = () => brainRef.config;

  server.tool(
    "master",
    `Read a Master singleton: biography, goals, or preferences. Returns its id, content, and
relation snippet.

section="<heading>" reads ONE section instead of the whole note — the efficient path on
preferences, whose schedule tables make it the largest of the three, when the session needs one
day's blocks rather than the whole week. outline(id) lists the headings.`,
    {
      which: z.enum(AREAS),
      section: z.string().optional().describe("Read only this heading's section (h2/h3/h4), instead of the whole note"),
      occurrence: z.number().int().positive().optional().describe("section=: which same-text heading, 1-based (default: the first)"),
    },
    async ({ which, section, occurrence }) => {
      const id = b().master[which];
      if (!id) throw new Error("BrainLLM not bootstrapped — run bootstrap.");
      const read = await readFull(trilium, id, { section, occurrence });
      const { id: _id, title: _title, kind: _kind, ...rest } = read;
      return txt({ which, id, ...rest });
    }
  );

  server.tool(
    "master_recall",
    "Skim all three Master singletons — the opening lines of biography, goals, and preferences (with ids and relation snippets).",
    {},
    async () => {
      const out: Record<string, { id: string; preview: string; relations?: RelationEdge[] }> = {};
      for (const which of AREAS) {
        const id = b().master[which];
        if (!id) continue;
        const [note, content] = await Promise.all([trilium.getNote(id).catch(() => null), trilium.getNoteContent(id).catch(() => "")]);
        const relations = note ? relationSnippet(note) : undefined;
        out[which] = { id, preview: toText(content, 200), ...(relations ? { relations } : {}) };
      }
      return txt(out);
    }
  );
}
