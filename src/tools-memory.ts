// BrainLLM — Memory surface (read). Threads + daily sessions.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { TriliumClient } from "./trilium.js";
import type { BrainLLMConfig } from "./config.js";
import { txt, skim, readFull } from "./tools-surface.js";

export function registerMemoryTools(server: McpServer, trilium: TriliumClient, brainRef: { config: BrainLLMConfig }): void {
  const b = () => brainRef.config;

  server.tool(
    "memory",
    "Read a Memory note in full by id — a thread or a session.",
    { id: z.string() },
    async ({ id }) => txt(await readFull(trilium, id))
  );

  server.tool(
    "memory_recall",
    "Skim Memory: active threads and recent sessions (ids + previews). An optional query filters threads by title.",
    { query: z.string().optional(), limit: z.number().optional() },
    async ({ query, limit }) => {
      const cfg = b();
      return txt({
        threads: await skim(trilium, cfg.memory.threads, { kind: "thread", query, limit: limit ?? 20 }),
        sessions: await skim(trilium, cfg.memory.sessions, { kind: "session", limit: 7 }),
      });
    }
  );
}
