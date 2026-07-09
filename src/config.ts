// ─────────────────────────────────────────────────────────────────────────────
// BrainLLM — runtime configuration (V7)
//
// IDs are stored in brainllm.json next to the bundle. On startup:
//   load file → auto-discover from Trilium (via #brainLlmRoot) → empty (bootstrap).
// bootstrap writes this file; no manual editing required.
//
// The schema number stays 5 as a compatibility contract: V6 and V7 added only
// optional fields (e.g. memory.metaThread) that default to "" when absent, so
// a V5-era brainllm.json loads without migration. Only version-5 configs load;
// anything older falls through to discovery/bootstrap.
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
  // metaThread: the standing, lifecycle-exempt "BrainLLM" self-analysis thread
  // (status=eternal) under Threads. "" until ensureMetaThread() lazily creates
  // or discovers it — safe to be empty on configs saved before this field existed.
  memory:    { root: string; sessions: string; threads: string; metaThread: string };
  knowledge: { root: string; master: string; domains: string };
  insights:  { root: string; logs: string };
  policy: LifecyclePolicy;
}

export const EMPTY_BRAINLLM: BrainLLMConfig = {
  version: 5,
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
    // Clean break: only V5 configs load. Older shapes fall through to discovery.
    if (typeof parsed?.root === "string" && parsed?.version === 5) {
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
  writeFileSync(path, JSON.stringify({ ...config, version: 5 }, null, 2) + "\n", "utf-8");
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

  // The meta-thread lives inside Threads (a grandchild of root), one level
  // deeper than the child/grandchild walk above reaches — find it by its
  // #status=eternal marker. Missing is non-fatal: ensureMetaThread() creates
  // or re-discovers it lazily on the next start()/remarks() call.
  if (config.memory.threads) {
    try {
      const found = await trilium.searchNotes("#noteType=thread #status=eternal", {
        ancestorNoteId: config.memory.threads,
        fastSearch: true,
        limit: 1,
      });
      if (found.results[0]) config.memory.metaThread = found.results[0].noteId;
    } catch { /* non-fatal */ }
  }

  return config;
}
