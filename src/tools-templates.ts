// BrainLLM — Templates surface (read). The per-type blueprints — structure,
// format, lifecycle, maintenance, and a worked example.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { TriliumClient } from "./trilium.js";
import type { BrainLLMConfig } from "./config.js";
import { txt, readFull } from "./tools-surface.js";

export function registerTemplatesTools(server: McpServer, trilium: TriliumClient, brainRef: { config: BrainLLMConfig }): void {
  const b = () => brainRef.config;

  server.tool(
    "templates",
    "Read a note type's blueprint — its structure / format / lifecycle / maintenance / example. Consult before maintaining a type.",
    { type: z.string().describe("Note type, e.g. thread, biography, information, log") },
    async ({ type }) => {
      const id = b().templates.byKind[type];
      if (!id) throw new Error(`No blueprint for "${type}". Known: ${Object.keys(b().templates.byKind).join(", ")}`);
      return txt(await readFull(trilium, id));
    }
  );

  server.tool(
    "templates_recall",
    "List all blueprints — the note types and their ids.",
    {},
    async () => txt(Object.entries(b().templates.byKind).map(([kind, id]) => ({ kind, id })))
  );
}
