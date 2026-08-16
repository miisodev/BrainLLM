// ─────────────────────────────────────────────────────────────────────────────
// BrainLLM — lifecycle engine (V10)
//
// Provides: structural-note protection (containers vs. editable singletons),
// the resolution content surgery for closing threads, the maintenance sweep
// (lite: age threads active → dormant → archived-in-place; deep: stale-review
// per the core-invaluability rule + the orphan report for unconnected
// knowledge), and the start orientation digest.
// ─────────────────────────────────────────────────────────────────────────────

import { type TriliumClient, type Note, ownedLabel, relationSnippet, type RelationEdge } from "./trilium.js";
import type { BrainLLMConfig } from "./config.js";
import type { AnyKind } from "./types.js";
import { toText, closeDangling, slugify, structureReport, hasPlaceholderRow, headingOutline, sectionProfile, escapeQueryRegex, repairDoubleEscaping, LARGE_NOTE_CHARS } from "./normalize.js";
import { RESOLUTION_ANCHOR, missingSections } from "./templates.js";
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
  ].filter(Boolean);
}

export function isStructural(cfg: BrainLLMConfig, noteId: string): boolean {
  return structuralIds(cfg).includes(noteId);
}

/** Containers — locked against content edits. The maintained singletons
 *  (biography/goals/preferences/responsibilities/protocols) are structural but
 *  editable in place, so they're excluded here (revise allows them;
 *  forget/resolve/withdraw still refuse them via isStructural). */
export function isContainer(cfg: BrainLLMConfig, noteId: string): boolean {
  const singletons = [
    cfg.master.biography, cfg.master.goals, cfg.master.preferences,
    cfg.llm.responsibilities, cfg.llm.protocols,
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
  /** Notes marked reviewed-and-correct this call. */
  acknowledged?: string[];
  /** Findings withheld because the note carries a current acknowledgement. */
  suppressed?: number;
  /** Set when the sweep was narrowed to one domain. */
  scope?: string;
  /** Passes that hit a cap — what was NOT looked at, stated rather than implied
   *  by a short list. */
  coverage?: string[];
  /** What to do with a flag that belongs to another lane — present on an
   *  unscoped deep run that produced findings. */
  laneHint?: string;
  dryRun: boolean;
  policy: { dormantAfterDays: number; archiveDormantAfterDays: number; staleAfterDays: number };
}

function isoDaysAgo(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
}

/** The acknowledgement key for a note: its content blob, which changes when and
 *  only when the body does. Deliberately NOT dateModified — writing the
 *  acknowledgement label would bump that and instantly invalidate itself. */
function reviewKey(n: Note): string {
  return n.blobId ?? n.dateModified;
}

/** How many notes deep's structural lint will read in full. Bounded because it
 *  costs one content fetch each; the cap is reported when reached rather than
 *  silently truncating the findings. */
const STRUCTURE_LINT_LIMIT = 40;

/** Past this many sections, choosing the right heading is the failure mode —
 *  outline() stops being optional. */
const SECTION_EDIT_RISK_COUNT = 25;

/** Past this, one section= replace destroys more than a caller pictures. */
const SECTION_EDIT_RISK_CHARS = 8000;

/** Singletons served in full even at digest depth — the two a session must have
 *  whole to orient from its first message. See readSlot() for the reasoning. */
const ALWAYS_FULL_SLOTS = new Set(["preferences", "protocols"]);

/** The V10 maintenance sweep.
 *  Lite (auto, inside start/close): age stale threads + unlabeled-node check.
 *  Deep: stale-review, orphan/sink report, structural lint, duplicate-title
 *  detection.
 *
 *  Findings can be acknowledged. A warning that reappears every run and is
 *  correctly ignored every run trains the reader to skim it, and a skimmed list
 *  is where a real finding gets lost — the same reason a linter carries a
 *  baseline file. ack=[noteId] records that the note's CURRENT content was
 *  reviewed and its findings accepted; the note is then quiet until its body
 *  actually changes, at which point every finding returns. */
export async function sweep(
  trilium: TriliumClient,
  cfg: BrainLLMConfig,
  opts: { deep?: boolean; dryRun?: boolean; domain?: string; ack?: string[]; repair?: string[] } = {}
): Promise<SweepReport> {
  const { deep = false, dryRun = false, ack, repair } = opts;
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

  const domainSlug = opts.domain ? slugify(opts.domain) : undefined;
  if (domainSlug) report.scope = domainSlug;

  /** Domain scoping for the deep passes: a scoped agent's flags should arrive
   *  in its own lane, the way addendum() already restricts what it folds.
   *  Without it every scoped run re-derives for itself that the cross-venture
   *  findings are somebody else's. */
  const inScope = (n: Note): boolean =>
    !domainSlug || n.attributes.some((a) => a.type === "label" && a.name === "domain" && a.value === domainSlug);

  let suppressed = 0;
  const acknowledged = (n: Note): boolean => {
    if (ownedLabel(n, "reviewed") !== reviewKey(n)) return false;
    suppressed++;
    return true;
  };

  // ── Acknowledgement ─────────────────────────────────────────────────────────
  // Re-read after the label write: the key must be the blob as it stands once
  // the acknowledgement exists, so the very next sweep agrees with it.
  if (ack?.length) {
    report.acknowledged = [];
    for (const id of ack) {
      const before = await trilium.getNote(id).catch(() => null);
      if (!before) {
        report.acknowledged.push(`not found: ${id}`);
        continue;
      }
      if (!dryRun) await trilium.updateLabelValue(id, "reviewed", reviewKey(before)).catch(() => null);
      report.acknowledged.push(`reviewed: ${before.title} [${id}] — quiet until its content changes`);
    }
  }

  const today = localToday();
  const dormantCutoff = isoDaysAgo(policy.dormantAfterDays);
  const archiveCutoff = isoDaysAgo(policy.archiveDormantAfterDays);

  // ── Aging: threads active → dormant → archived ──────────────────────────────
  // Keyed off the "updated" label, not note.dateModified — a thread's own
  // content (Context/Resolution) rarely changes once written; day-to-day
  // activity lands on threadEntry children instead, which don't bump the
  // book's own dateModified. labelPlan() seeds "updated" at thread creation
  // so every thread has one to compare against.
  const toDormant = await trilium
    .searchNotes(`#noteType=thread #status=active #updated < '${dormantCutoff}'`, { ancestorNoteId: cfg.memory.threads, limit: 50 })
    .catch(() => ({ results: [] as Note[] }));
  report.scanned += toDormant.results.length;
  for (const n of toDormant.results) {
    if (!dryRun) await trilium.updateLabelValue(n.noteId, "status", "dormant");
    report.transitions.push(`dormant: ${n.title} (thread, idle ${idleDays(threadUpdated(n))}d)`);
  }

  const toArchive = await trilium
    .searchNotes(`#noteType=thread #status=dormant #updated < '${archiveCutoff}'`, { ancestorNoteId: cfg.memory.threads, limit: 50 })
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
  //
  // Knowledge/Master and Knowledge/Domains were NOT covered here, and that
  // omission is what let nine unlabeled strategy notes — the entire strategy
  // layer — sit invisible to every read path without a single sweep flagging
  // them. The pass that exists to catch invisible notes could not see the
  // area where invisibility costs most, because an unlabeled knowledge note
  // still renders perfectly in Trilium and only fails silently at recall time.
  const typedContainers: Array<{ id: string; kind: string; label: string }> = [
    { id: cfg.memory.threads,     kind: "thread",  label: "Threads"          },
    { id: cfg.memory.sessions,    kind: "session", label: "Sessions"         },
    { id: cfg.llm.diary,          kind: "diary",   label: "Diary"            },
    { id: cfg.insights.logs,      kind: "log",     label: "Logs"             },
    { id: cfg.knowledge.master,   kind: "user",    label: "Knowledge/Master" },
    { id: cfg.knowledge.domains,  kind: "domain",  label: "Knowledge/Domains"},
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
        if (!child || child.attributes.some((a) => a.type === "label" && a.name === "archived")) continue;

        // A `book` with children in a flat text container is the USER's own
        // organisational folder, not an untyped content note. Knowledge/Master
        // holds text notes, so a book there is a grouping the human made and
        // typing it would be wrong. Knowledge/Domains is the exception — its
        // children ARE books and genuinely want #noteType=domain — so this
        // only skips where a typed child would never be a book.
        if (kind !== "domain" && child.type === "book" && (child.childNoteIds?.length ?? 0) > 0) continue;

        report.flagged.push(`unlabeled: ${child.title} [${childId}] in ${label} — add #noteType=${kind}`);
      }
    } catch { /* non-fatal */ }
  }

  // ── Kind migration: knowledge → user ────────────────────────────────────────
  // The Knowledge/Master note kind was renamed "knowledge" → "user" in V8.
  // Relabel any legacy notes so typed searches and recall keep seeing them.
  // Self-healing and idempotent: once nothing carries the old kind, the search
  // returns empty and this pass costs one fast query.
  if (cfg.knowledge.master) {
    const legacy = await trilium
      .searchNotes("#noteType=knowledge", { ancestorNoteId: cfg.knowledge.master, fastSearch: true, limit: 100, includeArchivedNotes: true })
      .catch(() => ({ results: [] as Note[] }));
    report.scanned += legacy.results.length;
    for (const n of legacy.results) {
      if (!dryRun) await trilium.updateLabelValue(n.noteId, "noteType", "user").catch(() => null);
      report.fixed.push(`migrated: ${n.title} [${n.noteId}] #noteType knowledge → user`);
    }
  }

  if (!deep) return report;

  // ── Deep: unlabeled thread-children sweep ───────────────────────────────────
  // Same check as the lite unlabeled-node sweep above, one level deeper: each
  // thread book's OWN children (threadEntry day-notes). Threads are containers
  // now too, but they aren't in typedContainers above (that list is fixed
  // structural containers; there are N threads, not one) — so this is its own
  // pass, and deep-only since it costs roughly two queries per thread.
  if (cfg.memory.threads) {
    const threads = await trilium
      .searchNotes("#noteType=thread", { ancestorNoteId: cfg.memory.threads, fastSearch: true, limit: 200 })
      .catch(() => ({ results: [] as Note[] }));
    for (const thread of threads.results) {
      const childIds = thread.childNoteIds;
      if (!childIds.length) continue;
      report.scanned += childIds.length;
      const typedChildren = await trilium
        .searchNotes("#noteType=threadEntry", { ancestorNoteId: thread.noteId, fastSearch: true, limit: childIds.length + 10 })
        .catch(() => ({ results: [] as Note[] }));
      const typedIds = new Set(typedChildren.results.map((n) => n.noteId));
      for (const childId of childIds) {
        if (typedIds.has(childId)) continue;
        const child = await trilium.getNote(childId).catch(() => null);
        if (child && !child.attributes.some((a) => a.type === "label" && a.name === "archived")) {
          report.flagged.push(`unlabeled: ${child.title} [${childId}] in thread "${thread.title}" — add #noteType=threadEntry`);
        }
      }
    }
  }

  // ── Deep: stale-review ──────────────────────────────────────────────────────
  const staleCutoff = isoDaysAgo(policy.staleAfterDays);
  const RECORDS = new Set(["log", "session", "diary", "threadEntry"]);
  const stale = await trilium
    .searchNotes(`#noteType note.dateModified < '${staleCutoff}'`, { ancestorNoteId: cfg.root, fastSearch: true, limit: 200 })
    .catch(() => ({ results: [] as Note[] }));
  report.scanned += stale.results.length;
  let staleFlagged = 0;
  let staleTotal = 0;
  for (const n of stale.results) {
    const kind = ownedLabel(n, "noteType");
    if (!kind || RECORDS.has(kind) || isStructural(cfg, n.noteId)) continue;
    if (!inScope(n) || acknowledged(n)) continue;
    staleTotal++;
    if (staleFlagged < 15) {
      staleFlagged++;
      report.flagged.push(`stale ${idleDays(n.dateModified)}d: ${n.title} [${n.noteId}] — revise() it, resolve() it, or maintain(ack=["${n.noteId}"]) if it is correct as it stands`);
    }
  }
  if (staleTotal > staleFlagged) {
    (report.coverage ??= []).push(`stale-review: ${staleFlagged} of ${staleTotal} shown (cap 15)`);
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
  // singletons are maintained/structural (excluded via isStructural);
  // sessions, diary, and logs are records, not graph nodes to connect.
  // Connectable candidates — Memory/Threads and Knowledge, the two areas
  // holding non-structural, non-record content that belongs in the graph.
  const connectable = async (query: string, limit = 200): Promise<Note[]> => {
    const roots = [cfg.memory.threads, cfg.knowledge.root].filter(Boolean);
    const batches = await Promise.all(
      roots.map((root) =>
        trilium.searchNotes(query, { ancestorNoteId: root, fastSearch: true, limit })
          .then((r) => r.results)
          .catch(() => [] as Note[])
      )
    );
    const seen = new Set<string>();
    return batches.flat().filter((n) => !seen.has(n.noteId) && seen.add(n.noteId));
  };

  /** Candidate filter shared by every deep pass: a real content kind, in the
   *  caller's lane, not structural, not acknowledged. */
  const eligible = (n: Note, skip: (kind: string) => boolean = () => false): boolean => {
    const kind = ownedLabel(n, "noteType");
    if (!kind || skip(kind) || isStructural(cfg, n.noteId)) return false;
    return inScope(n) && !acknowledged(n);
  };

  // ── Deep: orphan + sink report ──────────────────────────────────────────────
  // orphan = no outbound AND not pointed to by anything (truly isolated).
  // sink   = no outbound BUT has inbound (consumed but never connected forward).
  //
  // Both are computed SERVER-SIDE from note properties. The previous
  // implementation fetched ~900 notes across three queries and built a
  // brain-wide inbound Set in JS purely to answer "does anything point here",
  // then capped the findings at 10 orphans / 5 sinks because the scan was
  // expensive. Trilium exposes ownedRelationCount and targetRelationCount as
  // searchable properties, so the same question is two narrow queries and the
  // caps are gone — the report is now complete rather than truncated.
  //
  // targetRelationCount is inherently brain-wide, so a note referenced from
  // another area is still never misflagged as an orphan.
  //
  // One deliberate semantic note: ownedRelationCount counts a ~template
  // relation, which the JS version excluded. BrainLLM never wires ~template
  // itself, so this only differs for a relation a human added in Trilium — and
  // it errs toward flagging less, never toward hiding a genuine orphan.
  const NON_GRAPH = (kind: string) => kind === "domain" || kind === "sources" || kind === "threadEntry";
  const [orphanHits, sinkHits] = await Promise.all([
    connectable("#noteType note.ownedRelationCount = 0 note.targetRelationCount = 0"),
    connectable("#noteType note.ownedRelationCount = 0 note.targetRelationCount > 0"),
  ]);
  report.scanned += orphanHits.length + sinkHits.length;
  for (const n of orphanHits) {
    if (!eligible(n, NON_GRAPH)) continue;
    report.flagged.push(`unconnected: ${n.title} [${n.noteId}] (${ownedLabel(n, "noteType")}) — connect() it`);
  }
  for (const n of sinkHits) {
    if (!eligible(n, NON_GRAPH)) continue;
    report.flagged.push(`sink: ${n.title} [${n.noteId}] (${ownedLabel(n, "noteType")}) — has inbound relations but no outbound`);
  }

  // ── Deep: duplicate-relation cleanup ────────────────────────────────────────
  // Exact-duplicate edges (same type/name/value on one note) carry no meaning
  // and accumulate from non-idempotent auto-wiring (the V8 close() session↔log
  // bug). Self-healing: keep the first, delete the rest. Only the note's OWN
  // attributes are considered — inherited ones belong to their source note.
  // Narrowed by property: an exact duplicate needs at least two owned relations,
  // so notes below that threshold cannot possibly carry one.
  const edgeHeavy = await trilium
    .searchNotes("#noteType note.ownedRelationCount >= 2", { ancestorNoteId: cfg.root, fastSearch: true, limit: 300 })
    .then((r) => r.results)
    .catch(() => [] as Note[]);
  report.scanned += edgeHeavy.length;
  for (const n of edgeHeavy) {
    const seenEdges = new Set<string>();
    for (const a of n.attributes) {
      if (a.type !== "relation" || a.noteId !== n.noteId) continue;
      const key = `${a.name}→${a.value}`;
      if (seenEdges.has(key)) {
        if (!dryRun) await trilium.deleteAttribute(a.attributeId).catch(() => null);
        report.fixed.push(`deduped relation: ${n.title} [${n.noteId}] ~${a.name}→${a.value}`);
      } else {
        seenEdges.add(key);
      }
    }
  }

  // ── Deep: oversized notes ───────────────────────────────────────────────────
  // Server-side by contentSize. Previously this was folded into the structural
  // lint, which meant reading up to 40 note bodies just to learn how big they
  // were — the one question the server can answer without sending any body.
  const oversized = await trilium
    .searchNotes(`#noteType note.contentSize >= ${LARGE_NOTE_CHARS}`, { ancestorNoteId: cfg.root, fastSearch: true, limit: 50 })
    .then((r) => r.results)
    .catch(() => [] as Note[]);
  report.scanned += oversized.length;
  for (const n of oversized) {
    if (!eligible(n)) continue;
    report.flagged.push(`oversized: ${n.title} [${n.noteId}] (${ownedLabel(n, "noteType")}) — past ${Math.round(LARGE_NOTE_CHARS / 1000)}k characters; read it via section=/find=/outline() rather than in full, or split it`);
  }

  // ── Deep: structural lint ───────────────────────────────────────────────────
  // Duplicate headings and unbalanced tags inside maintained documents. The
  // write path already computes duplicateHeadings on every edit, but the run
  // that CREATES structural drift is definitionally not the run that notices
  // it: each write only ever looks at the section it is editing, while the
  // drift is a property of the whole note. This is the pass that reads the
  // whole note. Records are exempt — they repeat headings across addendum
  // blocks by design.
  const lintPool = (await connectable("#noteType")).filter((n) =>
    eligible(n, (kind) => RECORDS.has(kind) || kind === "domain")
  );

  // The window ROTATES by date, and the skipped notes are NAMED.
  //
  // This used to be a plain slice(0, 40) over whatever order the search
  // returned, so the same 40 notes were linted on every run and the remainder
  // were a permanent blind spot — 40 of 70 every run for five days, with
  // coverage[] reporting the count but never which 30 went unread. An unnamed
  // blind spot is only marginally better than a silent one: the caller cannot
  // even lint the remainder by hand.
  //
  // Rotating by day-of-year gives eventual full coverage over
  // ceil(pool / limit) days at zero extra cost. Deliberately NOT a "#linted"
  // label: writing one would bump dateModified on 40 notes per sweep, which
  // would make every linted note look freshly touched and quietly disable the
  // stale-review pass. That is the same trap the ack mechanic avoids by
  // keying on blobId rather than dateModified.
  lintPool.sort((a, b) => a.noteId.localeCompare(b.noteId)); // stable order across runs
  let lintCandidates = lintPool;
  if (lintPool.length > STRUCTURE_LINT_LIMIT) {
    const epochDay = Math.floor(Date.parse(`${localToday()}T00:00:00Z`) / 86_400_000);
    const windows = Math.ceil(lintPool.length / STRUCTURE_LINT_LIMIT);
    const start = ((epochDay % windows) * STRUCTURE_LINT_LIMIT) % lintPool.length;
    lintCandidates = [...lintPool.slice(start), ...lintPool.slice(0, start)].slice(0, STRUCTURE_LINT_LIMIT);

    const read = new Set(lintCandidates.map((n) => n.noteId));
    const skipped = lintPool.filter((n) => !read.has(n.noteId));
    (report.coverage ??= []).push(
      `structural lint: ${lintCandidates.length} of ${lintPool.length} notes read (cap ${STRUCTURE_LINT_LIMIT}); ` +
      `window rotates daily, full coverage every ${windows} days. Unread this run — ` +
      skipped.map((n) => `${n.title} [${n.noteId}]`).join(", ")
    );
  }
  for (const n of lintCandidates) {
    const content = await trilium.getNoteContent(n.noteId).catch(() => "");
    if (!content) continue;
    report.scanned++;
    const structure = structureReport(content);
    if (structure.duplicateHeadings.length) {
      report.flagged.push(`duplicate heading: ${n.title} [${n.noteId}] — '${structure.duplicateHeadings.join("', '")}' repeated in one note; merge with revise(section=…, mode=replace) or target one with occurrence=`);
    }
    // Completeness, not just well-formedness. The lint reads the whole note
    // here anyway, so checking it against the section set its own kind
    // requires costs nothing extra — and catches the class that was entirely
    // invisible before: a thread that lost its Resolution, a Sources note with
    // no Revision table. Both pass every structural check yet are broken.
    const lintKind = ownedLabel(n, "noteType") as AnyKind | undefined;
    if (lintKind) {
      const missing = missingSections(lintKind, content);
      if (missing.length) {
        report.flagged.push(
          `incomplete ${lintKind}: ${n.title} [${n.noteId}] — missing required section(s) '${missing.join("', '")}'. ` +
          `Compare against template(kind="${lintKind}") and restore with revise(section=…), or resolve() if it is a thread wanting closure.`
        );
      }
    }
    if (structure.unbalancedTags.length) {
      report.flagged.push(`unbalanced tags: ${n.title} [${n.noteId}] — <${structure.unbalancedTags.join(">, <")}> left open; the next write will auto-close them, or fix now with revise(mode=replace)`);
    }

    // Has this note outgrown safe section-targeted editing? A different
    // question from "can it be read whole", and it goes wrong earlier: picking
    // the right heading out of thirty is where the mistake happens, and a
    // replace on a section holding a third of the note destroys far more than
    // the caller pictured. The read-ceiling warning catches neither.
    const profile = sectionProfile(content);
    const biggest = profile.largest[0];
    const crowded = profile.count >= SECTION_EDIT_RISK_COUNT;
    const lopsided = !!biggest && biggest.chars >= SECTION_EDIT_RISK_CHARS;
    if (crowded || lopsided) {
      const reasons = [
        crowded ? `${profile.count} sections` : null,
        lopsided ? `largest is '${biggest!.text}' at ${Math.round(biggest!.chars / 1000)}k characters` : null,
        profile.ambiguous.length ? `${profile.ambiguous.length} heading text(s) repeated ('${profile.ambiguous.slice(0, 3).join("', '")}') — those need occurrence= to target` : null,
      ].filter(Boolean);
      report.flagged.push(
        `section-edit-risk: ${n.title} [${n.noteId}] — ${reasons.join("; ")}. ` +
        `Read outline(${n.noteId}) before any section= edit here, prefer find= for anything smaller than a section, and consider splitting the note.`
      );
    }
  }

  // ── Deep: hygiene passes ────────────────────────────────────────────────────
  await hygienePasses(trilium, cfg, report, { eligible, connectable, dryRun, repair: new Set(repair ?? []) });

  // ── Deep: duplicate-title detection ────────────────────────────────────────
  // Flat containers: group by normalised title, flag any group > 1.
  // Includes archived notes to catch leftovers from past dedup failures.
  const dupeContainers: Array<{ id: string; kind: string; label: string }> = [
    { id: cfg.memory.sessions,  kind: "session",   label: "Sessions"         },
    { id: cfg.llm.diary,        kind: "diary",     label: "Diary"            },
    { id: cfg.insights.logs,    kind: "log",       label: "Logs"             },
    { id: cfg.memory.threads,   kind: "thread",    label: "Threads"          },
    { id: cfg.knowledge.master,  kind: "user",      label: "Knowledge/Master"  },
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

      // ── Near-title duplicate SUBJECTS ──────────────────────────────────────
      // Equality-matching fires on the case that never occurs and stays silent
      // on the one that does. Nobody writes a second note with a byte-identical
      // title; they write "Authenticated Surfaces" beside an existing "Reading
      // Authenticated Surfaces" — which is what a writer produces when they
      // haven't read the domain's existing notes. maintain(deep) ran clean over
      // exactly that pair three separate times.
      //
      // Within ONE domain, two information notes sharing a significant title
      // token are worth a human glance. Cheap, and it targets the failure that
      // actually happens. Cross-domain reuse stays unflagged — "Current State"
      // in two domains is the consistency rule working.
      if (domainKind === "information") {
        const STOP_TOKENS = new Set(["and", "the", "for", "with", "state", "current", "notes", "note"]);
        const significant = (title: string): string[] =>
          title.toLowerCase().replace(/[^a-z0-9\s-]/g, " ").split(/\s+/)
            .filter((t) => t.length >= 5 && !STOP_TOKENS.has(t));

        const byDomain = new Map<string, Note[]>();
        for (const n of all.results) {
          const domSlug = n.attributes.find((a) => a.type === "label" && a.name === "domain")?.value ?? "_unknown";
          if (!byDomain.has(domSlug)) byDomain.set(domSlug, []);
          byDomain.get(domSlug)!.push(n);
        }
        // Heading sets, fetched once per note and only for notes that actually
        // land in a flagged pair. A shared title token says two notes MIGHT be
        // about one subject; their heading sets are what says whether they are.
        // Without them the flag gave nothing to judge on, so callers ack'd from
        // relation shape or reputation instead of reading either body — which is
        // acking a finding without evaluating it, the exact habit ack= exists to
        // avoid.
        const headingCache = new Map<string, string[]>();
        const headingsOf = async (n: Note): Promise<string[]> => {
          if (!headingCache.has(n.noteId)) {
            const content = await trilium.getNoteContent(n.noteId).catch(() => "");
            headingCache.set(n.noteId, headingOutline(content).filter((h) => h.level <= 3).map((h) => h.text));
          }
          return headingCache.get(n.noteId)!;
        };

        for (const [domSlug, notes] of byDomain) {
          const reported = new Set<string>();
          for (let i = 0; i < notes.length; i++) {
            for (let j = i + 1; j < notes.length; j++) {
              const a = notes[i]!, bn = notes[j]!;
              if (a.title.toLowerCase().trim() === bn.title.toLowerCase().trim()) continue; // exact — already flagged
              const shared = significant(a.title).filter((t) => significant(bn.title).includes(t));
              if (!shared.length) continue;
              const pairKey = [a.noteId, bn.noteId].sort().join("|");
              if (reported.has(pairKey)) continue;
              reported.add(pairKey);

              const [ha, hb] = await Promise.all([headingsOf(a), headingsOf(bn)]);
              const overlap = ha.filter((h) => hb.some((x) => x.toLowerCase() === h.toLowerCase()));
              const show = (h: string[]) => (h.length ? h.slice(0, 8).join(" · ") + (h.length > 8 ? " · …" : "") : "(no headings)");

              report.flagged.push(
                `near-duplicate subject: '${a.title}' [${a.noteId}] and '${bn.title}' [${bn.noteId}] in Domain/${domSlug} ` +
                `share '${shared.join("', '")}'. Sections — '${a.title}': ${show(ha)} | '${bn.title}': ${show(hb)}. ` +
                (overlap.length
                  ? `${overlap.length} heading(s) in common (${overlap.slice(0, 5).join(", ")}), which is what a genuine split subject looks like — read both, merge into the older one, and forget() the other.`
                  : `No headings in common, so these are most likely distinct notes that happen to share a title word — maintain(ack=["${a.noteId}"]) to silence this once you have confirmed it.`)
              );
            }
          }
        }
      }
    }
  }

  if (suppressed) report.suppressed = suppressed;

  // Scope guidance, both directions.
  //
  // The reported harm was never that the default is unscoped — a deep pass
  // exists to surface the cross-cutting problems a single-lane view cannot see,
  // and defaulting it to one lane would remove the reason to run it. The harm
  // was that a scoped session could neither honestly ack an out-of-lane flag
  // (ack= asserts the note was reviewed, and it was not) nor safely ignore it
  // (ignoring flags every run is what trains the skim). Neither is a scoping
  // problem; both are a missing instruction. Saying plainly what to do with a
  // flag that is not yours costs nothing and resolves it.
  if (deep) {
    if (domainSlug) {
      report.coverage = [
        ...(report.coverage ?? []),
        `scoped to domain '${domainSlug}' — findings outside it were not evaluated, including the cross-domain ones (duplicate titles across domains, orphans elsewhere) that only an unscoped run can see. Re-run without domain= periodically.`,
      ];
    } else if (report.flagged.length) {
      report.laneHint =
        "Flags here span the whole brain and may cover work this session never touched. LEAVE those — do not ack= them: an acknowledgement asserts the note's current content was reviewed, so acking unread is the one thing that makes the mechanism useless. Ack only what you actually read, act on what is yours, and pass domain= if you want a single lane.";
    }
  }

  return report;
}

// ── Hygiene passes ─────────────────────────────────────────────────────────────

/** Notes below this are a title and a stub — created and never written. */
const STUB_CONTENT_CHARS = 120;
/** Revisions past this on one note usually means a write loop, not history. */
const REVISION_BLOAT = 60;
/** Day-children past this make a thread expensive to walk; it wants a rolling
 *  summary on the book so successors read the summary, not the history. */
const THREAD_CONSOLIDATION_CHILDREN = 25;

/** Titles are the dedup key, so a date or run number in one mints a new note
 *  every run instead of updating the one that exists. */
const DATED_TITLE = /\b(\d{4}-\d{2}-\d{2}|\d{1,2}\/\d{1,2}\/\d{2,4}|run\s*\d+|v\d+\.\d+)\b/i;

/** The documented title rule: concise, maximum four words. */
function titleWordCount(title: string): number {
  return title.trim().split(/\s+/).filter(Boolean).length;
}

interface HygieneCtx {
  eligible: (n: Note, skip?: (kind: string) => boolean) => boolean;
  connectable: (query: string, limit?: number) => Promise<Note[]>;
  dryRun: boolean;
  /** Note ids the caller asked to REPAIR rather than merely report. */
  repair: Set<string>;
}

/** The correctness-and-convention passes, all server-side filtered.
 *
 *  These exist because the brain's failure modes are not the ones a note
 *  application worries about. A knowledge base does not care whether a title is
 *  four words; a memory whose dedup key IS the title cares enormously. Each pass
 *  here traces to a defect that actually happened and cost a session to find. */
async function hygienePasses(
  trilium: TriliumClient,
  cfg: BrainLLMConfig,
  report: SweepReport,
  ctx: HygieneCtx
): Promise<void> {
  const { eligible } = ctx;

  // 1. Entity-corrupted bodies — a body escaped a SECOND time on the way in,
  //    storing "&amp;lt;h2&amp;gt;" and rendering it as visible literal text,
  //    with a clean write receipt.
  //
  //    Two things were wrong here until v10.3. The producer (escapeHtml's
  //    blanket & → &amp;) was never fixed — only the detector and repairer
  //    were — so this kept recurring after being declared solved. And the
  //    detector itself only ever looked for "&amp;lt;", while the same bug
  //    produces "&amp;nbsp;" and "&amp;amp;" far more often: a body carrying an
  //    &nbsp; copied out of a prior read is the commonest case of all, and it
  //    was produced and then never flagged. The pattern below matches any
  //    doubly-escaped entity, not one spelling of it.
  const corrupted = await trilium
    .searchNotes(`#noteType note.content %= '${escapeQueryRegex("&amp;(?:[a-zA-Z][a-zA-Z0-9]*|#\\d+|#x[0-9a-fA-F]+);")}'`, { ancestorNoteId: cfg.root, limit: 50 })
    .then((r) => r.results)
    .catch(() => [] as Note[]);
  report.scanned += corrupted.length;
  for (const n of corrupted) {
    // eligible(), not isStructural() — this pass bypassed the acknowledgement
    // filter entirely, so an ack'd finding re-fired on every subsequent run
    // while `suppressed` climbed for the passes that did honour it. That is
    // exactly the "warning that always fires" failure ack= exists to prevent,
    // occurring inside the ack mechanic. It also matters more here than
    // elsewhere: a note DOCUMENTING the double-escape signature necessarily
    // contains it, so this detector has permanent true positives that must
    // stay silenceable.
    if (!eligible(n)) continue;
    if (ctx.repair.has(n.noteId)) {
      const before = await trilium.getNoteContent(n.noteId).catch(() => "");
      const after = repairDoubleEscaping(before);
      if (after === before) {
        report.flagged.push(`entity-corrupted: ${n.title} [${n.noteId}] — repair requested but the body did not change; the match is a note DOCUMENTING the signature rather than carrying it. maintain(ack=["${n.noteId}"]) to silence.`);
        continue;
      }
      if (!ctx.dryRun) {
        await trilium.createRevision(n.noteId).catch(() => null);
        await trilium.updateNoteContent(n.noteId, after);
      }
      report.fixed.push(`entity-repaired: ${n.title} [${n.noteId}] — unwound one level of double-escaping${ctx.dryRun ? " (dry run, not written)" : ", snapshot taken first"}.`);
      continue;
    }
    report.flagged.push(`entity-corrupted: ${n.title} [${n.noteId}] — body stores doubly-escaped markup ("&amp;lt;", "&amp;nbsp;") that renders as literal text. Repair with maintain(repair=["${n.noteId}"]) — the substitution is always the same, so it is a first-class action rather than something each caller reinvents. Read it first if you need to be sure.`);
  }

  // 1b. Claims whose verification has lapsed, or which are known broken.
  //
  //     This is the only pass that checks the brain against the WORLD rather
  //     than against itself. consistency() compares notes to each other and
  //     every other pass here checks structure — none of which notices that a
  //     recorded fact quietly stopped being true of the thing it describes.
  //     Registering a claim is what converts "is the brain stale" from a
  //     question answered by luck into one answered by a query.
  const claims = await trilium
    .searchNotes("#noteType=claim", { ancestorNoteId: cfg.root, fastSearch: true, limit: 200 })
    .then((r) => r.results)
    .catch(() => [] as Note[]);
  report.scanned += claims.length;
  for (const n of claims) {
    if (!eligible(n)) continue;
    const state = ownedLabel(n, "claimState");
    const verifiedOn = ownedLabel(n, "verified");
    const interval = Number(ownedLabel(n, "interval") ?? 30);
    if (state === "broken") {
      report.flagged.push(
        `claim broken: "${n.title}" [${n.noteId}] — last check FAILED${verifiedOn ? ` on ${verifiedOn}` : ""}. ` +
        `Correct every note asserting it (consistency() will find the others), then re-verify with claim(claimId="${n.noteId}", holds=true, evidence=…). ` +
        `A broken claim left in the register is a known-wrong fact with a timestamp on it.`
      );
      continue;
    }
    const due = !verifiedOn || verifiedOn < isoDaysAgo(interval);
    if (due) {
      report.flagged.push(
        `claim ${verifiedOn ? "lapsed" : "unverified"}: "${n.title}" [${n.noteId}] — ` +
        `${verifiedOn ? `last verified ${verifiedOn}, interval ${interval}d` : "never verified since registration"}. ` +
        `Read its check with claim(claimId="${n.noteId}"), run it, and record the result.`
      );
    }
  }

  // 2. Titles that break the dedup key. A dated or run-numbered title defeats
  //    dedup-by-title outright; an over-long one is the documented signal that
  //    the CONTENT wants splitting.
  const titled = await ctx.connectable("#noteType", 300);
  const RECORD_TITLES = new Set(["diary", "session", "log", "threadEntry"]);
  let longTitles = 0;
  for (const n of titled) {
    if (!eligible(n, (kind) => RECORD_TITLES.has(kind))) continue;
    if (DATED_TITLE.test(n.title)) {
      report.flagged.push(`dated title: "${n.title}" [${n.noteId}] — dates and run numbers defeat dedup-by-title, so this mints a new note instead of updating one. Retitle with revise(title=…) and fold the content into the note it should have updated.`);
    } else if (titleWordCount(n.title) > 4 && longTitles < 10) {
      longTitles++;
      report.flagged.push(`long title: "${n.title}" [${n.noteId}] — ${titleWordCount(n.title)} words against the 4-word rule. A title that won't trim is the signal the content should be split.`);
    }
  }

  // 3. Stubs — created, labelled, never written. They satisfy every structural
  //    check and carry nothing, so only a size query finds them.
  const stubs = await trilium
    .searchNotes(`#noteType note.contentSize < ${STUB_CONTENT_CHARS}`, { ancestorNoteId: cfg.root, fastSearch: true, limit: 50 })
    .then((r) => r.results)
    .catch(() => [] as Note[]);
  report.scanned += stubs.length;
  for (const n of stubs) {
    if (!eligible(n, (kind) => RECORD_TITLES.has(kind))) continue;
    report.flagged.push(`stub: ${n.title} [${n.noteId}] (${ownedLabel(n, "noteType")}) — under ${STUB_CONTENT_CHARS} characters. Write it, or forget() it; an empty note is worse than an absent one because recall() still surfaces it.`);
  }

  // 4. Revision bloat — a note revised into the hundreds is usually a write
  //    loop, not a well-tended document.
  const bloated = await trilium
    .searchNotes(`#noteType note.revisionCount > ${REVISION_BLOAT}`, { ancestorNoteId: cfg.root, fastSearch: true, limit: 20 })
    .then((r) => r.results)
    .catch(() => [] as Note[]);
  for (const n of bloated) {
    // eligible() for the same reason as pass 1 — this also bypassed ack=.
    if (!eligible(n)) continue;
    report.flagged.push(`revision bloat: ${n.title} [${n.noteId}] — over ${REVISION_BLOAT} revisions. Usually a repeated full-body rewrite where section=/find= would have been surgical.`);
  }

  // 5. Threads heavy enough that walking their day-children is expensive. The
  //    fix is a rolling summary on the book, so the next session reads what the
  //    thread established rather than replaying how it got there.
  if (cfg.memory.threads) {
    const heavy = await trilium
      .searchNotes(`#noteType=thread #status=active note.childrenCount > ${THREAD_CONSOLIDATION_CHILDREN}`, { ancestorNoteId: cfg.memory.threads, fastSearch: true, limit: 20 })
      .then((r) => r.results)
      .catch(() => [] as Note[]);
    for (const n of heavy) {
      if (!eligible(n)) continue;
      report.flagged.push(`consolidate: ${n.title} [${n.noteId}] — ${n.childNoteIds.length} day-children. Fold what the thread has ESTABLISHED into its Context section with revise(section="Context"), so a successor reads the conclusion instead of walking the history.`);
    }
  }

  // 6. Sources notes whose Revision table was never filled in. Every ✅ in the
  //    list above it claims a verification that the table does not record — the
  //    skeleton ships with a placeholder row and nothing forces it to be filled.
  if (cfg.knowledge.domains) {
    const sources = await trilium
      .searchNotes("#noteType=sources", { ancestorNoteId: cfg.knowledge.domains, fastSearch: true, limit: 50 })
      .then((r) => r.results)
      .catch(() => [] as Note[]);
    for (const n of sources) {
      if (!eligible(n, () => false)) continue;
      const content = await trilium.getNoteContent(n.noteId).catch(() => "");
      if (!content) continue;
      report.scanned++;
      if (hasPlaceholderRow(content, "Revision")) {
        report.flagged.push(`unverified sources: ${n.title} [${n.noteId}] (${ownedLabel(n, "domain") ?? "domain"}) — the Revision table still holds only its placeholder row. Record the verifications with remember(kind="sources", revision=[{source, marker, date}]).`);
      }
    }
  }
}

// ── Session digest ──────────────────────────────────────────────────────────────

/** One singleton in the orientation digest.
 *
 *  `depth="digest"` (the default) returns the section headings, a one-line
 *  preview and the size; `depth="full"` returns the whole body. The default
 *  used to be "full, unconditionally, every session", which meant a one-line
 *  question paid the same orientation cost as a full day's work — several
 *  thousand tokens of biography, goals, preferences, responsibilities and
 *  protocols before the first word of an answer. Comparable memory systems
 *  start a conversation in the low hundreds of tokens. Headings are enough to
 *  know what the brain holds; `master(which)` / `llm(which)` fetch the one
 *  section that turns out to matter. */
export interface DigestSlot {
  slot: string;
  /** Full body text — `depth="full"` only. */
  summary?: string;
  /** Section headings — the default view of a singleton. */
  sections?: string[];
  /** First line or so, so a heading list still has a hook. */
  preview?: string;
  /** Body size in characters — what the full read would cost. */
  size?: number;
}

export interface SessionDigest {
  master: DigestSlot[];
  llm: DigestSlot[];
  workingSet: Array<{ id: string; title: string; kind: string; status: string; idleDays: number; relations?: RelationEdge[] }>;
  reviewQueue: Array<{ id: string; title: string; kind: string; idleDays: number; relations?: RelationEdge[] }>;
  /** The most recent session BEFORE today — the previous session, never today's own note. */
  lastSession?: { id: string; title: string; date: string; summary: string };
  /** Today's session note, when it already exists. */
  todaySession?: { id: string; title: string; date: string; summary: string };
  counts: Record<string, number>;
}

function idleDays(dateModified: string): number {
  const ms = Date.now() - new Date(dateModified.replace(" ", "T")).getTime();
  return Math.max(0, Math.floor(ms / 86_400_000));
}

const label = (n: Note, name: string) =>
  n.attributes.find((a) => a.type === "label" && a.name === name)?.value;

/** A thread book's aging signal: its own "updated" label, not
 *  note.dateModified — content activity lands on threadEntry children,
 *  which don't bump the book's own dateModified. Falls back to
 *  dateModified for a not-yet-migrated legacy thread that lacks the label. */
const threadUpdated = (n: Note): string => label(n, "updated") ?? n.dateModified;

/** Orientation payload for start: the Master singletons (the user), the LLM
 *  singletons (the assistant's own self-model), live threads, and the last
 *  session summary. */
export async function buildDigest(
  trilium: TriliumClient,
  cfg: BrainLLMConfig,
  opts: { depth?: "digest" | "full" } = {}
): Promise<SessionDigest> {
  const depth = opts.depth ?? "digest";
  const digest: SessionDigest = { master: [], llm: [], workingSet: [], reviewQueue: [], counts: {} };

  // Singletons, fetched in parallel (5 sequential round-trips on every session
  // open was pure latency). What comes back depends on depth — see DigestSlot.
  const readSlot = async (slot: string, id: string): Promise<DigestSlot | null> => {
    if (!id) return null;
    const content = await trilium.getNoteContent(id).catch(() => "");
    if (!content) return null;
    // Two singletons always come back in full, even at digest depth.
    //
    // Preferences carries the schedule and working style; protocols carries the
    // operating rules governing the session itself. They are the two a session
    // needs whole to orient correctly from its FIRST message — before it knows
    // enough to decide it needed them, which is exactly when a digest sends it
    // back for a second round-trip. Biography, goals and responsibilities are
    // stabler and rarely load-bearing turn to turn, so they stay at headings
    // depth and the token cost of this stays bounded.
    if (depth === "full" || ALWAYS_FULL_SLOTS.has(slot)) {
      const summary = toText(content, Infinity);
      return summary ? { slot, summary } : null;
    }
    const sections = headingOutline(content).map((h) => h.text);
    const preview = toText(content, 180);
    if (!sections.length && !preview) return null;
    return { slot, ...(sections.length ? { sections } : {}), ...(preview ? { preview } : {}), size: content.length };
  };
  const [masterSlots, llmSlots] = await Promise.all([
    Promise.all([
      readSlot("biography", cfg.master.biography),
      readSlot("goals", cfg.master.goals),
      readSlot("preferences", cfg.master.preferences),
    ]),
    Promise.all([
      readSlot("responsibilities", cfg.llm.responsibilities),
      readSlot("protocols", cfg.llm.protocols),
    ]),
  ]);
  digest.master.push(...masterSlots.filter((s): s is DigestSlot => !!s));
  digest.llm.push(...llmSlots.filter((s): s is DigestSlot => !!s));

  // Working set — live threads in Memory/threads.
  const live = await trilium.searchNotes("#noteType=thread", {
    ancestorNoteId: cfg.memory.threads,
    fastSearch: true,
    limit: 30,
  }).catch(() => ({ results: [] as Note[] }));
  for (const n of live.results) {
    const status = label(n, "status") ?? "active";
    const idle = idleDays(threadUpdated(n));
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

  // Sessions: today's note (if open) and the previous session. The V8 code
  // returned the newest session as lastSession — which, once today's stub
  // exists, is today's own note, breaking the new-day sweep's premise.
  const sessions = await trilium.searchNotes("#noteType=session", {
    ancestorNoteId: cfg.memory.sessions,
    fastSearch: true,
    limit: 10,
    orderBy: "dateCreated",
    orderDirection: "desc",
  }).catch(() => ({ results: [] as Note[] }));
  const todayStr = localToday();
  const sessionDate = (n: Note) => label(n, "created") ?? n.dateCreated.slice(0, 10);
  const todayNote = sessions.results.find((n) => sessionDate(n) === todayStr);
  const prevNote = sessions.results.find((n) => sessionDate(n) < todayStr);
  const toEntry = async (n: Note) => ({
    id: n.noteId,
    title: n.title,
    date: sessionDate(n),
    summary: toText(await trilium.getNoteContent(n.noteId).catch(() => ""), 300),
  });
  const [todayEntry, prevEntry] = await Promise.all([
    todayNote ? toEntry(todayNote) : Promise.resolve(undefined),
    prevNote ? toEntry(prevNote) : Promise.resolve(undefined),
  ]);
  if (todayEntry) digest.todaySession = todayEntry;
  if (prevEntry) digest.lastSession = prevEntry;

  return digest;
}
