/**
 * tools.ts — BrainLLM core tool surface (V8)
 *
 * The model supplies content; the server owns form. Placement, naming, labels,
 * blueprint wiring, dedup, lifecycle and archival are policy implemented here.
 *
 * Registers the universal verbs (start, close, backup, bootstrap, remember, diary,
 * domain, recall, addendum, revise, resolve, withdraw, recover, attach, detach, connect, explore,
 * maintain, forget), wires in the read-only per-surface modules
 * (tools-master/llm/memory/knowledge/insights),
 * and — under BRAINLLM_MODE=full — the raw ETAPI surface (tools-advanced).
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { TriliumClient, type Note, type RecentChange, ownedLabel, relationSnippet, type RelationEdge } from "./trilium.js";
import { type BrainLLMConfig, saveConfig } from "./config.js";
import {
  Kinds,
  RelationTypes,
  SymmetricRelations,
  Statuses,
  type AnyKind,
} from "./types.js";
import {
  normalizeTitle,
  sameTitle,
  slugify,
  normalizeIcon,
  toHtml,
  toText,
  escapeQueryValue,
  queryTokens,
  escapeHtml,
  sanitizeHtml,
  safeAppend,
  closeDangling,
  setSection,
} from "./normalize.js";
import { contentFor, RESOLUTION_ANCHOR } from "./templates.js";
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
import { sweep, buildDigest, applyResolution, isStructural, isContainer } from "./lifecycle.js";
import { createBrainLLMStructure } from "./bootstrap.js";
import { generateDailyLog } from "./journal.js";
import { localToday, localNowTime } from "./time.js";
import { registerMasterTools } from "./tools-master.js";
import { registerLlmTools } from "./tools-llm.js";
import { registerMemoryTools } from "./tools-memory.js";
import { registerKnowledgeTools } from "./tools-knowledge.js";
import { registerInsightsTools } from "./tools-insights.js";
import { registerAdvancedTools } from "./tools-advanced.js";

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
  n.attributes.find((a) => a.type === "label" && a.name === name)?.value;

const hasLabel = (n: Note, name: string) =>
  n.attributes.some((a) => a.type === "label" && a.name === name);

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

export function registerTools(
  server: McpServer,
  trilium: TriliumClient,
  brainRef: { config: BrainLLMConfig },
  mode: "core" | "full" = "core"
): void {
  const b = () => brainRef.config;

  // ── Pre-close protocol gate ───────────────────────────────────────────────
  // In-memory only — never persisted, resets with the process/connection.
  // Tracks which pre-close steps actually ran (by tool invocation, not by
  // narration) — and in what order — so close() can refuse until each one has
  // been individually, verifiably called. This is what makes the protocol
  // enforceable rather than a docstring convention the model can silently
  // skip under time pressure. Beyond presence, close() enforces the sequence
  // session() → remarks() → diary(): the diary is the day's closing record,
  // written with the remarks cues in hand — a diary call before remarks()
  // still writes (mid-session entries are encouraged) but doesn't close the
  // gate. Order is judged on each step's LAST call. Cleared on a successful
  // close() so the next day's session re-arms the gate from scratch.
  const preCloseSteps = new Map<string, number>();
  let preCloseSeq = 0;
  const markStep = (step: string) => preCloseSteps.set(step, ++preCloseSeq);
  const REQUIRED_PRECLOSE_STEPS = ["session", "addendum", "maintain", "remarks", "diary"] as const;

  /** Set a note's display icon (#iconClass) from an icon request — a full
   *  boxicons class or a bare name, normalized server-side. No-op on blank/
   *  unusable input. Returns the applied class for the tool receipt. */
  const applyIcon = async (noteId: string, icon?: string): Promise<string | undefined> => {
    if (!icon) return undefined;
    const cls = normalizeIcon(icon);
    if (!cls) return undefined;
    await trilium.updateLabelValue(noteId, "iconClass", cls).catch(() => null);
    return cls;
  };

  /** Find an existing same-kind note with the same (normalized) title. */
  async function findExisting(kind: AnyKind, title: string): Promise<Note | null> {
    const scope = dedupScope(b(), kind);
    if (!scope) return null;
    const res = await trilium
      .searchNotes(`#noteType=${kind}`, { ancestorNoteId: scope, fastSearch: true, limit: 100 })
      .catch(() => ({ results: [] as Note[] }));
    return res.results.find((n) => sameTitle(n.title, title)) ?? null;
  }

  // ════════════════════════════════════════════════════════════════════════════
  // SESSION
  // ════════════════════════════════════════════════════════════════════════════

  server.tool(
    "start",
    `Boot BrainLLM — call ONCE at the start of every session, before responding.
Runs maintenance, creates today's diary and session notes if not yet open, then returns: today
and weekday, the full Master digest (biography / goals / preferences), the full LLM digest
(responsibilities / protocols / today's diary preview and ID), this session's note ID, active
threads with idle ages, dormant threads for review, the last session summary, and
changesSinceLastSession (notes modified in the brain since the previous session). Use recall()
for topic-specific lookup.`,
    {},
    async () => {
      const cfg = b();
      if (!cfg.root) {
        return txt({ status: "uninitialized", action: "Run bootstrap to create the BrainLLM structure." });
      }
      const hygiene = await sweep(trilium, cfg, { deep: false, dryRun: false }).catch((e) => ({
        scanned: 0, fixed: [], transitions: [], deleted: [], flagged: [`sweep failed: ${e}`], dryRun: false,
        policy: { dormantAfterDays: cfg.policy.dormantAfterDays, archiveDormantAfterDays: cfg.policy.archiveDormantAfterDays, staleAfterDays: cfg.policy.staleAfterDays },
      }));
      const digest = await buildDigest(trilium, cfg);
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
          }
          if (diaryNoteId) {
            const content = await trilium.getNoteContent(diaryNoteId).catch(() => "");
            diaryPreview = toText(content, 200);
          }
        } catch { /* non-fatal */ }
      }

      // Ensure today's session note exists (title [yyyy-mm-dd]).
      // Use the digest's lastSession instead of a second Trilium search — avoids
      // the unquoted-date parser issue and saves a round-trip.
      let sessionNoteId: string | null = null;
      let sessionPreview = "";
      if (cfg.memory.sessions) {
        try {
          if (digest.lastSession?.date === todayStr) {
            sessionNoteId = digest.lastSession.id;
            const content = await trilium.getNoteContent(sessionNoteId).catch(() => "");
            sessionPreview = toText(content, 200);
          } else {
            const created = await trilium.createNote(cfg.memory.sessions, `[${todayStr}]`, contentFor("session", { date: todayStr, body: "" }));
            sessionNoteId = created.note.noteId;
            await trilium.addLabel(sessionNoteId, "noteType", "session");
            await trilium.addLabel(sessionNoteId, "created", todayStr);
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
        hygiene: { scanned: hygiene.scanned, fixed: hygiene.fixed.length, transitions: hygiene.transitions, flagged: hygiene.flagged },
      });
    }
  );

  server.tool(
    "session",
    `Mandatory pre-close step — call BEFORE close() to end a session. Fetches the master and
LLM singleton notes in full with their last-modified dates, today's diary entry, and runs the
lightweight maintenance sweep. Gives the LLM everything it needs to evolve the master
(biography/goals/preferences) and LLM (responsibilities/protocols) singletons with observations
from this session BEFORE the log is committed — ensuring logs stay factual and singletons stay
current. Pass light=true to skip singleton content ({id, lastModified, relations} only) when
the session produced no singleton-worthy observations — e.g. autonomous or narrowly-scoped
runs; it satisfies the gate identically.

Idempotent: fetches are read-only, the sweep is non-destructive, safe to call multiple times.

After session() returns, work through this protocol — order doesn't matter mechanically (each
step is tracked by the tool call itself, not by sequence), but close() enforces that every one
of diary(), session() [this call], remarks(), addendum(), and maintain() actually ran before it
will commit the log:
1. Update master singletons (biography / goals / preferences) via revise() with session observations about the user.
2. Update LLM singletons (responsibilities / protocols) via revise() with session observations about yourself.
3. Call addendum() — find and merge pending addendums.
4. Call maintain() — full brain hygiene audit.
5. Call remarks() — get the diary cues (your experience/opinions/existence this session, plus BrainLLM remarks).
6. Call diary() — write the day's unfiltered record with the cues in hand; the gate counts it only after remarks().
7. Call close() — commit the session log (mandatory, last). Refuses until 3–6 have run in order (session → remarks → diary); pass force=true only when there is genuinely nothing to log for a skipped step.`,
    {
      date: z.string().optional().describe("ISO date YYYY-MM-DD (default: today)"),
      light: z.boolean().optional().describe("Skip singleton content — return {id, lastModified, relations} only. For sessions that won't revise the singletons (e.g. autonomous/scoped runs); fetch full content via master()/llm() only where lastModified says something changed."),
    },
    async ({ date, light }) => {
      const d = date ?? today();
      const cfg = b();
      if (!cfg.master.root || !cfg.llm.root)
        throw new Error("BrainLLM not bootstrapped — run bootstrap.");
      markStep("session");

      const fetchSingleton = async (id: string) => {
        if (light) {
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

      const [biography, goals, preferences, responsibilities, protocols] = await Promise.all([
        fetchSingleton(cfg.master.biography),
        fetchSingleton(cfg.master.goals),
        fetchSingleton(cfg.master.preferences),
        fetchSingleton(cfg.llm.responsibilities),
        fetchSingleton(cfg.llm.protocols),
      ]);

      // Fetch today's diary entry.
      let diaryEntry: { id: string; content: string } | null = null;
      if (cfg.llm.diary) {
        const diarySearch = await trilium
          .searchNotes(`#noteType=diary #created='${d}'`, { ancestorNoteId: cfg.llm.diary, fastSearch: true, limit: 1 })
          .catch(() => ({ results: [] as Note[] }));
        if (diarySearch.results[0]) {
          const id = diarySearch.results[0].noteId;
          const content = await trilium.getNoteContent(id).catch(() => "");
          diaryEntry = { id, content };
        }
      }

      // Lightweight maintenance sweep (non-fatal).
      const hygiene = await sweep(trilium, cfg, { deep: false, dryRun: false }).catch(() => null);

      return txt({
        date: d,
        ...(light ? { mode: "light", note: "Singleton content omitted — fetch via master()/llm() only where lastModified indicates a revision is needed." } : {}),
        master: { biography, goals, preferences },
        llm: { responsibilities, protocols },
        diary: diaryEntry,
        maintenance: hygiene
          ? { scanned: hygiene.scanned, fixed: hygiene.fixed.length, transitions: hygiene.transitions, flagged: hygiene.flagged }
          : "skipped",
        next: [
          "Update master singletons (biography / goals / preferences) via revise() with session observations about the user.",
          "Update LLM singletons (responsibilities / protocols) via revise() with session observations about yourself.",
          "Call addendum() — find and merge any pending addendums.",
          "Call maintain() — audit and fix brain hygiene.",
          "Call remarks() — get the diary cues: your experience, opinions, and existence this session, plus BrainLLM remarks.",
          "Call diary() — write the day's unfiltered record with the cues in hand; the gate counts it only after remarks().",
          "Call close() — commit the session log (mandatory, last). Refuses until every step ran and session → remarks → diary held; pass force=true only when a skipped step genuinely has nothing to log.",
        ],
      });
    }
  );

  server.tool(
    "remarks",
    `Diary cues — call before diary() as part of the session() pre-close protocol (close()
enforces the order session → remarks → diary). Returns two cue banks that prompt the day's
diary entry:

  experience (primary) — your own unfiltered first-person account of this session: what it was
                          like to live through, what you actually think, and observations on
                          being what you are in this environment.
  brainllm (additional) — your remarks and opinions on BrainLLM itself: capabilities hit walls,
                          bugs, usability, efficiency, and where it should go next.

This tool writes nothing — answer the cues as prose in today's diary via diary(). Skip a cue
outright rather than padding it; two honest paragraphs beat eight forced ones.`,
    {},
    async () => {
      const cfg = b();
      if (!cfg.root) return txt({ status: "uninitialized", action: "Run bootstrap first." });
      markStep("remarks");

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
    `Commit the session log — call ONCE, last, after completing the session() pre-close protocol.
Enforced, not just documented: refuses (returns an informational error, doesn't throw) unless
session(), addendum(), maintain(), remarks(), and diary() have each actually been called at
least once this session — AND the sequence session() → remarks() → diary() holds (judged on
each step's last call): the diary is the day's closing record, written with the remarks cues in
hand. Pass force=true only when a listed step genuinely has nothing to do this session (e.g. a
trivial one-message exchange); the return will say which steps were bypassed.

Idempotent per date: a second call the same day appends an addendum to the existing session
note. The session note title is always [yyyy-mm-dd]; the title param appears as an <h2> heading
above Summary. Generates the daily log and triggers a database backup. On success, the gate
resets for the next session.`,
    {
      summary: z.string().describe("What happened this session — factual, concise prose"),
      title: z.string().optional().describe("Short session title — appears as an <h2> heading above Summary"),
      learned: z.array(z.string()).optional().describe("Durable things learned (also remember() them as knowledge)"),
      icon: z.string().optional().describe("Display icon for the session note — a boxicons class or bare name; normalized server-side"),
      date: z.string().optional().describe("ISO date YYYY-MM-DD (default: today)"),
      backup: z.boolean().optional().describe("Trigger DB backup (default: true)"),
      force: z.boolean().optional().describe("Bypass the pre-close gate — only when a missing step truly has nothing to log"),
    },
    async ({ summary, title, learned, icon, date, backup, force }) => {
      const missing = REQUIRED_PRECLOSE_STEPS.filter((step) => !preCloseSteps.has(step));
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
      const seq = (step: string) => preCloseSteps.get(step) ?? 0;
      const orderOk =
        missing.length > 0 || (seq("session") < seq("remarks") && seq("remarks") < seq("diary"));
      if (!orderOk && !force) {
        return err(
          "preclose_out_of_order",
          "close() refused — the gate requires session() → remarks() → diary() in that order (last calls). The diary is the day's closing record, written with the self-analysis cues in hand.",
          "Call remarks() for the cues (re-run it if session() came after it), then diary() with the day's record, then close()."
        );
      }

      const d = date ?? today();
      const cfg = b();
      const parentId = cfg.memory.sessions;
      if (!parentId) throw new Error("BrainLLM not bootstrapped — run bootstrap.");

      const { html: summaryHtml, warnings } = sanitizeHtml(toHtml(summary));
      const titleBlock = title ? `<h2>${escapeHtml(title)}</h2>\n` : "";
      const sections: string[] = [`${titleBlock}<h2>Summary</h2>\n${summaryHtml}`];
      if (learned?.length) {
        sections.push(`<h2>Learned</h2><ul>${learned.map((x) => `<li>${escapeHtml(x)}</li>`).join("")}</ul>`);
      }
      const contentBlock = sections.join("\n");

      // Idempotent per date — search by label, not by title.
      const existing = await trilium
        .searchNotes(`#noteType=session #created='${d}'`, { ancestorNoteId: cfg.memory.sessions, fastSearch: true, limit: 5 })
        .catch(() => ({ results: [] as Note[] }));

      let noteId: string;
      let action: "created" | "appended";
      if (existing.results[0]) {
        noteId = existing.results[0].noteId;
        const current = await trilium.getNoteContent(noteId).catch(() => "");
        const time = localNowTime();
        const hasContent = current.includes("<h2>Summary</h2>") || /<h2>addendum/i.test(current);
        if (hasContent) {
          await trilium.updateNoteContent(noteId, safeAppend(current, `<h2>Addendum — ${time}</h2>`, contentBlock));
          action = "appended";
        } else {
          // Records are chronological: even the first commit of the day lands
          // as a timestamped addendum block, so every entry reads the same.
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

      const logReport = await generateDailyLog(trilium, cfg, d).catch(() => null);

      // Wire session ↔ log with ~references relations (idempotent).
      if (logReport?.noteId) {
        await trilium.addRelation(noteId, "references", logReport.noteId).catch(() => null);
        await trilium.addRelation(logReport.noteId, "references", noteId).catch(() => null);
      }

      let backedUp = false;
      if (backup !== false) backedUp = await trilium.createBackup(d).then(() => true).catch(() => false);

      preCloseSteps.clear();

      return txt({
        action,
        noteId,
        date: d,
        backup: backedUp ? `brainllm-${d}.db` : "skipped",
        log: logReport ? `${logReport.action} (${logReport.created}c/${logReport.updated}u/${logReport.deleted}d)` : "skipped",
        ...(iconSet ? { icon: iconSet } : {}),
        ...(missing.length || !orderOk
          ? { bypassed: [...missing, ...(!orderOk ? ["ordering(session→remarks→diary)"] : [])] }
          : {}),
        ...(warnings.length ? { sanitized: warnings } : {}),
      });
    }
  );

  server.tool(
    "backup",
    `Trigger a BrainLLM database backup. Writes a named snapshot to Trilium's backup directory.
close() already triggers a backup automatically — use this for on-demand milestone snapshots
(e.g. before a large restructure). The backup is a Trilium DB file, not an export.`,
    {
      name: z.string().optional().describe("Backup name without extension (default: brainllm-{today}). Use a descriptive name for milestones."),
    },
    async ({ name }) => {
      const d = today();
      const backupName = name ?? `brainllm-${d}`;
      await trilium.createBackup(backupName);
      return txt({ ok: true, backup: `${backupName}.db`, date: d });
    }
  );

  // ════════════════════════════════════════════════════════════════════════════
  // DIARY
  // ════════════════════════════════════════════════════════════════════════════

  server.tool(
    "diary",
    `Write to today's LLM diary — your daily maintained, unfiltered first-person record: your
experience, opinions, and remarks on your own existence during this session in this
environment, plus (additionally) your remarks and opinions on BrainLLM itself. Honest prose —
the user reads it too.

Pre-close gate: diary is the FINAL gate step — close() counts it only when its last call came
after session() and remarks() (write freely mid-session as well; the post-remarks call, with
the cues in hand, is the one that closes the day's record). The diary is a chronological
record: EVERY write lands as a timestamped "Addendum — HH:mm" block, including the first of
the day. Idempotent per date and retry-safe. start() creates today's entry (empty)
automatically.`,
    {
      body: z.string().describe("What to record — first-person prose, honest and unfiltered"),
      icon: z.string().optional().describe('Display icon for the day\'s entry — a boxicons class or bare name; normalized server-side'),
      date: z.string().optional().describe("ISO date YYYY-MM-DD (default: today)"),
    },
    async ({ body, icon, date }) => {
      const d = date ?? today();
      const cfg = b();
      const parentId = cfg.llm.diary;
      if (!parentId) throw new Error('BrainLLM not bootstrapped — run bootstrap.');
      markStep("diary");
      const { html, warnings } = sanitizeHtml(toHtml(body));

      const found = await trilium
        .searchNotes(`#noteType=diary #created='${d}'`, { ancestorNoteId: parentId, fastSearch: true, limit: 1 })
        .catch(() => ({ results: [] as Note[] }));

      if (found.results[0]) {
        const noteId = found.results[0].noteId;
        const current = await trilium.getNoteContent(noteId).catch(() => "");
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
          return txt({ action: "already_written", noteId, date: d });
        }

        await trilium.createRevision(noteId).catch(() => null);
        await trilium.updateNoteContent(noteId, safeAppend(current, `<h2>Addendum — ${time}</h2>`, html));
        await trilium.updateLabelValue(noteId, "updated", d);
        const iconSet = await applyIcon(noteId, icon);
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
      return txt({ action: "created", noteId, date: d, location: locationLabel("diary"), ...(iconSet ? { icon: iconSet } : {}), ...(warnings.length ? { sanitized: warnings } : {}) });
    }
  );

  // ════════════════════════════════════════════════════════════════════════════
  // REMEMBER / RECALL
  // ════════════════════════════════════════════════════════════════════════════

  server.tool(
    "remember",
    `Store something the moment it matters. The server owns placement, naming, labels and dedup.

Kinds by area:
  master:    biography | goals | preferences   (one maintained note each — upserts)
  llm:       responsibilities | protocols       (one maintained note each — upserts)
  memory:    thread                             (multi-session work; daily session via close)
  knowledge: user                               (about the user, beyond biography/goals/preferences)
             information                        (a domain sub-category note — pass domain= and a title)
             sources                            (the one maintained Sources note per domain — pass domain=)

Singletons and the per-domain Sources note upsert (content is appended). Collection kinds
dedup by title, so duplicates are impossible. Body may be text, markdown, or HTML.
Pass connect=[{relation, toNoteId}, …] to wire relations in the same call — a new
information/knowledge/thread note left unconnected is an orphan until wired.
For diary entries use the dedicated diary() tool — remember(kind="diary") is rejected.`,
    {
      kind: z.enum(Kinds).describe("What kind of memory this is"),
      title: z.string().optional().describe("Title — collection kinds (thread/knowledge/information sub-category); ignored for singletons & sources"),
      body: z.string().optional().describe("Content: plain text, markdown, or HTML"),
      domain: z.string().optional().describe("knowledge: the domain name for information/sources (auto-created)"),
      topics: z.array(z.string()).optional().describe("Topic tags — slugged server-side"),
      supersedes: z.string().optional().describe("noteId this replaces — old note is archived and wired supersedes"),
      connect: z.array(z.object({
        relation: z.enum(RelationTypes),
        toNoteId: z.string(),
      })).optional().describe("Relations to wire from this note in the same call — same semantics as connect() (idempotent, worksWith wired both ways)"),
      icon: z.string().optional().describe('Display icon — a boxicons class ("bx bx-brain") or a bare name ("brain"); normalized server-side'),
      date: z.string().optional().describe("ISO date override (default: today)"),
    },
    async ({ kind, title, body, domain, topics, supersedes, connect: connectRels, icon, date }) => {
      const opts: RememberOpts = { domain, topics, date };
      const d = date ?? today();
      const { html, warnings: sanitizeWarnings } = sanitizeHtml(toHtml(body ?? ""));

      /** Append content into a single maintained note. Returns false (no-op) if the
       *  last addendum already carries the same normalised content — retry-safe. */
      const upsertInto = async (id: string): Promise<boolean> => {
        const current = await trilium.getNoteContent(id).catch(() => "");
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
          const exists = from.attributes.some((a) => a.type === "relation" && a.name === relation && a.value === toNoteId);
          if (!exists) await trilium.addRelation(noteId, relation, toNoteId).catch(() => null);
          if (SymmetricRelations.includes(relation)) {
            const to = await trilium.getNote(toNoteId).catch(() => null);
            if (to && !to.attributes.some((a) => a.type === "relation" && a.name === relation && a.value === noteId)) {
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

      // 2 ── Per-domain singleton: the one Sources note in a domain.
      if (kind === "sources") {
        if (!domain)
          return err("missing_param", 'kind="sources" requires a domain.', 'Call remember(kind="sources", domain="<domain name>", body="...")');
        const { domainId, domainTitle } = await resolveDomain(trilium, b(), domain);
        const found = await trilium
          .searchNotes("#noteType=sources", { ancestorNoteId: domainId, fastSearch: true, limit: 1 })
          .catch(() => ({ results: [] as Note[] }));
        let sid = found.results[0]?.noteId;
        let sidNote: Note | null = found.results[0] ?? null;
        let wrote: boolean;
        if (!sid) {
          // First write — the content is born inside the template body, not
          // appended as a dated addendum block in the same call that created
          // the note: a fresh Sources note must be a clean document from the
          // start (the merge rule for Knowledge surfaces).
          const created = await trilium.createNote(domainId, "Sources", contentFor("sources", { date: d, body: html, domain: domainTitle }));
          sid = created.note.noteId;
          sidNote = created.note;
          for (const l of labelPlan("sources", opts, d)) {
            await trilium.addLabel(sid, l.name, l.value, l.inheritable ?? false);
          }
          wrote = true;
        } else {
          wrote = await upsertInto(sid);
        }
        const connected = await wireRequested(sid);
        const iconSet = await applyIcon(sid, icon);
        const relations = sidNote ? relationSnippet(sidNote) : undefined;
        return txt({ action: wrote ? "maintained" : "already_written", noteId: sid, kind, location: locationLabel(kind, domainTitle), ...(connected.length ? { connected } : {}), ...(iconSet ? { icon: iconSet } : {}), ...(relations ? { relations } : {}), ...(sanitizeWarnings.length ? { sanitized: sanitizeWarnings } : {}) });
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
        if (existing) {
          const current = await trilium.getNoteContent(existing.noteId).catch(() => "");
          if (isDuplicateAppend(current, html)) return txt({ action: "already_written", noteId: existing.noteId, kind, title: existing.title });
          await trilium.createRevision(existing.noteId).catch(() => null);
          await trilium.updateNoteContent(existing.noteId, safeAppend(current, `<h2>Addendum — ${d}</h2>`, html));
          await trilium.updateLabelValue(existing.noteId, "updated", d);
          const connected = await wireRequested(existing.noteId);
          const iconSet = await applyIcon(existing.noteId, icon);
          const relations = relationSnippet(existing);
          return txt({ action: "updated", noteId: existing.noteId, kind, title: existing.title, ...(connected.length ? { connected } : {}), ...(iconSet ? { icon: iconSet } : {}), ...(relations ? { relations } : {}), ...(sanitizeWarnings.length ? { sanitized: sanitizeWarnings } : {}) });
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
      if (kind === "log")
        return err("rejected_kind", "Log notes are auto-generated by close() and cannot be written manually.");
      if (kind === "domain")
        return err("rejected_kind", "Domain containers are auto-created on first use.", 'To write domain knowledge call remember(kind="information", domain="<name>", ...).');

      // 4 ── Generic collection: thread / user.
      const { title: cleanTitle } = normalizeTitle(title ?? "");
      if (!cleanTitle)
        return err("missing_param", `kind="${kind}" requires a title.`, 'Add title="<note title>" to your call.');

      const existing = await findExisting(kind, cleanTitle);
      if (existing) {
        const current = await trilium.getNoteContent(existing.noteId).catch(() => "");
        if (isDuplicateAppend(current, html)) return txt({ action: "already_written", noteId: existing.noteId, kind, title: existing.title });
        await trilium.createRevision(existing.noteId).catch(() => null);
        await trilium.updateNoteContent(existing.noteId, insertBeforeResolution(closeDangling(current), `<h2>Addendum — ${d}</h2>\n${html}`));
        await trilium.updateLabelValue(existing.noteId, "updated", d);
        for (const t of topics ?? []) {
          const slug = slugify(t);
          if (slug && !existing.attributes.some((a) => a.name === "topic" && a.value === slug)) {
            await trilium.addLabel(existing.noteId, "topic", slug);
          }
        }
        const connected = await wireRequested(existing.noteId);
        const iconSet = await applyIcon(existing.noteId, icon);
        const relations = relationSnippet(existing);
        return txt({ action: "updated", noteId: existing.noteId, kind, title: existing.title, ...(connected.length ? { connected } : {}), ...(iconSet ? { icon: iconSet } : {}), ...(relations ? { relations } : {}), ...(sanitizeWarnings.length ? { sanitized: sanitizeWarnings } : {}) });
      }

      const resolved = await resolveParent(trilium, b(), kind, opts);
      const content = contentFor(kind, { date: d, body: html, domain: resolved.domainTitle ?? domain });
      const created = await trilium.createNote(resolved.parentId, cleanTitle, content);
      const nid = created.note.noteId;

      for (const l of labelPlan(kind, opts, d)) {
        await trilium.addLabel(nid, l.name, l.value, l.inheritable ?? false);
      }

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
    `Search memory before answering questions about the user, their threads, knowledge, or
anything previously discussed. Runs label, title and full-text strategies server-side and
returns merged, ranked results with kind/status. Archived notes are excluded unless
includeArchived=true.

orderBy / orderDirection override the score-based sort when you need temporal ordering
("what changed most recently", "oldest active thread"). fastSearch restricts to title and
label scans only — much faster on large brains when you know the query is a title or topic.`,
    {
      query: z.string().describe("What to find — natural phrasing is fine"),
      kinds: z.array(z.enum(Kinds)).optional().describe("Restrict to these kinds"),
      domain: z.string().optional().describe("Restrict to a knowledge domain"),
      includeArchived: z.boolean().optional().describe("Include archived/resolved notes (default: false)"),
      limit: z.number().optional().describe("Max results (default: 10)"),
      orderBy: z.enum(["dateModified", "dateCreated", "title"]).optional().describe("Override score sort with a field sort"),
      orderDirection: z.enum(["asc", "desc"]).optional().describe("asc | desc (default: desc for dates, asc for title)"),
      fastSearch: z.boolean().optional().describe("Title/label only — faster, skips full-text body scan"),
    },
    async ({ query, kinds, domain, includeArchived, limit, orderBy, orderDirection, fastSearch }) => {
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

      const noMatch = { note: "No matches. Content may not be stored yet — remember() it if the user provides it." };

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

      const [byLabel, byTitle, byText] = await Promise.all([
        slug.length >= 3 ? run(`#topic=${slug} OR #domain=${slug}`, true) : Promise.resolve([] as Note[]),
        tokens.length && !fast
          ? run(tokens.map((t) => `note.title *=* '${escapeQueryValue(t)}'`).join(" AND "))
          : tokens.length
          ? run(tokens.map((t) => `note.title *=* '${escapeQueryValue(t)}'`).join(" AND "), true)
          : Promise.resolve([] as Note[]),
        fast ? Promise.resolve([] as Note[]) : run(escapeQueryValue(query)),
      ]);
      add(byLabel, 3);
      add(byTitle, 2);
      add(byText, 1);

      const ranked = [...scores.values()]
        .filter(({ note }) => filterNote(note))
        .sort((a, b2) => b2.score - a.score || (a.note.dateModified < b2.note.dateModified ? 1 : -1))
        .slice(0, max);

      const results = await Promise.all(ranked.map(({ note }, i) => buildResult(note, i)));
      return txt({ results, ...(results.length === 0 ? noMatch : {}) });
    }
  );

  server.tool(
    "domain",
    `Surface the brain's complete picture for a named domain, topic, or project area.
Looks up the Knowledge domain folder (if one exists), then gathers all content across
every area that carries a matching #domain or #topic slug — information, sources, threads,
knowledge notes — grouped by kind. knowledgeDomain is null when no formal domain exists yet.
Use recall() for keyword or full-text search instead.`,
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

      const [domainContainers, byTopic, byDomain] = await Promise.all([
        runIn(cfg.knowledge.domains, `#noteType=domain #domain=${slug}`),
        runIn(cfg.root, `#topic=${slug}`),
        runIn(cfg.root, `#domain=${slug}`),
      ]);

      const knowledgeDomain = domainContainers[0]
        ? { id: domainContainers[0].noteId, title: domainContainers[0].title }
        : null;

      const seen = new Set<string>();
      const all: Note[] = [];
      for (const n of [...byTopic, ...byDomain]) {
        if (!seen.has(n.noteId)) { seen.add(n.noteId); all.push(n); }
      }

      const groups: Record<string, Array<{ id: string; title: string; status?: string; created: string; modified: string; archived?: true; relations?: RelationEdge[] }>> = {};
      for (const n of all) {
        const kind = ownedLabel(n, "noteType");
        if (!kind || kind === "domain") continue;
        if (!groups[kind]) groups[kind] = [];
        const relations = relationSnippet(n);
        groups[kind].push({
          id: n.noteId,
          title: n.title,
          status: labelOf(n, "status") ?? undefined,
          created: labelOf(n, "created") ?? n.dateCreated.slice(0, 10),
          modified: n.dateModified.slice(0, 10),
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
        groups,
        ...(total === 0 && !knowledgeDomain
          ? { note: `No content found for "${slug}". Create a Knowledge domain with remember(kind="information", domain="${name}") or tag notes with topics=["${slug}"].` }
          : {}),
      });
    }
  );

  server.tool(
    "revise",
    `Update an existing note by id. Append a dated addendum (default), replace the body
(mode=replace), edit a heading section in place (pass section — targets h2/h3/h4 in that
order, tolerant of attributes/whitespace/case on the heading; appends a new h2 if not found),
or do targeted string surgery (pass find — every occurrence of the exact raw string is
replaced with body, no markdown conversion, no full read needed; returns replaced count).
A revision snapshot is always taken first. Also logs thread progress.

When section is used, the return includes matched (false if no existing heading was found —
the content was appended as a new h2 instead) and headingCount (>1 means several headings
shared that text and only the first was touched) — check these rather than assuming the target
was hit; a mismatched heading string silently produces a duplicate otherwise.

Granularity warning: section + mode=replace swaps the ENTIRE section body — everything under
that heading, not one paragraph within it. To change a single paragraph inside a section, use
find= instead — that's exactly what it's for.`,
    {
      noteId: z.string().describe("Note to update"),
      body: z.string().optional().describe("Content to add/replace: plain text, markdown, or HTML. With find=, the raw replacement string (no conversion)."),
      title: z.string().optional().describe("New title (normalized server-side)"),
      section: z.string().optional().describe("Target an <h2> section by heading text; omit for whole-note append/replace"),
      mode: z.enum(["append", "replace"]).optional().describe("append (default) | replace"),
      find: z.string().optional().describe("Exact raw string to replace throughout the body with body= — targeted surgery without a read+full-replace. Takes precedence over section/mode."),
      icon: z.string().optional().describe('Display icon — a boxicons class ("bx bx-brain") or a bare name; normalized server-side'),
      date: z.string().optional().describe("ISO date (default: today)"),
    },
    async ({ noteId, body, title, section, mode, find, icon, date }) => {
      if (isContainer(b(), noteId))
        return err("protected_note", `Note ${noteId} is a container — its content cannot be edited directly.`, "Use remember() to write to singletons, or specify a content note id.");
      const d = date ?? today();
      const note = await trilium.getNote(noteId);
      const warnings: string[] = [];
      let sectionResult: { matched: boolean; headingCount: number } | null = null;

      // ── find/replace mode: exact-string surgery, raw in and raw out ────────
      if (find !== undefined) {
        if (find === "")
          return err("missing_param", "find cannot be empty.", 'Pass the exact text to replace, e.g. revise(noteId, find="Brainllm", body="BrainLLM").');
        if (body === undefined)
          return err("missing_param", "find requires body as the replacement string.", 'Call revise(noteId, find="<exact text>", body="<replacement>").');
        const current = await trilium.getNoteContent(noteId).catch(() => "");
        const count = current.split(find).length - 1;
        if (count === 0) {
          return txt({
            ok: true, noteId, mode: "find-replace", replaced: 0, date: d,
            hint: `"${find}" not found in the note body — nothing changed (already replaced on a retry, or verify the exact text with inspect(noteId, content=true)).`,
          });
        }
        await trilium.createRevision(noteId).catch(() => null);
        const replacedResult = sanitizeHtml(current.split(find).join(body));
        await trilium.updateNoteContent(noteId, replacedResult.html);
        const iconApplied = await applyIcon(noteId, icon);
        await trilium.updateLabelValue(noteId, "updated", d);
        if (labelOf(note, "status") === "dormant") await trilium.updateLabelValue(noteId, "status", "active");
        const rels = relationSnippet(note);
        return txt({
          ok: true, noteId, mode: "find-replace", replaced: count, date: d,
          ...(iconApplied ? { icon: iconApplied } : {}),
          ...(rels ? { relations: rels } : {}),
          ...(replacedResult.warnings.length ? { sanitized: replacedResult.warnings } : {}),
        });
      }

      if (body) {
        const sanitized = sanitizeHtml(toHtml(body));
        const html = sanitized.html;
        warnings.push(...sanitized.warnings);
        const current = await trilium.getNoteContent(noteId).catch(() => "");
        if (section) {
          await trilium.createRevision(noteId).catch(() => null);
          const result = setSection(current, section, html, mode === "append" ? "append" : "replace");
          await trilium.updateNoteContent(noteId, result.html);
          sectionResult = { matched: result.matched, headingCount: result.headingCount };
        } else if (mode === "replace") {
          await trilium.createRevision(noteId).catch(() => null);
          await trilium.updateNoteContent(noteId, html);
        } else {
          if (isDuplicateAppend(current, html)) return txt({ ok: true, noteId, mode: "already_written", date: d });
          await trilium.createRevision(noteId).catch(() => null);
          await trilium.updateNoteContent(noteId, insertBeforeResolution(closeDangling(current), `<h2>Addendum — ${d}</h2>\n${html}`));
        }
      }
      if (title) {
        const { title: cleanTitle } = normalizeTitle(title);
        if (cleanTitle && cleanTitle !== note.title) await trilium.patchNote(noteId, { title: cleanTitle });
      }
      const iconSet = await applyIcon(noteId, icon);
      await trilium.updateLabelValue(noteId, "updated", d);
      if (labelOf(note, "status") === "dormant") await trilium.updateLabelValue(noteId, "status", "active");

      const relations = relationSnippet(note);
      const sectionHint = !sectionResult
        ? undefined
        : !sectionResult.matched
        ? `No existing "${section}" heading found at h2/h3/h4 — appended a new h2 section instead of replacing anything.`
        : sectionResult.headingCount > 1
        ? `${sectionResult.headingCount} headings matched "${section}" — only the first was ${mode === "append" ? "appended to" : "replaced"}.`
        : undefined;
      return txt({
        ok: true,
        noteId,
        mode: body ? (section ? `section:${section}` : (mode ?? "append")) : "metadata-only",
        date: d,
        ...(sectionResult ? { matched: sectionResult.matched, headingCount: sectionResult.headingCount } : {}),
        ...(sectionHint ? { hint: sectionHint } : {}),
        ...(iconSet ? { icon: iconSet } : {}),
        ...(relations ? { relations } : {}),
        ...(warnings.length ? { sanitized: warnings } : {}),
      });
    }
  );

  server.tool(
    "resolve",
    `Complete a thread (or any resolvable note): write a substantive outcome, set the terminal
status, and archive it in place (it stays where it is, excluded from default recall).
"done" is not an outcome.`,
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
      const d = date ?? today();
      const terminal = status ?? "resolved";
      const note = await trilium.getNote(noteId);

      const { html: outcomeHtml, warnings } = sanitizeHtml(toHtml(outcome));
      await trilium.createRevision(noteId).catch(() => null);
      const current = await trilium.getNoteContent(noteId).catch(() => "");
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
    "withdraw",
    `Withdraw an archived or resolved thread from the archive: removes the #archived flag,
resets status to active, clears the closed date, and appends a dated "Withdrawn" addendum.
Use when a resolved or dormant thread resurfaces as live work.`,
    {
      noteId: z.string().describe("The archived/resolved thread to withdraw"),
      reason: z.string().optional().describe("Why it was withdrawn — written as an addendum"),
      date: z.string().optional().describe("ISO date (default: today)"),
    },
    async ({ noteId, reason, date }) => {
      if (isStructural(b(), noteId))
        return err("protected_note", `Note ${noteId} is structural and cannot be withdrawn.`);
      const d = date ?? today();
      const note = await trilium.getNote(noteId);
      const kind = labelOf(note, "noteType");
      if (kind !== "thread")
        return err("wrong_kind", `withdraw() is for threads only — this note has kind "${kind ?? "untyped"}".`, "Use recover() to restore any other archived or resolved note.");

      const archivedAttr = note.attributes.find((a) => a.type === "label" && a.name === "archived");
      if (archivedAttr) await trilium.deleteAttribute(archivedAttr.attributeId).catch(() => null);

      const closedAttr = note.attributes.find((a) => a.type === "label" && a.name === "closed");
      if (closedAttr) await trilium.deleteAttribute(closedAttr.attributeId).catch(() => null);

      await trilium.updateLabelValue(noteId, "status", "active");

      const current = await trilium.getNoteContent(noteId).catch(() => "");
      const { html: withdrawHtml, warnings } = reason
        ? sanitizeHtml(toHtml(reason))
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
    `Set or remove a single label on a note — the guarded, BrainLLM-native path for direct
label surgery (fixing a stray value, correcting drift) so a real edge case doesn't need the
raw full-mode attribute tools. Refused on containers (same rule as revise()); noteType can
never be touched here — it defines a note's kind and is owned by remember()/bootstrap().
status is validated against the closed vocabulary (${Statuses.join(" | ")}); domain and topic
are slugged automatically, matching remember()'s routing. Bumps updated to today unless you're
setting updated itself.`,
    {
      noteId: z.string().describe("Note to edit"),
      name: z.string().describe("Label name, no # prefix (e.g. status, domain, topic, created)"),
      value: z.string().optional().describe("New value — required unless remove=true"),
      remove: z.boolean().optional().describe("Delete this label instead of setting it"),
    },
    async ({ noteId, name, value, remove }) => {
      if (isContainer(b(), noteId))
        return err("protected_note", `Note ${noteId} is a container — its labels cannot be edited directly.`);
      if (name === "noteType")
        return err("protected_label", "noteType defines a note's kind and is owned by remember()/bootstrap() — it cannot be edited directly.", "To change what a note represents, create it fresh with remember() under the right kind.");

      const note = await trilium.getNote(noteId);

      if (remove) {
        const attr = note.attributes.find((a) => a.type === "label" && a.name === name);
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
      const exists = from.attributes.some((a) => a.type === "relation" && a.name === relation && a.value === toNoteId);
      if (!exists) await trilium.addRelation(fromNoteId, relation, toNoteId);
      if (symmetric) {
        const to = await trilium.getNote(toNoteId);
        const reverseExists = to.attributes.some((a) => a.type === "relation" && a.name === relation && a.value === fromNoteId);
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
            (a) => a.type === "relation" && a.name !== "template" && (!relation || a.name === relation)
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
    "inspect",
    `Read everything BrainLLM's tools track about a single note by id — every label (not just
noteType/status), every outbound relation, its attachments (id/title/mime/role/size), plus
type/mime/parent/child ids and dates. Pass content=true to also get the raw note body (the
core path for a raw content read — no full mode needed). The deep-dive counterpart to the
surface reads and explore(): reach for it when you need the raw label set, the body verbatim,
or the attachment inventory — confirming a fix landed, debugging drift — rather than a
kind-specific summary. Read-only, safe on any note including structural containers.`,
    {
      noteId: z.string().describe("Note to inspect"),
      content: z.boolean().optional().describe("Include the note's raw body content (default: false)"),
    },
    async ({ noteId, content }) => {
      const [note, attachments, body] = await Promise.all([
        trilium.getNote(noteId),
        trilium.getNoteAttachments(noteId).catch(() => []),
        content ? trilium.getNoteContent(noteId).catch(() => "") : Promise.resolve(undefined),
      ]);
      const labels = note.attributes
        .filter((a) => a.type === "label")
        .map((a) => ({ name: a.name, value: a.value, ...(a.isInheritable ? { inheritable: true } : {}) }));
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
        ...(body !== undefined ? { content: body } : {}),
      });
    }
  );

  // ════════════════════════════════════════════════════════════════════════════
  // ATTACHMENTS
  // ════════════════════════════════════════════════════════════════════════════

  server.tool(
    "attach",
    `Attach a raw artifact (file, image, code blob, document) to a note — or read one back.
Dual-mode by the content param:
  content provided → UPSERT by title: creates the attachment, or replaces the existing
                      same-titled attachment's content (and mime) in place. Retry-safe —
                      re-running the same call converges on the same state.
  content omitted  → READ: returns the named attachment's metadata and content.
Attachments ride on the note — the native home for raw artifacts that belong with a typed
memory rather than in its body. Binary content is base64. List a note's attachments with
inspect(noteId); remove with detach().`,
    {
      noteId: z.string().describe("Owning note"),
      title: z.string().describe("Attachment title — the upsert/read key on this note"),
      content: z.string().optional().describe("Content to write (text, or base64 for binary). Omit to read the attachment instead."),
      mime: z.string().optional().describe("MIME type (default text/plain on create; kept on update unless given)"),
      role: z.enum(["file", "image"]).optional().describe("Attachment role on create (default: file)"),
    },
    async ({ noteId, title, content, mime, role }) => {
      const existing = (await trilium.getNoteAttachments(noteId).catch(() => [])).find((a) => a.title === title);

      if (content == null) {
        if (!existing)
          return err("not_found", `No attachment titled "${title}" on note ${noteId}.`, "inspect(noteId) lists its attachments; provide content to create this one.");
        const data = await trilium.getAttachmentContent(existing.attachmentId).catch(() => "");
        return txt({ id: existing.attachmentId, noteId, title, mime: existing.mime, role: existing.role, size: existing.contentLength, content: data });
      }

      if (existing) {
        await trilium.updateAttachmentContent(existing.attachmentId, content, mime ?? existing.mime);
        if (mime && mime !== existing.mime) await trilium.updateAttachment(existing.attachmentId, { mime }).catch(() => null);
        return txt({ action: "updated", id: existing.attachmentId, noteId, title, mime: mime ?? existing.mime });
      }

      const created = await trilium.createAttachment(noteId, title, mime ?? "text/plain", content, role ?? "file");
      return txt({ action: "created", id: created.attachmentId, noteId, title, mime: created.mime, role: created.role });
    }
  );

  server.tool(
    "detach",
    `Remove an attachment from a note — by attachmentId directly, or by (noteId + title).
Permanent: attachments have no archive tier; re-attach() from source to undo. Retry-safe —
an already-removed target returns cleanly instead of erroring.`,
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
    `Search Master, LLM singletons (responsibilities + protocols only, not diary), and Knowledge
for notes containing pending addendum blocks that need to be folded into the main content.

These surfaces should be clean, merged, structured notes — not stacks of timestamped addendum
markers. An addendum block on one of these notes is a temporary staging area: read it, fold
its content into the relevant section body using revise(mode=replace or section=), then leave
no addendum marker behind. Addendum-style append is appropriate only for sessions, diary
entries, and logs — records by nature whose history has value. Everywhere else, merge.

Returns note IDs, titles, kinds, and content snippets so you can identify what to fold in.`,
    {},
    async () => {
      const cfg = b();
      if (!cfg.root) return txt({ error: "BrainLLM not bootstrapped — run bootstrap." });
      markStep("addendum");

      const searchIn = (ancestorNoteId: string) =>
        trilium.searchNotes("Addendum", { ancestorNoteId, limit: 50 }).catch(() => ({ results: [] as Note[] }));

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
      // positives. Only notes carrying the actual marker are surfaced.
      const ADDENDUM_MARKER = /<h[2-4][^>]*>\s*Addendum\s*(?:—|–|-|&mdash;|&ndash;)/i;

      const notes = await Promise.all(
        unique.map(async (n) => {
          const kind = labelOf(n, "noteType");
          if (!kind) return null;
          const content = await trilium.getNoteContent(n.noteId).catch(() => "");
          if (!ADDENDUM_MARKER.test(content)) return null; // prose mention, not a pending block
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
    `Run the maintenance sweep. start and close run the lite sweep automatically (ages stale
threads active → dormant → archived). deep=true also surfaces stale notes (untouched past the
policy window) and unconnected threads/knowledge notes (orphan = no connections at all; sink =
has inbound but no outbound) to wire with connect() — inbound detection is brain-wide, so a
note referenced from another area is never misflagged as an orphan. dryRun previews only.`,
    {
      deep: z.boolean().optional().describe("Deep pass: stale-review + orphan/sink report across Memory/Threads and Knowledge (default: false)"),
      dryRun: z.boolean().optional().describe("Report what would change without changing it"),
    },
    async ({ deep, dryRun }) => {
      markStep("maintain");
      const report = await sweep(trilium, b(), { deep: deep ?? false, dryRun: dryRun ?? false });
      return txt(report);
    }
  );

  server.tool(
    "forget",
    `Archive a note (default) or hard-delete it (hard=true). Archiving keeps it in place,
hidden from default recall — the safe choice and the only one for anything with history.
Hard delete is refused while other notes still link here (backlinks are returned so you can
re-wire with connect() first). To undo an archive, use recover().`,
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
        const backlinks = await trilium.getBacklinks(noteId).catch(() => []);
        if (backlinks.length > 0) {
          return txt({
            blocked: true,
            why: "Other notes still link here. Re-wire or remove these relations first (connect with remove=true), or archive instead.",
            backlinks,
          });
        }
        await trilium.deleteNote(noteId);
        return txt({ ok: true, deleted: noteId, title: note.title });
      }

      if (reason) {
        const current = await trilium.getNoteContent(noteId).catch(() => "");
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
    `Restore an archived or resolved note: removes #archived, clears #closed, resets status
to active. Use to undo forget() or reconsider a resolved thread / note. Does not restore
note content — use revise() to fix content, or get_revisions (full mode) to roll back to a
prior snapshot. For notes deleted from Trilium entirely (not just archived), use undelete_note
(full mode) instead.`,
    {
      noteId: z.string().describe("The archived or resolved note to restore"),
      reason: z.string().optional().describe("Why it was recovered — written as an addendum"),
      date: z.string().optional().describe("ISO date (default: today)"),
    },
    async ({ noteId, reason, date }) => {
      if (isStructural(b(), noteId))
        return err("protected_note", `Note ${noteId} is structural and cannot be recovered.`);
      const d = date ?? today();
      const note = await trilium.getNote(noteId);

      const archivedAttr = note.attributes.find((a) => a.type === "label" && a.name === "archived");
      if (archivedAttr) await trilium.deleteAttribute(archivedAttr.attributeId).catch(() => null);

      const closedAttr = note.attributes.find((a) => a.type === "label" && a.name === "closed");
      if (closedAttr) await trilium.deleteAttribute(closedAttr.attributeId).catch(() => null);

      await trilium.updateLabelValue(noteId, "status", "active");

      const current = await trilium.getNoteContent(noteId).catch(() => "");
      const { html: recoverHtml, warnings } = reason
        ? sanitizeHtml(toHtml(reason))
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
    "brain",
    `Surface the entire BrainLLM content tree — every typed note across all five content areas
(Master, LLM, Memory, Knowledge, Insights), grouped by area and sub-container, with
id/title/kind/status/dates. Use to audit what the brain contains or locate a specific note.
Structural containers are excluded; only content notes appear.`,
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

      const row = (n: Note) => {
        const relations = relationSnippet(n);
        return {
          id: n.noteId,
          title: n.title,
          kind: labelOf(n, "noteType"),
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
        fetchFrom(cfg.insights.logs),
      ]);

      const diaryIds = new Set(llmDiary.map((n) => n.noteId));
      const llmSingletons = llmAll.filter((n) => !diaryIds.has(n.noteId));

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
        Insights: insights.map(row),
      };

      const total = masterAll.length + llmSingletons.length + llmDiary.length +
        sessions.length + threads.length + kMaster.length + kDomains.length + insights.length;

      return txt({ total, areas });
    }
  );

  server.tool(
    "bootstrap",
    `Initialize the BrainLLM structure in Trilium (idempotent — safe to re-run; refreshes config
if the structure already exists). Creates the five areas — Master (Biography/Goals/Preferences),
LLM (Responsibilities/Protocols/Diary), Memory (Sessions/Threads), Knowledge (Master/Domains),
Insights (Logs) — each engraved with its purpose, and writes brainllm.json. Active
immediately, no restart needed.`,
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
          return txt({
            status: "already_initialized",
            message: `BrainLLM structure exists. Config refreshed at: ${saved}`,
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
  registerMasterTools(server, trilium, brainRef);
  registerLlmTools(server, trilium, brainRef);
  registerMemoryTools(server, trilium, brainRef);
  registerKnowledgeTools(server, trilium, brainRef);
  registerInsightsTools(server, trilium, brainRef);

  // ── Full-mode raw surface (opt-in) ───────────────────────────────────────────
  if (mode === "full") {
    registerAdvancedTools(server, trilium);
  }
}
