// BrainLLM — LLM surface (read). Responsibilities + protocols singletons,
// and the diary collection.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { TriliumClient } from "./trilium.js";
import type { BrainLLMConfig } from "./config.js";
import { txt, skim, readFull, previewWithRelations } from "./tools-surface.js";

export function registerLlmTools(server: McpServer, trilium: TriliumClient, brainRef: { config: BrainLLMConfig }): void {
  const b = () => brainRef.config;

  server.tool(
    "llm",
    `Read an LLM note: responsibilities or protocols (singletons), or a diary entry by id.

section="<heading>" reads ONE section instead of the whole note — the efficient path on
protocols, which is the largest singleton and the one most often needed in part rather than
whole. outline(id) lists the headings.`,
    {
      which: z.enum(["responsibilities", "protocols", "diary"]),
      id: z.string().optional().describe("diary only: the entry id from llm_recall"),
      section: z.string().optional().describe("Read only this heading's section (h2/h3/h4), instead of the whole note"),
      occurrence: z.number().int().positive().optional().describe("section=: which same-text heading, 1-based (default: the first)"),
    },
    async ({ which, id, section, occurrence }) => {
      if (which === "diary") {
        if (!id) throw new Error("Reading a diary entry needs its id — use llm_recall to find one.");
        return txt(await readFull(trilium, id, { section, occurrence }));
      }
      const noteId = b().llm[which];
      if (!noteId) throw new Error("BrainLLM not bootstrapped — run bootstrap.");
      return txt(await readFull(trilium, noteId, { section, occurrence }));
    }
  );

  server.tool(
    "llm_recall",
    "Skim the LLM surface: responsibilities & protocols opening lines (with relation snippets), plus recent diary entries.",
    { limit: z.number().optional() },
    async ({ limit }) => {
      const cfg = b();
      const [resp, prot, diary] = await Promise.all([
        previewWithRelations(trilium, cfg.llm.responsibilities),
        previewWithRelations(trilium, cfg.llm.protocols),
        skim(trilium, cfg.llm.diary, { kind: "diary", limit: limit ?? 7 }),
      ]);
      return txt({
        responsibilities: { id: cfg.llm.responsibilities, ...resp },
        protocols: { id: cfg.llm.protocols, ...prot },
        diary,
      });
    }
  );
}
