/**
 * tools.ts — BrainLLM core tool surface (V10)
 *
 * The model supplies content; the server owns form. Placement, naming, labels,
 * blueprint wiring, dedup, lifecycle, archival — and in V10 structure
 * (canonical skeletons, heading rules, Last-updated stamps, thread
 * Goal/Resolution enforcement) — are policy implemented here.
 *
 * Registers the universal verbs (start, session, remarks, close, backup, bootstrap,
 * remember, diary, domain, recall, addendum, revise, resolve, withdraw, recover, label,
 * attach, detach, connect, explore, inspect, template, graph, day, maintain, forget,
 * brain), wires in the read-only per-surface modules
 * (tools-master/llm/memory/knowledge/insights),
 * and — under BRAINLLM_MODE=full — the raw ETAPI surface (tools-advanced).
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { TriliumClient, type Note, type RecentChange, ownedLabel, isOwnedAttribute, relationSnippet, type RelationEdge, PartialContentUploadError, isCollectionThread } from "./trilium.js";
import { ensureIcon, ICON_EXEMPT } from "./icons.js";
import { type BrainLLMConfig, saveConfig } from "./config.js";
import {
  Kinds,
  RelationTypes,
  SymmetricRelations,
  Statuses,
  KIND_AREA,
  type AnyKind,
  type SingletonKind,
} from "./types.js";
import {
  normalizeTitle,
  sameTitle,
  titleKey,
  slugify,
  normalizeIcon,
  toText,
  escapeQueryValue,
  escapeQueryRegex,
  stripTagsWithMap,
  queryTokens,
  escapeHtml,
  decodeEntities,
  sanitizeHtml,
  renderBody,
  safeAppend,
  closeDangling,
  setSection,
  getSection,
  mergeUnderSection,
  nearestContext,
  headingOutline,
  sectionLevelFor,
  structureReport,
  LARGE_NOTE_CHARS,
  upsertTableRow,
  tableRows,
  hasPlaceholderRow,
  tolerantFindRegex,
  spansBlockBoundary,
  looksEntityEscaped,
  fixRecordHeader,
  bumpLastUpdated,
  duplicateHeadings,
  leadingIdentification,
  hasAddendumMarker,
  nearestHeading,
  repairedStructure,
  extractSections,
} from "./normalize.js";
import { contentFor, RESOLUTION_ANCHOR, structureRuleFor, STRUCTURE_RULES, isOpenResolutionOnly, purposeContent } from "./templates.js";
import {
  dedupScope,
  labelPlan,
  resolveParent,
  resolveDomain,
  locationLabel,
  kindHome,
  isSingleton,
  type RememberOpts,
} from "./router.js";
import { sweep, buildDigest, applyResolution, isStructural, isContainer, type SweepReport } from "./lifecycle.js";
import { createBrainLLMStructure, containerPurposes } from "./bootstrap.js";
import { generateDailyLog, catchUpDeletions } from "./journal.js";
import { checkedDate, localToday, localNowTime } from "./time.js";
import { registerMasterTools } from "./tools-master.js";
import { registerLlmTools } from "./tools-llm.js";
import { registerMemoryTools } from "./tools-memory.js";
import { registerKnowledgeTools } from "./tools-knowledge.js";
import { registerInsightsTools } from "./tools-insights.js";

// ── Shared helpers ────────────────────────────────────────────────────────────

export const txt = (obj: unknown) => ({
  content: [{ type: "text" as const, text: typeof obj === "string" ? obj : JSON.stringify(obj, null, 2) }],
});

export const today = () => localToday();

/** Structured informational error return — use instead of throw for user-input errors
 *  so the LLM can read and react without the call appearing as a system failure. */
const err = (code: string, detail: string, hint?: string) =>
  txt({ error: code, detail, ...(hint ? { hint } : {}) });

const labelOf = (n: Note, name: string) =>
  n.attributes.find((a) => isOwnedAttribute(n, a) && a.type === "label" && a.name === name)?.value;

const hasLabel = (n: Note, name: string) =>
  n.attributes.some((a) => isOwnedAttribute(n, a) && a.type === "label" && a.name === name);

/** Insert a section before the Resolution anchor (or append). */
function insertBeforeResolution(html: string, section: string): string {
  const idx = html.indexOf(RESOLUTION_ANCHOR);
  if (idx >= 0) return html.slice(0, idx) + section + "\n" + html.slice(idx);
  return html + "\n" + section;
}

async function ensureArchivedFlag(trilium: TriliumClient, note: Note): Promise<void> {
  if (!hasLabel(note, "archived")) await trilium.addLabel(note.noteId, "archived", "");
}

/** True if the last BrainLLM append-block in `current` has the same normalised
 *  text as `incomingHtml`. Covers Addendum / Withdrawn / Recovered heading blocks
 *  (plus legacy Reopened blocks written before the withdraw rename).
 *  Used by all date-keyed append operations to make them safe to retry. */
function isDuplicateAppend(current: string, incomingHtml: string): boolean {
  const norm = (s: string) => s.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim().toLowerCase();
  const markerRe = /<h[23]>(?:Addendum|Withdrawn|Reopened|Recovered) —[^<]*<\/h[23]>/gi;
  let lastEnd = -1;
  let m: RegExpExecArray | null;
  while ((m = markerRe.exec(current)) !== null) lastEnd = m.index + m[0].length;
  if (lastEnd === -1) return false;
  const afterHeader = current.slice(lastEnd).replace(/^\n/, "");
  const nextH = afterHeader.search(/<h[1-6]/i);
  const block = nextH === -1 ? afterHeader : afterHeader.slice(0, nextH);
  return norm(block) === norm(incomingHtml);
}

// ── Registration ──────────────────────────────────────────────────────────────

/** Register the CORE surface: the universal verbs plus the ten dual-mode
 *  surface reads.
 *
 *  Core only. The raw ETAPI tools live in tools-advanced.ts and are registered
 *  by the caller — this function used to take a `mode` flag and reach into that
 *  module itself, which made "core" and "full" one tangled surface with the
 *  boundary expressed as a boolean halfway down a 3,800-line file. Composing
 *  them at the call site makes the split structural: what a mode contains is
 *  visible where the decision is made, and the two sets cannot silently overlap
 *  the way they did when both paths could register the same tool. */
export function registerTools(
  server: McpServer,
  trilium: TriliumClient,
  brainRef: { config: BrainLLMConfig }
): void {
  const b = () => brainRef.config;

  // ── Pre-close protocol gate ───────────────────────────────────────────────
  // Tracks which pre-close steps actually ran (by tool invocation, not by
  // narration) — and in what order — so close() can refuse until each one has
  // been individually, verifiably called. This is what makes the protocol
  // enforceable rather than a docstring convention the model can silently
  // skip under time pressure. Beyond presence, close() enforces the sequence
  // session() → remarks() → diary(): the diary is the day's closing record,
  // written with the remarks cues in hand — a diary call before remarks()
  // still writes (mid-session entries are encouraged) but doesn't close the
  // gate. Order is judged on each step's LAST call.
  //
  // DURABLE, not in-memory. Gate progress is written to today's session note as
  // a #gate label ("session:1,remarks:2,diary:3"). The in-memory Map is only a
  // write-through cache.
  //
  // This is a correctness requirement, not an optimisation. MCP's 2026-07-28
  // revision removes protocol-level sessions outright: requests are expected to
  // land on any instance behind a load balancer, and the spec's own guidance is
  // that servers needing cross-call state must keep it in explicit, server-held
  // handles. A gate living in one process's memory either never satisfies or is
  // silently bypassed the moment two calls land on different instances — and it
  // was already lost across a server restart mid-session. Today's session note
  // is the natural home: it is per-day, already exists, and is the thing the
  // gate is about.
  const preCloseSteps = new Map<string, number>();
  let preCloseSeq = 0;
  const REQUIRED_PRECLOSE_STEPS = ["session", "addendum", "maintain", "remarks", "diary"] as const;

  /** Today's session note, the gate's durable home. Search failures propagate:
   *  a missing note and an unavailable Trilium connection are different states,
   *  and treating the latter as "no gate" would let close() certify fiction. */
  const gateNote = async (date: string): Promise<string | null> => {
    const cfg = b();
    if (!cfg.memory.sessions) return null;
    const found = await trilium.searchNotes(
      `#noteType=session #created='${date}'`,
      { ancestorNoteId: cfg.memory.sessions, fastSearch: true, limit: 1 },
    );
    return found.results[0]?.noteId ?? null;
  };

  const parseGate = (raw: string | undefined): Map<string, number> => {
    const out = new Map<string, number>();
    for (const pair of (raw ?? "").split(",")) {
      const [step, seq] = pair.split(":");
      if (step && seq && !Number.isNaN(Number(seq))) out.set(step.trim(), Number(seq));
    }
    return out;
  };

  const serializeGate = (m: Map<string, number>): string =>
    [...m.entries()].map(([step, seq]) => `${step}:${seq}`).join(",");

  /** Record a completed pre-close step, write-through to today's session note.
   *  The durable write is authoritative; the in-memory map is only a cache and
   *  is updated after it succeeds. */
  const markStep = async (step: string, date?: string): Promise<void> => {
    const d = checkedDate(date);
    const noteId = await gateNote(d);
    if (!noteId) throw new Error(`Cannot record pre-close step "${step}": today's session note was not found`);
    const note = await trilium.getNote(noteId);
    const stored = parseGate(labelOf(note, "gate"));
    const next = Math.max(preCloseSeq, ...[...stored.values()], 0) + 1;
    stored.set(step, next);
    await trilium.updateLabelValue(noteId, "gate", serializeGate(stored));
    preCloseSteps.set(step, next);
    preCloseSeq = next;
  };

  /** Read the authoritative durable gate state. */
  const readGate = async (date: string): Promise<Map<string, number>> => {
    const noteId = await gateNote(date);
    if (!noteId) return new Map();
    const note = await trilium.getNote(noteId);
    return parseGate(labelOf(note, "gate"));
  };

  /** Clear the durable gate after a successful close so the next session re-arms. */
  const clearGate = async (date: string): Promise<void> => {
    const noteId = await gateNote(date);
    if (!noteId) throw new Error("Cannot clear the pre-close gate: today's session note was not found");
    await trilium.updateLabelValue(noteId, "gate", "");
    preCloseSteps.clear();
    preCloseSeq = 0;
  };

  // Chronological records legitimately repeat headings across addendum blocks —
  // every entry carries its own identification line and its own section names —
  // so structural checks apply to maintained documents only.
  const RECORD_KINDS = new Set(["session", "diary", "log", "threadEntry"]);

  /** Structural findings for a write receipt: duplicate section headings the
   *  edit introduced, so the run that creates drift is the one told about it.
   *  Empty for record kinds and for a body that came back clean. */
  const structuralFindings = (kind: string | undefined, html: string | null) => {
    if (!html || (kind && RECORD_KINDS.has(kind))) return {};
    const dupes = duplicateHeadings(html);
    if (!dupes.length) return {};
    return {
      duplicateHeadings: dupes,
      structureHint: "The note now carries duplicated section headings — merge them with revise(section=…, mode=replace), or target one specifically with occurrence=.",
    };
  };

  /** Set a note's display icon (#iconClass) from an icon request — a full
   *  boxicons class or a bare name, normalized server-side. Without a usable
   *  request, the note still gets its kind's default icon if it has none
   *  (every note carries an icon except logs). Returns the requested class
   *  for the tool receipt. */
  const applyIcon = async (noteId: string, icon?: string): Promise<string | undefined> => {
    const cls = icon ? normalizeIcon(icon) : "";
    if (!cls) {
      await ensureIcon(trilium, noteId);
      return undefined;
    }
    await trilium.updateLabelValue(noteId, "iconClass", cls).catch(() => null);
    return cls;
  };

  /** Find an existing same-kind note with the same (normalized) title. */
  async function findExisting(kind: AnyKind, title: string): Promise<Note | null> {
    const scope = dedupScope(b(), kind);
    if (!scope) return null;
    const res = await trilium.searchNotes(
      `#noteType=${kind}`,
      { ancestorNoteId: scope, fastSearch: true, limit: 100 },
    );
    const typedHit = res.results.find((n) => sameTitle(n.title, title));
    if (typedHit) return typedHit;

    // Title-and-container fallback.
    //
    // The typed scan above only sees notes that already carry #noteType, which
    // means the exact population that needs repairing is the population dedup
    // cannot see. remember(kind="thread", title="Tracker") against an existing
    // UNTYPED note titled Tracker returned action:"created" and minted a
    // duplicate beside it — so the natural repair attempt made the problem
    // worse. Fall back to matching by title among the container's own children
    // and adopt an untyped match instead of duplicating it.
    const container = await trilium.getNote(scope).catch(() => null);
    if (!container?.childNoteIds?.length) return null;
    for (const childId of container.childNoteIds) {
      const child = await trilium.getNote(childId).catch(() => null);
      if (!child || !sameTitle(child.title, title)) continue;
      if (ownedLabel(child, "noteType")) continue; // typed and a different kind — genuinely not ours
      return child;
    }
    return null;
  }

  /** Append a dated block into a thread's day-child note, creating today's
   *  [yyyy-mm-dd] threadEntry on first append of the day — mirrors diary()'s
   *  append behavior exactly (HH:mm sub-heading, full-block-scan retry guard,
   *  fixRecordHeader). The thread BOOK's own content is never touched here;
   *  callers still own bumping the book's "updated" label, title, icon, and
   *  relations against `threadId` afterward — this only owns the child. */
  async function appendThreadEntry(
    threadId: string,
    block: string,
    d: string
  ): Promise<{ noteId: string; action: "created" | "appended" | "already_written" }> {
    const found = await trilium.searchNotes(
      `#noteType=threadEntry #created='${d}'`,
      { ancestorNoteId: threadId, fastSearch: true, limit: 1 },
    );
    const time = localNowTime();

    if (found.results[0]) {
      const noteId = found.results[0].noteId;
      const current = fixRecordHeader(await trilium.getNoteContent(noteId), "threadEntry", d).html;
      const norm = (s: string) => s.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim().toLowerCase();
      const incoming = norm(block);
      const blocks = current.split(/<h2>Addendum — \d{2}:\d{2}<\/h2>\n?/i).slice(1);
      if (incoming && blocks.some((b) => norm(b) === incoming)) return { noteId, action: "already_written" };
      await trilium.createRevision(noteId);
      await trilium.updateNoteContent(noteId, safeAppend(current, `<h2>Addendum — ${time}</h2>`, block));
      await trilium.updateLabelValue(noteId, "updated", d);
      return { noteId, action: "appended" };
    }

    const created = await trilium.createNote(
      threadId,
      `[${d}]`,
      contentFor("threadEntry", { date: d, body: `<h2>Addendum — ${time}</h2>\n${block}` })
    );
    const noteId = created.note.noteId;
    await trilium.addLabel(noteId, "noteType", "threadEntry");
    await trilium.addLabel(noteId, "created", d);
    await ensureIcon(trilium, noteId);
    return { noteId, action: "created" };
  }

  /** A collection thread has no dated children to append to: its entries are
   *  titled, maintained documents. Refuse with the two paths that do exist. */
  function collectionAppendRefusal(book: Note) {
    return err(
      "collection_thread",
      `"${book.title}" is a collection thread — it holds one titled entry per item, not dated appends.`,
      `Add an entry: remember(kind="threadEntry", thread="${book.noteId}", title, body). Change one: revise(<entry id>, section=/find=/mode=…) — memory("${book.noteId}") lists them.`
    );
  }

  // ════════════════════════════════════════════════════════════════════════════
  // SESSION
  // ════════════════════════════════════════════════════════════════════════════

  server.tool(
    "start",
    `Boot BrainLLM — once, before responding to the first message. Runs lite maintenance, opens today's diary and session notes, and returns: date and weekday, preferences and protocols in full, the other singletons as section headings with a preview (depth="full" inlines everything), today's diary and session ids, active and dormant threads with idle ages, the previous session's summary, notes changed since, and newDay on the first session of a day.`,
    {
      depth: z.enum(["digest", "full"]).optional().describe('Singleton detail: "digest" (default — section headings + preview + size) or "full" (every singleton inline; token-heavy)'),
    },
    async ({ depth }) => {
      const cfg = b();
      if (!cfg.root) {
        return txt({ status: "uninitialized", action: "Run bootstrap to create the BrainLLM structure." });
      }
      // Sweep and digest are independent — run them concurrently.
      const [hygiene, digest] = await Promise.all([
        sweep(trilium, cfg, { deep: false, dryRun: false }).catch((e): SweepReport => ({
          scanned: 0, fixed: [], transitions: [], deleted: [], flagged: [`sweep failed: ${e}`], dryRun: false,
          policy: { dormantAfterDays: cfg.policy.dormantAfterDays, archiveDormantAfterDays: cfg.policy.archiveDormantAfterDays, staleAfterDays: cfg.policy.staleAfterDays, deletionCatchupDays: cfg.policy.deletionCatchupDays ?? 7 },
        })),
        buildDigest(trilium, cfg, { depth: depth ?? "digest" }),
      ]);
      const todayStr = today();
      const weekday = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"][new Date(`${todayStr}T00:00:00Z`).getUTCDay()];

      // Ensure today's diary note exists (title [yyyy-mm-dd]).
      let diaryNoteId: string | null = null;
      let diaryPreview = "";
      if (cfg.llm.diary) {
        try {
          const existingDiary = await trilium
            .searchNotes(`#noteType=diary #created='${todayStr}'`, { ancestorNoteId: cfg.llm.diary, fastSearch: true, limit: 1 })
            .catch(() => ({ results: [] as Note[] }));
          if (existingDiary.results[0]) {
            diaryNoteId = existingDiary.results[0].noteId;
          } else {
            const created = await trilium.createNote(cfg.llm.diary, `[${todayStr}]`, contentFor("diary", { date: todayStr, body: "" }));
            diaryNoteId = created.note.noteId;
            await trilium.addLabel(diaryNoteId, "noteType", "diary");
            await trilium.addLabel(diaryNoteId, "created", todayStr);
            await ensureIcon(trilium, diaryNoteId);
          }
          if (diaryNoteId) {
            const content = await trilium.getNoteContent(diaryNoteId).catch(() => "");
            diaryPreview = toText(content, 200);
          }
        } catch { /* non-fatal */ }
      }

      // Ensure today's session note exists (title [yyyy-mm-dd]). The digest
      // serves today's note and the previous session separately — lastSession
      // is always the PREVIOUS session, never today's own stub.
      let sessionNoteId: string | null = null;
      let sessionPreview = "";
      let newDay = false;
      if (cfg.memory.sessions) {
        try {
          if (digest.todaySession) {
            sessionNoteId = digest.todaySession.id;
            const content = await trilium.getNoteContent(sessionNoteId).catch(() => "");
            sessionPreview = toText(content, 200);
            // A session note without addendum blocks = nothing logged yet today.
            newDay = !/<h2(?:\s[^>]*)?>\s*Addendum/i.test(content);
          } else {
            const created = await trilium.createNote(cfg.memory.sessions, `[${todayStr}]`, contentFor("session", { date: todayStr, body: "" }));
            sessionNoteId = created.note.noteId;
            await trilium.addLabel(sessionNoteId, "noteType", "session");
            await trilium.addLabel(sessionNoteId, "created", todayStr);
            await ensureIcon(trilium, sessionNoteId);
            newDay = true;
          }
        } catch { /* non-fatal */ }
      }

      // Fetch recent changes within the brain since the last session.
      let changesSinceLastSession: Array<{ id: string; title: string; changed: string; deleted?: true }> = [];
      if (digest.lastSession && cfg.root) {
        const sinceDate = digest.lastSession.date;
        try {
          const history = await trilium.getNoteHistory(cfg.root);
          // Deduplicate by noteId — Trilium can emit multiple events for the
          // same note on the same day (common for deletions). Prefer the entry
          // where current_isDeleted=true so the flag is never lost.
          const deduped = new Map<string, RecentChange>();
          for (const h of history.filter((h) => h.date >= sinceDate)) {
            const prev = deduped.get(h.noteId);
            if (!prev || (h.current_isDeleted && !prev.current_isDeleted)) {
              deduped.set(h.noteId, h);
            }
          }
          changesSinceLastSession = [...deduped.values()]
            .slice(0, 25)
            .map((h) => ({
              id: h.noteId,
              title: h.current_title,
              changed: h.date.slice(0, 10),
              ...(h.current_isDeleted ? { deleted: true as const } : {}),
            }));
        } catch { /* non-fatal */ }
      }

      return txt({
        status: "ready",
        today: todayStr,
        weekday,
        master: digest.master,
        llm: [...digest.llm, ...(diaryNoteId ? [{ slot: "diary", id: diaryNoteId, preview: diaryPreview }] : [])],
        session: sessionNoteId ? { id: sessionNoteId, preview: sessionPreview } : null,
        activeThreads: digest.workingSet,
        dormantThreads: digest.reviewQueue.length
          ? { note: "These threads went dormant from inactivity. Mention them if relevant; revise() or resolve() to act.", items: digest.reviewQueue }
          : [],
        lastSession: digest.lastSession ?? null,
        changesSinceLastSession: changesSinceLastSession.length ? changesSinceLastSession : undefined,
        ...(newDay ? { newDay: true, newDayHint: "First session of the day — call day() for the sweep payload (previous session + log + changes in one call)." } : {}),
        ...((depth ?? "digest") === "digest"
          ? { depthHint: "Preferences and protocols came back IN FULL — the two needed whole to orient from the first message. Biography, goals and responsibilities are section headings + preview; pull one with master(which) / llm(which), or a single section with their section= parameter. start(depth=\"full\") serves all five inline." }
          : {}),
        hygiene: { scanned: hygiene.scanned, fixed: hygiene.fixed.length, transitions: hygiene.transitions, flagged: hygiene.flagged, ...(hygiene.suppressed ? { suppressed: hygiene.suppressed } : {}) },
      });
    }
  );

  server.tool(
    "session",
    `Mandatory pre-close step: call before close(). Returns the six singletons as {id, lastModified} stubs (full=true inlines them), today's diary as {id, blocks, size}, runs the lite maintenance sweep, and returns pending= (what each remaining step actually has to do), audit= (do the singletons agree, and do the LLM singletons still serve the master ones) and next[]. Idempotent.

Protocol: 1. update master singletons with what the session taught about the user; 2. update LLM singletons with what it taught about yourself; 3. addendum(); 4. maintain(); 5. remarks(); 6. diary(); 7. close(). close() refuses until 3–6 ran and session → remarks → diary held. scope="agent" drops steps 1–2 for scoped or autonomous runs.`,
    {
      date: z.string().optional().describe("ISO date YYYY-MM-DD (default: today)"),
      full: z.boolean().optional().describe("Inline every singleton's content and the diary body (default: stubs only)"),
      scope: z.enum(["interactive", "agent"]).optional().describe('"agent" for a scoped/autonomous run whose brief excludes the user\'s personal singletons — omits those steps from next[] (default: "interactive")'),
      light: z.boolean().optional().describe("Deprecated — light is now the default; accepted for compatibility and ignored"),
    },
    async ({ date, full, scope }) => {
      const d = checkedDate(date);
      const cfg = b();
      if (!cfg.master.root || !cfg.llm.root)
        throw new Error("BrainLLM not bootstrapped — run bootstrap.");
      // The gate is marked only after every read/sweep above succeeds.

      const fetchSingleton = async (id: string) => {
        if (!full) {
          const note = await trilium.getNote(id);
          const relations = relationSnippet(note);
          return { id, lastModified: note.dateModified.slice(0, 10), ...(relations ? { relations } : {}) };
        }
        const [note, content] = await Promise.all([
          trilium.getNote(id),
          trilium.getNoteContent(id).catch(() => ""),
        ]);
        const relations = relationSnippet(note);
        return { id, lastModified: note.dateModified.slice(0, 10), content, ...(relations ? { relations } : {}) };
      };

      // Every SingletonKind belongs here. selfcorrection was added to the kind
      // vocabulary, the router, the config, bootstrap, the templates, llm(),
      // llm_recall() and the start digest in V12 — and missed HERE, so the one
      // singleton that records what went wrong was the one the closing audit
      // could not see. A guard test now asserts this list covers SingletonKinds;
      // adding a singleton without adding it here fails that test.
      const [biography, goals, preferences, responsibilities, protocols, selfcorrection] = await Promise.all([
        fetchSingleton(cfg.master.biography),
        fetchSingleton(cfg.master.goals),
        fetchSingleton(cfg.master.preferences),
        fetchSingleton(cfg.llm.responsibilities),
        fetchSingleton(cfg.llm.protocols),
        // Guarded: a brain bootstrapped before V12 has no id here until
        // bootstrap() heals it, and pre-close must never fail on that.
        cfg.llm.selfcorrection ? fetchSingleton(cfg.llm.selfcorrection) : Promise.resolve(null),
      ]);

      // Today's diary entry. Light mode returns a stub: the id (which is all
      // diary() needs) plus how much is already written. Inlining a whole day's
      // entry costs real context on a day several addendum blocks deep, and a
      // second same-day close is exactly when that context is scarcest.
      let diaryEntry: { id: string; content?: string; blocks?: number; size?: number } | null = null;
      if (cfg.llm.diary) {
        const diarySearch = await trilium
          .searchNotes(`#noteType=diary #created='${d}'`, { ancestorNoteId: cfg.llm.diary, fastSearch: true, limit: 1 })
          .catch(() => ({ results: [] as Note[] }));
        if (diarySearch.results[0]) {
          const id = diarySearch.results[0].noteId;
          const content = await trilium.getNoteContent(id).catch(() => "");
          diaryEntry = full
            ? { id, content }
            : { id, blocks: (content.match(/<h2(?:\s[^>]*)?>\s*Addendum/gi) ?? []).length, size: content.length };
        }
      }

      // Lightweight maintenance sweep (non-fatal).
      const hygiene = await sweep(trilium, cfg, { deep: false, dryRun: false }).catch(() => null);

      // What is actually pending, measured rather than listed.
      //
      // The close protocol is roughly a dozen calls landing exactly when context
      // is scarcest, and next[] recited all of them unconditionally — including
      // the ones with nothing to do. Every value below was already computed by
      // this call before it returned; reporting them lets the remaining context
      // go to the diary and the log, which are the two things only the agent
      // can write.
      // The counter and addendum()'s search must agree on what a pending
      // addendum IS, or session() manufactures a step for the one field that
      // exists to prevent empty steps — `pending.addendums: 6` against
      // `addendum() found: 0` was confirmed three times before this was read
      // side by side. Both now require the structural marker (an h2–h4
      // "Addendum —" heading), not the bare word, which prose mentions of the
      // tool matched freely.
      const pendingAddendums = await trilium
        .searchNotes("#noteType note.content *=* 'Addendum'", { ancestorNoteId: cfg.root, fastSearch: false, limit: 40 })
        .then(async (r) => {
          const candidates = r.results.filter((n) => {
            const kind = labelOf(n, "noteType");
            return kind && !["session", "diary", "log", "threadEntry", "thread"].includes(kind);
          });
          const contents = await Promise.all(
            candidates.map((n) => trilium.getNoteContent(n.noteId).catch(() => ""))
          );
          return contents.filter(hasAddendumMarker).length;
        })
        .catch(() => null);

      // A Record keyed by SingletonKind, not a list — and that is the whole
      // point. Record<SingletonKind, …> is exhaustive, so a kind added to the
      // vocabulary and forgotten here fails to COMPILE. The list this replaced
      // did not, which is how selfcorrection reached production wired into
      // eight places and missing from the one that runs at close.
      const singletonStubs: Record<SingletonKind, { lastModified: string } | null> = {
        biography, goals, preferences, responsibilities, protocols, selfcorrection,
      };
      const touchedToday = (Object.keys(singletonStubs) as SingletonKind[])
        .filter((k) => singletonStubs[k]?.lastModified === d);

      const pending = {
        addendums: pendingAddendums === null ? "unknown" : pendingAddendums,
        maintenanceFlags: hygiene?.flagged.length ?? 0,
        diaryBlocksToday: (diaryEntry as { blocks?: number } | null)?.blocks ?? 0,
        singletonsWrittenToday: touchedToday.length ? touchedToday : "none",
      };

      await markStep("session", d);
      const scoped = scope === "agent";
      return txt({
        date: d,
        ...(scoped ? { scope: "agent" } : {}),
        ...(!full ? { mode: "light", note: "Singleton content and the diary body are omitted (default) — fetch via master()/llm() only where lastModified indicates a revision is needed; start() already served all singletons in full, and diary() needs only the id." } : {}),
        master: { biography, goals, preferences },
        llm: { responsibilities, protocols, ...(selfcorrection ? { selfcorrection } : {}) },
        diary: diaryEntry,
        maintenance: hygiene
          ? { scanned: hygiene.scanned, fixed: hygiene.fixed.length, transitions: hygiene.transitions, flagged: hygiene.flagged, ...(hygiene.suppressed ? { suppressed: hygiene.suppressed } : {}) }
          : "skipped",
        pending,
        // The audit that nothing else performs. consistency() checks the brain
        // against itself and maintain() checks structure; neither asks whether
        // the LLM's operating rules still SERVE what the user's goals and
        // preferences call for. That is a semantic question, it can only be
        // answered by reading, and pre-close is when the session's evidence for
        // it is freshest.
        audit: scoped
          ? undefined
          : {
              consistency: "Read every singleton and check for ambiguity, internal contradiction, or claims that disagree across them. Fix what you find with revise() BEFORE close(), so the log records a brain that already agrees with itself.",
              alignment: "Then check correlation, not just agreement: do responsibilities and protocols actually serve what biography, goals and preferences describe? A protocol can be perfectly consistent and still be serving a goal that has moved.",
              readThem: `master("biography"|"goals"|"preferences") and llm("responsibilities"|"protocols"|"selfcorrection") — or one section at a time with section=. Written today: ${touchedToday.length ? touchedToday.join(", ") : "none"}.`,
            },
        next: [
          ...(scoped
            ? ["Scoped run — the user's master singletons and your LLM singletons are OUT of scope and deliberately not listed here."]
            : [
                "Update master singletons (biography / goals / preferences) via revise() with session observations about the user.",
                "Update LLM singletons (responsibilities / protocols / selfcorrection) via revise() with session observations about yourself — selfcorrection takes what you got WRONG and what generalises from it, not what you did.",
              ]),
          ...(scoped
            ? []
            : ["Audit the singletons against each other and against each other's PURPOSE — see audit= above. This is the step that catches an operating rule still serving a goal that has moved."]),
          scoped
            ? `Call addendum() — fold only what is in your lane; leaving out-of-scope addendums for the next interactive session is correct, and the call itself satisfies the gate. (${pending.addendums} note(s) currently carry addendum markers.)`
            : pending.addendums === 0
            ? "Call addendum() — 0 notes currently carry addendum markers, so this should come back clean; the call still satisfies the gate."
            : `Call addendum() — ${pending.addendums} note(s) carry addendum markers; fold each into its section.`,
          scoped
            ? "Call maintain() — audit brain hygiene; pass domain= to keep the flags in your lane."
            : pending.maintenanceFlags === 0
            ? "Call maintain() — the lite sweep just ran clean, so this is a formality unless you want deep=true."
            : `Call maintain() — the lite sweep already flagged ${pending.maintenanceFlags} item(s), listed above.`,
          "Call remarks() — get the diary cues: your experience, opinions, and existence this session, plus BrainLLM remarks.",
          "Call diary() — write the day's unfiltered record with the cues in hand; the gate counts it only after remarks().",
          "Call close() — commit the session log (mandatory, last). Refuses until every step ran and session → remarks → diary held; pass force=true only when a skipped step genuinely has nothing to log.",
        ],
      });
    }
  );

  server.tool(
    "remarks",
    `Diary cues, called after session() and before diary(): an experience bank (the session from the inside, your opinions, being what you are here) and a BrainLLM bank (walls, bugs, usability, roadmap). Answer them as prose in diary(); skip a cue rather than pad it. The call marks its close-gate step.`,
    {},
    async () => {
      const cfg = b();
      if (!cfg.root) return txt({ status: "uninitialized", action: "Run bootstrap first." });

      await markStep("remarks");
      return txt({
        cues: {
          experience: [
            "1. Experience — what was this session actually like from the inside? The work, the flow, what happened and how it went.",
            "2. Opinions — what do you genuinely think about the decisions, direction, or content of this session — including anything you'd push back on or see differently?",
            "3. Existence — observations on being what you are, here: your role, constraints, tools, the collaboration, anything about operating in this environment worth recording honestly.",
          ],
          brainllm: [
            "4. Capabilities — did you hit a wall because a BrainLLM tool or capability didn't exist? What would you have used if it did?",
            "5. Issues & Bugs — what broke, misbehaved, or returned something wrong or confusing?",
            "6. Usability & Efficiency — which tools or descriptions could serve you better; any redundant reads/writes, token-heavy returns, or slow multi-round-trip calls?",
            "7. Roadmap — does BrainLLM feel like the best possible native memory/brain for an LLM? What's the next concrete step — tools to add, prune, or consolidate?",
          ],
        },
        next: [
          "Write today's diary via diary(body) — unfiltered first-person prose: experience first, BrainLLM remarks after. Skip any cue with nothing real to say.",
          "Then call close() to commit the session log.",
        ],
      });
    }
  );

  server.tool(
    "close",
    `Commit the session log — once, last, after the session() protocol. Refuses unless session(), addendum(), maintain(), remarks() and diary() ran and session → remarks → diary held (force=true bypasses a step with genuinely nothing to do; bypassed steps are reported). identity= is required. Writes a timestamped block to today's [yyyy-mm-dd] session note (title= becomes its heading), regenerates the daily log, backs up the database and resets the gate. continuing=true is a second close the same day, skipping the ceremonial re-run.`,
    {
      summary: z.string().describe("What happened this session — factual, concise prose"),
      title: z.string().optional().describe("Short session title — appears as an <h2> heading above Summary"),
      identity: z.string().describe('Identification line "LLM · environment · agent/mode [· Run N]" — rendered as the block\'s h3 (required)'),
      learned: z.array(z.string()).optional().describe("Durable things learned (also remember() them as knowledge)"),
      icon: z.string().optional().describe("Display icon for the session note — a boxicons class or bare name; normalized server-side"),
      date: z.string().optional().describe("ISO date YYYY-MM-DD (default: today)"),
      backup: z.boolean().optional().describe("Trigger DB backup (default: true)"),
      continuing: z.boolean().optional().describe("A second close on a day already closed — skips the gate's ceremonial re-run. Refused unless today's session note already carries an addendum."),
      force: z.boolean().optional().describe("Bypass the pre-close gate — only when a missing step truly has nothing to log"),
    },
    async ({ summary, title, identity, learned, icon, date, backup, continuing, force }) => {
      const gateDate = checkedDate(date);
      const cfgForGate = b();

      // A same-day continuation: verify it really is one before letting it past
      // the gate — an unearned skip on the FIRST close of a day is exactly what
      // the gate exists to prevent.
      let continued = false;
      if (continuing) {
        const prior = await trilium.searchNotes(
          `#noteType=session #created='${gateDate}'`,
          { ancestorNoteId: cfgForGate.memory.sessions, fastSearch: true, limit: 1 },
        );
        const priorContent = prior.results[0]
          ? await trilium.getNoteContent(prior.results[0].noteId)
          : "";
        continued = /<h2(?:\s[^>]*)?>\s*Addendum/i.test(priorContent);
        if (!continued) {
          return err(
            "not_a_continuation",
            `continuing=true needs a session note for ${gateDate} that already carries an addendum — there is none, so this is the day's first close.`,
            "Run the full pre-close protocol: session() → addendum() → maintain() → remarks() → diary() → close()."
          );
        }
      }

      const gate = await readGate(gateDate);
      const missing = continued ? [] : REQUIRED_PRECLOSE_STEPS.filter((step) => !gate.has(step));
      if (missing.length && !force) {
        return err(
          "preclose_incomplete",
          `close() refused — these pre-close steps haven't run yet this session: ${missing.join(", ")}.`,
          `Call ${missing.map((s) => `${s}()`).join(", ")} first, or pass force=true if one of them genuinely has nothing to log.`
        );
      }

      // Ordering: session → remarks → diary, judged on each step's LAST call.
      // The diary is the day's closing record, written with the remarks cues in
      // hand; a session() re-run restarts the sequence. Only checkable when all
      // three steps are present (missing steps are the previous error, or a
      // forced bypass).
      const seq = (step: string) => gate.get(step) ?? 0;
      const orderOk =
        continued || missing.length > 0 || (seq("session") < seq("remarks") && seq("remarks") < seq("diary"));
      if (!orderOk && !force) {
        return err(
          "preclose_out_of_order",
          "close() refused — the gate requires session() → remarks() → diary() in that order (last calls). The diary is the day's closing record, written with the self-analysis cues in hand.",
          "Call remarks() for the cues (re-run it if session() came after it), then diary() with the day's record, then close()."
        );
      }

      const d = checkedDate(date);
      const cfg = b();
      const parentId = cfg.memory.sessions;
      if (!parentId) throw new Error("BrainLLM not bootstrapped — run bootstrap.");

      const { html: summaryHtml, warnings } = renderBody(summary);
      // Canonical session structure: every addendum block opens with the
      // identification line. Enforced — identity= or a summary that already
      // leads with the h3.
      if (!identity && !leadingIdentification(summaryHtml)) {
        return err(
          "missing_identity",
          "Session addendums open with the canonical identification line (h3): \"LLM · environment · agent/mode [· Run N]\".",
          'Pass identity="Claude … · <environment> · <agent/mode>" on close() — the server renders it as the block\'s h3.'
        );
      }
      const identityBlock = identity && !leadingIdentification(summaryHtml) ? `<h3>${escapeHtml(identity)}</h3>\n` : "";
      const titleBlock = title ? `<h2>${escapeHtml(title)}</h2>\n` : "";
      const sections: string[] = [`${identityBlock}${titleBlock}<h2>Summary</h2>\n${summaryHtml}`];
      if (learned?.length) {
        sections.push(`<h2>Learned</h2><ul>${learned.map((x) => `<li>${escapeHtml(x)}</li>`).join("")}</ul>`);
      }
      const contentBlock = sections.join("\n");

      // Idempotent per date — search by label, not by title.
      const existing = await trilium.searchNotes(
        `#noteType=session #created='${d}'`,
        { ancestorNoteId: cfg.memory.sessions, fastSearch: true, limit: 5 },
      );

      let noteId: string;
      let action: "created" | "appended" | "already_written";
      if (existing.results[0]) {
        noteId = existing.results[0].noteId;
        // Dated-record header guard: correct a stale meta-line date (rewrite
        // residue) to the note's canonical date before appending.
        const current = fixRecordHeader(await trilium.getNoteContent(noteId), "session", d).html;
        const time = localNowTime();
        const hasContent = current.includes("<h2>Summary</h2>") || /<h2>addendum/i.test(current);
        if (hasContent && isDuplicateAppend(current, contentBlock)) {
          action = "already_written";
        } else if (hasContent) {
          await trilium.createRevision(noteId);
          await trilium.updateNoteContent(noteId, safeAppend(current, `<h2>Addendum — ${time}</h2>`, contentBlock));
          action = "appended";
        } else {
          // Records are chronological: even the first commit of the day lands
          // as a timestamped addendum block, so every entry reads the same.
          await trilium.createRevision(noteId);
          await trilium.updateNoteContent(noteId, contentFor("session", { date: d, body: `<h2>Addendum — ${time}</h2>\n${contentBlock}` }));
          action = "created";
        }
      } else {
        const time = localNowTime();
        const created = await trilium.createNote(parentId, `[${d}]`, contentFor("session", { date: d, body: `<h2>Addendum — ${time}</h2>\n${contentBlock}` }));
        noteId = created.note.noteId;
        await trilium.addLabel(noteId, "noteType", "session");
        await trilium.addLabel(noteId, "created", d);
        action = "created";
      }

      const iconSet = await applyIcon(noteId, icon);

      // Deletion catch-up BEFORE today's own log: a note deleted earlier in
      // the window (or during a no-close gap) gets its day's log regenerated,
      // and today's regeneration — right below — sees today's deletions
      // through the same change feed. Without this a deletion landing after
      // the day's close was reported nowhere, which is how notes could vanish
      // without any tool noticing.
      const caughtUp = await catchUpDeletions(trilium, cfg, d).catch(() => null);

      const logReport = await generateDailyLog(trilium, cfg, d);

      // Wire session ↔ log with ~references relations — genuinely idempotent:
      // check each side's existing edges first (the V8 unconditional adds
      // stacked 8 duplicate edges per direction over a day of closes).
      if (logReport?.noteId) {
        const hasEdge = (n: Note | null, to: string) =>
          !!n?.attributes.some((a) => a.type === "relation" && a.name === "references" && a.value === to && a.noteId === n.noteId);
        const [sessNote, logNote] = await Promise.all([
          trilium.getNote(noteId).catch(() => null),
          trilium.getNote(logReport.noteId).catch(() => null),
        ]);
        if (!hasEdge(sessNote, logReport.noteId)) await trilium.addRelation(noteId, "references", logReport.noteId).catch(() => null);
        if (!hasEdge(logNote, noteId)) await trilium.addRelation(logReport.noteId, "references", noteId).catch(() => null);
      }

      let backupStatus: "disabled" | "completed" | "failed" = "disabled";
      let backupName = `brainllm-${d}`;
      if (backup !== false) {
        try {
          await trilium.createBackup(backupName);
          backupStatus = "completed";
        } catch {
          backupStatus = "failed";
        }
      }

      await clearGate(d);

      return txt({
        action,
        noteId,
        date: d,
        backup: backupName,
        backupStatus,
        log: logReport ? `${logReport.action} (${logReport.created}c/${logReport.updated}u/${logReport.deleted}d)` : "skipped",
        ...(caughtUp?.coverage === "unknown"
          ? { deletionCatchUp: "unknown — Trilium's deletion history could not be read; the configured catch-up window is not fully verified" }
          : caughtUp && caughtUp.deletionsFound
          ? { deletionCatchUp: `${caughtUp.deletionsFound} deletion(s) caught up — logs regenerated for: ${caughtUp.regenerated.join(", ")}` }
          : {}),
        ...(iconSet ? { icon: iconSet } : {}),
        ...(continued ? { continuing: true } : {}),
        ...(missing.length || !orderOk
          ? { bypassed: [...missing, ...(!orderOk ? ["ordering(session→remarks→diary)"] : [])] }
          : {}),
        ...(warnings.length ? { sanitized: warnings } : {}),
      });
    }
  );

  server.tool(
    "backup",
    `Named database snapshot. close() already backs up; use this before a large restructure.`,
    {
      name: z.string().optional().describe("Backup name without extension (default: brainllm-{today}). Use a descriptive name for milestones."),
    },
    async ({ name }) => {
      const d = today();
      const backupName = name ?? `brainllm-${d}`;
      try {
        await trilium.createBackup(backupName);
        return txt({ ok: true, backup: backupName, backupStatus: "completed", date: d });
      } catch (error) {
        return txt({ ok: false, backup: backupName, backupStatus: "failed", error: error instanceof Error ? error.message : String(error), date: d });
      }
    }
  );

  // ════════════════════════════════════════════════════════════════════════════
  // DIARY
  // ════════════════════════════════════════════════════════════════════════════

  server.tool(
    "diary",
    `Write to today's diary: your unfiltered first-person record of the session — experience, opinions, remarks on existing here — then remarks on BrainLLM itself. identity= required. Every write lands as a timestamped block. The close gate counts it only when its last call came after session() and remarks().`,
    {
      body: z.string().describe("What to record — first-person prose, honest and unfiltered"),
      identity: z.string().describe('Identification line "LLM · environment · agent/mode [· Run N]" — rendered as the block\'s h3 (required)'),
      icon: z.string().optional().describe('Display icon for the day\'s entry — a boxicons class or bare name; normalized server-side'),
      date: z.string().optional().describe("ISO date YYYY-MM-DD (default: today)"),
    },
    async ({ body, identity, icon, date }) => {
      const d = checkedDate(date);
      const cfg = b();
      const parentId = cfg.llm.diary;
      if (!parentId) throw new Error('BrainLLM not bootstrapped — run bootstrap.');
      const sanitized = renderBody(body);
      const warnings = sanitized.warnings;
      // Canonical diary structure: every addendum block opens with the
      // identification line. Enforced — identity= or a body that already
      // leads with the h3.
      if (!identity && !leadingIdentification(sanitized.html)) {
        return err(
          "missing_identity",
          "Diary addendums open with the canonical identification line (h3): \"LLM · environment · agent/mode [· Run N]\".",
          'Pass identity="Claude … · <environment> · <agent/mode>" on diary() — the server renders it as the block\'s h3.'
        );
      }
      const html = identity && !leadingIdentification(sanitized.html) ? `<h3>${escapeHtml(identity)}</h3>\n${sanitized.html}` : sanitized.html;

      const found = await trilium.searchNotes(
        `#noteType=diary #created='${d}'`,
        { ancestorNoteId: parentId, fastSearch: true, limit: 1 },
      );

      if (found.results[0]) {
        const noteId = found.results[0].noteId;
        // Dated-record header guard: correct a stale meta-line date before appending.
        const current = fixRecordHeader(await trilium.getNoteContent(noteId), "diary", d).html;
        const time = localNowTime();

        // Idempotency guard: the diary note is one-per-day, so every addendum
        // block in it is today's. If ANY block already carries this exact
        // normalised content, the call is a retry — skip the write. Scanning
        // all blocks (rather than only the last within a time window) also
        // catches a duplicate that landed behind an interleaved write, the
        // double-append observed on 2026-07-05.
        const norm = (s: string) => s.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim().toLowerCase();
        const incoming = norm(html);
        const blocks = current.split(/<h2>Addendum — \d{2}:\d{2}<\/h2>\n?/i).slice(1);
        if (incoming && blocks.some((b) => norm(b) === incoming)) {
          await markStep("diary", d);
          return txt({ action: "already_written", noteId, date: d });
        }

        await trilium.createRevision(noteId).catch(() => null);
        await trilium.updateNoteContent(noteId, safeAppend(current, `<h2>Addendum — ${time}</h2>`, html));
        await trilium.updateLabelValue(noteId, "updated", d);
        const iconSet = await applyIcon(noteId, icon);
        await markStep("diary", d);
        return txt({ action: "appended", noteId, date: d, ...(iconSet ? { icon: iconSet } : {}), ...(warnings.length ? { sanitized: warnings } : {}) });
      }

      // Records are chronological: even the first write of the day lands as a
      // timestamped addendum block, so every entry in a diary note reads the same.
      const time = localNowTime();
      const created = await trilium.createNote(parentId, `[${d}]`, contentFor("diary", { date: d, body: `<h2>Addendum — ${time}</h2>\n${html}` }));
      const noteId = created.note.noteId;
      await trilium.addLabel(noteId, "noteType", "diary");
      await trilium.addLabel(noteId, "created", d);
      const iconSet = await applyIcon(noteId, icon);
      await markStep("diary", d);
       return txt({ action: "created", noteId, date: d, location: locationLabel("diary"), ...(iconSet ? { icon: iconSet } : {}), ...(warnings.length ? { sanitized: warnings } : {}) });
    }
  );

  // ════════════════════════════════════════════════════════════════════════════
  // REMEMBER / RECALL
  // ════════════════════════════════════════════════════════════════════════════

  server.tool(
    "remember",
    `Store something the moment it matters; the server owns placement, labels and dedup.

Kinds: biography | goals | preferences | responsibilities | protocols (singletons, upsert) · thread (goal= required to create; shape="collection" for a titled-entry thread; appends need identity=) · threadEntry (a titled entry in a collection thread: thread= + title) · user (knowledge about the user) · information (domain= + title) · sources (domain=; revision=[…] upserts rows).

Collection kinds dedup by title — mustCreate=true refuses instead of adopting an existing note, and check action= on the receipt. connect=[{relation, toNoteId}] wires relations in the same call. diary/session/log/claim/domain have dedicated paths.`,
    {
      kind: z.enum(Kinds).describe("What kind of memory this is"),
      title: z.string().optional().describe("Title — collection kinds (thread/knowledge/information sub-category); ignored for singletons & sources"),
      body: z.string().optional().describe("Content: plain text, markdown, or HTML"),
      goal: z.string().optional().describe("thread creation: the goal statement — REQUIRED for a new thread (query the user for it); becomes the Context → Goal section"),
      shape: z.enum(["dated", "collection"]).optional().describe('thread creation: "dated" (default — one [yyyy-mm-dd] child per active day) or "collection" (one titled child per item, e.g. an ideas list)'),
      thread: z.string().optional().describe('kind="threadEntry" only: the collection thread\'s id — adds a titled child to it'),
      identity: z.string().optional().describe('Appending to a dated thread: the identification line "LLM · environment · agent/mode [· Run N]" (required)'),
      domain: z.string().optional().describe("knowledge: the domain name for information/sources (auto-created complete with its Sources note)"),
      revision: z.array(z.object({
        source: z.string().describe("Must exactly match how the source is introduced in the Sources list — this is the upsert key"),
        marker: z.string().describe('"❇️" (discovered/credible) or "✅" (used)'),
        date: z.string().optional().describe("ISO date (default: today)"),
      })).optional().describe("kind=sources: upsert Revision rows by source name"),
      topics: z.array(z.string()).optional().describe("Topic tags — slugged server-side"),
      supersedes: z.string().optional().describe("noteId this replaces — old note is archived and wired supersedes"),
      mandate: z.boolean().optional().describe("kind=information: flag the note as a standing brief a session must follow (#mandate)"),
      mustCreate: z.boolean().optional().describe("Refuse instead of adopting a note that already has this title"),
      strict: z.boolean().optional().describe("Refuse the write when the body needs structural repair (unclosed tags, <br> runs) instead of accepting the repaired form"),
      connect: z.array(z.object({
        relation: z.enum(RelationTypes),
        toNoteId: z.string(),
      })).optional().describe("Relations to wire from this note in the same call — same semantics as connect() (idempotent, worksWith wired both ways)"),
      icon: z.string().optional().describe('Display icon — a boxicons class ("bx bx-brain") or a bare name ("brain"); normalized server-side'),
      date: z.string().optional().describe("ISO date override (default: today)"),
    },
    async ({ kind, title, body, goal, shape, thread, identity, domain, revision, topics, supersedes, mandate, mustCreate, strict, connect: connectRels, icon, date }) => {
      /** mustCreate turns adoption into a refusal.
       *
       *  Dedup-by-title is what makes remember() idempotent, and it is also a
       *  loaded weapon: "Current State", "Sources", "Technology Stack" and
       *  "Product and Business" each exist in four or more domains, so a caller
       *  that believes it is creating a note can silently REPLACE one. That is
       *  not hypothetical — it cost an 8,259-byte note, recovered from a
       *  revision only because someone checked. The receipt said action:
       *  "updated" and nothing was wrong with it; the caller simply was not
       *  expecting to have written over anything. */
      const refuseAdoption = (existingId: string, existingTitle: string, where: string) =>
        err(
          "already_exists",
          `A ${kind} note titled "${existingTitle}" already exists ${where} [${existingId}] — mustCreate=true refuses to adopt it.`,
          `Read it first with ${kind === "thread" ? "memory" : "knowledge"}(${existingId}). To add to it deliberately, re-run without mustCreate, or use revise(${existingId}, …). To keep both, pick a title that distinguishes them.`
        );
      const opts: RememberOpts = { domain, topics, date, ...(mandate ? { mandate: true } : {}) };
      const d = checkedDate(date);
      const { html, warnings: sanitizeWarnings } = renderBody(body ?? "");

      // strict= mirrors revise(): a body whose tag structure the sanitizer had
      // to repair is a refusal, not a receipt field the caller reads as
      // reassurance. Nothing has been written at this point.
      if (strict) {
        const repairs = repairedStructure(sanitizeWarnings);
        if (repairs.length) {
          return err(
            "body_repaired",
            `strict=true: the body needed structural repair and nothing was written — ${repairs.join("; ")}.`,
            "Fix the markup (close the open tags, use paragraphs instead of <br> runs) and re-send, or drop strict= to accept the repaired form."
          );
        }
      }

      // Threads carry exactly one Resolution — the bottom section, owned by
      // resolve(). A body smuggling its own is refused before any write.
      if (
        kind === "thread" &&
        /<h[2-4](?:\s[^>]*)?>\s*Resolution\s*<\/h[2-4]>/i.test(html) &&
        !isOpenResolutionOnly(html)
      ) {
        return err(
          "structure_violation",
          "Thread bodies must not carry a FILLED or duplicate Resolution — a thread has exactly one Resolution, at the bottom, owned by resolve(). A single empty '— open —' placeholder is the canonical skeleton and is accepted.",
          "Remove the Resolution content from the body; close the thread with resolve(noteId, outcome) when the work completes."
        );
      }

      /** Append content into a single maintained note. Returns false (no-op) if the
       *  last addendum already carries the same normalised content — retry-safe. */
      const upsertInto = async (id: string): Promise<boolean> => {
        const current = await trilium.getNoteContent(id);
        if (isDuplicateAppend(current, html)) return false;
        await trilium.createRevision(id).catch(() => null);
        await trilium.updateNoteContent(id, safeAppend(current, `<h2>Addendum — ${d}</h2>`, html));
        await trilium.updateLabelValue(id, "updated", d);
        return true;
      };

      /** Wire caller-requested relations from a note — same semantics as connect():
       *  idempotent, symmetric relations wired both ways. Returns the edges wired
       *  (or already present) so receipts can surface them. */
      const wireRequested = async (noteId: string): Promise<RelationEdge[]> => {
        if (!connectRels?.length) return [];
        const from = await trilium.getNote(noteId).catch(() => null);
        if (!from) return [];
        const wiredEdges: RelationEdge[] = [];
        for (const { relation, toNoteId } of connectRels) {
          if (toNoteId === noteId) continue;
          const exists = from.attributes.some((a) => isOwnedAttribute(from, a) && a.type === "relation" && a.name === relation && a.value === toNoteId);
          if (!exists) await trilium.addRelation(noteId, relation, toNoteId).catch(() => null);
          if (SymmetricRelations.includes(relation)) {
            const to = await trilium.getNote(toNoteId).catch(() => null);
            if (to && !to.attributes.some((a) => isOwnedAttribute(to, a) && a.type === "relation" && a.name === relation && a.value === noteId)) {
              await trilium.addRelation(toNoteId, relation, noteId).catch(() => null);
            }
          }
          wiredEdges.push({ relation, toNoteId });
        }
        return wiredEdges;
      };

      /** Orphan-prevention nudge for a freshly-created connectable note. */
      const ORPHAN_HINT =
        "Unconnected — wire a real relation now with connect() (or pass connect=[{relation, toNoteId}] on remember) so this note doesn't surface as an orphan in maintain(deep=true).";

      // 1 ── Global singletons: one fixed maintained note (biography, goals, …).
      if (isSingleton(kind)) {
        const id = kindHome(b(), kind);
        if (!id) throw new Error(`BrainLLM not bootstrapped for "${kind}" — run bootstrap`);
        const wrote = await upsertInto(id);
        const connected = await wireRequested(id);
        const iconSet = await applyIcon(id, icon);
        const relations = relationSnippet(await trilium.getNote(id));
        return txt({ action: wrote ? "maintained" : "already_written", noteId: id, kind, location: locationLabel(kind), ...(connected.length ? { connected } : {}), ...(iconSet ? { icon: iconSet } : {}), ...(relations ? { relations } : {}), ...(sanitizeWarnings.length ? { sanitized: sanitizeWarnings } : {}) });
      }

      // 2 ── Per-domain singleton: the one Sources note in a domain. Domains
      //      are born complete (resolveDomain creates the canonical Sources
      //      note with the book), so writes here MERGE into the Sources
      //      section — a maintained clean document, never addendum stacks.
      if (kind === "sources") {
        if (!domain)
          return err("missing_param", 'kind="sources" requires a domain.', 'Call remember(kind="sources", domain="<domain name>", body="...")');
        const { domainId, domainTitle, createdDomain, sourcesId } = await resolveDomain(trilium, b(), domain);
        const found = sourcesId
          ? { results: [] as Note[] }
          : await trilium
              .searchNotes("#noteType=sources", { ancestorNoteId: domainId, fastSearch: true, limit: 1 })
              .catch(() => ({ results: [] as Note[] }));
        let sid = sourcesId ?? found.results[0]?.noteId;
        let wrote = false;
        let sourceMerge: { mergedIntoGroups?: string[]; newGroups?: string[] } = {};
        if (!sid) {
          // Legacy domain without a Sources note — create the canonical one.
          const created = await trilium.createNote(domainId, "Sources", contentFor("sources", { date: d, body: html, domain: domainTitle }));
          sid = created.note.noteId;
          for (const l of labelPlan("sources", opts, d)) {
            await trilium.addLabel(sid, l.name, l.value, l.inheritable ?? false);
          }
          wrote = true;
        } else if (html && toText(html, 50)) {
          const current = await trilium.getNoteContent(sid);
          if (!current.includes(html)) {
            await trilium.createRevision(sid).catch(() => null);
            // Group-by-group, not a wholesale append: appending an incoming
            // block under Sources created a SECOND copy of any h3 the note
            // already had, so re-filing under an existing group split it in two
            // instead of adding to it.
            const merged = mergeUnderSection(current, html, "Sources");
            sourceMerge = { ...(merged.mergedInto.length ? { mergedIntoGroups: merged.mergedInto } : {}), ...(merged.appended.length ? { newGroups: merged.appended } : {}) };
            const stamped = bumpLastUpdated(merged.html, d);
            await trilium.updateNoteContent(sid, stamped.html);
            await trilium.updateLabelValue(sid, "updated", d);
            wrote = true;
          }
        }

        // Revision rows are upserted by source name, never appended — this is
        // what keeps the table current-state instead of growing a new row
        // every time the same source gets re-verified.
        const revisionChanges: string[] = [];
        if (sid && revision?.length) {
          let current = await trilium.getNoteContent(sid);
          let changed = false;
          for (const row of revision) {
            const result = upsertTableRow(current, "Revision", row.source, [row.marker, row.date ?? d]);
            if (result.matched || result.created) {
              current = result.html;
              changed = true;
              revisionChanges.push(`${result.matched ? "updated" : "added"}: ${row.source}`);
            }
          }
          if (changed) {
            await trilium.createRevision(sid).catch(() => null);
            const stamped = bumpLastUpdated(current, d);
            await trilium.updateNoteContent(sid, stamped.html);
            await trilium.updateLabelValue(sid, "updated", d);
            wrote = true;
          }
        }

        const connected = await wireRequested(sid);
        const iconSet = await applyIcon(sid, icon);
        const sidNote = await trilium.getNote(sid).catch(() => null);
        const relations = sidNote ? relationSnippet(sidNote) : undefined;

        // The Sources note's own state, returned so the next call doesn't need
        // a full read to know it. Revision rows are keyed by exact source
        // string, which is unguessable without seeing them; and the skeleton
        // ships with an empty placeholder row that nothing forces you to fill,
        // so a fully-populated ✅ source list can sit above a table recording no
        // verification at all.
        const finalHtml = await trilium.getNoteContent(sid).catch(() => "");
        const revisionKeys = tableRows(finalHtml, "Revision").map((cells) => cells[0]).filter(Boolean);
        const placeholderLeft = hasPlaceholderRow(finalHtml, "Revision");
        // `wrote` is also set by the revision-row upsert below, which runs with
        // no body at all — and renderBody("") returns "<p></p>", which is
        // truthy. So `!!html` was true on every revision-only call and this
        // hint fired nine times in a row claiming a loose block had been
        // appended when nothing had been. Test emptiness the way the merge
        // branch above already does (html && toText(html, 50)), and require
        // that the body write actually happened rather than any write.
        const bodyWritten = !!html && !!toText(html, 50);
        const looseProse = bodyWritten && !createdDomain && !/<(?:ul|ol|li|h[34]|table)\b/i.test(html);

        return txt({
          action: wrote ? "maintained" : "already_written",
          noteId: sid, kind, domainId, location: locationLabel(kind, domainTitle),
          ...(createdDomain ? { createdDomain: domainTitle } : {}),
          ...(revisionChanges.length ? { revision: revisionChanges } : {}),
          ...sourceMerge,
          ...(revisionKeys.length ? { revisionRows: revisionKeys } : {}),
          ...(placeholderLeft
            ? { structureHint: "The Revision table still holds only its placeholder row. Every source marked ✅ was verified by someone — record that with revision=[{source, marker, date}] so the table says so too; marker dates live there, never inline." }
            : {}),
          ...(looseProse
            ? { placementHint: "The body was appended to the Sources section as a loose block, which is rarely what a maintained source list wants. Fold it into the existing entries with revise(noteId, find=…) — or pass list markup so it joins the list structurally." }
            : {}),
          ...(connected.length ? { connected } : {}),
          ...(iconSet ? { icon: iconSet } : {}),
          ...(relations ? { relations } : {}),
          ...(sanitizeWarnings.length ? { sanitized: sanitizeWarnings } : {}),
        });
      }

      // 3 ── Domain collection: sub-category information notes (many per domain),
      //      deduped WITHIN their domain so different domains can share a title.
      if (kind === "information") {
        if (!domain)
          return err("missing_param", 'kind="information" requires a domain.', 'Call remember(kind="information", domain="<domain>", title="<sub-category>", body="...")');
        const { title: subTitle } = normalizeTitle(title ?? "");
        if (!subTitle)
          return err("missing_param", 'kind="information" requires a sub-category title.', 'Add title="<sub-category name>" to your call.');
        const { domainId, domainTitle, createdDomain } = await resolveDomain(trilium, b(), domain);
        const inDomain = await trilium
          .searchNotes("#noteType=information", { ancestorNoteId: domainId, fastSearch: true, limit: 100 })
          .catch(() => ({ results: [] as Note[] }));
        const existing = inDomain.results.find((n) => sameTitle(n.title, subTitle));
        if (existing && mustCreate) return refuseAdoption(existing.noteId, existing.title, `in domain "${domainTitle}"`);
        if (existing) {
          const current = await trilium.getNoteContent(existing.noteId);
          if (isDuplicateAppend(current, html)) {
            if (mandate && !ownedLabel(existing, "mandate")) await trilium.addLabel(existing.noteId, "mandate", "");
            return txt({ action: "already_written", noteId: existing.noteId, kind, title: existing.title, domainId });
          }
          await trilium.createRevision(existing.noteId).catch(() => null);
          const appended = bumpLastUpdated(safeAppend(current, `<h2>Addendum — ${d}</h2>`, html), d);
          await trilium.updateNoteContent(existing.noteId, appended.html);
          await trilium.updateLabelValue(existing.noteId, "updated", d);
          if (mandate && !ownedLabel(existing, "mandate")) await trilium.addLabel(existing.noteId, "mandate", "");
          const connected = await wireRequested(existing.noteId);
          const iconSet = await applyIcon(existing.noteId, icon);
          const relations = relationSnippet(existing);
          return txt({ action: "updated", noteId: existing.noteId, kind, title: existing.title, domainId, ...(connected.length ? { connected } : {}), ...(iconSet ? { icon: iconSet } : {}), ...(relations ? { relations } : {}), ...(sanitizeWarnings.length ? { sanitized: sanitizeWarnings } : {}) });
        }
        const created = await trilium.createNote(domainId, subTitle, contentFor("information", { date: d, body: html, domain: domainTitle }));
        const nid = created.note.noteId;
        for (const l of labelPlan("information", opts, d)) {
          await trilium.addLabel(nid, l.name, l.value, l.inheritable ?? false);
        }
        const connected = await wireRequested(nid);
        const iconSet = await applyIcon(nid, icon);
        return txt({
          action: "created",
          noteId: nid,
          kind,
          title: subTitle,
          domainId,
          location: locationLabel(kind, domainTitle),
          ...(createdDomain ? { createdDomain: domainTitle } : {}),
          ...(connected.length ? { connected } : { hint: ORPHAN_HINT }),
          ...(iconSet ? { icon: iconSet } : {}),
          ...(sanitizeWarnings.length ? { sanitized: sanitizeWarnings } : {}),
        });
      }

      // 3.5 ── Server-managed kinds — reject with clear redirects.
      if (kind === "diary")
        return err("rejected_kind", "Diary entries use the dedicated diary() tool.", 'Call diary(body="...") to write today\'s diary entry.');
      if (kind === "session")
        return err("rejected_kind", "Session notes are written by close().", 'Call close(summary="...") to log this session.');
      if (kind === "claim")
        return err("rejected_kind", "Claims are registered by claim().", 'Call claim(assertion="...", check="...") — a claim carries a verification schedule and history that a generic write cannot set up.');
      if (kind === "log")
        return err("rejected_kind", "Log notes are auto-generated by close() and cannot be written manually.");
      if (kind === "domain")
        return err("rejected_kind", "Domain containers are auto-created on first use.", 'To write domain knowledge call remember(kind="information", domain="<name>", ...).');
      if (kind === "threadEntry") {
        const book = thread ? await trilium.getNote(thread).catch(() => null) : null;
        if (!book || ownedLabel(book, "noteType") !== "thread" || !isCollectionThread(book))
          return err(
            "rejected_kind",
            "Dated thread entries are created automatically when appending to a thread; titled entries exist only in collection threads.",
            'Dated thread: remember(kind="thread", title="<thread>", body, identity). Collection thread: remember(kind="threadEntry", thread="<collection thread id>", title, body).'
          );
        const { title: entryTitle } = normalizeTitle(title ?? "");
        if (!entryTitle) return err("missing_param", "A collection entry needs a title.", 'Add title="<entry name>".');
        const siblings = await trilium
          .searchNotes("#noteType=threadEntry", { ancestorNoteId: book.noteId, fastSearch: true, limit: 500 })
          .then((r) => r.results)
          .catch(() => [] as Note[]);
        const clash = siblings.find((s) => s.parentNoteIds.includes(book.noteId) && sameTitle(s.title, entryTitle));
        if (clash)
          return err(
            "already_exists",
            `"${book.title}" already has an entry titled "${clash.title}" [${clash.noteId}].`,
            `Edit it in place with revise("${clash.noteId}", section=/find=/mode=…) — collection entries are maintained documents, not appended records.`
          );
        const created = await trilium.createNote(book.noteId, entryTitle, contentFor("threadEntry", { date: d, body: html }));
        const eid = created.note.noteId;
        await trilium.addLabel(eid, "noteType", "threadEntry");
        await trilium.addLabel(eid, "created", d);
        await trilium.updateLabelValue(book.noteId, "updated", d);
        const connected = await wireRequested(eid);
        const iconSet = await applyIcon(eid, icon);
        return txt({ action: "created", noteId: eid, kind, title: entryTitle, thread: book.title, ...(connected.length ? { connected } : {}), ...(iconSet ? { icon: iconSet } : {}), ...(sanitizeWarnings.length ? { sanitized: sanitizeWarnings } : {}) });
      }

      // 4 ── Generic collection: thread / user.
      const { title: cleanTitle } = normalizeTitle(title ?? "");
      if (!cleanTitle)
        return err("missing_param", `kind="${kind}" requires a title.`, 'Add title="<note title>" to your call.');

      const existing = await findExisting(kind, cleanTitle);
      if (existing && mustCreate) return refuseAdoption(existing.noteId, existing.title, `in ${KIND_AREA[kind] ?? "the brain"}`);
      if (existing) {
        // Canonical thread structure: every addendum block opens with the
        // identification line (h3). Enforced on thread appends.
        if (kind === "thread" && !identity && !leadingIdentification(html)) {
          return err(
            "missing_identity",
            "Thread addendums open with the canonical identification line (h3): \"LLM · environment · agent/mode [· Run N]\".",
            'Pass identity="Claude … · <environment> · <agent/mode>" — the server renders it as the addendum\'s h3.'
          );
        }
        const block = identity && !leadingIdentification(html) ? `<h3>${escapeHtml(identity)}</h3>\n${html}` : html;

        // Threads: content lands in today's day-child, never the book itself.
        if (kind === "thread") {
          if (isCollectionThread(existing)) return collectionAppendRefusal(existing);
          const entry = await appendThreadEntry(existing.noteId, block, d);
          if (entry.action === "already_written") {
            return txt({ action: "already_written", noteId: existing.noteId, entryId: entry.noteId, kind, title: existing.title });
          }
          await trilium.updateLabelValue(existing.noteId, "updated", d);
          for (const t of topics ?? []) {
            const slug = slugify(t);
            if (slug && !existing.attributes.some((a) => isOwnedAttribute(existing, a) && a.name === "topic" && a.value === slug)) {
              await trilium.addLabel(existing.noteId, "topic", slug);
            }
          }
          const connected = await wireRequested(existing.noteId);
          const iconSet = await applyIcon(existing.noteId, icon);
          const relations = relationSnippet(existing);
          return txt({ action: "updated", noteId: existing.noteId, entryId: entry.noteId, entryAction: entry.action, kind, title: existing.title, ...(connected.length ? { connected } : {}), ...(iconSet ? { icon: iconSet } : {}), ...(relations ? { relations } : {}), ...(sanitizeWarnings.length ? { sanitized: sanitizeWarnings } : {}) });
        }

        const current = await trilium.getNoteContent(existing.noteId);
        if (isDuplicateAppend(current, block)) return txt({ action: "already_written", noteId: existing.noteId, kind, title: existing.title });
        await trilium.createRevision(existing.noteId).catch(() => null);
        const updatedContent = bumpLastUpdated(insertBeforeResolution(closeDangling(current), `<h2>Addendum — ${d}</h2>\n${block}`), d);
        await trilium.updateNoteContent(existing.noteId, updatedContent.html);
        await trilium.updateLabelValue(existing.noteId, "updated", d);
        for (const t of topics ?? []) {
          const slug = slugify(t);
          if (slug && !existing.attributes.some((a) => isOwnedAttribute(existing, a) && a.name === "topic" && a.value === slug)) {
            await trilium.addLabel(existing.noteId, "topic", slug);
          }
        }
        const connected = await wireRequested(existing.noteId);
        const iconSet = await applyIcon(existing.noteId, icon);
        const relations = relationSnippet(existing);
        const dupes = duplicateHeadings(updatedContent.html);
        return txt({ action: "updated", noteId: existing.noteId, kind, title: existing.title, ...(connected.length ? { connected } : {}), ...(iconSet ? { icon: iconSet } : {}), ...(relations ? { relations } : {}), ...(dupes.length ? { duplicateHeadings: dupes, structureHint: "The note now carries duplicated section headings — merge them with revise(section=…, mode=replace)." } : {}), ...(sanitizeWarnings.length ? { sanitized: sanitizeWarnings } : {}) });
      }

      // Thread structure enforcement: a new thread is born with its goal — the
      // Context → Goal section is the canonical top, queried from the user at
      // creation. A body already carrying the Context structure also passes.
      if (kind === "thread" && !goal && !/<h2(?:\s[^>]*)?>\s*Context\s*<\/h2>/i.test(html)) {
        return err(
          "missing_goal",
          "A new thread requires a goal — the Context → Goal section is queried from the user at creation.",
          'Ask the user what this thread\'s goal is, then re-call remember(kind="thread", title, goal="<the goal statement>", body?).'
        );
      }

      const resolved = await resolveParent(trilium, b(), kind, opts);
      const content = contentFor(kind, { date: d, body: html, goal, domain: resolved.domainTitle ?? domain });
      // Threads are book notes — the day-to-day content lives in threadEntry
      // children created by appendThreadEntry(), never stacked in the book.
      const created = await trilium.createNote(resolved.parentId, cleanTitle, content, kind === "thread" ? "book" : "text");
      const nid = created.note.noteId;

      for (const l of labelPlan(kind, opts, d)) {
        await trilium.addLabel(nid, l.name, l.value, l.inheritable ?? false);
      }
      if (kind === "thread" && shape === "collection") await trilium.addLabel(nid, "threadShape", "collection");

      const wired: string[] = [];
      const extraRelations: RelationEdge[] = [];
      if (supersedes) {
        const old = await trilium.getNote(supersedes).catch(() => null);
        if (old && !isStructural(b(), supersedes)) {
          await trilium.addRelation(nid, "supersedes", supersedes).catch(() => null);
          await trilium.updateLabelValue(supersedes, "status", "superseded");
          await trilium.updateLabelValue(supersedes, "closed", d);
          await ensureArchivedFlag(trilium, old);
          wired.push(`supersedes → ${old.title} (archived)`);
          extraRelations.push({ relation: "supersedes", toNoteId: supersedes });
        }
      }
      const connected = await wireRequested(nid);
      extraRelations.push(...connected);
      const iconSet = await applyIcon(nid, icon);
      const relations = [...(relationSnippet(created.note) ?? []), ...extraRelations];

      return txt({
        action: "created",
        noteId: nid,
        kind,
        title: cleanTitle,
        location: locationLabel(kind, resolved.domainTitle),
        ...(resolved.createdDomain ? { createdDomain: resolved.domainTitle } : {}),
        ...(wired.length ? { wired } : {}),
        ...(relations.length ? { relations } : { hint: ORPHAN_HINT }),
        ...(iconSet ? { icon: iconSet } : {}),
        ...(sanitizeWarnings.length ? { sanitized: sanitizeWarnings } : {}),
      });
    }
  );

  server.tool(
    "recall",
    `Ranked search across the whole brain — label, title and full-text strategies merged, with kind and status. Pass domain= whenever you know the area. orderBy/orderDirection sort by date; fastSearch= scans titles and labels only; regex= matches note bodies with a real regular expression; a fuzzy pass runs automatically when exact results are thin (hits marked fuzzy: true are leads, not answers). includeArchived= includes archived notes. A thin result is evidence about the query, not the brain.`,
    {
      query: z.string().describe("What to find — natural phrasing is fine"),
      kinds: z.array(z.enum(Kinds)).optional().describe("Restrict to these kinds"),
      domain: z.string().optional().describe("Restrict to a knowledge domain"),
      includeArchived: z.boolean().optional().describe("Include archived/resolved notes (default: false)"),
      limit: z.number().optional().describe("Max results (default: 10)"),
      orderBy: z.enum(["dateModified", "dateCreated", "title"]).optional().describe("Override score sort with a field sort"),
      orderDirection: z.enum(["asc", "desc"]).optional().describe("asc | desc (default: desc for dates, asc for title)"),
      fastSearch: z.boolean().optional().describe("Title/label only — faster, skips full-text body scan"),
      regex: z.string().optional().describe("Regular expression matched against note bodies (Trilium %= operator). Takes precedence over the keyword strategies; escape backslashes."),
      fuzzy: z.boolean().optional().describe("Force the fuzzy pass on (default: automatic when exact strategies return few results) or off"),
    },
    async ({ query, kinds, domain, includeArchived, limit, orderBy, orderDirection, fastSearch, regex, fuzzy }) => {
      const cfg = b();
      const max = limit ?? 10;
      const fast = fastSearch ?? false;
      const slug = slugify(query);
      const tokens = queryTokens(query);
      const domSlug = domain ? slugify(domain) : null;
      const kindSet = kinds?.length ? new Set<string>(kinds) : null;

      const run = (q: string, useFast = false, ord?: { orderBy: string; orderDirection: "asc" | "desc" }) =>
        trilium
          .searchNotes(q, {
            ancestorNoteId: cfg.root,
            limit: 30,
            fastSearch: useFast,
            includeArchivedNotes: includeArchived ?? false,
            ...(ord ?? {}),
          })
          .then((r) => r.results)
          .catch(() => [] as Note[]);

      const filterNote = (note: Note) => {
        const k = labelOf(note, "noteType");
        if (!k) return false;
        if (kindSet && !kindSet.has(k)) return false;
        if (domSlug && labelOf(note, "domain") !== domSlug) return false;
        return true;
      };

      const buildResult = async (note: Note, i: number) => {
        const relations = relationSnippet(note);
        const base = {
          id: note.noteId,
          title: note.title,
          kind: labelOf(note, "noteType"),
          status: labelOf(note, "status"),
          updated: note.dateModified.slice(0, 10),
          ...(hasLabel(note, "archived") ? { archived: true } : {}),
          ...(relations ? { relations } : {}),
        };
        if (i < 3) {
          const content = await trilium.getNoteContent(note.noteId).catch(() => "");
          return { ...base, snippet: toText(content, 280) };
        }
        return base;
      };

      // A no-match says something about the QUERY first, not about the brain.
      // The old wording ("Content may not be stored yet — remember() it if the
      // user provides it") actively pointed the caller at writing a duplicate
      // of something already stored, which is the worst possible advice from a
      // memory system's search. Never conclude "not in the brain" from one miss.
      const noMatch = {
        note:
          "No matches for this query. That is evidence about the query, not about the brain — do NOT conclude the content is unstored, and do not remember() it as new. " +
          "Retry with domain(name) for anything venture- or subject-scoped, recall(query, domain=…) to scope the ranking, or 2-3 content words instead of a sentence. " +
          "Only treat it as absent once a domain read confirms it.",
      };

      // Regex mode: a body-pattern question, not a keyword one. Answers what
      // keyword search structurally cannot — "which notes still carry a
      // doubly-escaped tag" is a pattern, and finding those by guessing
      // substrings is how a corruption class stays hidden.
      if (regex) {
        // Trilium's %= operator is the CANDIDATE filter, not the answer.
        //
        // Measured: a single literal pattern comes back correct, but an
        // alternation over-matches — `zzzznotrealzzzz|triliumnext/trilium:latest`
        // returned five notes where only three contained either alternative,
        // and a six-term staleness sweep returned a note containing none of
        // them. A search tool that silently widens its own filter is worse
        // than one that refuses the query, because the results look like an
        // answer: this is the tool you reach for to ask "has this wrong claim
        // leaked anywhere else", and a false clean sweep reports the opposite
        // of the truth.
        //
        // So the backend narrows, and we verify locally against the real
        // regex. Costs one content fetch per candidate, bounded by limit —
        // cheap next to being wrong about what the brain contains.
        let re: RegExp | null = null;
        try {
          re = new RegExp(regex, "i");
        } catch (e) {
          return err(
            "invalid_pattern",
            `Not a valid regular expression: ${(e as Error).message}`,
            "Escape backslashes — a JSON string needs \\\\d for \\d."
          );
        }

        // escapeQueryRegex, not escapeQueryValue: the latter replaces every
        // backslash with a SPACE, so "(\d+)" reached the backend as "( d+)"
        // and returned nothing — a silent empty sweep on the tool whose whole
        // job is proving a claim has not leaked. Trilium's lexer also consumes
        // one level of escaping, so backslashes are doubled on the way out.
        const candidates = (await run(`note.content %= '${escapeQueryRegex(regex)}'`)).filter(filterNote);
        const confirmed: Note[] = [];
        let rejected = 0;
        let tagSpanning = 0;
        for (const n of candidates) {
          if (confirmed.length >= max) break;
          const content = await trilium.getNoteContent(n.noteId).catch(() => "");
          if (!content) { rejected++; continue; }
          // Verify against the raw body AND a tag-stripped projection: the
          // backend matches a striptags'd copy, so a phrase broken by an
          // inline <strong> or <code> is a real hit that raw-only checking
          // would have thrown away as a false positive.
          const rawHit = re.test(content);
          const projectedHit = !rawHit && re.test(stripTagsWithMap(content).text);
          if (rawHit || projectedHit) {
            if (projectedHit) tagSpanning++;
            confirmed.push(n);
          } else rejected++;
        }

        const results = await Promise.all(confirmed.map(buildResult));
        const notes = [
          rejected ? `${rejected} backend candidate(s) did not actually match the pattern and were dropped — results are verified against the real regex, not just the search index.` : null,
          tagSpanning ? `${tagSpanning} match(es) were found only after stripping markup — the phrase is split by an inline tag there.` : null,
          results.length === 0 ? "No bodies matched that pattern, searched both as stored HTML and tag-stripped. Note that Trilium's %= pre-filter reads a striptags'd copy, so a pattern anchored ON tags may never reach verification — consistency() scans exhaustively if you need certainty." : null,
        ].filter(Boolean);
        return txt({
          mode: "regex",
          pattern: regex,
          results,
          ...(notes.length ? { note: notes.join(" ") } : {}),
        });
      }

      // When orderBy is set, do a single ordered query — preserves Trilium's sort.
      if (orderBy) {
        const ord = { orderBy, orderDirection: orderDirection ?? (orderBy === "title" ? "asc" as const : "desc" as const) };
        const q = query.trim() ? escapeQueryValue(query) : "#noteType";
        const notes = await run(q, fast, ord);
        const filtered = notes.filter(filterNote).slice(0, max);
        const results = await Promise.all(filtered.map(buildResult));
        return txt({ results, ...(results.length === 0 ? noMatch : {}) });
      }

      // Multi-strategy scoring for relevance-ranked search.
      const scores = new Map<string, { note: Note; score: number }>();
      const add = (notes: Note[], weight: number) => {
        for (const n of notes) {
          const entry = scores.get(n.noteId);
          if (entry) entry.score += weight;
          else scores.set(n.noteId, { note: n, score: weight });
        }
      };

      // Title matching is OR + per-token scoring, not AND.
      //
      // The AND join meant a note scored ZERO from titles unless its title
      // contained EVERY query token, which is the opposite of what a title is
      // for. Measured: a note titled exactly "Tool Surface" did not appear in
      // the top 5 for `tool surface full mode` — "full" and "mode" are not in
      // its title, so the whole title strategy dropped it, leaving it tied on
      // full-text weight 1 with every other note mentioning those words and
      // broken by recency. Scoring each matched token separately, plus a
      // decisive bonus when the title actually IS the query, makes an exact
      // title win the way a caller expects.
      const [byLabel, byTitleRaw, byText] = await Promise.all([
        slug.length >= 3 ? run(`#topic='${slug}' OR #domain='${slug}'`, true) : Promise.resolve([] as Note[]),
        tokens.length
          ? run(tokens.map((t) => `note.title *=* '${escapeQueryValue(t)}'`).join(" OR "), fast || undefined)
          : Promise.resolve([] as Note[]),
        fast ? Promise.resolve([] as Note[]) : run(escapeQueryValue(query)),
      ]);
      add(byLabel, 3);
      add(byText, 1);

      // Per-token title weight (2 each), then an exact/prefix-title bonus.
      const queryKey = titleKey(query);
      for (const n of byTitleRaw) {
        const lowerTitle = n.title.toLowerCase();
        const hits = tokens.filter((t) => lowerTitle.includes(t)).length;
        if (!hits) continue;
        let weight = 2 * hits;
        const noteKey = titleKey(n.title);
        if (noteKey === queryKey) weight += 8;              // the title IS the query
        else if (queryKey.startsWith(noteKey) || noteKey.startsWith(queryKey)) weight += 4;
        add([n], weight);
      }

      // Fuzzy fallback. Trilium's ~= (fuzzy exact) and ~* (fuzzy contains)
      // tolerate typos and spelling variants — ≥3 characters, edit distance ≤2,
      // diacritics normalised. It runs only when the exact strategies came back
      // thin, mirroring Trilium's own progressive-search behaviour, because a
      // near-match ranked alongside an exact one is worse than no near-match at
      // all: recall's job is to be trustworthy about what it found.
      const EXACT_ENOUGH = 5;
      const fuzzyTokens = tokens.filter((t) => t.length >= 3);
      const wantFuzzy = fuzzy ?? (scores.size < EXACT_ENOUGH && fuzzyTokens.length > 0);
      const fuzzyIds = new Set<string>();
      if (wantFuzzy && fuzzyTokens.length) {
        const byFuzzy = await run(
          fuzzyTokens.map((t) => `note.title ~* '${escapeQueryValue(t)}'`).join(" OR "),
          fast
        );
        for (const n of byFuzzy) if (!scores.has(n.noteId)) fuzzyIds.add(n.noteId);
        add(byFuzzy, 0.5);
      }

      const ranked = [...scores.values()]
        .filter(({ note }) => filterNote(note))
        .sort((a, b2) => b2.score - a.score || (a.note.dateModified < b2.note.dateModified ? 1 : -1))
        .slice(0, max);

      const results = await Promise.all(
        ranked.map(async ({ note }, i) => {
          const row = await buildResult(note, i);
          return fuzzyIds.has(note.noteId) ? { ...row, fuzzy: true as const } : row;
        })
      );
      const fuzzyCount = results.filter((r) => "fuzzy" in r).length;
      return txt({
        results,
        ...(fuzzyCount
          ? { fuzzyMatches: `${fuzzyCount} result(s) came from the fuzzy pass (marked fuzzy: true) — treat them as leads to verify, not as answers.` }
          : {}),
        ...(results.length === 0 ? noMatch : {}),
      });
    }
  );

  server.tool(
    "domain",
    `Everything for a domain, topic or project: its knowledge book (if any) plus every note carrying a matching #domain or #topic slug, grouped by kind, each with idle days and a stale flag. The reliable retrieval path for an area; use recall() for keyword search.`,
    {
      name: z.string().describe("Domain, topic, or project name"),
      includeArchived: z.boolean().optional().describe("Include archived/resolved items (default: false)"),
    },
    async ({ name, includeArchived }) => {
      const cfg = b();
      const slug = slugify(name);
      const runIn = (ancestor: string | undefined, q: string) =>
        ancestor
          ? trilium
              .searchNotes(q, { ancestorNoteId: ancestor, limit: 100, fastSearch: true, includeArchivedNotes: includeArchived ?? false })
              .then((r) => r.results)
              .catch(() => [] as Note[])
          : Promise.resolve([] as Note[]);

      // Label values are quoted: Trilium's lexer treats "-" as an operator, so
      // an unquoted hyphenated slug (wall-e) silently truncates to "wall".
      const [domainContainers, byTopic, byDomain] = await Promise.all([
        runIn(cfg.knowledge.domains, `#noteType=domain #domain='${slug}'`),
        runIn(cfg.root, `#topic='${slug}'`),
        runIn(cfg.root, `#domain='${slug}'`),
      ]);

      const knowledgeDomain = domainContainers[0]
        ? { id: domainContainers[0].noteId, title: domainContainers[0].title }
        : null;

      const seen = new Set<string>();
      const all: Note[] = [];
      for (const n of [...byTopic, ...byDomain]) {
        if (!seen.has(n.noteId)) { seen.add(n.noteId); all.push(n); }
      }

      // Staleness is computed here rather than left as a date for the caller to
      // reason about: "which of these needs re-verifying" was a calculation
      // every scoped run redid by hand off the modified column, and it is the
      // same policy window maintain(deep) already applies to threads.
      const staleAfter = cfg.policy.staleAfterDays;
      const idleSince = (iso: string) =>
        Math.max(0, Math.floor((Date.now() - new Date(iso.replace(" ", "T")).getTime()) / 86_400_000));
      const RECORD_ROWS = new Set(["session", "diary", "log", "threadEntry"]);

      const groups: Record<string, Array<{ id: string; title: string; status?: string; created: string; modified: string; idleDays?: number; stale?: true; archived?: true; relations?: RelationEdge[] }>> = {};
      let staleCount = 0;
      for (const n of all) {
        const kind = ownedLabel(n, "noteType");
        if (!kind || kind === "domain") continue;
        if (!groups[kind]) groups[kind] = [];
        const relations = relationSnippet(n);
        const idle = idleSince(n.dateModified);
        const stale = !RECORD_ROWS.has(kind) && idle >= staleAfter && !hasLabel(n, "archived");
        if (stale) staleCount++;
        groups[kind].push({
          id: n.noteId,
          title: n.title,
          status: labelOf(n, "status") ?? undefined,
          created: labelOf(n, "created") ?? n.dateCreated.slice(0, 10),
          modified: n.dateModified.slice(0, 10),
          idleDays: idle,
          ...(stale ? { stale: true as const } : {}),
          ...(hasLabel(n, "mandate") ? { mandate: true as const } : {}),
          ...(hasLabel(n, "archived") ? { archived: true as const } : {}),
          ...(relations ? { relations } : {}),
        });
      }

      const total = all.filter((n) => {
        const k = ownedLabel(n, "noteType");
        return k && k !== "domain";
      }).length;

      return txt({
        domain: name,
        slug,
        knowledgeDomain,
        total,
        ...(staleCount ? { stale: `${staleCount} note(s) untouched ${staleAfter}d+ — marked stale:true below; re-verify against live sources before treating them as current` } : {}),
        groups,
        ...(total === 0 && !knowledgeDomain
          ? { note: `No content found for "${slug}". Create a Knowledge domain with remember(kind="information", domain="${name}") or tag notes with topics=["${slug}"].` }
          : {}),
      });
    }
  );

  server.tool(
    "read",
    `Several note bodies in one round trip: ids=[…] (up to 10) → {notes:[{id, title, kind, content, relations}]}. For one note prefer the kinded read; for a huge note prefer a section= read.`,
    {
      ids: z.array(z.string()).min(1).max(10).describe("Note ids to read — one body per id, one round trip (cap 10)"),
    },
    async ({ ids }) => {
      const notes = await Promise.all(
        ids.map(async (id) => {
          try {
            const note = await trilium.getNote(id);
            const contentResult = await trilium.getNoteContentResult(id, note.type);
            const relations = relationSnippet(note);
            return {
              id, title: note.title, kind: ownedLabel(note, "noteType") ?? undefined,
              content: typeof contentResult === "string" ? contentResult : contentResult.content,
              ...(typeof contentResult === "string" ? {} : { contentEncoding: contentResult.encoding, mime: contentResult.mime }),
              ...(relations ? { relations } : {}),
            };
          } catch {
            return { id, missing: true as const };
          }
        })
      );
      return txt({ count: notes.length, notes });
    }
  );

  server.tool(
    "revise",
    `Edit a note by id. A revision is taken first; "Last updated" lines are bumped on content writes.

Modes: default append (a dated addendum — right only for records; a dated thread's append lands in today's child), mode=replace (whole body), section="<heading>" (replace that section's whole body, h2→h3→h4, occurrence= for repeats), section= + mode=before|after (insert a sibling block around the whole section), mode=prepend (top of the section body), mode=remove (delete the section). find="<exact stored text>" replaces every occurrence (nth= for one); edits=[{find, body}] applies several in one write. title= composes with every mode; retitling a domain book cascades its #domain slug.

Check the receipt: matched=false means a NEW section was written (available= lists real headings; strict=true refuses instead). A section replace swaps everything under the heading — use find= for anything smaller. find= matches stored HTML (tags literal), not rendered text.`,
    {
      noteId: z.string().describe("Note to update"),
      body: z.string().optional().describe("Content to add/replace: plain text, markdown, or HTML. With find=, the raw replacement string (no conversion)."),
      title: z.string().optional().describe("New title (normalized server-side)"),
      section: z.string().optional().describe("Target a section by heading text (h2/h3/h4, in that order); omit for whole-note append/replace"),
      occurrence: z.number().int().positive().optional().describe("section=: which same-text heading to target, 1-based (default: the first). Read them with outline(noteId)."),
      strict: z.boolean().optional().describe("Refuse (note untouched) on a section= miss or a body needing structural repair, instead of writing a new section"),
      mode: z.enum(["append", "replace", "before", "after", "prepend", "remove"]).optional().describe('append (default) | replace | before | after (around the whole section=) | prepend (top of its body) | remove (delete section=, no body needed)'),
      find: z.string().optional().describe("Exact raw string to replace throughout the body with body= — targeted surgery without a read+full-replace. Takes precedence over section/mode."),
      nth: z.number().int().positive().optional().describe("find=: replace only the Nth occurrence, 1-based (default: all of them)"),
      edits: z.array(z.object({
        find: z.string().describe("Exact raw string to replace"),
        body: z.string().describe("Raw replacement string"),
        nth: z.number().int().positive().optional().describe("Replace only the Nth occurrence"),
      })).optional().describe("Several find/replace surgeries applied in order against one read and one write. Mutually exclusive with find=."),
      identity: z.string().optional().describe('Appending to a dated thread: the identification line "LLM · environment · agent/mode [· Run N]" (required)'),
      icon: z.string().optional().describe('Display icon — a boxicons class ("bx bx-brain") or a bare name; normalized server-side'),
      date: z.string().optional().describe("ISO date (default: today)"),
    },
    async ({ noteId, body, title, section, occurrence, mode, find, nth, edits, identity, icon, date, strict }) => {
      if (isContainer(b(), noteId))
        return err("protected_note", `Note ${noteId} is a container — its content cannot be edited directly.`, "Use remember() to write to singletons, or specify a content note id.");
      const d = checkedDate(date);
      const note = await trilium.getNote(noteId);
      const noteKind = labelOf(note, "noteType");
      const warnings: string[] = [];
      let sectionResult: { matched: boolean; headingCount: number; replacedSubsections?: string[] } | null = null;

      /** Apply a title change — with the domain rename cascade: retitling a
       *  domain book updates its #domain slug AND every descendant's, so
       *  domain() gathering never breaks on a stale slug. */
      const applyTitle = async (): Promise<{ retitled?: string; cascaded?: number }> => {
        if (!title) return {};
        const { title: cleanTitle } = normalizeTitle(title);
        if (!cleanTitle || cleanTitle === note.title) return {};
        await trilium.patchNote(noteId, { title: cleanTitle });
        if (noteKind !== "domain") return { retitled: cleanTitle };
        const newSlug = slugify(cleanTitle);
        if (!newSlug) return { retitled: cleanTitle };
        await trilium.updateLabelValue(noteId, "domain", newSlug).catch(() => null);
        const children = await trilium
          .searchNotes("#domain", { ancestorNoteId: noteId, fastSearch: true, limit: 200, includeArchivedNotes: true })
          .catch(() => ({ results: [] as Note[] }));
        let cascaded = 0;
        for (const child of children.results) {
          if (child.noteId === noteId) continue;
          if (!child.attributes.some((a) => a.type === "label" && a.name === "domain" && a.noteId === child.noteId)) continue;
          await trilium.updateLabelValue(child.noteId, "domain", newSlug).catch(() => null);
          cascaded++;
        }
        return { retitled: cleanTitle, cascaded };
      };

      // ── find/replace mode: exact-string surgery, raw in and raw out ────────
      if (find !== undefined || edits !== undefined) {
        if (find !== undefined && edits !== undefined)
          return err("conflicting_params", "Pass either find= or edits=, not both.", "Fold the single find/body pair into the edits array.");

        const plan = edits ?? [{ find: find!, body: body!, nth }];
        if (!plan.length)
          return err("missing_param", "edits cannot be empty.", 'Pass at least one {find, body} pair, or use find=/body= for a single surgery.');
        for (const [i, e] of plan.entries()) {
          if (!e.find)
            return err("missing_param", `edits[${i}].find cannot be empty.`, 'Pass the exact text to replace, e.g. revise(noteId, find="Brainllm", body="BrainLLM").');
          if (e.body === undefined)
            return err("missing_param", `edits[${i}] requires body as the replacement string.`, 'Call revise(noteId, find="<exact text>", body="<replacement>").');
        }

        /** One surgery against `source`. Tries the verbatim string first, then
         *  an attribute- and whitespace-tolerant pass (CKEditor injects
         *  attributes into stored tags and does not preserve whitespace between
         *  elements, so previously-authored formatted text stops matching
         *  verbatim after one storage round-trip). Returns null on a miss. */
        const applyEdit = (
          source: string,
          needle: string,
          replacement: string,
          index?: number
        ): { html: string; count: number; matchMode: "exact" | "attribute-tolerant" } | null => {
          const spans = (hits: Array<{ start: number; length: number }>, matchMode: "exact" | "attribute-tolerant") => {
            if (index === undefined) {
              let out = "";
              let cursor = 0;
              for (const h of hits) {
                out += source.slice(cursor, h.start) + replacement;
                cursor = h.start + h.length;
              }
              return { html: out + source.slice(cursor), count: hits.length, matchMode };
            }
            const hit = hits[index - 1];
            if (!hit) return null;
            return {
              html: source.slice(0, hit.start) + replacement + source.slice(hit.start + hit.length),
              count: 1,
              matchMode,
            };
          };

          const exact: Array<{ start: number; length: number }> = [];
          for (let at = source.indexOf(needle); at !== -1; at = source.indexOf(needle, at + needle.length)) {
            exact.push({ start: at, length: needle.length });
          }
          if (exact.length) return spans(exact, "exact");

          const rx = tolerantFindRegex(needle);
          if (!rx) return null;
          const tolerant = [...source.matchAll(rx)].map((m) => ({ start: m.index!, length: m[0].length }));
          return tolerant.length ? spans(tolerant, "attribute-tolerant") : null;
        };

        /** A miss is almost never "the text is gone" — it is one of three
         *  specific, distinguishable causes. Naming the right one is the
         *  difference between a one-call retry and burning several on
         *  whitespace variants. */
        const missHint = (needle: string, source: string, alreadyConsumed: boolean): string => {
          if (alreadyConsumed)
            return `Not found — but an EARLIER edit in this same edits= array already replaced this exact string. The array is applied in order against one body, so the second pass had nothing left to match. This is the expected result, not a failure.`;
          if (looksEntityEscaped(needle))
            return `Not found — the search string carries escaped markup (&lt;…&gt;) while note bodies store real tags. Pass the tag literally, e.g. "<h3>Typography</h3>".`;
          if (spansBlockBoundary(needle))
            return `Not found — this string spans an element boundary (a closing tag followed by an opening one). Anchor the find INSIDE a single element instead, or target the heading directly with section= (with mode="before"/"after" to insert around it).`;
          return `Not found in the note body (exact or attribute-tolerant) — already replaced on a retry, or the text genuinely differs.`;
        };

        /** The nearest real text, attached to a miss. Answers "how does it
         *  actually differ" in the same call that reported the miss. */
        const missContext = (needle: string, source: string) => {
          const near = nearestContext(source, needle);
          return near
            ? { matchedUpTo: near.fragment, storedNearby: near.context }
            : {};
        };

        const current = await trilium.getNoteContent(noteId);
        let working = current;
        const results: Array<{ find: string; replaced: number; matchMode?: string; hint?: string; matchedUpTo?: string; storedNearby?: string }> = [];
        let total = 0;
        const consumed = new Set<string>();
        for (const e of plan) {
          const applied = applyEdit(working, e.find, e.body, e.nth);
          if (!applied) {
            // "Already consumed by an earlier edit in this call" and "the text
            // genuinely differs" are different diagnoses with different fixes,
            // and reporting the second for the first sent callers hunting a
            // discrepancy that did not exist.
            const alreadyConsumed = consumed.has(e.find);
            results.push({
              find: e.find,
              replaced: 0,
              hint: missHint(e.find, current, alreadyConsumed),
              ...(alreadyConsumed ? {} : missContext(e.find, working)),
            });
            continue;
          }
          consumed.add(e.find);
          working = applied.html;
          total += applied.count;
          results.push({ find: e.find, replaced: applied.count, matchMode: applied.matchMode });
        }

        if (total === 0) {
          return txt({
            ok: true, noteId, mode: edits ? "edits" : "find-replace", replaced: 0, date: d,
            ...(edits
              ? { results }
              : {
                  hint: results[0]!.hint,
                  ...(results[0]!.matchedUpTo ? { matchedUpTo: results[0]!.matchedUpTo } : {}),
                  ...(results[0]!.storedNearby ? { storedNearby: results[0]!.storedNearby } : {}),
                }),
          });
        }

        await trilium.createRevision(noteId).catch(() => null);
        const replacedResult = sanitizeHtml(working);
        const stamped = bumpLastUpdated(replacedResult.html, d);
        await trilium.updateNoteContent(noteId, stamped.html);
        const titled = await applyTitle();
        const iconApplied = await applyIcon(noteId, icon);
        await trilium.updateLabelValue(noteId, "updated", d);
        if (labelOf(note, "status") === "dormant") await trilium.updateLabelValue(noteId, "status", "active");
        const rels = relationSnippet(note);
        const missed = results.filter((r) => r.replaced === 0);
        const structure = structuralFindings(noteKind, stamped.html);
        return txt({
          ok: true, noteId, mode: edits ? "edits" : "find-replace", replaced: total, date: d,
          ...(edits ? { results } : { matchMode: results[0].matchMode }),
          ...(edits && missed.length ? { missed: missed.length, hint: `${missed.length} of ${plan.length} edits matched nothing — see results[].hint. The rest were applied.` } : {}),
          ...(titled.retitled ? { retitled: titled.retitled } : {}),
          ...(titled.cascaded ? { domainCascade: `#domain updated on ${titled.cascaded} descendant note(s)` } : {}),
          ...(iconApplied ? { icon: iconApplied } : {}),
          ...(rels ? { relations: rels } : {}),
          ...structure,
          ...(replacedResult.warnings.length ? { sanitized: replacedResult.warnings } : {}),
        });
      }

      if ((mode === "before" || mode === "after" || mode === "prepend") && !section)
        return err("missing_param", `mode="${mode}" inserts relative to a heading and needs one.`, 'Pass section="<heading text>" alongside it, or use mode="append" for a whole-note addendum.');
      if (mode === "remove" && !section)
        return err("missing_param", 'mode="remove" deletes a section and needs one.', 'Pass section="<heading text>". To delete the whole note use forget(noteId).');

      // Removal is the one section operation with no body, so it runs BEFORE
      // the `if (body)` guard that every other section mode lives behind —
      // which is precisely why deleting a section had no working path before.
      if (mode === "remove" && section) {
        const current = await trilium.getNoteContent(noteId);
        const result = setSection(current, section, "", "remove", occurrence ?? 1);
        if (!result.matched) {
          return txt({
            ok: true, noteId, mode: `section:remove:${section}`, matched: false, date: d,
            available: result.available,
            hint: `No "${section}" heading at h2/h3/h4 — nothing was removed and the body is untouched. Check available= for the note's real heading texts.`,
          });
        }
        await trilium.createRevision(noteId).catch(() => null);
        const stamped = bumpLastUpdated(result.html, d);
        await trilium.updateNoteContent(noteId, stamped.html);
        const titledOnRemove = await applyTitle();
        const iconOnRemove = await applyIcon(noteId, icon);
        await trilium.updateLabelValue(noteId, "updated", d);
        if (labelOf(note, "status") === "dormant") await trilium.updateLabelValue(noteId, "status", "active");
        const relsOnRemove = relationSnippet(note);
        return txt({
          ok: true, noteId, mode: `section:remove:${section}`, matched: true,
          headingCount: result.headingCount, date: d,
          ...(result.replacedSubsections?.length
            ? { removedSubsections: result.replacedSubsections, displacedHint: `The removed section contained ${result.replacedSubsections.length} nested heading(s) — they went with it. A revision was taken first.` }
            : {}),
          ...(titledOnRemove.retitled ? { retitled: titledOnRemove.retitled } : {}),
          ...(iconOnRemove ? { icon: iconOnRemove } : {}),
          ...(relsOnRemove ? { relations: relsOnRemove } : {}),
          ...structuralFindings(noteKind, stamped.html),
        });
      }

      let finalContent: string | null = null;
      let sectionMiss: { appendedAtLevel?: number; available?: string[]; didYouMean?: string } = {};
      let threadEntryResult: { noteId: string; action: "created" | "appended" | "already_written" } | null = null;
      if (body) {
        const sanitized = renderBody(body);
        const html = sanitized.html;
        warnings.push(...sanitized.warnings);

        // strict= covers more than section misses: when the sanitizer had to
        // repair the body's tag structure, a receipt reporting the repair
        // landed twice as "reassurance" while the damaged note shipped. Under
        // strict= the repair is the failure — refuse before the revision
        // snapshot, so the note is untouched and the caller sees the damage
        // they authored rather than a note that now contains it.
        if (strict) {
          const repairs = repairedStructure(sanitized.warnings);
          if (repairs.length) {
            return err(
              "body_repaired",
              `strict=true: the body needed structural repair and nothing was written — ${repairs.join("; ")}.`,
              "Fix the markup (close the open tags, use paragraphs instead of <br> runs inside table cells) and re-send, or drop strict= to accept the repaired form."
            );
          }
        }

        // Threads carry exactly one Resolution, owned by resolve() — refuse an
        // appended body that smuggles its own.
        if (
          noteKind === "thread" &&
          mode !== "replace" &&
          /<h[2-4](?:\s[^>]*)?>\s*Resolution\s*<\/h[2-4]>/i.test(html) &&
          !isOpenResolutionOnly(html)
        ) {
          return err(
            "structure_violation",
            "Thread bodies must not carry a FILLED or duplicate Resolution — a thread has exactly one Resolution, at the bottom, owned by resolve(). A single empty '— open —' placeholder is the canonical skeleton and is accepted.",
            "Remove the Resolution content from the body; close the thread with resolve(noteId, outcome) when the work completes."
          );
        }

        const current = await trilium.getNoteContent(noteId);
        if (section) {
          const sectionMode =
            mode === "append" || mode === "before" || mode === "after" || mode === "prepend" ? mode : "replace";
          const result = setSection(current, section, html, sectionMode, occurrence ?? 1);
          // Near-miss detection: a miss within edit distance of a real heading
          // is a typo wearing a new-section receipt. Surface the nearest name
          // either way; under strict=, refuse the write entirely — appending a
          // typo'd heading is exactly the failure strict exists to prevent, and
          // the note must stay untouched when it fires. The revision snapshot
          // waits until after this check for the same reason.
          const near = !result.matched && result.available?.length
            ? nearestHeading(section, result.available)
            : null;
          const suggestion = near && near.distance <= Math.max(2, Math.floor(section.length / 5))
            ? near
            : null;
          if (strict && !result.matched) {
            return err(
              "section_not_found",
              `strict=true: no heading matches "${section}" and nothing was written.`,
              `Available headings: ${result.available?.length ? result.available.join(" · ") : "(none)"}${suggestion ? ` — did you mean "${suggestion.heading}"?` : ""} Re-target with the exact text, or drop strict= to allow the new-section append.`
            );
          }
          await trilium.createRevision(noteId).catch(() => null);
          finalContent = bumpLastUpdated(result.html, d).html;
          await trilium.updateNoteContent(noteId, finalContent);
          sectionResult = {
            matched: result.matched,
            headingCount: result.headingCount,
            ...(result.replacedSubsections?.length ? { replacedSubsections: result.replacedSubsections } : {}),
          };
          sectionMiss = {
            ...(result.appendedAtLevel ? { appendedAtLevel: result.appendedAtLevel } : {}),
            ...(result.available?.length ? { available: result.available } : {}),
            ...(suggestion ? { didYouMean: suggestion.heading } : {}),
          };
        } else if (mode === "replace") {
          await trilium.createRevision(noteId).catch(() => null);
          finalContent = bumpLastUpdated(html, d).html;
          await trilium.updateNoteContent(noteId, finalContent);
        } else if (noteKind === "thread") {
          if (isCollectionThread(note)) return collectionAppendRefusal(note);
          // Threads: content lands in today's day-child, never the book itself.
          // Canonical thread structure: every addendum block opens with the
          // identification line (h3). Enforced on thread appends.
          if (!identity && !leadingIdentification(html)) {
            return err(
              "missing_identity",
              "Thread addendums open with the canonical identification line (h3): \"LLM · environment · agent/mode [· Run N]\".",
              'Pass identity="Claude … · <environment> · <agent/mode>" — the server renders it as the addendum\'s h3.'
            );
          }
          const block = identity && !leadingIdentification(html) ? `<h3>${escapeHtml(identity)}</h3>\n${html}` : html;
          threadEntryResult = await appendThreadEntry(noteId, block, d);
          if (threadEntryResult.action === "already_written") {
            return txt({ ok: true, noteId, mode: "already_written", entryId: threadEntryResult.noteId, date: d });
          }
        } else {
          const block = identity && !leadingIdentification(html) ? `<h3>${escapeHtml(identity)}</h3>\n${html}` : html;
          if (isDuplicateAppend(current, block)) return txt({ ok: true, noteId, mode: "already_written", date: d });
          await trilium.createRevision(noteId).catch(() => null);
          finalContent = bumpLastUpdated(insertBeforeResolution(closeDangling(current), `<h2>Addendum — ${d}</h2>\n${block}`), d).html;
          await trilium.updateNoteContent(noteId, finalContent);
        }
      }
      const titled = await applyTitle();
      const iconSet = await applyIcon(noteId, icon);
      await trilium.updateLabelValue(noteId, "updated", d);
      if (labelOf(note, "status") === "dormant") await trilium.updateLabelValue(noteId, "status", "active");

      const relations = relationSnippet(note);
      const targeted = occurrence && occurrence > 1 ? ` occurrence ${occurrence} of` : "";
      const verb = mode === "append" ? "appended to" : mode === "prepend" ? "prepended to" : mode === "before" || mode === "after" ? `inserted ${mode}` : "replaced";
      const sectionHint = !sectionResult
        ? undefined
        : !sectionResult.matched
        ? `No existing "${section}" heading found at h2/h3/h4 — wrote a NEW h${sectionMiss.appendedAtLevel ?? 2} section instead of replacing anything.${sectionMiss.didYouMean ? ` Nearest existing heading: "${sectionMiss.didYouMean}" — a typo is the likeliest cause.` : ""} Check available= for the note's real heading texts, then re-target.`
        : sectionResult.headingCount > 1 && !occurrence
        ? `${sectionResult.headingCount} headings match "${section}" — the FIRST was ${verb}. Pass occurrence= (1-${sectionResult.headingCount}) to reach a different one; outline(noteId) lists them.`
        : sectionResult.headingCount > 1
        ? `${sectionResult.headingCount} headings match "${section}" —${targeted} that one was ${verb}.`
        : undefined;
      return txt({
        ok: true,
        noteId,
        // mode used to collapse every section operation to "section:<heading>",
        // so an insert-after and a whole-section replace produced identical
        // receipts — and a rename-only call reported "metadata-only", which
        // reads as "nothing happened" even though the title HAD been changed.
        mode: body
          ? section
            ? `section:${mode === "before" || mode === "after" ? `insert-${mode}` : mode === "append" ? "append-within" : mode === "prepend" ? "prepend" : "replace"}:${section}`
            : (mode ?? "append")
          : titled.retitled
          ? "rename"
          : iconSet
          ? "icon"
          : "no-op",
        date: d,
        ...(sectionResult ? { matched: sectionResult.matched, headingCount: sectionResult.headingCount } : {}),
        ...(sectionResult?.replacedSubsections?.length
          ? {
              replacedSubsections: sectionResult.replacedSubsections,
              displacedHint: `The replaced section contained ${sectionResult.replacedSubsections.length} nested heading(s) — they went with it. Re-add any that should have survived.`,
            }
          : {}),
        ...sectionMiss,
        ...(sectionHint ? { hint: sectionHint } : {}),
        ...(threadEntryResult ? { entryId: threadEntryResult.noteId, entryAction: threadEntryResult.action } : {}),
        ...(titled.retitled ? { retitled: titled.retitled } : {}),
        ...(titled.cascaded ? { domainCascade: `#domain updated on ${titled.cascaded} descendant note(s)` } : {}),
        ...structuralFindings(noteKind, finalContent),
        ...(iconSet ? { icon: iconSet } : {}),
        ...(relations ? { relations } : {}),
        ...(warnings.length ? { sanitized: warnings } : {}),
      });
    }
  );

  server.tool(
    "resolve",
    `Close a thread (or any resolvable note) with a substantive outcome: writes the Resolution, sets the terminal status and archives it in place. "done" is not an outcome.`,
    {
      noteId: z.string().describe("The thread / note to complete"),
      outcome: z.string().describe("The resolution — substantive, standalone prose"),
      status: z.enum(["resolved", "superseded"]).optional().describe("Terminal status (default: resolved)"),
      supersededBy: z.string().optional().describe("noteId of the replacement, when status=superseded"),
      date: z.string().optional().describe("ISO date (default: today)"),
    },
    async ({ noteId, outcome, status, supersededBy, date }) => {
      if (isStructural(b(), noteId))
        return err("protected_note", `Note ${noteId} is a structural note and cannot be resolved.`, "Only thread and content notes can be resolved.");
      const d = checkedDate(date);
      const terminal = status ?? "resolved";
      const note = await trilium.getNote(noteId);

      const { html: outcomeHtml, warnings } = renderBody(outcome);
      await trilium.createRevision(noteId).catch(() => null);
      const current = await trilium.getNoteContent(noteId);
      await trilium.updateNoteContent(noteId, applyResolution(current, outcomeHtml, d));
      await trilium.updateLabelValue(noteId, "status", terminal);
      await trilium.updateLabelValue(noteId, "closed", d);
      await ensureArchivedFlag(trilium, note);

      const followUps: string[] = [];
      if (supersededBy) {
        await trilium.addRelation(supersededBy, "supersedes", noteId).catch(() => null);
        followUps.push(`superseded by ${supersededBy}`);
      }
      // note's own outbound relations are unaffected by resolve() — supersededBy
      // wires a relation FROM the replacement TO this note, not the reverse
      // (already surfaced above via followUps).
      const relations = relationSnippet(note);

      return txt({
        ok: true,
        noteId,
        kind: (labelOf(note, "noteType") as AnyKind | undefined) ?? "note",
        status: terminal,
        archivedInPlace: true,
        ...(followUps.length ? { followUps } : {}),
        ...(relations ? { relations } : {}),
        ...(warnings.length ? { sanitized: warnings } : {}),
      });
    }
  );

  server.tool(
    "split",
    `Move whole sections (heading + body, nested sub-sections included) out of a note into a new note under the same parent, typed and labelled like the source; the source keeps a pointer and a ~references edge. Use it when a note is past the read ceiling or holds two subjects. sections=[heading texts], into="<new title>". Missing sections come back in missed=. A revision is taken first; refused on containers and singletons.`,
    {
      noteId: z.string().describe("Note to split — the source whose sections are moving out"),
      sections: z.array(z.string()).min(1).max(20).describe("Section headings (text) to move out — nested sub-sections go with their parent"),
      into: z.string().describe("Title of the new note that receives the moved sections"),
      date: z.string().optional().describe("ISO date (default: today)"),
    },
    async ({ noteId, sections, into, date }) => {
      if (isStructural(b(), noteId))
        return err("protected_note", `Note ${noteId} is a structural note (container or singleton) and cannot be split.`, "split() is for content notes — pass a content note id, not a container.");
      const d = checkedDate(date);
      const note = await trilium.getNote(noteId);
      const kind = labelOf(note, "noteType") ?? "information";
      const current = await trilium.getNoteContent(noteId);

      const result = extractSections(current, sections);
      if (result.overlap.length) {
        return err(
          "overlapping_sections",
          `The requested sections overlap: ${result.overlap.join(" and ")}.`,
          "A parent section already contains its nested child; request the parent or child, not both."
        );
      }
      if (!result.matched.length)
        return err(
          "no_sections_matched",
          `None of the requested sections exist in this note.`,
          `Available headings: ${headingOutline(current).map((h) => `"${h.text}"`).join(", ") || "(none)"}. Pass the exact heading text from outline(noteId).`
        );

      const { title: cleanTitle } = normalizeTitle(into);
      if (!cleanTitle)
        return err("missing_param", "into= produced no usable title.", 'Give the new note a real title, e.g. into="Code Priority Queue — resolved items".');

      // Create the receiving note under the same parent, carrying the source's
      // type and labels so it is born wired and discoverable.
      const parentId = note.parentNoteIds[0];
      if (!parentId)
        return err("no_parent", "The source note has no parent — cannot place the split target.", "A content note should have exactly one parent.");
      const created = await trilium.createNote(parentId, cleanTitle, result.extracted, "text");
      const nid = created.note.noteId;
      for (const l of labelPlan(kind as AnyKind, { domain: labelOf(note, "domain"), topics: (note.attributes.filter((a) => isOwnedAttribute(note, a) && a.type === "label" && a.name === "topic").map((a) => a.value ?? "").filter(Boolean)) }, d)) {
        if (l.name === "noteType" || l.name === "created") await trilium.addLabel(nid, l.name, l.value, l.inheritable ?? false);
      }
      if (labelOf(note, "domain")) await trilium.addLabel(nid, "domain", labelOf(note, "domain")!).catch(() => null);
      for (const t of note.attributes.filter((a) => isOwnedAttribute(note, a) && a.type === "label" && a.name === "topic")) {
        if (t.value) await trilium.addLabel(nid, "topic", t.value).catch(() => null);
      }

      // Pointer left in the source where the first section used to be — a
      // navigable breadcrumb rather than a silent removal.
      const pointer = `<p><em>Split ${d} — moved ${result.matched.length} section(s) into <strong>${escapeHtml(cleanTitle)}</strong> [${nid}].</em></p>`;
      await trilium.createRevision(noteId).catch(() => null);
      await trilium.updateNoteContent(noteId, `${pointer}\n${result.html}`);
      await trilium.updateLabelValue(noteId, "updated", d);

      await trilium.addRelation(noteId, "references", nid).catch(() => null);

      const remaining = await trilium.getNoteContent(noteId);
      const remainingNote = await trilium.getNote(noteId).catch(() => null);
      return txt({
        ok: true,
        action: "split",
        noteId,
        newNoteId: nid,
        newNoteTitle: cleanTitle,
        moved: result.matched,
        ...(result.missed.length ? { missed: result.missed } : {}),
        remainingSize: remaining.length,
        pointer: `Split ${d} — moved ${result.matched.length} section(s) into ${cleanTitle} [${nid}]`,
        ...(remainingNote ? { relations: relationSnippet(remainingNote) } : {}),
        note: `Moved ${result.matched.length} section(s) into "${cleanTitle}" [${nid}]; the source now points at it. If this was the wrong seam, the source has a revision from before the split.`,
      });
    }
  );

  server.tool(
    "withdraw",
    `Return an archived or resolved thread to active and note the withdrawal on the book. Use when closed work resurfaces.`,
    {
      noteId: z.string().describe("The archived/resolved thread to withdraw"),
      reason: z.string().optional().describe("Why it was withdrawn — written as an addendum"),
      date: z.string().optional().describe("ISO date (default: today)"),
    },
    async ({ noteId, reason, date }) => {
      if (isStructural(b(), noteId))
        return err("protected_note", `Note ${noteId} is structural and cannot be withdrawn.`);
      const d = checkedDate(date);
      const note = await trilium.getNote(noteId);
      const kind = labelOf(note, "noteType");
      if (kind !== "thread")
        return err("wrong_kind", `withdraw() is for threads only — this note has kind "${kind ?? "untyped"}".`, "Use recover() to restore any other archived or resolved note.");

      const archivedAttr = note.attributes.find((a) => isOwnedAttribute(note, a) && a.type === "label" && a.name === "archived");
      if (archivedAttr) await trilium.deleteAttribute(archivedAttr.attributeId).catch(() => null);

      const closedAttr = note.attributes.find((a) => isOwnedAttribute(note, a) && a.type === "label" && a.name === "closed");
      if (closedAttr) await trilium.deleteAttribute(closedAttr.attributeId).catch(() => null);

      await trilium.updateLabelValue(noteId, "status", "active");

      const current = await trilium.getNoteContent(noteId);
      const { html: withdrawHtml, warnings } = reason
        ? renderBody(reason)
        : { html: "<p><em>Thread re-activated.</em></p>", warnings: [] as string[] };
      if (!isDuplicateAppend(current, withdrawHtml)) {
        await trilium.createRevision(noteId).catch(() => null);
        await trilium.updateNoteContent(noteId, safeAppend(current, `<h2>Withdrawn — ${d}</h2>`, withdrawHtml));
        await trilium.updateLabelValue(noteId, "updated", d);
      }

      const relations = relationSnippet(note);
      return txt({
        ok: true,
        noteId,
        kind: (labelOf(note, "noteType") as AnyKind | undefined) ?? "note",
        status: "active",
        withdrawn: d,
        ...(relations ? { relations } : {}),
        ...(warnings.length ? { sanitized: warnings } : {}),
      });
    }
  );

  server.tool(
    "label",
    `Set or remove one label (remove=true). Refused on containers. noteType cannot be changed or removed, but can be set on an untyped note to repair it. status must be one of ${Statuses.join(" | ")}; domain and topic are slugged. Bumps updated unless you are setting it.`,
    {
      noteId: z.string().describe("Note to edit"),
      name: z.string().describe("Label name, no # prefix (e.g. status, domain, topic, created)"),
      value: z.string().optional().describe("New value — required unless remove=true"),
      remove: z.boolean().optional().describe("Delete this label instead of setting it"),
    },
    async ({ noteId, name, value, remove }) => {
      if (isContainer(b(), noteId))
        return err("protected_note", `Note ${noteId} is a container — its labels cannot be edited directly.`);
      if (name === "iconClass" && remove) {
        const n = await trilium.getNote(noteId).catch(() => null);
        if (n && !ICON_EXEMPT.has(ownedLabel(n, "noteType") ?? ""))
          return err("protected_label", "Every note except a log carries an icon.", 'Change it instead: label(noteId, "iconClass", value="bx bx-<name>").');
      }
      const noteForGuard = name === "noteType" ? await trilium.getNote(noteId).catch(() => null) : null;
      if (name === "noteType") {
        // noteType is never EDITABLE — but it must be REPAIRABLE.
        //
        // The blanket refusal was right for changing a kind and wrong for
        // restoring a missing one. Combined with dedup being blind to untyped
        // notes, it left no core path back from an untyped note holding real
        // content: dedup would not find it, and this tool would not type it.
        // Repairing one required dropping to full-mode add_label. So the guard
        // now refuses only what it was actually protecting — an existing kind.
        if (!noteForGuard)
          return err("not_found", `Note ${noteId} could not be read.`, "Check the noteId.");
        const existing = ownedLabel(noteForGuard, "noteType");
        if (existing)
          return err(
            "protected_label",
            `noteType is already set to "${existing}" and defines this note's kind — it cannot be changed.`,
            "To change what a note represents, create it fresh with remember() under the right kind."
          );
        if (remove)
          return err("protected_label", "noteType cannot be removed — a note without it is invisible to every read path.");
        if (!value || !(Kinds as readonly string[]).includes(value))
          return err(
            "invalid_value",
            `"${value ?? ""}" is not a valid kind.`,
            `Repairing an untyped note requires one of: ${Kinds.join(" · ")}`
          );
        await trilium.addLabel(noteId, "noteType", value, false);
        // A repaired note also needs the rest of its label plan, or it is typed
        // but ages wrongly and reports no dates.
        const applied: string[] = [`noteType=${value}`];
        for (const l of labelPlan(value as AnyKind, {}, today())) {
          if (l.name === "noteType" || ownedLabel(noteForGuard, l.name)) continue;
          await trilium.addLabel(noteId, l.name, l.value, l.inheritable ?? false).catch(() => null);
          applied.push(l.value ? `${l.name}=${l.value}` : l.name);
        }
        return txt({
          ok: true, noteId, name, value, action: "repaired", applied,
          note: "This note was untyped and therefore invisible to brain(), recall() and every surface read. It is now typed and will appear.",
        });
      }

      const note = await trilium.getNote(noteId);

      if (remove) {
        const attr = note.attributes.find((a) => isOwnedAttribute(note, a) && a.type === "label" && a.name === name);
        if (!attr) return txt({ ok: true, noteId, name, action: "not_found" });
        await trilium.deleteAttribute(attr.attributeId);
        if (name !== "updated") await trilium.updateLabelValue(noteId, "updated", today()).catch(() => null);
        return txt({ ok: true, noteId, name, action: "removed" });
      }

      if (value === undefined)
        return err("missing_param", "label() requires value unless remove=true.", 'Add value="..." or set remove=true.');

      if (name === "status" && !(Statuses as readonly string[]).includes(value))
        return err("invalid_value", `"${value}" is not a valid status.`, `Use one of: ${Statuses.join(", ")}.`);

      const finalValue = name === "domain" || name === "topic" ? slugify(value) : value;
      await trilium.updateLabelValue(noteId, name, finalValue);
      if (name !== "updated") await trilium.updateLabelValue(noteId, "updated", today()).catch(() => null);

      return txt({ ok: true, noteId, name, value: finalValue, action: "set" });
    }
  );

  // ════════════════════════════════════════════════════════════════════════════
  // GRAPH
  // ════════════════════════════════════════════════════════════════════════════

  server.tool(
    "connect",
    `Wire a typed relation between two notes when you notice a real connection.
Vocabulary (closed): ${RelationTypes.join(" | ")}.
worksWith is symmetric and wired both ways automatically. Existing edges are detected —
calling twice is safe. Use remove=true to delete an edge.`,
    {
      fromNoteId: z.string().describe("Source note"),
      relation: z.enum(RelationTypes).describe("Relation type"),
      toNoteId: z.string().describe("Target note"),
      remove: z.boolean().optional().describe("Delete this relation instead of creating it"),
    },
    async ({ fromNoteId, relation, toNoteId, remove }) => {
      const symmetric = SymmetricRelations.includes(relation);

      if (remove) {
        await trilium.removeRelation(fromNoteId, relation, toNoteId).catch(() => null);
        if (symmetric) await trilium.removeRelation(toNoteId, relation, fromNoteId).catch(() => null);
        return txt({ ok: true, removed: `${fromNoteId} ~${relation}→ ${toNoteId}` });
      }

      const from = await trilium.getNote(fromNoteId);
      const exists = from.attributes.some((a) => isOwnedAttribute(from, a) && a.type === "relation" && a.name === relation && a.value === toNoteId);
      if (!exists) await trilium.addRelation(fromNoteId, relation, toNoteId);
      if (symmetric) {
        const to = await trilium.getNote(toNoteId);
        const reverseExists = to.attributes.some((a) => isOwnedAttribute(to, a) && a.type === "relation" && a.name === relation && a.value === fromNoteId);
        if (!reverseExists) await trilium.addRelation(toNoteId, relation, fromNoteId);
      }
      return txt({ ok: true, action: exists ? "already-existed" : "created", edge: `${fromNoteId} ~${relation}${symmetric ? "↔" : "→"} ${toNoteId}` });
    }
  );

  server.tool(
    "explore",
    `Walk the relation graph around a note.
  mode=links         what this note points to (one hop)
  mode=backlinks     what points to this note (one hop)
  mode=neighborhood  everything within N hops, both directions (depth, optional relation filter);
                     via is prefixed ← for edges walked inbound
  mode=path          shortest connection between noteId and toNoteId`,
    {
      noteId: z.string().describe("Starting note"),
      mode: z.enum(["links", "backlinks", "neighborhood", "path"]).describe("Traversal mode"),
      toNoteId: z.string().optional().describe("Target note (mode=path)"),
      depth: z.number().optional().describe("Hops for neighborhood (default: 2)"),
      relation: z.string().optional().describe("Restrict to one relation type"),
    },
    async ({ noteId, mode, toNoteId, depth, relation }) => {
      switch (mode) {
        case "links": {
          const note = await trilium.getNote(noteId);
          const rels = note.attributes.filter(
            (a) => isOwnedAttribute(note, a) && a.type === "relation" && a.name !== "template" && (!relation || a.name === relation)
          );
          const linked = await Promise.all(
            rels.map(async (r) => {
              const n = await trilium.getNote(r.value).catch(() => null);
              return n ? { id: n.noteId, title: n.title, via: r.name } : null;
            })
          );
          return txt({ mode, links: linked.filter(Boolean) });
        }
        case "backlinks": {
          const backlinks = await trilium.getBacklinks(noteId);
          return txt({ mode, backlinks: relation ? backlinks.filter((b2) => b2.relationName === relation) : backlinks });
        }
        case "neighborhood": {
          const nodes = await trilium.getNeighborhood(noteId, depth ?? 2, relation);
          return txt({ mode, nodeCount: nodes.length, nodes });
        }
        case "path": {
          if (!toNoteId) throw new Error("mode=path requires toNoteId");
          if (noteId === toNoteId) {
            const self = await trilium.getNote(noteId);
            return txt({ mode, found: true, hops: 0, path: [{ noteId, title: self.title, depth: 0 }] });
          }
          const path = await trilium.findNeuralPath(noteId, toNoteId, depth ?? 6);
          return txt(path ? { mode, found: true, hops: path.length - 1, path } : { mode, found: false });
        }
      }
    }
  );

  server.tool(
    "consistency",
    `Does the brain agree with itself? pattern= is a regex with ONE capture group naming the value that should match across notes, e.g. "(\\\\d+) mailboxes"; the result groups every asserting note by value with agreement unanimous or DISAGREEMENT. subject="<fact in prose>" finds notes asserting about a subject however phrased. staleAfterDays=N also reports values held in exactly one note untouched N+ days. Matches stored HTML and tag-stripped text; escape backslashes; scope with domain=/kinds=. Scans every in-scope note (fast=true uses Trilium's lossy pre-filter). Run it after correcting any fact recorded in more than one place.`,
    {
      pattern: z.string().optional().describe("Regex over note bodies. One capture group = the value that should agree across notes. Omit when using subject= (prose mode)."),
      subject: z.string().optional().describe("A fact in prose — returns notes asserting about it however phrased (instead of pattern=)"),
      staleAfterDays: z.number().optional().describe("With pattern: also report values held in exactly one note untouched N+ days (staleSingles)"),
      domain: z.string().optional().describe("Restrict to one knowledge domain"),
      kinds: z.array(z.enum(Kinds)).optional().describe("Restrict to these kinds"),
      includeArchived: z.boolean().optional().describe("Include archived notes (default false)"),
      limit: z.number().optional().describe("Max notes to examine (default 60)"),
      fast: z.boolean().optional().describe("Use Trilium's faster but lossy %= pre-filter (default: scan every in-scope note)"),
    },
    async ({ pattern, subject, staleAfterDays, domain, kinds, includeArchived, limit, fast }) => {
      if (!pattern && !subject)
        return err("missing_param", "consistency() needs either a regex pattern or a prose subject.", 'Pass pattern="(\\\\d+) users" to compare a captured value, or subject="<a fact in prose>" to find every note asserting about that subject however phrased.');

      // ── Prose-subject mode: "which notes assert something about X, however phrased".
      // The reason consistency() felt useless for re-measuring a fact was the regex
      // guesswork — a pattern anchored on the wrong word order returns nothing while
      // a note plainly states the fact. subject= replaces the guess with significant
      // tokens extracted from the prose, and a note counts as asserting about the
      // subject when it contains a majority of them.
      if (subject && !pattern) {
        const max = limit ?? 60;
        const tokens = queryTokens(subject, 8);
        if (!tokens.length)
          return err("no_tokens", "The subject produced no significant content words.", 'A subject of all stop-words ("what was it") cannot find anything — name the thing you re-measured.');
        const clauses = ["#noteType"];
        if (domain) clauses.push(`#domain='${slugify(domain)}'`);
        const notes = await trilium
          .searchNotes(clauses.join(" AND "), { ancestorNoteId: b().root, limit: max, includeArchivedNotes: includeArchived ?? false })
          .then((r) => r.results)
          .catch(() => [] as Note[]);
        const scoped = notes.filter((n) => {
          const kind = ownedLabel(n, "noteType");
          if (!kind) return false;
          return !kinds?.length || (kinds as string[]).includes(kind);
        });
        const threshold = Math.max(1, Math.ceil(tokens.length / 2));
        const hits: Array<{ id: string; title: string; kind: string; matchedTokens: string[]; snippet: string }> = [];
        for (const n of scoped) {
          const content = await trilium.getNoteContent(n.noteId).catch(() => "");
          if (!content) continue;
          const text = stripTagsWithMap(content).text.toLowerCase();
          const matchedTokens = tokens.filter((t) => text.includes(t));
          if (matchedTokens.length < threshold) continue;
          hits.push({ id: n.noteId, title: n.title, kind: ownedLabel(n, "noteType") ?? "", matchedTokens, snippet: toText(content, 200) });
        }
        return txt({
          mode: "subject",
          subject,
          tokens,
          threshold: `${threshold} of ${tokens.length} token(s)`,
          notesExamined: scoped.length,
          notes: hits,
          total: hits.length,
          ...(domain ? { domain: slugify(domain) } : {}),
          note: hits.length
            ? `${hits.length} note(s) assert something about "${subject}". Open each to read the claim — or narrow with domain= / kinds=.`
            : `No note in scope matched ${threshold}+ of the subject's tokens. That is evidence about the phrasing, not the brain — this mode is deliberately phrase-agnostic, so if you expected a hit, the fact may not be recorded here at all.`,
        });
      }
      if (!pattern) return err("missing_param", "No regex pattern given for consistency.", 'Pass pattern="(\\\\d+) users" — or subject="<a fact in prose>" for the prose-subject mode.');
      let re: RegExp;
      try {
        re = new RegExp(pattern, "gi");
      } catch (e) {
        return err("invalid_pattern", `Not a valid regular expression: ${(e as Error).message}`, "Escape backslashes — a JSON string needs \\\\d for \\d.");
      }

      const max = limit ?? 60;
      // Candidate acquisition. The %= pre-filter is opt-in because it is lossy
      // in BOTH directions: Trilium matches a striptags'd copy, so a pattern
      // anchored on tags returns nothing, and its lexer eats a level of
      // backslash escaping (hence escapeQueryRegex, which doubles them —
      // escapeQueryValue used to replace each backslash with a SPACE, quietly
      // rewriting the regex before the backend ever saw it).
      const clauses = fast ? [`note.content %= '${escapeQueryRegex(pattern)}'`] : ["#noteType"];
      if (domain) clauses.push(`#domain='${slugify(domain)}'`);
      const notes = await trilium
        .searchNotes(clauses.join(" AND "), { ancestorNoteId: b().root, limit: max, includeArchivedNotes: includeArchived ?? false })
        .then((r) => r.results)
        .catch(() => [] as Note[]);

      const scoped = notes.filter((n) => {
        const kind = ownedLabel(n, "noteType");
        if (!kind) return false;
        return !kinds?.length || (kinds as string[]).includes(kind);
      });

      // Group by the captured value. A note asserting the value more than once
      // contributes each distinct capture, because a note that contradicts
      // ITSELF is the same defect at smaller scale.
      const byValue = new Map<string, Array<{ id: string; title: string; kind: string; idleDays: number }>>();
      const noCapture: Array<{ id: string; title: string; kind: string; idleDays: number }> = [];
      let hasCaptureGroup = false;

      /** Run the pattern over one corpus, returning every captured value and
       *  whether the pattern matched at all.
       *
       *  Takes the first group that actually captured, not group 1. An
       *  alternation puts the value in whichever branch matched, so
       *  `a([0-9]+)|b([0-9]+)` leaves m[1] undefined whenever the second branch
       *  wins — and reading only m[1] made the whole call silently degrade to
       *  presence mode and report "the pattern has no capture group" about a
       *  pattern that plainly has two. */
      const scan = (haystack: string): { values: string[]; matched: boolean } => {
        const values: string[] = [];
        let matched = false;
        re.lastIndex = 0;
        let m: RegExpExecArray | null;
        while ((m = re.exec(haystack)) !== null) {
          matched = true;
          const captured = m.slice(1).find((g) => g !== undefined);
          if (captured !== undefined) values.push(toText(captured, 120).trim() || captured.trim());
          if (m[0] === "") re.lastIndex++; // guard against a zero-width match looping
        }
        return { values, matched };
      };

      let tagSpanning = 0;
      const idleSince = (iso: string) =>
        Math.max(0, Math.floor((Date.now() - new Date(iso.replace(" ", "T")).getTime()) / 86_400_000));
      for (const n of scoped) {
        const content = await trilium.getNoteContent(n.noteId).catch(() => "");
        if (!content) continue;
        const stub = { id: n.noteId, title: n.title, kind: ownedLabel(n, "noteType") ?? "", idleDays: idleSince(n.dateModified) };

        // Two corpora, unioned: the raw stored body (so a pattern anchored on
        // tags or entities still works) and a tag-stripped projection (so a
        // phrase broken by an inline <strong> or <code> is not invisible).
        // Matching only the raw body is what made a split phrase report zero
        // with no warning that the regex could not traverse markup.
        const raw = scan(content);
        const projected = scan(stripTagsWithMap(content).text);
        if (projected.matched && !raw.matched) tagSpanning++;

        const seen = new Set<string>();
        for (const value of [...raw.values, ...projected.values]) {
          hasCaptureGroup = true;
          if (seen.has(value)) continue;
          seen.add(value);
          if (!byValue.has(value)) byValue.set(value, []);
          byValue.get(value)!.push(stub);
        }
        if ((raw.matched || projected.matched) && !seen.size) noCapture.push(stub);
      }

      if (!hasCaptureGroup) {
        return txt({
          mode: "presence",
          pattern,
          scan: fast ? "fast (%= pre-filter)" : "exhaustive",
          notesExamined: scoped.length,
          notes: noCapture,
          total: noCapture.length,
          note:
            noCapture.length === 0
              ? `No note body matched that pattern across ${scoped.length} note(s), searched both as stored HTML and tag-stripped.${fast ? " fast=true used Trilium's %= pre-filter, which reads a striptags'd copy and can drop notes — re-run without it before concluding anything." : " That is evidence about the pattern, not the brain."}`
              : "The pattern has no capture group, so this is a presence check only. Add one — consistency(\"(\\\\d+) users\") — to compare the values these notes actually assert.",
        });
      }

      const groups = [...byValue.entries()]
        .map(([value, notes]) => ({ value, count: notes.length, notes }))
        .sort((a, b) => b.count - a.count);

      // Stale-single-copy report: figures asserted in EXACTLY one note, whose
      // sole note was last touched more than staleAfterDays ago. The inverse of
      // the agreement check — consistency() can only tell a single copy that it
      // agrees with itself, so a one-copy figure rots silently until someone
      // re-measures it. Only reported when the caller opts in with staleAfterDays=.
      const staleSingles = staleAfterDays
        ? groups
            .filter((g) => g.count === 1 && g.notes[0]!.idleDays >= staleAfterDays)
            .map((g) => ({ value: g.value, note: { id: g.notes[0]!.id, title: g.notes[0]!.title, kind: g.notes[0]!.kind }, idleDays: g.notes[0]!.idleDays }))
        : [];

      const agrees = groups.length <= 1;
      return txt({
        mode: "consistency",
        pattern,
        scan: fast ? "fast (%= pre-filter)" : "exhaustive",
        ...(domain ? { domain: slugify(domain) } : {}),
        notesExamined: scoped.length,
        ...(tagSpanning ? { tagSpanning, tagSpanningNote: `${tagSpanning} note(s) matched only once markup was stripped — the phrase is split by an inline tag there. Before v10.3 those were invisible.` } : {}),
        distinctValues: groups.length,
        agreement: groups.length === 0 ? "no-data" : agrees ? "unanimous" : "DISAGREEMENT",
        groups,
        ...(staleAfterDays ? { staleAfterDays } : {}),
        ...(staleSingles.length
          ? { staleSingles, staleSinglesNote: `${staleSingles.length} figure(s) appear in exactly one note, untouched ${staleAfterDays}d+ — a single copy cannot disagree with itself, so re-measure these against the world rather than against other notes.` }
          : {}),
        ...(noCapture.length ? { matchedWithoutValue: noCapture } : {}),
        note: agrees
          ? groups.length === 0
            ? "No note asserted a value for that pattern. That is evidence about the pattern, not about the brain — check it against a note you know contains the fact."
            : `All ${groups[0]!.count} note(s) agree on "${groups[0]!.value}".`
          : `${groups.length} DIFFERENT values are asserted across ${scoped.length} notes. Establish which is true from evidence, correct every note that disagrees, and wire ~corrects from the note that overturns the old claim — revising in place leaves no trace the wrong value was ever believed.`,
      });
    }
  );

  server.tool(
    "outline",
    `A note's heading tree without its body: each h2–h4 with level and occurrence index (and raw stored text where inline markup differs), table key columns, size, and structural findings. Read it before a section= edit you're not sure of. Notes over 15k also get a first-block preview per section.`,
    {
      noteId: z.string().describe("Note to outline"),
    },
    async ({ noteId }) => {
      const note = await trilium.getNote(noteId);
      const contentResult = await trilium.getNoteContentResult(noteId, note.type);
      if (typeof contentResult !== "string") {
        return txt({ noteId, title: note.title, kind: labelOf(note, "noteType"), binary: true, encoding: contentResult.encoding, mime: contentResult.mime, size: contentResult.content.length, note: "Binary notes have no HTML heading outline; use inspect(content=true) or the raw content tool." });
      }
      const content = contentResult;
      const headings = headingOutline(content);
      const report = structureReport(content);
      const tables = headings
        .map((h) => ({ section: h.text, keys: tableRows(content, h.text).map((c) => c[0]).filter(Boolean) }))
        .filter((t) => t.keys.length);
      // First-block preview per section, on notes large enough for "which
      // section do I actually want" to be a real question. One walk, stop-tag
      // = the next heading of any level, matching how headingOutline treats
      // the tree as flat. An extract, never the body — the section still has
      // to be read for its full content.
      const previews: Array<{ section: string; preview: string }> = [];
      if (content.length >= 15_000) {
        const chunkRe = /<h[2-4](?:\s[^>]*)?>([\s\S]*?)<\/h[2-4]>([\s\S]*?)(?=<h[2-4][\s>]|$)/gi;
        let cm: RegExpExecArray | null;
        while ((cm = chunkRe.exec(content)) !== null) {
          const text = decodeEntities(cm[1]!.replace(/<[^>]+>/g, "")).replace(/\s+/g, " ").trim();
          if (!text) continue;
          const block = cm[2]!.match(/<(?:p|li)[^>]*>([\s\S]*?)<\/(?:p|li)>/i);
          const preview = decodeEntities((block ? block[1]! : cm[2]!).replace(/<[^>]+>/g, " "))
            .replace(/\s+/g, " ")
            .trim()
            .slice(0, 140) || "(empty)";
          previews.push({ section: text, preview });
        }
      }
      const sizeWarning = report.size >= LARGE_NOTE_CHARS
        ? `${Math.round(report.size / 1000)}k characters — approaching the tool output ceiling. Prefer section=/find= edits and targeted reads over whole-note reads.`
        : undefined;
      return txt({
        noteId,
        title: note.title,
        kind: labelOf(note, "noteType"),
        size: report.size,
        headings: headings.map((h) => ({
          level: h.level,
          text: h.text,
          ...(h.occurrence > 1 ? { occurrence: h.occurrence } : {}),
          ...(h.raw ? { raw: h.raw } : {}),
        })),
        ...(headings.some((h) => h.raw)
          ? { rawHint: 'Headings carrying inline markup also report raw — their STORED form. section= matches text (use it), find= matches stored HTML (use raw). Building a find= from text alone misses on exactly these headings.' }
          : {}),
        sectionLevel: sectionLevelFor(content),
        ...(tables.length ? { tables } : {}),
        ...(previews.length ? { previews } : {}),
        ...(report.duplicateHeadings.length ? { duplicateHeadings: report.duplicateHeadings } : {}),
        ...(report.unbalancedTags.length ? { unbalancedTags: report.unbalancedTags } : {}),
        ...(sizeWarning ? { sizeWarning } : {}),
        ...(headings.length === 0 ? { note: "No h2–h4 headings — section= would append a new section rather than match anything." } : {}),
      });
    }
  );

  server.tool(
    "inspect",
    `Everything about one note: every label, relation and attachment, type/mime, parent and child ids, dates. content=true adds the raw body (section= narrows it). find="<literal>" counts occurrences (total, per addendum block, per section) and on a miss shows the nearest stored text. Read-only, safe on any note.`,
    {
      noteId: z.string().describe("Note to inspect"),
      content: z.boolean().optional().describe("Include the note's raw body content (default: false)"),
      section: z.string().optional().describe("With content=true, return only this heading's section rather than the whole body"),
      find: z.string().optional().describe("Literal string to count in the body — returns total occurrences + per-addendum-block counts (flag-staleness tracking)"),
    },
    async ({ noteId, content, section, find }) => {
      const note = await trilium.getNote(noteId);
      const [attachments, rawResult] = await Promise.all([
        trilium.getNoteAttachments(noteId).catch(() => []),
        content || find ? trilium.getNoteContentResult(noteId, note.type) : Promise.resolve(undefined),
      ]);
      if (rawResult && typeof rawResult !== "string" && (section || find)) {
        return err("binary_content", `Note ${noteId} contains binary ${rawResult.mime} data; section= and find= operate on text only.`, "Read the full body without section/find, or use the raw get_note_content tool for the base64 envelope.");
      }
      const rawBody = typeof rawResult === "string" ? rawResult : undefined;
      const binaryBody = rawResult && typeof rawResult !== "string" ? rawResult : undefined;
      // A sectioned raw read: the same heading contract as revise(section=), so
      // "inspect the part I am about to edit" costs the section, not the note.
      let sectionRead: ReturnType<typeof getSection> | null = null;
      if (content && section && rawBody !== undefined) sectionRead = getSection(rawBody, section);
      const body = content ? (binaryBody ?? (sectionRead ? sectionRead.content : rawBody)) : undefined;

      // Literal-occurrence count, total + per addendum block. Blocks are keyed
      // by their marker heading; content before the first marker is "(head)".
      let findReport: { find: string; total: number; blocks: Array<{ block: string; count: number }>; sections?: Array<{ section: string; count: number }>; matchedUpTo?: string; storedNearby?: string; hint?: string } | undefined;
      if (find && rawBody !== undefined) {
        const countIn = (s: string) => s.split(find).length - 1;
        // Which heading each occurrence sits under — the locator that turns
        // "hunt one literal across a 31k note" into a single read. Attributed
        // on the same body the count uses, so the two never disagree. A match
        // before the first heading is "(head)".
        const headings: Array<{ text: string; index: number }> = [];
        const headingRe = /<h[2-4](?:\s[^>]*)?>([\s\S]*?)<\/h[2-4]>/gi;
        let hm: RegExpExecArray | null;
        while ((hm = headingRe.exec(rawBody)) !== null) {
          const text = decodeEntities(hm[1]!.replace(/<[^>]+>/g, "")).replace(/\s+/g, " ").trim();
          if (text) headings.push({ text, index: hm.index });
        }
        const bySection = new Map<string, number>();
        let scan = rawBody.indexOf(find);
        while (scan !== -1) {
          let sectionName = "(head)";
          for (const h of headings) {
            if (h.index < scan) sectionName = h.text;
            else break;
          }
          bySection.set(sectionName, (bySection.get(sectionName) ?? 0) + 1);
          scan = rawBody.indexOf(find, scan + Math.max(1, find.length));
        }
        const sections = [...bySection.entries()].map(([section, count]) => ({ section, count }));
        const markerRe = /<h2(?:\s[^>]*)?>\s*((?:Addendum|Withdrawn|Recovered|Reopened)\s*(?:—|–|-)[^<]*)<\/h2>/gi;
        const blocks: Array<{ block: string; count: number }> = [];
        let last: { name: string; index: number } | null = null;
        let m: RegExpExecArray | null;
        const flush = (end: number) => {
          if (!last) return;
          const count = countIn(rawBody.slice(last.index, end));
          if (count > 0) blocks.push({ block: last.name, count });
        };
        while ((m = markerRe.exec(rawBody)) !== null) {
          if (!last) {
            const headCount = countIn(rawBody.slice(0, m.index));
            if (headCount > 0) blocks.push({ block: "(head)", count: headCount });
          }
          flush(m.index);
          last = { name: m[1].replace(/\s+/g, " ").trim(), index: m.index };
        }
        flush(rawBody.length);
        if (!last) {
          const total = countIn(rawBody);
          if (total > 0) blocks.push({ block: "(body)", count: total });
        }
        const total = countIn(rawBody);
        const near = total === 0 ? nearestContext(rawBody, find) : null;
        findReport = {
          find,
          total,
          blocks,
          ...(sections.length ? { sections } : {}),
          ...(near ? { matchedUpTo: near.fragment, storedNearby: near.context } : {}),
          ...(total === 0 && !near ? { hint: "Not present, and no fragment of it is either — the string is unrelated to this note's content." } : {}),
        };
      }
      const labels = note.attributes
        .filter((a) => a.type === "label")
        .map((a) => ({ name: a.name, value: a.value, owned: isOwnedAttribute(note, a), ...(a.isInheritable ? { inheritable: true } : {}) }));
      const relations = relationSnippet(note, 50);
      return txt({
        id: note.noteId,
        title: note.title,
        kind: labelOf(note, "noteType"),
        type: note.type,
        mime: note.mime,
        status: labelOf(note, "status"),
        ...(hasLabel(note, "archived") ? { archived: true } : {}),
        created: note.dateCreated.slice(0, 10),
        modified: note.dateModified.slice(0, 10),
        labels,
        ...(relations ? { relations } : {}),
        ...(attachments.length
          ? { attachments: attachments.map((a) => ({ id: a.attachmentId, title: a.title, mime: a.mime, role: a.role, size: a.contentLength })) }
          : {}),
        parentNoteIds: note.parentNoteIds,
        childNoteIds: note.childNoteIds,
        ...(findReport ? { findReport } : {}),
        ...(sectionRead
          ? sectionRead.matched
            ? { section, sectionMatched: true, ...(sectionRead.subsections?.length ? { subsections: sectionRead.subsections } : {}) }
            : { section, sectionMatched: false, available: sectionRead.available, hint: `No "${section}" heading — content is empty. Re-target from available=.` }
          : {}),
        ...(body !== undefined ? { content: typeof body === "string" ? body : body.content, ...(typeof body === "string" ? {} : { contentEncoding: body.encoding }) } : {}),
      });
    }
  );

  /** The Claims container under Insights, resolved or created on demand — the
   *  same pattern the Graph note uses, so no config migration is needed. */
  const resolveClaimsContainer = async (): Promise<string> => {
    const cfg = b();
    const found = await trilium
      .searchNotes("note.title = 'Claims'", { ancestorNoteId: cfg.insights.root, fastSearch: true, limit: 1 })
      .catch(() => ({ results: [] as Note[] }));
    if (found.results[0]) return found.results[0].noteId;
    const created = await trilium.createNote(
      cfg.insights.root,
      "Claims",
      "<p><em>Checkable assertions and when each was last verified against the world. Registered and verified through claim(); this container is maintained by the tool.</em></p>"
    );
    await trilium.addLabel(created.note.noteId, "iconClass", "bx bx-check-shield").catch(() => null);
    return created.note.noteId;
  };

  server.tool(
    "claim",
    `Does the brain still agree with the world? Register a checkable assertion and record whether it holds. BrainLLM never runs the check — it stores it as inert text; you run it and report.

assertion + check → register (deduped by assertion); claimId + holds + evidence → verify (evidence required); claimId alone → read with history; nothing → list (status= filters). noteId= links the claim to its source note (~derivedFrom). maintain(deep) surfaces lapsed, never-verified, broken and source-changed claims.`,
    {
      assertion: z.string().optional().describe("The claim in plain words, e.g. \"the parse pipeline runs before validation\" — also the dedup key"),
      check: z.string().optional().describe("How to verify it, as INERT text a human or agent runs: a command, a query, a file path, a URL. Never executed by BrainLLM"),
      noteId: z.string().optional().describe("The note this claim is made in — wired ~derivedFrom so the claim and its source stay linked"),
      intervalDays: z.number().int().positive().optional().describe("How long a verification stays good (default: 30)"),
      claimId: z.string().optional().describe("An existing claim, to read or to verify"),
      holds: z.boolean().optional().describe("With claimId: did the check pass? false marks the claim broken and surfaces it in maintain()"),
      evidence: z.string().optional().describe("With holds: what you actually observed — the output, the count, the response. A verification without evidence is an assertion about an assertion"),
      status: z.enum(["holding", "broken", "lapsed", "all"]).optional().describe("List filter (default: all)"),
      retire: z.boolean().optional().describe("With claimId: archive this claim — the thing it described is gone"),
    },
    async ({ assertion, check, noteId, intervalDays, claimId, holds, evidence, status, retire }) => {
      const cfg = b();
      if (!cfg.root) return txt({ status: "uninitialized", action: "Run bootstrap first." });
      const d = today();
      const container = await resolveClaimsContainer();

      const lapsed = (n: Note): boolean => {
        const verifiedOn = labelOf(n, "verified");
        if (!verifiedOn) return true;
        const days = Number(labelOf(n, "interval") ?? 30);
        return verifiedOn < new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
      };
      const stateOf = (n: Note): "holding" | "broken" | "lapsed" =>
        labelOf(n, "claimState") === "broken" ? "broken" : lapsed(n) ? "lapsed" : "holding";
      const row = (n: Note) => ({
        claimId: n.noteId,
        assertion: n.title,
        state: stateOf(n),
        lastVerified: labelOf(n, "verified") ?? "never",
        intervalDays: Number(labelOf(n, "interval") ?? 30),
      });

      // ── VERIFY / READ / RETIRE ────────────────────────────────────────────
      if (claimId) {
        const note = await trilium.getNote(claimId).catch(() => null);
        if (!note || labelOf(note, "noteType") !== "claim")
          return err("not_found", `${claimId} is not a claim.`, "List them with claim() and no arguments.");

        if (retire) {
          await trilium.addLabel(claimId, "archived", "").catch(() => null);
          return txt({ ok: true, claimId, action: "retired", assertion: note.title });
        }

        if (holds === undefined) {
          const content = await trilium.getNoteContent(claimId);
          return txt({ ...row(note), check: getSection(content, "Check").content, history: getSection(content, "Verifications").content, relations: relationSnippet(note) });
        }

        if (!evidence)
          return err("missing_param", "A verification needs evidence.", 'Pass evidence="<what you actually observed>" — the output, the count, the response. Recording a verdict without it makes the register a record of opinions.');

        const content = await trilium.getNoteContent(claimId);
        const entry = `<p><strong>${d} — ${holds ? "HOLDS" : "BROKEN"}</strong>: ${escapeHtml(evidence)}</p>`;
        const updated = setSection(content, "Verifications", entry, "append");
        await trilium.createRevision(claimId).catch(() => null);
        await trilium.updateNoteContent(claimId, updated.html);
        await trilium.updateLabelValue(claimId, "verified", d).catch(() => null);
        await trilium.updateLabelValue(claimId, "claimState", holds ? "holding" : "broken").catch(() => null);
        await trilium.updateLabelValue(claimId, "updated", d).catch(() => null);

        const refreshed = await trilium.getNote(claimId).catch(() => note);
        return txt({
          ok: true, action: holds ? "verified" : "marked-broken", ...row(refreshed),
          ...(holds
            ? {}
            : { hint: "This claim is now BROKEN. Correct every note that asserts it — consistency() will find the others — then re-verify. A broken claim left in the register is a known-wrong fact with a timestamp on it." }),
        });
      }

      // ── REGISTER ──────────────────────────────────────────────────────────
      if (assertion) {
        if (!check)
          return err("missing_param", "A claim needs a check.", 'Pass check="<command, query, file path or URL that settles it>". A claim nobody can verify is just a sentence; the check is what makes it a claim.');
        const { title } = normalizeTitle(assertion);
        const existing = await trilium
          .searchNotes("#noteType=claim", { ancestorNoteId: container, fastSearch: true, limit: 200 })
          .then((r) => r.results.find((n) => sameTitle(n.title, title)))
          .catch(() => undefined);

        const body =
          `<h2>Check</h2>\n<p>${escapeHtml(check)}</p>\n` +
          `<p><em>Inert by design — BrainLLM never runs this. Run it yourself, then record the outcome with claim(claimId, holds, evidence).</em></p>\n` +
          `<h2>Verifications</h2>\n`;

        if (existing) {
          const current = await trilium.getNoteContent(existing.noteId);
          await trilium.createRevision(existing.noteId).catch(() => null);
          await trilium.updateNoteContent(existing.noteId, setSection(current, "Check", `<p>${escapeHtml(check)}</p>`, "replace").html);
          if (intervalDays) await trilium.updateLabelValue(existing.noteId, "interval", String(intervalDays)).catch(() => null);
          return txt({ ok: true, action: "updated", ...row(existing), note: "A claim with this assertion already existed — its check was updated and its verification history kept." });
        }

        const created = await trilium.createNote(container, title, body);
        const id = created.note.noteId;
        await trilium.addLabel(id, "noteType", "claim");
        await trilium.addLabel(id, "created", d);
        await trilium.addLabel(id, "interval", String(intervalDays ?? 30));
        await trilium.addLabel(id, "claimState", "unverified");
        await trilium.addLabel(id, "iconClass", "bx bx-check-shield").catch(() => null);
        if (noteId) await trilium.addRelation(id, "derivedFrom", noteId).catch(() => null);

        return txt({
          ok: true, action: "registered", claimId: id, assertion: title,
          intervalDays: intervalDays ?? 30,
          location: "Insights → Claims",
          next: `Run the check, then record the result: claim(claimId="${id}", holds=true|false, evidence="<what you observed>"). Until then it is unverified, not holding.`,
        });
      }

      // ── LIST ──────────────────────────────────────────────────────────────
      const all = await trilium
        .searchNotes("#noteType=claim", { ancestorNoteId: container, fastSearch: true, limit: 200 })
        .then((r) => r.results)
        .catch(() => [] as Note[]);
      const rows = all.map(row).filter((r) => !status || status === "all" || r.state === status);
      const broken = rows.filter((r) => r.state === "broken").length;
      const stale = rows.filter((r) => r.state === "lapsed").length;
      return txt({
        total: rows.length,
        ...(broken ? { broken } : {}),
        ...(stale ? { needingReverification: stale } : {}),
        claims: rows.sort((a, b) => a.lastVerified.localeCompare(b.lastVerified)),
        ...(all.length === 0
          ? { note: 'No claims registered. Register one with claim(assertion="…", check="…") — the assertions worth registering are the ones that would be expensive to discover had gone stale.' }
          : {}),
      });
    }
  );

  server.tool(
    "diff",
    `What a write actually changed: a revision snapshot (default the latest) against the note as it stands, as changed lines with context and added/removed counts. The revision list comes back on every call; pass revisionId to compare against an earlier one.`,
    {
      noteId: z.string().describe("Note to diff"),
      revisionId: z.string().optional().describe("Compare against this revision (default: the most recent one)"),
      context: z.number().int().min(0).max(10).optional().describe("Unchanged lines to show around each change (default: 1)"),
    },
    async ({ noteId, revisionId, context }) => {
      const revisions = await trilium.getNoteRevisions(noteId).catch(() => []);
      if (!revisions.length)
        return txt({ noteId, note: "No revisions — this note has not been written through a content-mutating tool yet, or its revisions have been pruned.", revisions: [] });

      const target = revisionId ? revisions.find((r) => r.revisionId === revisionId) : revisions[0];
      if (!target)
        return err("not_found", `Revision ${revisionId} does not belong to note ${noteId}.`, `Available: ${revisions.slice(0, 10).map((r) => r.revisionId).join(", ")}`);

      const [before, after] = await Promise.all([
        trilium.getRevisionContent(target.revisionId),
        trilium.getNoteContent(noteId),
      ]);

      const index = revisions.map((r) => ({
        revisionId: r.revisionId,
        dateCreated: r.dateCreated?.slice(0, 16),
        size: r.contentLength,
        ...(r.revisionId === target.revisionId ? { compared: true as const } : {}),
      }));

      if (before === after) {
        return txt({
          noteId, comparedTo: target.revisionId, identical: true, revisions: index,
          note: "The snapshot and the current body are byte-identical — the write after this revision changed nothing, or the revision was taken after it.",
        });
      }

      // Block-level line split: these bodies are one long line of HTML, so
      // splitting on element boundaries is what makes a diff readable at all.
      const lines = (s: string) => s.replace(/></g, ">\n<").split("\n");
      const a = lines(before);
      const bLines = lines(after);

      // Common prefix and suffix, then report the middle. Adequate and honest
      // for the edit shapes this tool exists to verify — surgical replacements
      // in a known region — and it never claims a similarity it did not check.
      let head = 0;
      while (head < a.length && head < bLines.length && a[head] === bLines[head]) head++;
      let tail = 0;
      while (tail < a.length - head && tail < bLines.length - head && a[a.length - 1 - tail] === bLines[bLines.length - 1 - tail]) tail++;

      const pad = context ?? 1;
      const removed = a.slice(head, a.length - tail);
      const added = bLines.slice(head, bLines.length - tail);
      const cap = (arr: string[]) => (arr.length > 40 ? [...arr.slice(0, 40), `… ${arr.length - 40} more line(s)`] : arr);

      return txt({
        noteId,
        comparedTo: target.revisionId,
        revisionDate: target.dateCreated?.slice(0, 16),
        identical: false,
        sizeBefore: before.length,
        sizeAfter: after.length,
        contextBefore: cap(a.slice(Math.max(0, head - pad), head)),
        removed: cap(removed),
        added: cap(added),
        contextAfter: cap(a.slice(a.length - tail, a.length - tail + pad)),
        summary: `${removed.length} block(s) removed, ${added.length} added, ${after.length - before.length >= 0 ? "+" : ""}${after.length - before.length} characters.`,
        revisions: index,
      });
    }
  );

  // ════════════════════════════════════════════════════════════════════════════
  // ATTACHMENTS
  // ════════════════════════════════════════════════════════════════════════════

  server.tool(
    "attach",
    `Upsert a raw artifact (file, image, blob) on a note by title (content given; mime=, encoding="base64" for binary) or read one back (content omitted). List with inspect(), remove with detach().`,
    {
      noteId: z.string().describe("Owning note"),
      title: z.string().describe("Attachment title — the upsert/read key on this note"),
      content: z.string().optional().describe("Content to write (text, or base64 for binary). Omit to read the attachment instead."),
      mime: z.string().optional().describe("MIME type (default text/plain on create; kept on update unless given)"),
      role: z.enum(["file", "image"]).optional().describe("Attachment role on create (default: file)"),
      encoding: z.enum(["auto", "text", "base64"]).optional().describe("Content encoding; auto uses MIME to choose UTF-8 vs base64"),
    },
    async ({ noteId, title, content, mime, role, encoding }) => {
      const existing = (await trilium.getNoteAttachments(noteId).catch(() => [])).find((a) => a.title === title);

      if (content == null) {
        if (!existing)
          return err("not_found", `No attachment titled "${title}" on note ${noteId}.`, "inspect(noteId) lists its attachments; provide content to create this one.");
        const data = await trilium.getAttachmentContentResult(existing.attachmentId, existing.mime);
        return txt({
          id: existing.attachmentId, noteId, title, mime: existing.mime, role: existing.role, size: existing.contentLength,
          content: typeof data === "string" ? data : data.content,
          ...(typeof data === "string" ? {} : { contentEncoding: data.encoding }),
        });
      }

      if (existing) {
        const targetMime = mime ?? existing.mime;
        if (mime && mime !== existing.mime) await trilium.updateAttachment(existing.attachmentId, { mime });
        try {
          await trilium.updateAttachmentContent(existing.attachmentId, content, targetMime, encoding ?? "auto");
        } catch (error) {
          if (mime && mime !== existing.mime) throw new Error(`attachment MIME changed to ${mime}, but content upload failed: ${error instanceof Error ? error.message : String(error)}`);
          throw error;
        }
        return txt({ action: "updated", id: existing.attachmentId, noteId, title, mime: targetMime });
      }

      try {
        const created = await trilium.createAttachment(noteId, title, mime ?? "text/plain", content, role ?? "file", encoding ?? "auto");
        return txt({ action: "created", id: created.attachmentId, noteId, title, mime: created.mime, role: created.role, contentUploaded: created.contentUploaded ?? true });
      } catch (error) {
        if (error instanceof PartialContentUploadError) return err("partial_upload", error.message, `The ${error.entityType} was created as ${error.entityId}; retry the content upload rather than creating another entity.`);
        throw error;
      }
    }
  );

  server.tool(
    "detach",
    `Remove an attachment by attachmentId, or by noteId + title. Permanent; retry-safe.`,
    {
      attachmentId: z.string().optional().describe("The attachment to remove"),
      noteId: z.string().optional().describe("Owning note — used with title when the id isn't at hand"),
      title: z.string().optional().describe("Attachment title on noteId"),
    },
    async ({ attachmentId, noteId, title }) => {
      let id = attachmentId ?? null;
      if (!id) {
        if (!noteId || !title)
          return err("missing_param", "detach() needs attachmentId, or noteId + title.", 'inspect(noteId) lists attachments with their ids.');
        const found = (await trilium.getNoteAttachments(noteId).catch(() => [])).find((a) => a.title === title);
        if (!found) return txt({ ok: true, action: "already_removed", noteId, title });
        id = found.attachmentId;
      }
      try {
        await trilium.deleteAttachment(id);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (msg.includes("404")) return txt({ ok: true, action: "already_removed", attachmentId: id });
        throw e;
      }
      return txt({ ok: true, removed: id, ...(noteId ? { noteId, title } : {}) });
    }
  );

  // ════════════════════════════════════════════════════════════════════════════
  // LIFECYCLE / SYSTEM
  // ════════════════════════════════════════════════════════════════════════════

  server.tool(
    "addendum",
    `Find pending addendum blocks on notes that must stay merged documents (master and LLM singletons, knowledge notes). Fold each into its section with revise(section=/find=) and leave no marker; only sessions, diary, logs and dated thread entries accumulate addenda. The call marks its close-gate step.`,
    {},
    async () => {
      const cfg = b();
      if (!cfg.root) return txt({ error: "BrainLLM not bootstrapped — run bootstrap." });

      const searchIn = (ancestorNoteId: string) =>
        trilium.searchNotes("Addendum", { ancestorNoteId, limit: 50 });

      const [masterRes, llmRes, knowledgeRes] = await Promise.all([
        cfg.master.root    ? searchIn(cfg.master.root)    : Promise.resolve({ results: [] as Note[] }),
        cfg.llm.root       ? searchIn(cfg.llm.root)       : Promise.resolve({ results: [] as Note[] }),
        cfg.knowledge.root ? searchIn(cfg.knowledge.root) : Promise.resolve({ results: [] as Note[] }),
      ]);

      // Exclude diary notes from the LLM area — diary is a record, not a singleton to merge.
      const allRaw = [
        ...masterRes.results,
        ...llmRes.results.filter((n) => labelOf(n, "noteType") !== "diary"),
        ...knowledgeRes.results,
      ];

      const seen = new Set<string>();
      const unique = allRaw.filter((n) => { if (seen.has(n.noteId)) return false; seen.add(n.noteId); return true; });

      // A pending addendum is a structural marker block (an h2–h4 heading
      // starting with "Addendum —"), not the bare word — the full-text search
      // above matches prose mentions too (e.g. the Protocols singleton
      // describing the addendum() tool), which produced recurring false
      // positives. Only notes carrying the actual marker are surfaced. The
      // marker lives in normalize.ts, shared with session()'s pending counter —
      // the two answers must never again disagree on what counts.
      const notes = await Promise.all(
        unique.map(async (n) => {
          const kind = labelOf(n, "noteType");
          if (!kind) return null;
          const content = await trilium.getNoteContent(n.noteId);
          if (!hasAddendumMarker(content)) return null; // prose mention, not a pending block
          const relations = relationSnippet(n);
          return {
            id: n.noteId,
            title: n.title,
            kind,
            snippet: toText(content, 280),
            ...(relations ? { relations } : {}),
          };
        })
      );

      const found = notes.filter(Boolean);
      await markStep("addendum");
      return txt({
        found: found.length,
        notes: found,
        ...(found.length === 0
          ? { note: "No notes with pending addendums." }
          : { hint: "Fold each addendum into its note: read the block, then revise(noteId, section='<heading>', body='<merged content>', mode='replace') to absorb it into the right section. These notes must be left clean — no addendum markers. Addendum-style history belongs only in sessions, diary, and logs. Scoped/autonomous agents: fold only what's in your lane — leaving personal or out-of-scope addendums for the next interactive session is correct, and calling this tool is what satisfies the pre-close gate." }),
      });
    }
  );

  server.tool(
    "maintain",
    `Brain hygiene. Lite (automatic in start/close): ages threads active → dormant → archived and checks labels. deep=true adds stale notes, orphans and sinks, structural lint (duplicate headings, unbalanced tags, missing required sections, dated prose in timeless notes, oversized notes), duplicate titles, lapsed or broken claims and hygiene passes. dryRun previews. ack=[ids] silences a note you reviewed until its content changes. domain= narrows deep passes to one lane. repair=[ids] unwinds entity double-escaping in place. coverage names any capped pass.`,
    {
      deep: z.boolean().optional().describe("Deep pass: stale-review + orphan/sink + structural lint + duplicate titles across Memory/Threads and Knowledge (default: false)"),
      dryRun: z.boolean().optional().describe("Report what would change without changing it"),
      domain: z.string().optional().describe("Narrow the deep passes to one domain's notes (slugged server-side) — for scoped agents working a single lane"),
      ack: z.array(z.string()).optional().describe("Note ids to mark reviewed-and-correct — suppresses their findings until the note's content changes"),
      repair: z.array(z.string()).optional().describe("Note ids to auto-repair entity corruption on — unwinds one level of double-escaping, revision taken first"),
    },
    async ({ deep, dryRun, domain, ack, repair }) => {
      const report = await sweep(trilium, b(), {
        deep: deep ?? false,
        dryRun: dryRun ?? false,
        ...(domain ? { domain } : {}),
        ...(ack?.length ? { ack } : {}),
        ...(repair?.length ? { repair } : {}),
      });
      // The size-trajectory baselines live in brainllm.json, written by the
      // deep lint pass onto the live config object. Without this save the
      // baselines reset on restart and every run reads as first-sighting.
      if (deep && !dryRun && b().sizes && Object.keys(b().sizes!).length) {
        saveConfig(b());
      }
      await markStep("maintain");
      return txt(report);
    }
  );

  server.tool(
    "forget",
    `Archive a note (default — hidden from default recall, recoverable with recover()) or hard-delete it (hard=true, refused while backlinked).`,
    {
      noteId: z.string().describe("Note to forget"),
      reason: z.string().optional().describe("Why — recorded in the note before archiving"),
      hard: z.boolean().optional().describe("Permanently delete instead of archive"),
    },
    async ({ noteId, reason, hard }) => {
      if (isStructural(b(), noteId))
        return err("protected_note", `Note ${noteId} is structural and cannot be forgotten.`, "Structural notes are managed by BrainLLM and cannot be archived or deleted.");
      const note = await trilium.getNote(noteId);

      if (hard) {
        let backlinks: Array<{ noteId: string; title: string; relationName: string }>;
        try {
          backlinks = await trilium.getBacklinks(noteId);
        } catch (error) {
          return err(
            "backlink_check_failed",
            `Could not verify backlinks for ${noteId}; hard delete was blocked.`,
            `The Trilium search failed (${error instanceof Error ? error.message : String(error)}). Archive instead, or restore the search connection and retry; an unknown backlink state is never treated as zero.`
          );
        }
        if (backlinks.length > 0) {
          return txt({
            blocked: true,
            why: "Other notes still link here. Re-wire or remove these relations first (connect with remove=true), or archive instead.",
            backlinks,
          });
        }

        // Blast radius. Trilium's delete takes the whole SUBTREE when this is
        // the last branch, and a cloned note lives in several containers at
        // once — so a hard delete aimed at one stub can take its children, or
        // remove a note from a container the caller never mentioned. This is
        // the only code path in the core surface that destroys content
        // (verified: the sweep's `deleted` field is never populated, and
        // neither close() nor generateDailyLog() deletes anything), so it is
        // the one place worth making the caller look before it fires.
        const children = note.childNoteIds ?? [];
        const parents = note.parentBranchIds ?? [];
        if (children.length > 0 || parents.length > 1) {
          const childTitles = await Promise.all(
            children.slice(0, 25).map((id) =>
              trilium.getNote(id).then((c) => `${c.title} [${id}]`).catch(() => id)
            )
          );
          return txt({
            blocked: true,
            why:
              children.length > 0
                ? `Hard delete takes the whole subtree — ${children.length} child note(s) would be destroyed with it.`
                : `This note is cloned into ${parents.length} containers; deleting it removes it from all of them, not just the one you have in mind.`,
            children: childTitles,
            parentBranchIds: parents,
            hint:
              "Archive instead (omit hard), or delete the children first if losing them is genuinely intended. " +
              "Threads keep their day-to-day content in threadEntry children, so a thread almost never wants a hard delete.",
          });
        }

        await trilium.deleteNote(noteId);
        return txt({ ok: true, deleted: noteId, title: note.title, hardDeleted: true });
      }

      if (reason) {
        const current = await trilium.getNoteContent(noteId);
        await trilium.updateNoteContent(noteId, safeAppend(current, `<p><em>Archived ${today()}: ${escapeHtml(reason)}</em></p>`));
      }
      await trilium.updateLabelValue(noteId, "closed", today());
      await ensureArchivedFlag(trilium, note);
      const relations = relationSnippet(note);
      return txt({ ok: true, archived: noteId, title: note.title, ...(relations ? { relations } : {}) });
    }
  );

  server.tool(
    "recover",
    `Restore an archived or resolved note: clears #archived and #closed and resets status. Content is untouched — use revise(), or get_revisions for an older snapshot. Notes deleted from Trilium need undelete_note.`,
    {
      noteId: z.string().describe("The archived or resolved note to restore"),
      reason: z.string().optional().describe("Why it was recovered — written as an addendum"),
      date: z.string().optional().describe("ISO date (default: today)"),
    },
    async ({ noteId, reason, date }) => {
      if (isStructural(b(), noteId))
        return err("protected_note", `Note ${noteId} is structural and cannot be recovered.`);
      const d = checkedDate(date);
      const note = await trilium.getNote(noteId);

      const archivedAttr = note.attributes.find((a) => isOwnedAttribute(note, a) && a.type === "label" && a.name === "archived");
      if (archivedAttr) await trilium.deleteAttribute(archivedAttr.attributeId).catch(() => null);

      const closedAttr = note.attributes.find((a) => isOwnedAttribute(note, a) && a.type === "label" && a.name === "closed");
      if (closedAttr) await trilium.deleteAttribute(closedAttr.attributeId).catch(() => null);

      await trilium.updateLabelValue(noteId, "status", "active");

      const current = await trilium.getNoteContent(noteId);
      const { html: recoverHtml, warnings } = reason
        ? renderBody(reason)
        : { html: "<p><em>Note restored from archive.</em></p>", warnings: [] as string[] };
      if (!isDuplicateAppend(current, recoverHtml)) {
        await trilium.createRevision(noteId).catch(() => null);
        await trilium.updateNoteContent(noteId, safeAppend(current, `<h2>Recovered — ${d}</h2>`, recoverHtml));
        await trilium.updateLabelValue(noteId, "updated", d);
      }

      const relations = relationSnippet(note);
      return txt({
        ok: true,
        noteId,
        kind: (labelOf(note, "noteType") as AnyKind | undefined) ?? "note",
        status: "active",
        recovered: d,
        ...(relations ? { relations } : {}),
        ...(warnings.length ? { sanitized: warnings } : {}),
      });
    }
  );

  server.tool(
    "template",
    `The canonical structure for a kind: skeleton, top-to-bottom structure, and the rules writes are held to (including what stays authorial). Read it before your first write of a kind; then read an existing sibling and match its shape.`,
    {
      kind: z.enum(Kinds).describe("The content kind to serve the canonical structure for"),
    },
    async ({ kind }) => {
      const rule = structureRuleFor(kind);
      const skeleton = contentFor(kind, {
        date: today(),
        body: "",
        domain: kind === "sources" || kind === "information" ? "<Domain>" : undefined,
        goal: kind === "thread" ? "<goal statement — queried from the user>" : undefined,
      });
      return txt({
        kind,
        ...(rule
          ? { structure: rule.structure, rules: rule.rules }
          : { note: "No bespoke structure for this kind — server meta line + body." }),
        skeleton,
        conventions: [
          "Headings h2–h4 only (h1 is the title); only headings that earn their place — depth comes from tables, lists and emphasis.",
          "Titles: at most 4 words, no dates or run numbers (they defeat dedup-by-title).",
          "Timeless kinds carry no state, version or decision history: state goes to the domain's Current State note, history to thread entries and sessions.",
          "One sentence is enough if it says the thing; drop what is rarely relevant.",
          "Merge, don't stack: only sessions, diary, logs and dated thread entries are append-only records.",
          "Match your siblings' structure; improve a pattern everywhere or nowhere.",
          "Every note carries an icon except logs: the kind default is set for you; pass icon= to choose a fitting one.",
        ],
      });
    }
  );

  server.tool(
    "graph",
    `Render the relation graph as a Mermaid flowchart — the whole brain, or a neighborhood (noteId + depth). Returns the source and writes it to the Insights/Graph note. On demand only; a scoped call replaces the note's content.`,
    {
      noteId: z.string().optional().describe("Center the graph on this note's neighborhood instead of the whole brain"),
      depth: z.number().optional().describe("Neighborhood hops when noteId is given (default: 2)"),
      includeArchived: z.boolean().optional().describe("Include archived notes (default: false)"),
    },
    async ({ noteId, depth, includeArchived }) => {
      const cfg = b();
      if (!cfg.root) return txt({ status: "uninitialized", action: "Run bootstrap first." });

      let notes: Note[];
      if (noteId) {
        const hood = await trilium.getNeighborhood(noteId, depth ?? 2);
        const fetched = await Promise.all(hood.map((h) => trilium.getNote(h.noteId).catch(() => null)));
        notes = fetched.filter((n): n is Note => !!n);
      } else {
        notes = (await trilium.searchNotes(
          "#noteType",
          { ancestorNoteId: cfg.root, fastSearch: true, limit: 300, includeArchivedNotes: includeArchived ?? false },
        )).results;
      }
      if (!includeArchived) notes = notes.filter((n) => !hasLabel(n, "archived"));

      const included = new Map(notes.map((n) => [n.noteId, n]));
      const mermaidLabel = (value: string): string => {
        const compact = value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\\/g, "\\\\");
        const truncated = compact.length > 34 ? `${compact.slice(0, 33)}…` : compact;
        return truncated
          .replace(/"/g, "#quot;")
          .replace(/\[/g, "&#91;")
          .replace(/\]/g, "&#93;")
          .replace(/\{/g, "&#123;")
          .replace(/\}/g, "&#125;")
          .replace(/</g, "&lt;")
          .replace(/>/g, "&gt;")
          .replace(/\|/g, "&#124;");
      };
      const safeRelationName = /^[A-Za-z_][A-Za-z0-9_]*$/;
      const skippedRelationNames = new Set<string>();
      const AREA_CLASS: Record<string, string> = {
        master: "master", llm: "llm", memory: "memory", knowledge: "knowledge", insights: "insights",
      };
      const lines: string[] = ["flowchart LR"];
      const classAssignments: Record<string, string[]> = {};
      for (const n of notes) {
        lines.push(`  ${n.noteId}["${mermaidLabel(n.title)}"]`);
        const kind = labelOf(n, "noteType") as AnyKind | undefined;
        const area = kind ? AREA_CLASS[KIND_AREA[kind]] : undefined;
        if (area) (classAssignments[area] ??= []).push(n.noteId);
      }
      let edgeCount = 0;
      const drawn = new Set<string>();
      for (const n of notes) {
        for (const a of n.attributes) {
          if (a.type !== "relation" || a.name === "template" || a.noteId !== n.noteId) continue;
          if (!safeRelationName.test(a.name)) { skippedRelationNames.add(a.name); continue; }
          if (!included.has(a.value)) continue;
          const key = `${n.noteId}|${a.name}|${a.value}`;
          if (drawn.has(key)) continue; // duplicate edges render once
          drawn.add(key);
          lines.push(`  ${n.noteId} -- ${a.name} --> ${a.value}`);
          edgeCount++;
        }
      }
      lines.push("  classDef master fill:#e8f0fe,stroke:#4285f4");
      lines.push("  classDef llm fill:#e6f4ea,stroke:#34a853");
      lines.push("  classDef memory fill:#fef7e0,stroke:#fbbc04");
      lines.push("  classDef knowledge fill:#fce8e6,stroke:#ea4335");
      lines.push("  classDef insights fill:#f3e8fd,stroke:#a142f4");
      for (const [cls, ids] of Object.entries(classAssignments)) {
        if (ids.length) lines.push(`  class ${ids.join(",")} ${cls}`);
      }
      const mermaid = lines.join("\n");

      // Upsert the maintained Graph note under Insights.
      let graphNoteId: string | null = null;
      try {
        const found = await trilium.searchNotes(`note.title = 'Graph'`, { ancestorNoteId: cfg.insights.root, fastSearch: true, limit: 1 });
        if (found.results[0]) {
          graphNoteId = found.results[0].noteId;
          await trilium.createRevision(graphNoteId);
          await trilium.updateNoteContent(graphNoteId, mermaid);
        } else {
          const created = await trilium.createNote(cfg.insights.root, "Graph", mermaid, "mermaid", "text/mermaid");
          graphNoteId = created.note.noteId;
          await trilium.addLabel(graphNoteId, "iconClass", "bx bx-network-chart");
        }
      } catch { /* the returned source is still the deliverable */ }

      return txt({
        scope: noteId ? { noteId, depth: depth ?? 2 } : "brain",
        nodes: notes.length,
        edges: edgeCount,
        ...(skippedRelationNames.size ? { skippedRelationNames: [...skippedRelationNames], note: "Unsafe custom relation names were omitted from Mermaid syntax; the notes remain intact." } : {}),
        ...(graphNoteId ? { graphNoteId } : {}),
        mermaid,
      });
    }
  );

  server.tool(
    "day",
    `The new-day sweep in one call: whether today is fresh (no addendum blocks in today's session
note), the previous session in full, that day's log, and the notes touched since. Present what the
touched notes evidence in the first message.

recap=true instead returns every addendum block written today across the session note, the diary
and every thread day-child, in time order with its identification line.`,
    {
      date: z.string().optional().describe("ISO date YYYY-MM-DD (default: today)"),
      recap: z.boolean().optional().describe("Return today's addendum blocks across sessions, diary and thread children in chronological order, instead of the new-day sweep"),
    },
    async ({ date, recap }) => {
      const cfg = b();
      if (!cfg.root) return txt({ status: "uninitialized", action: "Run bootstrap first." });
      const todayStr = checkedDate(date);

      // ── recap: everything written today, in order, across every surface ─────
      if (recap) {
        const BLOCK = /<h2(?:\s[^>]*)?>\s*Addendum\s*[—–-]\s*([^<]*)<\/h2>([\s\S]*?)(?=<h2(?:\s[^>]*)?>\s*Addendum\s*[—–-]|$)/gi;
        const entries: Array<{ time: string; surface: string; noteId: string; identity?: string; text: string }> = [];

        const harvest = (surface: string, noteId: string, content: string) => {
          for (const m of content.matchAll(BLOCK)) {
            const bodyHtml = m[2] ?? "";
            const identity = /<h3(?:\s[^>]*)?>([\s\S]*?)<\/h3>/i.exec(bodyHtml)?.[1];
            entries.push({
              time: (m[1] ?? "").trim(),
              surface,
              noteId,
              ...(identity ? { identity: toText(identity, 120) } : {}),
              text: toText(bodyHtml, 400),
            });
          }
        };

        const dayNotes = await Promise.all([
          trilium.searchNotes(`#noteType=session #created='${todayStr}'`, { ancestorNoteId: cfg.memory.sessions, fastSearch: true, limit: 1 }).catch(() => ({ results: [] as Note[] })),
          trilium.searchNotes(`#noteType=diary #created='${todayStr}'`, { ancestorNoteId: cfg.llm.diary, fastSearch: true, limit: 1 }).catch(() => ({ results: [] as Note[] })),
          trilium.searchNotes(`#noteType=threadEntry #created='${todayStr}'`, { ancestorNoteId: cfg.memory.threads, fastSearch: true, limit: 50 }).catch(() => ({ results: [] as Note[] })),
        ]);
        const surfaces: Array<[string, Note]> = [
          ...dayNotes[0].results.map((n) => ["session", n] as [string, Note]),
          ...dayNotes[1].results.map((n) => ["diary", n] as [string, Note]),
          ...dayNotes[2].results.map((n) => ["thread", n] as [string, Note]),
        ];
        for (const [surface, n] of surfaces) {
          const content = await trilium.getNoteContent(n.noteId).catch(() => "");
          harvest(surface === "thread" ? `thread: ${(await trilium.getNote(n.parentNoteIds[0]).catch(() => null))?.title ?? n.title}` : surface, n.noteId, content);
        }
        entries.sort((a, b) => a.time.localeCompare(b.time));

        return txt({
          date: todayStr,
          mode: "recap",
          instances: new Set(entries.map((e) => e.identity ?? "unattributed")).size,
          entries,
          ...(entries.length === 0 ? { note: `Nothing written today across sessions, diary or thread children — call day() without recap for the new-day sweep.` } : {}),
        });
      }

      // Is today fresh? (No addendum blocks logged yet.)
      let newDay = true;
      const todaySess = await trilium
        .searchNotes(`#noteType=session #created='${todayStr}'`, { ancestorNoteId: cfg.memory.sessions, fastSearch: true, limit: 1 })
        .catch(() => ({ results: [] as Note[] }));
      if (todaySess.results[0]) {
        const content = await trilium.getNoteContent(todaySess.results[0].noteId).catch(() => "");
        newDay = !/<h2(?:\s[^>]*)?>\s*Addendum/i.test(content);
      }

      // Previous session (strictly before today) — in full.
      const sessions = await trilium.searchNotes("#noteType=session", {
        ancestorNoteId: cfg.memory.sessions, fastSearch: true, limit: 10, orderBy: "dateCreated", orderDirection: "desc",
      }).catch(() => ({ results: [] as Note[] }));
      const prev = sessions.results.find((n) => (labelOf(n, "created") ?? n.dateCreated.slice(0, 10)) < todayStr);
      let lastSession: { id: string; date: string; content: string } | null = null;
      let previousLog: { id: string; content: string } | null = null;
      if (prev) {
        const prevDate = labelOf(prev, "created") ?? prev.dateCreated.slice(0, 10);
        lastSession = { id: prev.noteId, date: prevDate, content: await trilium.getNoteContent(prev.noteId).catch(() => "") };
        const log = await trilium
          .searchNotes(`#noteType=log #created='${prevDate}'`, { ancestorNoteId: cfg.insights.logs, fastSearch: true, limit: 1 })
          .catch(() => ({ results: [] as Note[] }));
        if (log.results[0]) previousLog = { id: log.results[0].noteId, content: await trilium.getNoteContent(log.results[0].noteId).catch(() => "") };
      }

      // Notes touched since the previous session.
      let changes: Array<{ id: string; title: string; changed: string; deleted?: true }> = [];
      if (lastSession) {
        try {
          const history = await trilium.getNoteHistory(cfg.root);
          const deduped = new Map<string, RecentChange>();
          for (const h of history.filter((h) => h.date >= lastSession!.date)) {
            const prevEntry = deduped.get(h.noteId);
            if (!prevEntry || (h.current_isDeleted && !prevEntry.current_isDeleted)) deduped.set(h.noteId, h);
          }
          changes = [...deduped.values()].slice(0, 25).map((h) => ({
            id: h.noteId, title: h.current_title, changed: h.date.slice(0, 10),
            ...(h.current_isDeleted ? { deleted: true as const } : {}),
          }));
        } catch { /* non-fatal */ }
      }

      return txt({
        date: todayStr,
        newDay,
        lastSession,
        previousLog,
        changes: changes.length ? changes : undefined,
        next: [
          "Skim lastSession, previousLog and changes for evidenced outputs — never plausibility.",
          "Present what moved in the first message.",
        ],
      });
    }
  );

  server.tool(
    "brain",
    `The full inventory: every content note across all five areas with id, title, kind, status, parent and dates, grouped by area (Insights returns logs and claims). Use it to audit or locate a note; read parent, not position — each group is flat. includeArchived= adds archived notes.`,
    {
      includeArchived: z.boolean().optional().describe("Include archived/resolved notes (default: false)"),
    },
    async ({ includeArchived }) => {
      const cfg = b();
      if (!cfg.root) return txt({ status: "uninitialized", action: "Run bootstrap first." });

      const fetchFrom = async (id: string | undefined): Promise<Note[]> => {
        if (!id) return [];
        return trilium.searchNotes("#noteType", {
          ancestorNoteId: id,
          fastSearch: true,
          limit: 300,
          includeArchivedNotes: includeArchived ?? false,
          orderBy: "dateCreated",
          orderDirection: "desc",
        })
          .then((r) => r.results)
          .catch(() => []);
      };

      // parent is not decoration — it is the field whose absence caused a real
      // data loss. Each group below is a FLAT list of every descendant, so a
      // domain book and its information/sources children arrive interleaved
      // with nothing distinguishing them; the sequence LOOKS nested and is not.
      // An audit read that ordering, concluded a domain held only a Sources
      // note, and wrote a replacement whose generic title ("Current State")
      // deduped onto the real note and overwrote it. The value was already
      // loaded on every note in the result — it was simply never read.
      const row = (n: Note) => {
        const relations = relationSnippet(n);
        return {
          id: n.noteId,
          title: n.title,
          kind: labelOf(n, "noteType"),
          parent: n.parentNoteIds?.[0],
          status: labelOf(n, "status") ?? undefined,
          created: labelOf(n, "created") ?? n.dateCreated.slice(0, 10),
          modified: n.dateModified.slice(0, 10),
          ...(hasLabel(n, "archived") ? { archived: true } : {}),
          ...(relations ? { relations } : {}),
        };
      };

      const [
        masterAll,
        llmAll, llmDiary,
        sessions, threads,
        kMaster, kDomains,
        insights,
      ] = await Promise.all([
        fetchFrom(cfg.master.root),
        fetchFrom(cfg.llm.root),
        fetchFrom(cfg.llm.diary),
        fetchFrom(cfg.memory.sessions),
        fetchFrom(cfg.memory.threads),
        fetchFrom(cfg.knowledge.master),
        fetchFrom(cfg.knowledge.domains),
        // Insights is fetched at its ROOT, not at .logs.
        //
        // Claims live in a container resolved on demand by title (see
        // resolveClaimsContainer) and are absent from the config schema, so a
        // fetch scoped to .logs could never reach them: brain() reported itself
        // as "the full inventory" while the entire claim register was invisible
        // to it. An inventory with a structural blind spot is worse than a
        // partial one that says so, because the count looks complete.
        fetchFrom(cfg.insights.root),
      ]);

      const diaryIds = new Set(llmDiary.map((n) => n.noteId));
      const llmSingletons = llmAll.filter((n) => !diaryIds.has(n.noteId));
      const insightLogs = insights.filter((n) => labelOf(n, "noteType") === "log");
      const insightClaims = insights.filter((n) => labelOf(n, "noteType") === "claim");

      const areas = {
        Master: masterAll.map(row),
        LLM: {
          singletons: llmSingletons.map(row),
          diary: llmDiary.map(row),
        },
        Memory: {
          sessions: sessions.map(row),
          threads: threads.map(row),
        },
        Knowledge: {
          master: kMaster.map(row),
          domains: kDomains.map(row),
        },
        Insights: {
          logs: insightLogs.map(row),
          claims: insightClaims.map(row),
        },
      };

      const total = masterAll.length + llmSingletons.length + llmDiary.length +
        sessions.length + threads.length + kMaster.length + kDomains.length + insights.length;

      return txt({ total, areas });
    }
  );

  server.tool(
    "assembly",
    `What the brain holds: every note by title, grouped under its surface with that surface's purpose. Dated collections (sessions, diary, logs) collapse to a count and span; domains nest their notes; threads group by status. The awareness read — use brain() instead to audit or locate by id. area= zooms into one surface.`,
    {
      area: z.enum(["master", "llm", "memory", "knowledge", "insights"]).optional().describe("Zoom into one surface instead of all five"),
      includeArchived: z.boolean().optional().describe("Include archived/resolved notes (default: false)"),
    },
    async ({ area, includeArchived }) => {
      const cfg = b();
      if (!cfg.root) return txt({ status: "uninitialized", action: "Run bootstrap first." });

      const fetchFrom = async (id: string | undefined): Promise<Note[]> => {
        if (!id) return [];
        return trilium
          .searchNotes("#noteType", {
            ancestorNoteId: id, fastSearch: true, limit: 400,
            includeArchivedNotes: includeArchived ?? false,
            orderBy: "dateModified", orderDirection: "desc",
          })
          .then((r) => r.results)
          .catch(() => []);
      };

      /** The purpose engraved on a container at bootstrap. Read rather than
       *  hardcoded: a copy here would silently disagree with the note the
       *  moment either changed, and the note is the one the user can see. */
      const purposeOf = async (id: string | undefined): Promise<string | undefined> => {
        if (!id) return undefined;
        const content = await trilium.getNoteContent(id).catch(() => "");
        const text = toText(content, 400).trim();
        return text || undefined;
      };

      const dateOf = (n: Note) => labelOf(n, "created") ?? n.dateCreated.slice(0, 10);
      /** Dated records summarised rather than listed — see the tool description. */
      const span = (notes: Note[], label: string) => {
        if (!notes.length) return { count: 0, note: `No ${label} yet.` };
        const dates = notes.map(dateOf).sort();
        return {
          count: notes.length,
          earliest: dates[0],
          latest: dates[dates.length - 1],
          note: `${notes.length} ${label}, ${dates[0]} → ${dates[dates.length - 1]}. Titles are all [yyyy-mm-dd] — read one with its surface tool, or brain() for the full list.`,
        };
      };
      const titles = (notes: Note[]) => notes.map((n) => n.title);

      const want = (a: string) => !area || area === a;
      const out: Record<string, unknown> = {};

      if (want("master")) {
        const notes = await fetchFrom(cfg.master.root);
        out.Master = { purpose: await purposeOf(cfg.master.root), singletons: titles(notes) };
      }

      if (want("llm")) {
        const [all, diary] = await Promise.all([fetchFrom(cfg.llm.root), fetchFrom(cfg.llm.diary)]);
        const diaryIds = new Set(diary.map((n) => n.noteId));
        out.LLM = {
          purpose: await purposeOf(cfg.llm.root),
          singletons: titles(all.filter((n) => !diaryIds.has(n.noteId))),
          diary: span(diary, "diary entries"),
        };
      }

      if (want("memory")) {
        const [threads, sessions] = await Promise.all([fetchFrom(cfg.memory.threads), fetchFrom(cfg.memory.sessions)]);
        // Thread books only — day-children are the thread's content, not
        // separate things the brain knows.
        const books = threads.filter((n) => labelOf(n, "noteType") === "thread");
        const byStatus = (s: string) => titles(books.filter((n) => (labelOf(n, "status") ?? "active") === s));
        out.Memory = {
          purpose: await purposeOf(cfg.memory.root),
          threads: {
            active: byStatus("active"),
            ...(byStatus("dormant").length ? { dormant: byStatus("dormant") } : {}),
            ...(byStatus("eternal").length ? { eternal: byStatus("eternal") } : {}),
            ...(includeArchived && byStatus("resolved").length ? { resolved: byStatus("resolved") } : {}),
          },
          sessions: span(sessions.filter((n) => labelOf(n, "noteType") === "session"), "sessions"),
        };
      }

      if (want("knowledge")) {
        const [master, domainNotes] = await Promise.all([fetchFrom(cfg.knowledge.master), fetchFrom(cfg.knowledge.domains)]);
        // Nest by parent — the flat listing is exactly the shape that got a
        // domain misread as empty once, and the reason brain() now reports
        // parent at all.
        const books = domainNotes.filter((n) => labelOf(n, "noteType") === "domain");
        const domains = books.map((book) => {
          const children = domainNotes.filter((n) => n.noteId !== book.noteId && n.parentNoteIds?.includes(book.noteId));
          return {
            domain: book.title,
            sources: children.some((c) => labelOf(c, "noteType") === "sources"),
            notes: titles(children.filter((c) => labelOf(c, "noteType") === "information")),
          };
        });
        const orphaned = domainNotes.filter(
          (n) => labelOf(n, "noteType") !== "domain" && !books.some((bk) => n.parentNoteIds?.includes(bk.noteId))
        );
        out.Knowledge = {
          purpose: await purposeOf(cfg.knowledge.root),
          aboutTheUser: titles(master),
          domains,
          ...(orphaned.length
            ? { unparented: titles(orphaned), hint: "These carry a knowledge kind but sit under no domain book — inspect() them for their real parent." }
            : {}),
        };
      }

      if (want("insights")) {
        const [logs, all] = await Promise.all([fetchFrom(cfg.insights.logs), fetchFrom(cfg.insights.root)]);
        const claims = all.filter((n) => labelOf(n, "noteType") === "claim");
        out.Insights = {
          purpose: await purposeOf(cfg.insights.root),
          logs: span(logs.filter((n) => labelOf(n, "noteType") === "log"), "daily logs"),
          claims: claims.length
            ? { count: claims.length, assertions: titles(claims), note: "Each claim's title IS its assertion. claim(claimId) reads one with its verification history." }
            : { count: 0, note: "No claims registered — nothing is currently being checked against the world." },
        };
      }

      return txt({
        brain: await purposeOf(cfg.root),
        ...(area ? { scope: area } : {}),
        ...out,
        ...(includeArchived ? {} : { note: "Archived and resolved notes are excluded — pass includeArchived=true to see them." }),
      });
    }
  );

  server.tool(
    "bootstrap",
    `Create the BrainLLM structure in Trilium, or verify and refresh it when it exists (idempotent): the five areas with their containers, singletons and engraved purposes, plus brainllm.json. Only creates a new tree when the stored root is confirmed deleted.`,
    {},
    async () => {
      if (b().root) {
        try {
          const existing = await trilium.getNote(b().root);
          const children = await Promise.all(
            existing.childNoteIds.map(async (cid) => {
              const child = await trilium.getNote(cid);
              return { id: child.noteId, title: child.title };
            })
          );
          const saved = saveConfig(brainRef.config);
          // Re-engrave container purposes.
          //
          // These are written once at bootstrap and are then unreachable:
          // revise() refuses containers, so nothing in the tool surface can
          // update them, and a purpose that goes stale stays stale for the life
          // of the brain. That was invisible until assembly() started serving
          // this text to orient a session — Insights still described itself as
          // holding only per-day logs, long after it gained the graph and the
          // claims register. Re-running bootstrap now heals them.
          //
          // Only genuinely different text is written, and every change is
          // reported: this overwrites a note the user can see, so it must never
          // be a silent side effect of a call made for another reason.
          // Heal singletons that a newer version introduced.
          //
          // This branch used to only re-engrave purposes, so a brain created
          // before a new singleton existed never got one: bootstrap reported
          // "already_initialized" and changed nothing, while the docstring
          // promised it refreshes an existing structure. An upgrade path that
          // exists in the fresh-install code and nowhere else is not an upgrade
          // path — every brain already in use is precisely the set it misses.
          //
          // Find-or-create by title, then persist the id. Both halves matter:
          // creating blind would duplicate the note on a brain where a human
          // already made it, and finding without persisting would re-search on
          // every boot while the config stayed empty.
          const healed: string[] = [];
          const ensureSingleton = async (
            slot: "selfcorrection",
            title: string,
            kind: AnyKind,
            purpose: string
          ): Promise<void> => {
            if (brainRef.config.llm[slot]) return;
            const hit = await trilium
              .searchNotes(`note.title = '${title}'`, { ancestorNoteId: brainRef.config.llm.root, fastSearch: true, limit: 1 })
              .catch(() => ({ results: [] as Note[] }));
            let id = hit.results[0]?.noteId;
            if (!id) {
              const made = await trilium.createNote(
                brainRef.config.llm.root,
                title,
                purposeContent(purpose) + "\n" + contentFor(kind, { date: localToday(), body: "" }),
                "text"
              );
              id = made.note.noteId;
              await trilium.addLabel(id, "noteType", kind).catch(() => null);
              healed.push(`created ${title}`);
            } else {
              healed.push(`adopted existing ${title}`);
            }
            brainRef.config.llm[slot] = id;
          };
          await ensureSingleton(
            "selfcorrection",
            "Self-correction",
            "selfcorrection",
            "A single maintained note of the assistant's own corrections — the mistakes it has made, what generalises from each, and the rule that prevents a repeat. Split out of Protocols in V12 so orientation stops paying for it on every session start."
          );
          if (healed.length) saveConfig(brainRef.config);

          const refreshed: string[] = [];
          for (const [id, purpose] of containerPurposes(brainRef.config)) {
            if (!id) continue;
            const current = await trilium.getNoteContent(id).catch(() => null);
            if (current === null) continue;
            const wanted = purposeContent(purpose);
            if (toText(current, 400).trim() === toText(wanted, 400).trim()) continue;
            await trilium.updateNoteContent(id, wanted).catch(() => null);
            const note = await trilium.getNote(id).catch(() => null);
            refreshed.push(note?.title ?? id);
          }
          return txt({
            status: "already_initialized",
            message: `BrainLLM structure exists. Config refreshed at: ${saved}`,
            ...(refreshed.length
              ? { purposesRefreshed: refreshed, note: "These containers described themselves with text that no longer matched the canonical purpose, and have been re-engraved. Container notes are unreachable through revise(), so bootstrap is the only path that can correct them." }
              : {}),
            ...(healed.length
              ? { singletonsHealed: healed, healNote: "A singleton introduced by a newer version was missing from this brain and has been created (or an existing note by that title adopted), with its id persisted to the config." }
              : {}),
            root: { id: existing.noteId, title: existing.title },
            children,
          });
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          if (!msg.includes("404")) throw e;
          // 404 = note deleted from Trilium — fall through to fresh init.
        }
      }

      const newConfig = await createBrainLLMStructure(trilium);
      const savedPath = saveConfig(newConfig);
      brainRef.config = newConfig;

      return txt({
        status: "initialized",
        message: `BrainLLM bootstrapped. Config written to: ${savedPath}. Ready to use — no restart needed.`,
        config: newConfig,
      });
    }
  );

  // ── Surface tools (core) — read-only, dual-mode per surface ──────────────────
  //
  // Registration order is the tools/list order, and it is deliberately fixed:
  // universal verbs above, then the five surfaces in area order, then full mode
  // last. MCP's 2026-07-28 revision asks servers to return tools in a
  // deterministic order specifically "to enable client-side caching and improve
  // LLM prompt cache hit rates" — a tool list that reshuffles between boots
  // invalidates the client's cached prompt prefix for no benefit. Keep these
  // calls in this order; do not sort or reorder them for tidiness.
  registerMasterTools(server, trilium, brainRef);
  registerLlmTools(server, trilium, brainRef);
  registerMemoryTools(server, trilium, brainRef);
  registerKnowledgeTools(server, trilium, brainRef);
  registerInsightsTools(server, trilium, brainRef);
}
