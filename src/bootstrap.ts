// ─────────────────────────────────────────────────────────────────────────────
// BrainLLM — structure builder (V8)
// Shared by the bootstrap tool and the init.ts CLI.
//
// Builds the six-area tree on a fresh instance. Collection containers are real
// Trilium `book` notes; the singleton maintained notes (biography, goals, …)
// are `text` notes — structured singletons are also seeded with their enforced
// section skeleton. Each note is engraved with its purpose at creation, and the
// authored blueprints are created under their Templates area book. The root
// carries #brainLlmRoot so auto-discovery can find the tree by marker, not title.
// ─────────────────────────────────────────────────────────────────────────────

import { TriliumClient } from "./trilium.js";
import type { BrainLLMConfig } from "./config.js";
import { DEFAULT_POLICY, type AnyKind } from "./types.js";
import { purposeContent, contentFor, STRUCTURED_SINGLETONS } from "./templates.js";

export async function createBrainLLMStructure(trilium: TriliumClient): Promise<BrainLLMConfig> {
  const d = new Date().toISOString().slice(0, 10);

  // ── Root ───────────────────────────────────────────────────────────────────
  const root = await trilium.createNote(
    "root",
    "BrainLLM",
    purposeContent("The interconnected second brain — five areas: Master, LLM, Memory, Knowledge, and Insights."),
    "book"
  );
  const rootId = root.note.noteId;
  await Promise.all([
    trilium.addLabel(rootId, "brainLlmRoot", ""),
    trilium.addLabel(rootId, "iconClass", "bx bx-brain"),
  ]);

  // ── Helpers ─────────────────────────────────────────────────────────────────
  // book → a collection container (renders its children); leaf → a single
  // maintained note carrying its #noteType. Structured singletons are seeded
  // with their enforced section skeleton beneath the purpose.
  const book = async (parent: string, title: string, purpose: string, icon?: string): Promise<string> => {
    const n = await trilium.createNote(parent, title, purposeContent(purpose), "book");
    if (icon) await trilium.addLabel(n.note.noteId, "iconClass", icon);
    return n.note.noteId;
  };
  const leaf = async (parent: string, title: string, kind: string, purpose: string): Promise<string> => {
    const skeleton = STRUCTURED_SINGLETONS.has(kind as AnyKind) ? "\n" + contentFor(kind as AnyKind, { date: d, body: "" }) : "";
    const n = await trilium.createNote(parent, title, purposeContent(purpose) + skeleton, "text");
    await trilium.addLabel(n.note.noteId, "noteType", kind);
    return n.note.noteId;
  };

  // ── Master ──────────────────────────────────────────────────────────────────
  const masterRoot = await book(rootId, "Master", "The master/user. Houses the fundamental, durable information about who they are — biography, goals, and preferences.", "bx bx-user");
  const [biography, goals, preferences] = await Promise.all([
    leaf(masterRoot, "Biography", "biography", "A single maintained note of biographical information about the master/user."),
    leaf(masterRoot, "Goals", "goals", "A single maintained note of the master/user's goals."),
    leaf(masterRoot, "Preferences", "preferences", "A single maintained note of the master/user's preferences."),
  ]);

  // ── LLM ─────────────────────────────────────────────────────────────────────
  const llmRoot = await book(rootId, "LLM", "The assistant. Houses the assistant's fundamental self-model — its responsibilities, operating protocols, and diary.", "bx bx-bot");
  const [responsibilities, protocols, diary] = await Promise.all([
    leaf(llmRoot, "Responsibilities", "responsibilities", "A single maintained note of the assistant's responsibilities to the master/user, derived from their goals and preferences."),
    leaf(llmRoot, "Protocols", "protocols", "A single maintained note of the assistant's operating and self-correctness protocols — how it maximises its value to the master/user by efficiently meeting its responsibilities."),
    book(llmRoot, "Diary", "A collection of daily maintained diary notes — the assistant's unfiltered first-person record of its experience, opinions, and remarks on its own existence during each session in the environment, plus its remarks and opinions on BrainLLM itself.", "bx bx-book-heart"),
  ]);

  // ── Memory ──────────────────────────────────────────────────────────────────
  const memoryRoot = await book(rootId, "Memory", "The primary memory system the brain operates on — the running record of daily sessions and multi-session threads.", "bx bx-been-here");
  const [sessions, threads] = await Promise.all([
    book(memoryRoot, "Sessions", "A collection of daily, day-lifecycle session notes, each summarising that day's session.", "bx bx-calendar"),
    book(memoryRoot, "Threads", "A collection of maintained thread notes, each tracking a line of multi-session running work.", "bx bx-git-branch"),
  ]);

  // ── Knowledge ───────────────────────────────────────────────────────────────
  const knowledgeRoot = await book(rootId, "Knowledge", "The secondary memory system — learned knowledge that adds to or conflicts with the assistant's training data, about the master/user and across domains.", "bx bx-library");
  const [knowledgeMaster, domains] = await Promise.all([
    book(knowledgeRoot, "Master", "A secondary collection of maintained notes about the master/user that don't fit the primary Master area (Biography / Goals / Preferences).", "bx bx-user-circle"),
    book(knowledgeRoot, "Domains", "A collection of domain-scoped books. Each domain holds one maintained Sources note plus the sub-category information notes capturing important learned knowledge — beyond or conflicting with training data — about that domain.", "bx bx-category"),
  ]);

  // ── Insights ────────────────────────────────────────────────────────────────
  const insightsRoot = await book(rootId, "Insights", "The insights system — the brain's record of itself, starting with per-day logs of how its own content changed.", "bx bx-bulb");
  const logs = await book(insightsRoot, "Logs", "A collection of per-day, auto-generated notes recording the brain content (notes) created, updated, or deleted that day.", "bx bx-history");

  return {
    version: 5,
    root: rootId,
    master:    { root: masterRoot, biography, goals, preferences },
    llm:       { root: llmRoot, responsibilities, protocols, diary },
    memory:    { root: memoryRoot, sessions, threads, metaThread: "" },
    knowledge: { root: knowledgeRoot, master: knowledgeMaster, domains },
    insights:  { root: insightsRoot, logs },
    policy: { ...DEFAULT_POLICY },
  };
}
