// BrainLLM — Insights surface (read). The brain's per-day change logs
// (derived/auto-generated — read-only).

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { TriliumClient, type Note } from "./trilium.js";
import type { BrainLLMConfig } from "./config.js";
import { localToday } from "./time.js";
import { txt, skim, readFull } from "./tools-surface.js";

export function registerInsightsTools(server: McpServer, trilium: TriliumClient, brainRef: { config: BrainLLMConfig }): void {
  const b = () => brainRef.config;

  server.tool(
    "insights",
    "Read the BrainLLM's change log for a day (default: today). Format: YYYY-MM-DD.",
    { date: z.string().optional() },
    async ({ date }) => {
      const d = date ?? localToday();
      const found = await trilium
        .searchNotes(`#noteType=log #created='${d}'`, { ancestorNoteId: b().insights.logs, fastSearch: true, limit: 1 })
        .catch(() => ({ results: [] as Note[] }));
      if (!found.results[0]) return txt({ date: d, note: "No log for this day." });
      return txt(await readFull(trilium, found.results[0].noteId));
    }
  );

  server.tool(
    "insights_recall",
    "Skim recent change logs (days + previews).",
    { limit: z.number().optional() },
    async ({ limit }) => txt(await skim(trilium, b().insights.logs, { kind: "log", limit: limit ?? 14 }))
  );
}
