// ─────────────────────────────────────────────────────────────────────────────
// BrainLLM — lifecycle engine (V6)
//
// Provides: structural-note protection (containers vs. editable singletons),
// the resolution content surgery for closing threads, the maintenance sweep
// (lite: age threads active → dormant → archived-in-place; deep: stale-review
// per the core-invaluability rule + the orphan report for unconnected
// knowledge), and the start orientation digest.
// ─────────────────────────────────────────────────────────────────────────────

import { type TriliumClient, type Note, ownedLabel, relationSnippet, type RelationEdge } from "./trilium.js";
import type { BrainLLMConfig } from "./config.js";
import { toText, closeDangling } from "./normalize.js";
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
    cfg.memory.root, cfg.memory.sessions, cfg.memory.threads, cfg.memory.metaThread,
    cfg.knowledge.root, cfg.knowledge.master, cfg.knowledge.domains,
    cfg.insights.root, cfg.insights.logs,
  ].filter(Boolean);
}

export function isStructural(cfg: BrainLLMConfig, noteId: string): boolean {
  return structuralIds(cfg).includes(noteId);
}

/** Containers — locked against content edits. The maintained singletons
 *  (biography/goals/preferences/responsibilities/protocols) and the BrainLLM
 *  meta-thread are structural but editable in place, so they're excluded here
 *  (revise allows them; forget/resolve/reopen still refuse them via isStructural). */
export function isContainer(cfg: BrainLLMConfig, noteId: string): boolean {
  const singletons = [
    cfg.master.biography, cfg.master.goals, cfg.master.preferences,
    cfg.llm.responsibilities, cfg.llm.protocols,
    cfg.memory.metaThread,
  ];
  return isStructural(cfg, noteId) && !singletons.includes(noteId);
}

// ── Resolution content surgery (pure) ──────────────────────────────────────────

/** Write an outcome into a note body. Replaces everything from the Resolution
 *  anchor down; appends the section if absent. Closes dangling open tags in
 *  `html` before surgery so the slice never cuts inside an unclosed element. */
export function applyResolution(html: string, outcome: string, date: string): string {
  const safe = closeDangling(html);
  const section = `${RESOLUTION_ANCHOR}\n${outcome}\n<p><em>Closed ${date}</em></p>`;
  const idx = safe.indexOf(RESOLUTION_ANCHOR);
  if (idx >= 0) return safe.slice(0, idx) + section;
  return `${safe}\n${section}`;
}

// ── Maintenance sweep (deferred) ────────────────────────────────────────────────

export interface SweepReport {
  scanned: number;
  fixed: string[];
  transitions: string[];
  deleted: string[];
  flagged: string[];
  dryRun: boolean;
  policy: { dormantAfterDays: number; archiveDormantAfterDays: number; staleAfterDays: number };
}

function isoDaysAgo(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
}

/** The V6 maintenance sweep.
 *  Lite (auto, inside start/close): age stale threads + unlabeled-node check.
 *  Deep: stale-review, orphan/sink report, duplicate-title detection. */
export async function sweep(
  trilium: TriliumClient,
  cfg: BrainLLMConfig,
  opts: { deep?: boolean; dryRun?: boolean } = {}
): Promise<SweepReport> {
  const { deep = false, dryRun = false } = opts;
  const policy = cfg.policy;
  const report: SweepReport = {
    scanned: 0, fixed: [], transitions: [], deleted: [], flagged: [], dryRun,
    policy: {
      dormantAfterDays: policy.dormantAfterDays,
      archiveDormantAfterDays: policy.archiveDormantAfterDays,
      staleAfterDays: policy.staleAfterDays,
    },
  };
  if (!cfg.root) return report;

  const today = localToday();
  const dormantCutoff = isoDaysAgo(policy.dormantAfterDays);
  const archiveCutoff = isoDaysAgo(policy.archiveDormantAfterDays);

  // ── Aging: threads active → dormant → archived ──────────────────────────────
  const toDormant = await trilium
    .searchNotes(`#noteType=thread #status=active note.dateModified < '${dormantCutoff}'`, { ancestorNoteId: cfg.memory.threads, limit: 50 })
    .catch(() => ({ results: [] as Note[] }));
  report.scanned += toDormant.results.length;
  for (const n of toDormant.results) {
    if (!dryRun) await trilium.updateLabelValue(n.noteId, "status", "dormant");
    report.transitions.push(`dormant: ${n.title} (thread, idle ${idleDays(n.dateModified)}d)`);
  }

  const toArchive = await trilium
    .searchNotes(`#noteType=thread #status=dormant note.dateModified < '${archiveCutoff}'`, { ancestorNoteId: cfg.memory.threads, limit: 50 })
    .catch(() => ({ results: [] as Note[] }));
  report.scanned += toArchive.results.length;
  for (const n of toArchive.results) {
    if (!dryRun) {
      await trilium.updateLabelValue(n.noteId, "closed", today);
      await trilium.addLabel(n.noteId, "archived", "");
    }
    report.transitions.push(`archived: ${n.title} (thread, dormant past grace)`);
  }

  // ── Unlabeled-node sweep ────────────────────────────────────────────────────
  // Fetch each typed container's direct children; diff against a typed search
  // to find children that escaped labelling (via create_note bypass or past bugs).
  const typedContainers: Array<{ id: string; kind: string; label: string }> = [
    { id: cfg.memory.threads,  kind: "thread",  label: "Threads"  },
    { id: cfg.memory.sessions, kind: "session", label: "Sessions" },
    { id: cfg.llm.diary,       kind: "diary",   label: "Diary"    },
    { id: cfg.insights.logs,   kind: "log",     label: "Logs"     },
  ];
  for (const { id, kind, label } of typedContainers) {
    if (!id) continue;
    try {
      const container = await trilium.getNote(id);
      const childIds = container.childNoteIds;
      if (!childIds.length) continue;
      report.scanned += childIds.length;

      const typed = await trilium
        .searchNotes(`#noteType=${kind}`, { ancestorNoteId: id, fastSearch: true, limit: childIds.length + 10 })
        .catch(() => ({ results: [] as Note[] }));
      const typedIds = new Set(typed.results.map((n) => n.noteId));

      for (const childId of childIds) {
        if (typedIds.has(childId) || isStructural(cfg, childId)) continue;
        const child = await trilium.getNote(childId).catch(() => null);
        if (child && !child.attributes.some((a) => a.type === "label" && a.name === "archived")) {
          report.flagged.push(`unlabeled: ${child.title} [${childId}] in ${label} — add #noteType=${kind}`);
        }
      }
    } catch { /* non-fatal */ }
  }

  if (!deep) return report;

  // ── Deep: stale-review ──────────────────────────────────────────────────────
  const staleCutoff = isoDaysAgo(policy.staleAfterDays);
  const RECORDS = new Set(["log", "session", "diary"]);
  const stale = await trilium
    .searchNotes(`#noteType note.dateModified < '${staleCutoff}'`, { ancestorNoteId: cfg.root, fastSearch: true, limit: 200 })
    .catch(() => ({ results: [] as Note[] }));
  report.scanned += stale.results.length;
  for (const n of stale.results) {
    const kind = ownedLabel(n, "noteType");
    if (!kind || RECORDS.has(kind) || isStructural(cfg, n.noteId)) continue;
    if (report.flagged.length < 15) report.flagged.push(`stale ${idleDays(n.dateModified)}d: ${n.title} [${n.noteId}]`);
  }

  // ── Deep: orphan + sink report ──────────────────────────────────────────────
  // orphan = no outbound AND not pointed to by anything (truly isolated).
  // sink   = no outbound BUT has inbound (consumed but never connected forward).
  //
  // Inbound detection ("targets") is brain-wide, so a candidate referenced
  // from outside its own area (e.g. a thread an LLM singleton points at)
  // isn't misclassified as an orphan just because the pointer lives
  // elsewhere — an inbound-only note is a sink, never an orphan, regardless
  // of which area the inbound edge originates in.
  //
  // The candidates actually flagged are scoped to Memory/Threads and
  // Knowledge (master + domains-and-below) — the two areas holding
  // connectable, non-structural, non-record content. Master and the LLM
  // singletons are maintained/structural (excluded via isStructural, which
  // also protects the BrainLLM meta-thread); sessions, diary, and logs are
  // records, not graph nodes to connect.
  const [allNotes, threadNotes, knowledgeNotes] = await Promise.all([
    trilium.searchNotes("#noteType", { ancestorNoteId: cfg.root, fastSearch: true, limit: 500 }).catch(() => ({ results: [] as Note[] })),
    cfg.memory.threads
      ? trilium.searchNotes("#noteType", { ancestorNoteId: cfg.memory.threads, fastSearch: true, limit: 200 }).catch(() => ({ results: [] as Note[] }))
      : Promise.resolve({ results: [] as Note[] }),
    cfg.knowledge.root
      ? trilium.searchNotes("#noteType", { ancestorNoteId: cfg.knowledge.root, fastSearch: true, limit: 200 }).catch(() => ({ results: [] as Note[] }))
      : Promise.resolve({ results: [] as Note[] }),
  ]);
  report.scanned += allNotes.results.length;

  const targets = new Set<string>();
  for (const n of allNotes.results) {
    for (const a of n.attributes) if (a.type === "relation" && a.name !== "template") targets.add(a.value);
  }

  const seenCandidates = new Set<string>();
  const candidates = [...threadNotes.results, ...knowledgeNotes.results].filter((n) => {
    if (seenCandidates.has(n.noteId)) return false;
    seenCandidates.add(n.noteId);
    return true;
  });

  let orphans = 0;
  let sinks = 0;
  for (const n of candidates) {
    const kind = ownedLabel(n, "noteType");
    if (!kind || kind === "domain" || kind === "sources" || isStructural(cfg, n.noteId)) continue;
    const hasOut = n.attributes.some((a) => a.type === "relation" && a.name !== "template");
    const hasIn = targets.has(n.noteId);
    if (!hasOut && !hasIn && orphans < 10) {
      orphans++;
      report.flagged.push(`unconnected: ${n.title} [${n.noteId}] (${kind}) — connect() it`);
    } else if (!hasOut && hasIn && sinks < 5) {
      sinks++;
      report.flagged.push(`sink: ${n.title} [${n.noteId}] (${kind}) — has inbound relations but no outbound`);
    }
  }

  // ── Deep: duplicate-title detection ────────────────────────────────────────
  // Flat containers: group by normalised title, flag any group > 1.
  // Includes archived notes to catch leftovers from past dedup failures.
  const dupeContainers: Array<{ id: string; kind: string; label: string }> = [
    { id: cfg.memory.sessions,  kind: "session",   label: "Sessions"         },
    { id: cfg.llm.diary,        kind: "diary",     label: "Diary"            },
    { id: cfg.insights.logs,    kind: "log",       label: "Logs"             },
    { id: cfg.memory.threads,   kind: "thread",    label: "Threads"          },
    { id: cfg.knowledge.master,  kind: "knowledge", label: "Knowledge/Master"  },
    { id: cfg.knowledge.domains, kind: "domain",    label: "Knowledge/Domains" },
  ];
  for (const { id, kind, label: containerLabel } of dupeContainers) {
    if (!id) continue;
    const all = await trilium
      .searchNotes(`#noteType=${kind}`, { ancestorNoteId: id, fastSearch: true, limit: 500, includeArchivedNotes: true })
      .catch(() => ({ results: [] as Note[] }));
    report.scanned += all.results.length;
    const byTitle = new Map<string, Note[]>();
    for (const n of all.results) {
      const key = n.title.toLowerCase().trim();
      if (!byTitle.has(key)) byTitle.set(key, []);
      byTitle.get(key)!.push(n);
    }
    for (const [, group] of byTitle) {
      if (group.length > 1) {
        const ids = group.map((n) => n.noteId).join(", ");
        report.flagged.push(`duplicate: '${group[0].title}' ×${group.length} [${ids}] in ${containerLabel} — forget() the extras`);
      }
    }
  }

  // Domain-scoped kinds: information and sources are per-domain, so group by
  // (#domain-slug, title) — same title in different domains is intentional.
  if (cfg.knowledge.domains) {
    for (const domainKind of ["information", "sources"] as const) {
      const all = await trilium
        .searchNotes(`#noteType=${domainKind}`, { ancestorNoteId: cfg.knowledge.domains, fastSearch: true, limit: 500, includeArchivedNotes: true })
        .catch(() => ({ results: [] as Note[] }));
      report.scanned += all.results.length;
      const byDomainTitle = new Map<string, Note[]>();
      for (const n of all.results) {
        const domSlug = n.attributes.find((a) => a.type === "label" && a.name === "domain")?.value ?? "_unknown";
        const key = `${domSlug}::${n.title.toLowerCase().trim()}`;
        if (!byDomainTitle.has(key)) byDomainTitle.set(key, []);
        byDomainTitle.get(key)!.push(n);
      }
      for (const [key, group] of byDomainTitle) {
        if (group.length > 1) {
          const domSlug = key.split("::")[0];
          const ids = group.map((n) => n.noteId).join(", ");
          report.flagged.push(`duplicate: '${group[0].title}' ×${group.length} [${ids}] in Domain/${domSlug} (${domainKind}) — forget() the extras`);
        }
      }
    }
  }

  return report;
}

// ── Session digest ──────────────────────────────────────────────────────────────

export interface SessionDigest {
  master: Array<{ slot: string; summary: string }>;
  llm: Array<{ slot: string; summary: string }>;
  workingSet: Array<{ id: string; title: string; kind: string; status: string; idleDays: number; relations?: RelationEdge[] }>;
  reviewQueue: Array<{ id: string; title: string; kind: string; idleDays: number; relations?: RelationEdge[] }>;
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

  // Master singletons — all in full.
  const slots: Array<[string, string]> = [
    ["biography", cfg.master.biography],
    ["goals", cfg.master.goals],
    ["preferences", cfg.master.preferences],
  ];
  for (const [slot, id] of slots) {
    if (!id) continue;
    const content = await trilium.getNoteContent(id).catch(() => "");
    const summary = toText(content, Infinity);
    if (summary) digest.master.push({ slot, summary });
  }

  // LLM singletons — both in full. Diary is added inline by start().
  const llmSlots: Array<[string, string]> = [
    ["responsibilities", cfg.llm.responsibilities],
    ["protocols", cfg.llm.protocols],
  ];
  for (const [slot, id] of llmSlots) {
    if (!id) continue;
    const content = await trilium.getNoteContent(id).catch(() => "");
    const summary = toText(content, Infinity);
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
    const relations = relationSnippet(n);
    if (status === "dormant") {
      digest.reviewQueue.push({ id: n.noteId, title: n.title, kind: "thread", idleDays: idle, ...(relations ? { relations } : {}) });
    } else {
      digest.workingSet.push({ id: n.noteId, title: n.title, kind: "thread", status, idleDays: idle, ...(relations ? { relations } : {}) });
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
