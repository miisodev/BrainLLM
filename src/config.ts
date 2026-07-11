// ─────────────────────────────────────────────────────────────────────────────
// BrainLLM — runtime configuration (V8)
//
// IDs are stored in brainllm.json next to the bundle. On startup:
//   load file → auto-discover from Trilium (via #brainLlmRoot) → empty (bootstrap).
// bootstrap writes this file; no manual editing required.
//
// The schema is version 8. Version-5 files (the long-lived prior contract —
// every later release added only optional fields that default to "" when
// absent) still load and are re-saved as 8 on the next write. Anything else
// falls through to discovery/bootstrap.
// ─────────────────────────────────────────────────────────────────────────────

import { existsSync, readFileSync, writeFileSync } from "fs";
import { join, dirname } from "path";
import type { TriliumClient } from "./trilium.js";
import { DEFAULT_POLICY, type LifecyclePolicy } from "./types.js";

// ── Type ─────────────────────────────────────────────────────────────────────

export interface BrainLLMConfig {
  version?: number;
  root: string;
  master:    { root: string; biography: string; goals: string; preferences: string };
  llm:       { root: string; responsibilities: string; protocols: string; diary: string };
  // metaThread: vestigial — the former standing self-analysis thread's slot
  // (self-analysis lives in the diary). Kept in the schema so legacy config
  // files load unchanged; always "".
  memory:    { root: string; sessions: string; threads: string; metaThread: string };
  knowledge: { root: string; master: string; domains: string };
  insights:  { root: string; logs: string };
  policy: LifecyclePolicy;
}

export const EMPTY_BRAINLLM: BrainLLMConfig = {
  version: 8,
  root: "",
  master:    { root: "", biography: "", goals: "", preferences: "" },
  llm:       { root: "", responsibilities: "", protocols: "", diary: "" },
  memory:    { root: "", sessions: "", threads: "", metaThread: "" },
  knowledge: { root: "", master: "", domains: "" },
  insights:  { root: "", logs: "" },
  policy:    { ...DEFAULT_POLICY },
};

// ── File path ─────────────────────────────────────────────────────────────────

export function configFilePath(): string {
  // BRAINLLM_CONFIG lets Railway (or any persistent-volume deploy) pin the file
  // to a mount path that survives redeploys, avoiding auto-discovery on every cold start.
  const override = process.env.BRAINLLM_CONFIG;
  if (override) return override;
  return join(dirname(Bun.main), "brainllm.json");
}

// ── Load ──────────────────────────────────────────────────────────────────────

export function loadConfig(): BrainLLMConfig | null {
  const path = configFilePath();
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8"));
    // Version 8, or legacy version 5 (re-saved as 8 on the next write).
    // Older shapes fall through to discovery.
    if (typeof parsed?.root === "string" && (parsed?.version === 8 || parsed?.version === 5)) {
      return {
        ...parsed,
        memory: { metaThread: "", ...(parsed.memory ?? {}) },
        policy: { ...DEFAULT_POLICY, ...(parsed.policy ?? {}) },
      } as BrainLLMConfig;
    }
  } catch {
    // Corrupted file — return null so discovery runs.
  }
  return null;
}

// ── Save ──────────────────────────────────────────────────────────────────────

export function saveConfig(config: BrainLLMConfig): string {
  const path = configFilePath();
  writeFileSync(path, JSON.stringify({ ...config, version: 8 }, null, 2) + "\n", "utf-8");
  return path;
}

// ── Auto-discovery ────────────────────────────────────────────────────────────
// Rebuild config by walking the brain tree from its #brainLlmRoot marker. Called
// when brainllm.json is missing (e.g. the bundle moved, or a CLI init ran first).

export async function discoverBrainLLM(trilium: TriliumClient): Promise<BrainLLMConfig | null> {
  let rootId: string | null = null;
  try {
    const res = await trilium.searchNotes("#brainLlmRoot", { limit: 5 });
    rootId = res.results[0]?.noteId ?? null;
  } catch {
    return null;
  }
  if (!rootId) return null;

  const config: BrainLLMConfig = { ...EMPTY_BRAINLLM, policy: { ...DEFAULT_POLICY }, root: rootId };

  try {
    const root = await trilium.getNote(rootId);

    for (const cid of root.childNoteIds) {
      const child = await trilium.getNote(cid).catch(() => null);
      if (!child) continue;

      // Build grandchild title → ID map.
      const gc: Record<string, string> = {};
      for (const gcid of child.childNoteIds) {
        const n = await trilium.getNote(gcid).catch(() => null);
        if (n) gc[n.title] = n.noteId;
      }

      const id = child.noteId;
      const g = (t: string) => gc[t] ?? "";

      switch (child.title) {
        case "Master":
          config.master = { root: id, biography: g("Biography"), goals: g("Goals"), preferences: g("Preferences") };
          break;
        case "LLM":
          config.llm = { root: id, responsibilities: g("Responsibilities"), protocols: g("Protocols"), diary: g("Diary") };
          break;
        case "Memory":
          config.memory = { root: id, sessions: g("Sessions"), threads: g("Threads"), metaThread: "" };
          break;
        case "Knowledge":
          config.knowledge = { root: id, master: g("Master"), domains: g("Domains") };
          break;
        case "Insights":
          config.insights = { root: id, logs: g("Logs") };
          break;
      }
    }
  } catch {
    return null;
  }

  // Validate that required structural IDs are populated.
  const requiredIds = [
    config.master.root, config.llm.root, config.memory.root,
    config.knowledge.root, config.insights.root,
  ];
  if (requiredIds.some((id) => !id)) return null;

  return config;
}
