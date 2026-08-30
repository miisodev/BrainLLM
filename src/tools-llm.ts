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
    `Read an LLM note: responsibilities, protocols or selfcorrection (singletons), or a diary
entry by id.

selfcorrection holds the assistant's own corrections — what it got wrong, what generalises, and
the rule that prevents a repeat. It is the one LLM singleton start() does NOT serve in full: it
is the largest and the least load-bearing at a first message, so it arrives as section headings
and is read here on demand. Reach for it when about to repeat a class of work that has gone
wrong before — an audit, a large edit, a claim of completeness.

section="<heading>" reads ONE section instead of the whole note — the efficient path on
protocols and selfcorrection, the two largest singletons and the ones most often needed in part
rather than whole. outline(id) lists the headings.`,
    {
      which: z.enum(["responsibilities", "protocols", "selfcorrection", "diary"]),
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
      if (!noteId) {
        // Distinguish "no brain" from "this brain predates this singleton". The
        // remedy is the same call, but the second is an upgrade rather than a
        // setup error, and reporting it as "not bootstrapped" on a brain in
        // daily use reads as data loss.
        throw new Error(
          which === "selfcorrection"
            ? "This brain has no Self-correction note yet — it arrived in V12. Run bootstrap() once; it finds or creates the note and persists its id, leaving everything else untouched."
            : "BrainLLM not bootstrapped — run bootstrap."
        );
      }
      return txt(await readFull(trilium, noteId, { section, occurrence }));
    }
  );

  server.tool(
    "llm_recall",
    "Skim the LLM surface: responsibilities, protocols & self-correction opening lines (with relation snippets), plus recent diary entries.",
    { limit: z.number().optional() },
    async ({ limit }) => {
      const cfg = b();
      const [resp, prot, selfcorr, diary] = await Promise.all([
        previewWithRelations(trilium, cfg.llm.responsibilities),
        previewWithRelations(trilium, cfg.llm.protocols),
        // Guarded: a brain that predates V12 has no id here, and skimming a
        // surface must never fail because one slot is newer than the brain.
        cfg.llm.selfcorrection ? previewWithRelations(trilium, cfg.llm.selfcorrection) : Promise.resolve(null),
        skim(trilium, cfg.llm.diary, { kind: "diary", limit: limit ?? 7 }),
      ]);
      return txt({
        responsibilities: { id: cfg.llm.responsibilities, ...resp },
        protocols: { id: cfg.llm.protocols, ...prot },
        ...(selfcorr ? { selfcorrection: { id: cfg.llm.selfcorrection, ...selfcorr } } : {}),
        diary,
      });
    }
  );
}
