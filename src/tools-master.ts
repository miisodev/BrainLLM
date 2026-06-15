// ─────────────────────────────────────────────────────────────────────────────
// BrainLLM — Master surface (read)
//
// Surface tools are read-only and dual-mode: `master` reads a singleton in full,
// `master_recall` skims all three. Writes/edits go through the universal tools
// (remember / revise / forget). Master is three fixed singletons.
// ─────────────────────────────────────────────────────────────────────────────

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { TriliumClient } from "./trilium.js";
import type { BrainLLMConfig } from "./config.js";
import { toText } from "./normalize.js";

const txt = (obj: unknown) => ({
  content: [{ type: "text" as const, text: typeof obj === "string" ? obj : JSON.stringify(obj, null, 2) }],
});

const AREAS = ["biography", "goals", "preferences"] as const;

export function registerMasterTools(server: McpServer, trilium: TriliumClient, brainRef: { config: BrainLLMConfig }): void {
  const b = () => brainRef.config;

  server.tool(
    "master",
    "Read a Master singleton in full: biography, goals, or preferences. Returns its id and content.",
    { which: z.enum(AREAS) },
    async ({ which }) => {
      const id = b().master[which];
      if (!id) throw new Error("BrainLLM not bootstrapped — run bootstrap.");
      const content = await trilium.getNoteContent(id).catch(() => "");
      return txt({ which, id, content });
    }
  );

  server.tool(
    "master_recall",
    "Skim all three Master singletons — the opening lines of biography, goals, and preferences (with ids).",
    {},
    async () => {
      const out: Record<string, { id: string; preview: string }> = {};
      for (const which of AREAS) {
        const id = b().master[which];
        if (!id) continue;
        const content = await trilium.getNoteContent(id).catch(() => "");
        out[which] = { id, preview: toText(content, 200) };
      }
      return txt(out);
    }
  );
}
