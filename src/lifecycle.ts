// ─────────────────────────────────────────────────────────────────────────────
// BrainLLM — lifecycle engine (V5)
//
// Provides: structural-note protection (containers vs. editable singletons),
// the resolution content surgery for closing threads, the maintenance sweep
// (lite: age threads active → dormant → archived-in-place; deep: stale-review
// per the core-invaluability rule + the orphan report for unconnected
// knowledge), and the start orientation digest.
// ─────────────────────────────────────────────────────────────────────────────

import { type TriliumClient, type Note, ownedLabel } from "./trilium.js";
import type { BrainLLMConfig } from "./config.js";
import { toText } from "./normalize.js";
import { RESOLUTION_ANCHOR } from "./templates.js";
import { localToday } from "./time.js";

// ── Structural protection ──────────────────────────────────────────────────────

/** Every container and singleton the brain owns — never relabelled, retitled,
 *  edited or forgotten by the tools. */
export function structuralIds(cfg: BrainLLMConfig): string[] {
  return [
    cfg.root,
    cfg.master.root, cfg.master.biography, cfg.master.goals, cfg.master.preferences,
    cfg.llm.root, cfg.llm.responsibilities, cfg.llm.protocols, cfg.llm.diary,
    cfg.memory.root, cfg.memory.sessions, cfg.memory.threads,
    cfg.knowledge.root, cfg.knowledge.master, cfg.knowledge.domains,
    cfg.insights.root, cfg.insights.logs,
    cfg.templates.root, cfg.templates.master, cfg.templates.llm,
    cfg.templates.memory, cfg.templates.knowledge, cfg.templates.insights,
    ...Object.values(cfg.templates.byKind),
  ].filter(Boolean);
}

export function isStructural(cfg: BrainLLMConfig, noteId: string): boolean {
  return structuralIds(cfg).includes(noteId);
}

/** Containers and blueprints — locked against content edits. The maintained
 *  singletons (biography/goals/preferences/responsibilities/protocols) are
 *  structural but editable in place, so they're excluded here (revise allows
 *  them; forget still refuses them via isStructural). */
export function isContainer(cfg: BrainLLMConfig, noteId: string): boolean {
  const singletons = [
    cfg.master.biography, cfg.master.goals, cfg.master.preferences,
    cfg.llm.responsibilities, cfg.llm.protocols,
  ];
  return isStructural(cfg, noteId) && !singletons.includes(noteId);
}

// ── Resolution content surgery (pure) ──────────────────────────────────────────

/** Write an outcome into a note body. Replaces everything from the Resolution
 *  anchor down; appends the section if absent. */
export function applyResolution(html: string, outcome: string, date: string): string {
  const section = `${RESOLUTION_ANCHOR}\n${outcome}\n<p><em>Closed ${date}</em></p>`;
  const idx = html.indexOf(RESOLUTION_ANCHOR);
  if (idx >= 0) return html.slice(0, idx) + section;
  return `${html}\n${section}`;
}

// ── Maintenance sweep (deferred) ────────────────────────────────────────────────

export interface SweepReport {
  scanned: number;
  fixed: string[];
  transitions: string[];
  deleted: string[];
  flagged: string[];
  dryRun: boolean;
}

function isoDaysAgo(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
}

/** The V5 maintenance sweep. Lite (auto, inside start/close): age stale threads.
 *  Deep: also surface stale notes (the core-invaluability rule) and unconnected
 *  knowledge to wire with connect(). Degrades, never deletes. */
export async function sweep(
  trilium: TriliumClient,
  cfg: BrainLLMConfig,
  opts: { deep?: boolean; dryRun?: boolean } = {}
): Promise<SweepReport> {
  const { deep = false, dryRun = false } = opts;
  const report: SweepReport = { scanned: 0, fixed: [], transitions: [], deleted: [], flagged: [], dryRun };
  if (!cfg.root) return report;

  const policy = cfg.policy;
  const today = localToday();
  const dormantCutoff = isoDaysAgo(policy.dormantAfterDays);
  const archiveCutoff = isoDaysAgo(policy.archiveDormantAfterDays);

  // ── Aging: threads active → dormant → archived ──────────────────────────────
  const toDormant = await trilium
    .searchNotes(`#noteType=thread #status=active note.dateModified < '${dormantCutoff}'`, { ancestorNoteId: cfg.memory.threads, limit: 50 })
    .catch(() => ({ results: [] as Note[] }));
  for (const n of toDormant.results) {
    report.scanned++;
    if (!dryRun) await trilium.updateLabelValue(n.noteId, "status", "dormant");
    report.transitions.push(`dormant: ${n.title} (thread, idle ${idleDays(n.dateModified)}d)`);
  }
  const toArchive = await trilium
    .searchNotes(`#noteType=thread #status=dormant note.dateModified < '${archiveCutoff}'`, { ancestorNoteId: cfg.memory.threads, limit: 50 })
    .catch(() => ({ results: [] as Note[] }));
  for (const n of toArchive.results) {
    report.scanned++;
    if (!dryRun) {
      await trilium.updateLabelValue(n.noteId, "closed", today);
      await trilium.addLabel(n.noteId, "archived", "");
    }
    report.transitions.push(`archived: ${n.title} (thread, dormant past grace)`);
  }

  if (!deep) return report;

  // ── Deep: stale-review (nothing useful left untouched) ──────────────────────
  const staleCutoff = isoDaysAgo(policy.staleAfterDays);
  const RECORDS = new Set(["log", "session", "diary", "blueprint"]);
  const stale = await trilium
    .searchNotes(`#noteType note.dateModified < '${staleCutoff}'`, { ancestorNoteId: cfg.root, fastSearch: true, limit: 200 })
    .catch(() => ({ results: [] as Note[] }));
  for (const n of stale.results) {
    const kind = ownedLabel(n, "noteType");
    if (!kind || RECORDS.has(kind) || isStructural(cfg, n.noteId)) continue;
    if (report.flagged.length < 15) report.flagged.push(`stale ${idleDays(n.dateModified)}d: ${n.title} [${n.noteId}]`);
  }

  // ── Deep: orphan report — knowledge with no relation either way ─────────────
  const kNotes = await trilium
    .searchNotes("#noteType", { ancestorNoteId: cfg.knowledge.root, fastSearch: true, limit: 200 })
    .catch(() => ({ results: [] as Note[] }));
  const targets = new Set<string>();
  for (const n of kNotes.results) {
    for (const a of n.attributes) if (a.type === "relation" && a.name !== "template") targets.add(a.value);
  }
  let orphans = 0;
  for (const n of kNotes.results) {
    const kind = ownedLabel(n, "noteType");
    if (!kind || kind === "domain" || kind === "sources") continue;
    const hasOut = n.attributes.some((a) => a.type === "relation" && a.name !== "template");
    if (!hasOut && !targets.has(n.noteId) && orphans < 10) {
      orphans++;
      report.flagged.push(`unconnected: ${n.title} [${n.noteId}] — connect() it`);
    }
  }

  return report;
}

// ── Session digest ──────────────────────────────────────────────────────────────

export interface SessionDigest {
  master: Array<{ slot: string; summary: string }>;
  llm: Array<{ slot: string; summary: string }>;
  workingSet: Array<{ id: string; title: string; kind: string; status: string; idleDays: number }>;
  reviewQueue: Array<{ id: string; title: string; kind: string; idleDays: number }>;
  lastSession?: { id: string; title: string; date: string; summary: string };
  counts: Record<string, number>;
}

function idleDays(dateModified: string): number {
  const ms = Date.now() - new Date(dateModified.replace(" ", "T")).getTime();
  return Math.max(0, Math.floor(ms / 86_400_000));
}

const label = (n: Note, name: string) =>
  n.attributes.find((a) => a.type === "label" && a.name === name)?.value;

/** Orientation payload for start: the Master singletons (the user), the LLM
 *  singletons (the assistant's own self-model), live threads, and the last
 *  session summary. */
export async function buildDigest(trilium: TriliumClient, cfg: BrainLLMConfig): Promise<SessionDigest> {
  const digest: SessionDigest = { master: [], llm: [], workingSet: [], reviewQueue: [], counts: {} };

  // Master singletons — goals in full; biography and preferences as short previews.
  const slots: Array<[string, string]> = [
    ["biography", cfg.master.biography],
    ["goals", cfg.master.goals],
    ["preferences", cfg.master.preferences],
  ];
  for (const [slot, id] of slots) {
    if (!id) continue;
    const content = await trilium.getNoteContent(id).catch(() => "");
    const summary = toText(content, slot === "biography" ? 200 : Infinity);
    if (summary) digest.master.push({ slot, summary });
  }

  // LLM singletons — protocols in full; responsibilities as a short preview.
  const llmSlots: Array<[string, string]> = [
    ["responsibilities", cfg.llm.responsibilities],
    ["protocols", cfg.llm.protocols],
  ];
  for (const [slot, id] of llmSlots) {
    if (!id) continue;
    const content = await trilium.getNoteContent(id).catch(() => "");
    const summary = toText(content, slot === "protocols" ? Infinity : 500);
    if (summary) digest.llm.push({ slot, summary });
  }

  // Working set — live threads in Memory/threads.
  const live = await trilium.searchNotes("#noteType=thread", {
    ancestorNoteId: cfg.memory.threads,
    fastSearch: true,
    limit: 30,
  }).catch(() => ({ results: [] as Note[] }));
  for (const n of live.results) {
    const status = label(n, "status") ?? "active";
    const idle = idleDays(n.dateModified);
    if (status === "dormant") {
      digest.reviewQueue.push({ id: n.noteId, title: n.title, kind: "thread", idleDays: idle });
    } else {
      digest.workingSet.push({ id: n.noteId, title: n.title, kind: "thread", status, idleDays: idle });
    }
    digest.counts["thread"] = (digest.counts["thread"] ?? 0) + 1;
  }
  digest.workingSet.sort((a, b) => a.idleDays - b.idleDays);
  digest.reviewQueue.sort((a, b) => b.idleDays - a.idleDays);

  // Last session.
  const sessions = await trilium.searchNotes("#noteType=session", {
    ancestorNoteId: cfg.memory.sessions,
    fastSearch: true,
    limit: 5,
    orderBy: "dateCreated",
    orderDirection: "desc",
  }).catch(() => ({ results: [] as Note[] }));
  const last = sessions.results[0];
  if (last) {
    const content = await trilium.getNoteContent(last.noteId).catch(() => "");
    digest.lastSession = {
      id: last.noteId,
      title: last.title,
      date: label(last, "created") ?? last.dateCreated.slice(0, 10),
      summary: toText(content, 300),
    };
  }

  return digest;
}
