// BrainLLM — LLM surface (read). Responsibilities + protocols singletons,
// and the diary collection.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { TriliumClient } from "./trilium.js";
import type { BrainLLMConfig } from "./config.js";
import { txt, skim, readFull, preview } from "./tools-surface.js";

export function registerLlmTools(server: McpServer, trilium: TriliumClient, brainRef: { config: BrainLLMConfig }): void {
  const b = () => brainRef.config;

  server.tool(
    "llm",
    "Read an LLM note in full: responsibilities or protocols (singletons), or a diary entry by id.",
    {
      which: z.enum(["responsibilities", "protocols", "diary"]),
      id: z.string().optional().describe("diary only: the entry id from llm_recall"),
    },
    async ({ which, id }) => {
      if (which === "diary") {
        if (!id) throw new Error("Reading a diary entry needs its id — use llm_recall to find one.");
        return txt(await readFull(trilium, id));
      }
      const noteId = b().llm[which];
      if (!noteId) throw new Error("BrainLLM not bootstrapped — run bootstrap.");
      return txt(await readFull(trilium, noteId));
    }
  );

  server.tool(
    "llm_recall",
    "Skim the LLM surface: responsibilities & protocols opening lines, plus recent diary entries.",
    { limit: z.number().optional() },
    async ({ limit }) => {
      const cfg = b();
      return txt({
        responsibilities: await preview(trilium, cfg.llm.responsibilities),
        protocols: await preview(trilium, cfg.llm.protocols),
        diary: await skim(trilium, cfg.llm.diary, { kind: "diary", limit: limit ?? 7 }),
      });
    }
  );
}
