// ─────────────────────────────────────────────────────────────────────────────
// BrainLLM — runtime configuration (V5)
//
// IDs are stored in brainllm.json next to the bundle. On startup:
//   load file → auto-discover from Trilium (via #brainLlmRoot) → empty (bootstrap).
// bootstrap writes this file; no manual editing required.
//
// V5 is a clean break from v4 — the section shape changed, so a v4 brainllm.json is
// NOT forward-merged. Only version-5 configs load; anything older falls through
// to discovery/bootstrap against the (fresh) V5 instance.
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
  memory:    { root: string; sessions: string; threads: string };
  knowledge: { root: string; master: string; domains: string };
  insights:  { root: string; logs: string };
  templates: { root: string; master: string; llm: string; memory: string; knowledge: string; insights: string; byKind: Record<string, string> };
  policy: LifecyclePolicy;
}

export const EMPTY_BRAINLLM: BrainLLMConfig = {
  version: 5,
  root: "",
  master:    { root: "", biography: "", goals: "", preferences: "" },
  llm:       { root: "", responsibilities: "", protocols: "", diary: "" },
  memory:    { root: "", sessions: "", threads: "" },
  knowledge: { root: "", master: "", domains: "" },
  insights:  { root: "", logs: "" },
  templates: { root: "", master: "", llm: "", memory: "", knowledge: "", insights: "", byKind: {} },
  policy:    { ...DEFAULT_POLICY },
};

// ── File path ─────────────────────────────────────────────────────────────────

export function configFilePath(): string {
  // Always co-located with the running bundle — no env override.
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
          config.memory = { root: id, sessions: g("Sessions"), threads: g("Threads") };
          break;
        case "Knowledge":
          config.knowledge = { root: id, master: g("Master"), domains: g("Domains") };
          break;
        case "Insights":
          config.insights = { root: id, logs: g("Logs") };
          break;
        case "Templates":
          config.templates = {
            root: id,
            master: g("Master"),
            llm: g("LLM"),
            memory: g("Memory"),
            knowledge: g("Knowledge"),
            insights: g("Insights"),
            byKind: {},
          };
          break;
      }
    }
  } catch {
    return null;
  }

  // Discover blueprint ids (Templates → area book → blueprint note).
  if (config.templates.root) {
    const bps = await trilium
      .searchNotes("#noteType=blueprint", { ancestorNoteId: config.templates.root, fastSearch: true, limit: 100 })
      .catch(() => null);
    for (const n of bps?.results ?? []) {
      // Guard: noteType=blueprint must be an OWNED attribute (not inherited via ~template).
      // fastSearch can bypass ancestorNoteId, returning content notes that inherited
      // the blueprint's labels — skip those so they don't end up in structuralIds().
      const isOwnBlueprint = n.attributes.some(
        (a) => a.type === "label" && a.name === "noteType" && a.value === "blueprint" && a.noteId === n.noteId
      );
      if (!isOwnBlueprint) continue;
      const kind = n.attributes.find(
        (a) => a.type === "label" && a.name === "blueprint" && a.noteId === n.noteId
      )?.value;
      if (kind) config.templates.byKind[kind] = n.noteId;
    }
  }

  // Validate that required structural IDs are populated.
  const requiredIds = [
    config.master.root, config.llm.root, config.memory.root,
    config.knowledge.root, config.insights.root, config.templates.root,
  ];
  if (requiredIds.some((id) => !id)) return null;

  return config;
}
