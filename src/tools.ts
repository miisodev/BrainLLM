/**
 * tools.ts — BrainLLM core tool surface (V5)
 *
 * The model supplies content; the server owns form. Placement, naming, labels,
 * blueprint wiring, dedup, lifecycle and archival are policy implemented here.
 *
 * Registers the universal verbs (start, close, bootstrap, remember, recall,
 * revise, resolve, connect, explore, maintain, forget), wires in the read-only
 * per-surface modules (tools-master/llm/memory/knowledge/insights/templates),
 * and — under BRAINLLM_MODE=full — the raw ETAPI surface (tools-advanced).
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { TriliumClient, type Note, ownedLabel } from "./trilium.js";
import { type BrainLLMConfig, saveConfig } from "./config.js";
import {
  Kinds,
  RelationTypes,
  SymmetricRelations,
  type AnyKind,
} from "./types.js";
import {
  normalizeTitle,
  sameTitle,
  slugify,
  toHtml,
  toText,
  escapeQueryValue,
  queryTokens,
  escapeHtml,
} from "./normalize.js";
import { contentFor, RESOLUTION_ANCHOR } from "./templates.js";
import {
  dedupScope,
  templateIdFor,
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
import { localToday } from "./time.js";
import { registerMasterTools } from "./tools-master.js";
import { registerLlmTools } from "./tools-llm.js";
import { registerMemoryTools } from "./tools-memory.js";
import { registerKnowledgeTools } from "./tools-knowledge.js";
import { registerInsightsTools } from "./tools-insights.js";
import { registerTemplatesTools } from "./tools-templates.js";
import { registerAdvancedTools } from "./tools-advanced.js";

// ── Shared helpers ────────────────────────────────────────────────────────────

export const txt = (obj: unknown) => ({
  content: [{ type: "text" as const, text: typeof obj === "string" ? obj : JSON.stringify(obj, null, 2) }],
});

export const today = () => localToday();

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

/** Replace or append within a heading section (h2/h3/h4 tried in order).
 *  Appends as a new h2 section if the heading is not found at any level. */
function setSection(html: string, heading: string, content: string, mode: "replace" | "append"): string {
  for (const level of [2, 3, 4]) {
    const tag = `h${level}`;
    const open = `<${tag}>${heading}</${tag}>`;
    const start = html.indexOf(open);
    if (start === -1) continue;
    const after = start + open.length;
    const nextMatch = html.slice(after).search(new RegExp(`<h[2-${level}]>`));
    const end = nextMatch === -1 ? html.length : after + nextMatch;
    const existing = html.slice(after, end).trim();
    const inner = mode === "append" && existing ? `${existing}\n${content}` : content;
    return `${html.slice(0, after)}\n${inner}\n${html.slice(end)}`;
  }
  return `${html}\n<h2>${heading}</h2>\n${content}`;
}

async function ensureArchivedFlag(trilium: TriliumClient, note: Note): Promise<void> {
  if (!hasLabel(note, "archived")) await trilium.addLabel(note.noteId, "archived", "");
}

/** Extract accumulated addendums from a note body (created by revise() default mode).
 *  Returns the h2 section headings of the main content and each addendum block separately. */
function parseAddendums(html: string): {
  sectionHeadings: string[];
  addendums: Array<{ date: string; content: string }>;
} {
  const segments = html.split(/(?=<h2>)/i);
  const sectionHeadings: string[] = [];
  const addendums: Array<{ date: string; content: string }> = [];
  for (const seg of segments) {
    const addendumMatch = seg.match(/^<h2>Addendum\s*[—–\-]\s*([^<]+)<\/h2>([\s\S]*)/i);
    if (addendumMatch) {
      addendums.push({ date: addendumMatch[1].trim(), content: addendumMatch[2].trim() });
    } else {
      const headingMatch = seg.match(/^<h2>([^<]+)<\/h2>/i);
      if (headingMatch) sectionHeadings.push(headingMatch[1]);
    }
  }
  return { sectionHeadings, addendums };
}

// ── Registration ──────────────────────────────────────────────────────────────

export function registerTools(
  server: McpServer,
  trilium: TriliumClient,
  brainRef: { config: BrainLLMConfig },
  mode: "core" | "full" = "core"
): void {
  const b = () => brainRef.config;

  /** Find an existing same-kind note with the same (normalized) title. */
  async function findExisting(kind: AnyKind, title: string): Promise<Note | null> {
    const scope = dedupScope(b(), kind);
    if (!scope) return null;
    const res = await trilium
      .searchNotes(`#noteType=${kind}`, { ancestorNoteId: scope, fastSearch: true, limit: 100 })
      .catch(() => ({ results: [] as Note[] }));
    return res.results.find((n) => sameTitle(n.title, title)) ?? null;
  }

  /** Wire an instance to its type's blueprint via Trilium's ~template relation. */
  async function wireTemplate(noteId: string, kind: AnyKind): Promise<void> {
    const tpl = templateIdFor(b(), kind);
    if (tpl) await trilium.addRelation(noteId, "template", tpl).catch(() => null);
  }

  // ════════════════════════════════════════════════════════════════════════════
  // SESSION
  // ════════════════════════════════════════════════════════════════════════════

  server.tool(
    "start",
    `Boot BrainLLM — call ONCE at the start of every session, before responding.
Returns orientation: awareness (today + weekday), the Master digest (the user: biography preview /
goals in full / preferences in full), the LLM digest (your own self-model: responsibilities / protocols), the
live working set (active threads with idle ages), a review queue of items gone dormant, and the
last session's summary. recall is for topic-specific lookup.`,
    {},
    async () => {
      const cfg = b();
      if (!cfg.root) {
        return txt({ status: "uninitialized", action: "Run bootstrap to create the BrainLLM structure." });
      }
      const hygiene = await sweep(trilium, cfg, { deep: false, dryRun: false }).catch((e) => ({
        scanned: 0, fixed: [], transitions: [], deleted: [], flagged: [`sweep failed: ${e}`], dryRun: false,
      }));
      const digest = await buildDigest(trilium, cfg);
      const todayStr = today();
      const weekday = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"][new Date(`${todayStr}T00:00:00Z`).getUTCDay()];
      const lastDate = digest.lastSession?.date;
      const daysSinceLastSession = lastDate ? Math.round((Date.parse(todayStr) - Date.parse(lastDate)) / 86_400_000) : null;

      // Ensure today's diary note exists (create empty entry if none yet).
      let diaryNoteId: string | null = null;
      if (cfg.llm.diary) {
        try {
          const existingDiary = await trilium
            .searchNotes(`#noteType=diary #created=${todayStr}`, { ancestorNoteId: cfg.llm.diary, fastSearch: true, limit: 1 })
            .catch(() => ({ results: [] as Note[] }));
          if (existingDiary.results[0]) {
            diaryNoteId = existingDiary.results[0].noteId;
          } else {
            const created = await trilium.createNote(cfg.llm.diary, todayStr, contentFor("diary", { date: todayStr, body: "" }));
            diaryNoteId = created.note.noteId;
            await trilium.addLabel(diaryNoteId, "noteType", "diary");
            await trilium.addLabel(diaryNoteId, "created", todayStr);
            await wireTemplate(diaryNoteId, "diary");
          }
        } catch { /* non-fatal — diary creation fails silently */ }
      }

      return txt({
        status: "ready",
        awareness: { today: todayStr, weekday, diaryNoteId, lastSession: lastDate ?? null, daysSinceLastSession },
        master: digest.master,
        llm: digest.llm,
        workingSet: digest.workingSet,
        reviewQueue: digest.reviewQueue.length
          ? { note: "These threads went dormant from inactivity. Mention them if relevant; revise() or resolve() to act.", items: digest.reviewQueue }
          : [],
        lastSession: digest.lastSession ?? null,
        hygiene: { scanned: hygiene.scanned, fixed: hygiene.fixed.length, transitions: hygiene.transitions, flagged: hygiene.flagged },
      });
    }
  );

  server.tool(
    "close",
    `Log the session — call ONCE at the end (or when the user says goodbye). Idempotent per
date: a second call the same day appends an addendum to the existing session note. Runs
maintenance and triggers a database backup. Just pass the summary — placement and dedup
are handled here.

After close() returns, follow this protocol in order:
1. Call absorb() — scan notes for unabsorbed addendums and integrate them.
2. Call maintain() — audit and fix brain hygiene (stale threads, missing labels, etc.).`,
    {
      summary: z.string().describe("What happened this session — factual, concise prose"),
      title: z.string().optional().describe("Short session title (default: derived from summary)"),
      learned: z.array(z.string()).optional().describe("Durable things learned (also remember() them as knowledge)"),
      date: z.string().optional().describe("ISO date YYYY-MM-DD (default: today)"),
      backup: z.boolean().optional().describe("Trigger DB backup (default: true)"),
    },
    async ({ summary, title, learned, date, backup }) => {
      const d = date ?? today();
      const cfg = b();
      const parentId = cfg.memory.sessions;

      const sections: string[] = [`<h2>Summary</h2>\n${toHtml(summary)}`];
      if (learned?.length) {
        sections.push(`<h2>Learned</h2><ul>${learned.map((x) => `<li>${escapeHtml(x)}</li>`).join("")}</ul>`);
      }
      const body = sections.join("\n");

      // Idempotent per date.
      const existing = await trilium
        .searchNotes(`#noteType=session #created=${d}`, { ancestorNoteId: cfg.memory.sessions, fastSearch: true, limit: 5 })
        .catch(() => ({ results: [] as Note[] }));

      let noteId: string;
      let action: "created" | "appended";
      if (existing.results[0]) {
        noteId = existing.results[0].noteId;
        const current = await trilium.getNoteContent(noteId).catch(() => "");
        const time = new Date().toISOString().slice(11, 16);
        await trilium.updateNoteContent(noteId, `${current}\n<h2>Addendum — ${time}</h2>\n${body}`);
        action = "appended";
      } else {
        const hint = title ?? summary.split(/\s+/).slice(0, 7).join(" ");
        const { title: cleanTitle } = normalizeTitle(`${d} — ${hint}`);
        const created = await trilium.createNote(parentId, cleanTitle, contentFor("session", { date: d, body }));
        noteId = created.note.noteId;
        await trilium.addLabel(noteId, "noteType", "session");
        await trilium.addLabel(noteId, "created", d);
        await wireTemplate(noteId, "session");
        action = "created";
      }

      const hygiene = await sweep(trilium, cfg, { deep: false, dryRun: false }).catch(() => null);
      let backedUp = false;
      if (backup !== false) backedUp = await trilium.createBackup(d).then(() => true).catch(() => false);

      const logReport = await generateDailyLog(trilium, cfg, d).catch(() => null);

      // Wire session ↔ log with ~references relations (idempotent).
      if (logReport?.noteId) {
        await trilium.addRelation(noteId, "references", logReport.noteId).catch(() => null);
        await trilium.addRelation(logReport.noteId, "references", noteId).catch(() => null);
      }

      return txt({
        action, noteId, date: d,
        backup: backedUp ? `brainllm-${d}.db` : "skipped",
        maintenance: hygiene ? "ran" : "skipped",
        log: logReport ? `${logReport.action} (${logReport.created}c/${logReport.updated}u/${logReport.deleted}d)` : "skipped",
        logNoteId: logReport?.noteId ?? null,
        next: [
          "Call absorb() — find and absorb any unabsorbed addendums.",
          "Call maintain() — audit and fix brain hygiene.",
        ],
      });
    }
  );

  // ════════════════════════════════════════════════════════════════════════════
  // DIARY
  // ════════════════════════════════════════════════════════════════════════════

  server.tool(
    "diary",
    `Write to today's LLM diary — your raw, unfiltered daily record. Idempotent per date:
a second call the same day appends a timestamped addendum to the existing entry.
start() creates today's entry (empty) automatically; use this tool to write content into it.`,
    {
      body: z.string().describe("What to record — prose, honest and unfiltered"),
      date: z.string().optional().describe("ISO date YYYY-MM-DD (default: today)"),
    },
    async ({ body, date }) => {
      const d = date ?? today();
      const cfg = b();
      const parentId = cfg.llm.diary;
      if (!parentId) throw new Error('BrainLLM not bootstrapped — run bootstrap.');
      const html = toHtml(body);

      const found = await trilium
        .searchNotes(`#noteType=diary #created=${d}`, { ancestorNoteId: parentId, fastSearch: true, limit: 1 })
        .catch(() => ({ results: [] as Note[] }));

      if (found.results[0]) {
        const noteId = found.results[0].noteId;
        await trilium.createRevision(noteId).catch(() => null);
        const current = await trilium.getNoteContent(noteId).catch(() => "");
        const time = new Date().toISOString().slice(11, 16);
        await trilium.updateNoteContent(noteId, `${current}\n<h3>Addendum — ${time}</h3>\n${html}`);
        await trilium.updateLabelValue(noteId, "updated", d);
        return txt({ action: "appended", noteId, date: d });
      }

      const created = await trilium.createNote(parentId, d, contentFor("diary", { date: d, body: html }));
      const noteId = created.note.noteId;
      await trilium.addLabel(noteId, "noteType", "diary");
      await trilium.addLabel(noteId, "created", d);
      await wireTemplate(noteId, "diary");
      return txt({ action: "created", noteId, date: d, location: locationLabel("diary") });
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
  knowledge: knowledge                          (about the user, beyond biography/goals/preferences)
             information                        (a domain sub-category note — pass domain= and a title)
             sources                            (the one maintained Sources note per domain — pass domain=)

Singletons and the per-domain Sources note upsert (content is appended). Collection kinds
dedup by title, so duplicates are impossible. Body may be text, markdown, or HTML.
For diary entries use the dedicated diary() tool — remember(kind="diary") is rejected.`,
    {
      kind: z.enum(Kinds).describe("What kind of memory this is"),
      title: z.string().optional().describe("Title — collection kinds (thread/knowledge/information sub-category); ignored for singletons & sources"),
      body: z.string().optional().describe("Content: plain text, markdown, or HTML"),
      domain: z.string().optional().describe("knowledge: the domain name for information/sources (auto-created)"),
      topics: z.array(z.string()).optional().describe("Topic tags — slugged server-side"),
      supersedes: z.string().optional().describe("noteId this replaces — old note is archived and wired supersedes"),
      date: z.string().optional().describe("ISO date override (default: today)"),
    },
    async ({ kind, title, body, domain, topics, supersedes, date }) => {
      const opts: RememberOpts = { domain, topics, date };
      const d = date ?? today();
      const html = toHtml(body ?? "");

      /** Append content into a single maintained note. */
      const upsertInto = async (id: string) => {
        await trilium.createRevision(id).catch(() => null);
        const current = await trilium.getNoteContent(id).catch(() => "");
        await trilium.updateNoteContent(id, `${current}\n<h2>Addendum — ${d}</h2>\n${html}`);
        await trilium.updateLabelValue(id, "updated", d);
      };

      // 1 ── Global singletons: one fixed maintained note (biography, goals, …).
      if (isSingleton(kind)) {
        const id = kindHome(b(), kind);
        if (!id) throw new Error(`BrainLLM not bootstrapped for "${kind}" — run bootstrap`);
        await upsertInto(id);
        return txt({ action: "maintained", noteId: id, kind, location: locationLabel(kind) });
      }

      // 2 ── Per-domain singleton: the one Sources note in a domain.
      if (kind === "sources") {
        if (!domain) throw new Error('kind "sources" requires a domain');
        const { domainId, domainTitle } = await resolveDomain(trilium, b(), domain);
        const found = await trilium
          .searchNotes("#noteType=sources", { ancestorNoteId: domainId, fastSearch: true, limit: 1 })
          .catch(() => ({ results: [] as Note[] }));
        let sid = found.results[0]?.noteId;
        if (!sid) {
          const created = await trilium.createNote(domainId, "Sources", contentFor("sources", { date: d, body: "", domain: domainTitle }));
          sid = created.note.noteId;
          for (const l of labelPlan("sources", opts, d)) {
            await trilium.addLabel(sid, l.name, l.value, l.inheritable ?? false);
          }
          await wireTemplate(sid, "sources");
        }
        await upsertInto(sid);
        return txt({ action: "maintained", noteId: sid, kind, location: locationLabel(kind, domainTitle) });
      }

      // 3 ── Domain collection: sub-category information notes (many per domain),
      //      deduped WITHIN their domain so different domains can share a title.
      if (kind === "information") {
        if (!domain) throw new Error('kind "information" requires a domain');
        const { title: subTitle } = normalizeTitle(title ?? "");
        if (!subTitle) throw new Error('kind "information" requires a sub-category title');
        const { domainId, domainTitle, createdDomain } = await resolveDomain(trilium, b(), domain);
        const inDomain = await trilium
          .searchNotes("#noteType=information", { ancestorNoteId: domainId, fastSearch: true, limit: 100 })
          .catch(() => ({ results: [] as Note[] }));
        const existing = inDomain.results.find((n) => sameTitle(n.title, subTitle));
        if (existing) {
          await trilium.createRevision(existing.noteId).catch(() => null);
          const current = await trilium.getNoteContent(existing.noteId).catch(() => "");
          await trilium.updateNoteContent(existing.noteId, insertBeforeResolution(current, `<h2>Addendum — ${d}</h2>\n${html}`));
          await trilium.updateLabelValue(existing.noteId, "updated", d);
          return txt({ action: "updated", noteId: existing.noteId, kind, title: existing.title });
        }
        const created = await trilium.createNote(domainId, subTitle, contentFor("information", { date: d, body: html, domain: domainTitle }));
        const nid = created.note.noteId;
        for (const l of labelPlan("information", opts, d)) {
          await trilium.addLabel(nid, l.name, l.value, l.inheritable ?? false);
        }
        await wireTemplate(nid, "information");
        return txt({
          action: "created",
          noteId: nid,
          kind,
          title: subTitle,
          location: locationLabel(kind, domainTitle),
          ...(createdDomain ? { createdDomain: domainTitle } : {}),
        });
      }

      // 3.5 ── Diary is now a dedicated tool — reject here with a clear redirect.
      if (kind === "diary") {
        throw new Error('Use the dedicated diary() tool to write diary entries. remember(kind="diary") is no longer supported.');
      }

      // 4 ── Generic collection: thread / knowledge / session / log / domain.
      const { title: cleanTitle } = normalizeTitle(title ?? "");
      if (!cleanTitle) throw new Error(`kind "${kind}" requires a title`);

      const existing = await findExisting(kind, cleanTitle);
      if (existing) {
        await trilium.createRevision(existing.noteId).catch(() => null);
        const current = await trilium.getNoteContent(existing.noteId).catch(() => "");
        await trilium.updateNoteContent(existing.noteId, insertBeforeResolution(current, `<h2>Addendum — ${d}</h2>\n${html}`));
        await trilium.updateLabelValue(existing.noteId, "updated", d);
        for (const t of topics ?? []) {
          const slug = slugify(t);
          if (slug && !existing.attributes.some((a) => a.name === "topic" && a.value === slug)) {
            await trilium.addLabel(existing.noteId, "topic", slug);
          }
        }
        return txt({ action: "updated", noteId: existing.noteId, kind, title: existing.title });
      }

      const resolved = await resolveParent(trilium, b(), kind, opts);
      const content = contentFor(kind, { date: d, body: html, domain: resolved.domainTitle ?? domain });
      const created = await trilium.createNote(resolved.parentId, cleanTitle, content);
      const nid = created.note.noteId;

      for (const l of labelPlan(kind, opts, d)) {
        await trilium.addLabel(nid, l.name, l.value, l.inheritable ?? false);
      }
      await wireTemplate(nid, kind);

      const wired: string[] = [];
      if (supersedes) {
        const old = await trilium.getNote(supersedes).catch(() => null);
        if (old && !isStructural(b(), supersedes)) {
          await trilium.addRelation(nid, "supersedes", supersedes).catch(() => null);
          await trilium.updateLabelValue(supersedes, "status", "superseded");
          await trilium.updateLabelValue(supersedes, "closed", d);
          await ensureArchivedFlag(trilium, old);
          wired.push(`supersedes → ${old.title} (archived)`);
        }
      }

      return txt({
        action: "created",
        noteId: nid,
        kind,
        title: cleanTitle,
        location: locationLabel(kind, resolved.domainTitle),
        ...(resolved.createdDomain ? { createdDomain: resolved.domainTitle } : {}),
        ...(wired.length ? { wired } : {}),
      });
    }
  );

  server.tool(
    "recall",
    `Search memory before answering questions about the user, their threads, knowledge, or
anything previously discussed. Runs label, title and full-text strategies server-side and
returns merged, ranked results with kind/status. Archived notes are excluded unless
includeArchived=true.`,
    {
      query: z.string().describe("What to find — natural phrasing is fine"),
      kinds: z.array(z.enum(Kinds)).optional().describe("Restrict to these kinds"),
      domain: z.string().optional().describe("Restrict to a knowledge domain"),
      includeArchived: z.boolean().optional().describe("Include archived/resolved notes (default: false)"),
      limit: z.number().optional().describe("Max results (default: 10)"),
    },
    async ({ query, kinds, domain, includeArchived, limit }) => {
      const cfg = b();
      const max = limit ?? 10;
      const scores = new Map<string, { note: Note; score: number }>();
      const add = (notes: Note[], weight: number) => {
        for (const n of notes) {
          const entry = scores.get(n.noteId);
          if (entry) entry.score += weight;
          else scores.set(n.noteId, { note: n, score: weight });
        }
      };
      const run = (q: string, fast = false) =>
        trilium
          .searchNotes(q, { ancestorNoteId: cfg.root, limit: 30, fastSearch: fast, includeArchivedNotes: includeArchived ?? false })
          .then((r) => r.results)
          .catch(() => [] as Note[]);

      const slug = slugify(query);
      const tokens = queryTokens(query);
      const [byLabel, byTitle, byText] = await Promise.all([
        slug.length >= 3 ? run(`#topic=${slug} OR #domain=${slug}`, true) : Promise.resolve([] as Note[]),
        tokens.length ? run(tokens.map((t) => `note.title *=* '${escapeQueryValue(t)}'`).join(" AND ")) : Promise.resolve([] as Note[]),
        run(escapeQueryValue(query)),
      ]);
      add(byLabel, 3);
      add(byTitle, 2);
      add(byText, 1);

      const domSlug = domain ? slugify(domain) : null;
      const kindSet = kinds?.length ? new Set<string>(kinds) : null;

      const ranked = [...scores.values()]
        .filter(({ note }) => {
          const k = labelOf(note, "noteType");
          if (!k) return false; // structural / untyped notes are not memories
          if (kindSet && !kindSet.has(k)) return false;
          if (domSlug && labelOf(note, "domain") !== domSlug) return false;
          return true;
        })
        .sort((a, b2) => b2.score - a.score || (a.note.dateModified < b2.note.dateModified ? 1 : -1))
        .slice(0, max);

      const results = await Promise.all(
        ranked.map(async ({ note }, i) => {
          const base = {
            id: note.noteId,
            title: note.title,
            kind: labelOf(note, "noteType"),
            status: labelOf(note, "status"),
            updated: note.dateModified.slice(0, 10),
            ...(hasLabel(note, "archived") ? { archived: true } : {}),
          };
          if (i < 3) {
            const content = await trilium.getNoteContent(note.noteId).catch(() => "");
            return { ...base, snippet: toText(content, 280) };
          }
          return base;
        })
      );

      return txt({
        results,
        ...(results.length === 0 ? { note: "No matches. Content may not be stored yet — remember() it if the user provides it." } : {}),
      });
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

      const groups: Record<string, Array<{ id: string; title: string; status?: string; created: string; modified: string; archived?: true }>> = {};
      for (const n of all) {
        const kind = ownedLabel(n, "noteType");
        if (!kind || kind === "blueprint" || kind === "domain") continue;
        if (!groups[kind]) groups[kind] = [];
        groups[kind].push({
          id: n.noteId,
          title: n.title,
          status: labelOf(n, "status") ?? undefined,
          created: labelOf(n, "created") ?? n.dateCreated.slice(0, 10),
          modified: n.dateModified.slice(0, 10),
          ...(hasLabel(n, "archived") ? { archived: true as const } : {}),
        });
      }

      const total = all.filter((n) => {
        const k = ownedLabel(n, "noteType");
        return k && k !== "blueprint" && k !== "domain";
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
(mode=replace), or edit a heading section in place (pass section — targets h2/h3/h4 in that
order; appends as h2 if not found). A revision snapshot is always taken first. Also logs thread progress.`,
    {
      noteId: z.string().describe("Note to update"),
      body: z.string().optional().describe("Content to add/replace: plain text, markdown, or HTML"),
      title: z.string().optional().describe("New title (normalized server-side)"),
      section: z.string().optional().describe("Target an <h2> section (e.g. a blueprint section); omit for whole-note append/replace"),
      mode: z.enum(["append", "replace"]).optional().describe("append (default) | replace"),
      date: z.string().optional().describe("ISO date (default: today)"),
    },
    async ({ noteId, body, title, section, mode, date }) => {
      if (isContainer(b(), noteId)) throw new Error("Refusing to edit a container or blueprint note");
      const d = date ?? today();
      const note = await trilium.getNote(noteId);
      await trilium.createRevision(noteId).catch(() => null);

      if (body) {
        const html = toHtml(body);
        const current = await trilium.getNoteContent(noteId).catch(() => "");
        if (section) {
          await trilium.updateNoteContent(noteId, setSection(current, section, html, mode === "append" ? "append" : "replace"));
        } else if (mode === "replace") {
          await trilium.updateNoteContent(noteId, html);
        } else {
          await trilium.updateNoteContent(noteId, insertBeforeResolution(current, `<h2>Addendum — ${d}</h2>\n${html}`));
        }
      }
      if (title) {
        const { title: cleanTitle } = normalizeTitle(title);
        if (cleanTitle && cleanTitle !== note.title) await trilium.patchNote(noteId, { title: cleanTitle });
      }
      await trilium.updateLabelValue(noteId, "updated", d);
      if (labelOf(note, "status") === "dormant") await trilium.updateLabelValue(noteId, "status", "active");

      return txt({ ok: true, noteId, mode: body ? (section ? `section:${section}` : (mode ?? "append")) : "metadata-only", date: d });
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
      if (isStructural(b(), noteId)) throw new Error("Refusing to resolve a structural note");
      const d = date ?? today();
      const terminal = status ?? "resolved";
      const note = await trilium.getNote(noteId);

      await trilium.createRevision(noteId).catch(() => null);
      const current = await trilium.getNoteContent(noteId).catch(() => "");
      await trilium.updateNoteContent(noteId, applyResolution(current, toHtml(outcome), d));
      await trilium.updateLabelValue(noteId, "status", terminal);
      await trilium.updateLabelValue(noteId, "closed", d);
      await ensureArchivedFlag(trilium, note);

      const followUps: string[] = [];
      if (supersededBy) {
        await trilium.addRelation(supersededBy, "supersedes", noteId).catch(() => null);
        followUps.push(`superseded by ${supersededBy}`);
      }

      return txt({
        ok: true,
        noteId,
        kind: (labelOf(note, "noteType") as AnyKind | undefined) ?? "note",
        status: terminal,
        archivedInPlace: true,
        ...(followUps.length ? { followUps } : {}),
      });
    }
  );

  server.tool(
    "reopen",
    `Reopen an archived or resolved thread: removes the #archived flag, resets status to
active, clears the closed date, and appends a dated "Reopened" addendum. Use when a resolved
or dormant thread resurfaces as live work.`,
    {
      noteId: z.string().describe("The archived/resolved thread to reopen"),
      reason: z.string().optional().describe("Why it was reopened — written as an addendum"),
      date: z.string().optional().describe("ISO date (default: today)"),
    },
    async ({ noteId, reason, date }) => {
      if (isStructural(b(), noteId)) throw new Error("Refusing to reopen a structural note");
      const d = date ?? today();
      const note = await trilium.getNote(noteId);

      const archivedAttr = note.attributes.find((a) => a.type === "label" && a.name === "archived");
      if (archivedAttr) await trilium.deleteAttribute(archivedAttr.attributeId).catch(() => null);

      const closedAttr = note.attributes.find((a) => a.type === "label" && a.name === "closed");
      if (closedAttr) await trilium.deleteAttribute(closedAttr.attributeId).catch(() => null);

      await trilium.updateLabelValue(noteId, "status", "active");

      await trilium.createRevision(noteId).catch(() => null);
      const current = await trilium.getNoteContent(noteId).catch(() => "");
      const addendum = reason
        ? `<h2>Reopened — ${d}</h2>\n${toHtml(reason)}`
        : `<h2>Reopened — ${d}</h2>\n<p><em>Thread re-activated.</em></p>`;
      await trilium.updateNoteContent(noteId, `${current}\n${addendum}`);
      await trilium.updateLabelValue(noteId, "updated", d);

      return txt({
        ok: true,
        noteId,
        kind: (labelOf(note, "noteType") as AnyKind | undefined) ?? "note",
        status: "active",
        reopened: d,
      });
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
  mode=neighborhood  everything within N hops (depth, optional relation filter)
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
          const path = await trilium.findNeuralPath(noteId, toNoteId, depth ?? 6);
          return txt(path ? { mode, found: true, hops: path.length - 1, path } : { mode, found: false });
        }
      }
    }
  );

  // ════════════════════════════════════════════════════════════════════════════
  // LIFECYCLE / SYSTEM
  // ════════════════════════════════════════════════════════════════════════════

  server.tool(
    "absorb",
    `Scan singleton notes (biography, goals, preferences, responsibilities, protocols) for
accumulated addendums — blocks appended by revise() default mode — and return them
structured so you can merge each one back into the right section via
revise(noteId, section=<heading>, body=<merged>, mode=replace).
Pass noteId to scan a specific note; omit to scan all five singletons. Read-only — does not modify anything.`,
    {
      noteId: z.string().optional().describe("Specific note to scan; omit to scan all five singletons"),
    },
    async ({ noteId }) => {
      const cfg = b();

      const targets: Array<[string, string]> = [];
      if (noteId) {
        const note = await trilium.getNote(noteId);
        targets.push([noteId, labelOf(note, "noteType") ?? "unknown"]);
      } else {
        const singletons: Array<[string, string]> = [
          [cfg.master.biography,    "biography"],
          [cfg.master.goals,        "goals"],
          [cfg.master.preferences,  "preferences"],
          [cfg.llm.responsibilities,"responsibilities"],
          [cfg.llm.protocols,       "protocols"],
        ];
        for (const [id, kind] of singletons) {
          if (id) targets.push([id, kind]);
        }
      }

      const rows = await Promise.all(targets.map(async ([id, kind]) => {
        const note = await trilium.getNote(id).catch(() => null);
        if (!note) return null;
        const content = await trilium.getNoteContent(id).catch(() => "");
        const { sectionHeadings, addendums } = parseAddendums(content);
        if (!addendums.length) return null;
        return {
          id,
          title: note.title,
          kind,
          sectionHeadings,
          addendums: addendums.map((a) => ({ date: a.date, snippet: toText(a.content, 300), content: a.content })),
        };
      }));

      const found = rows.filter(Boolean);
      return txt({
        scanned: targets.length,
        withAddendums: found.length,
        notes: found,
        ...(found.length === 0
          ? { note: "All clean — no pending addendums." }
          : { hint: "Call revise(noteId, section='<heading>', body='<merged>', mode='replace') to absorb each addendum." }),
      });
    }
  );

  server.tool(
    "maintain",
    `Run the maintenance sweep. start and close run the lite sweep automatically (ages stale
threads active → dormant → archived). deep=true also surfaces stale notes (untouched past the
policy window) and unconnected knowledge notes to wire with connect(). dryRun previews only.`,
    {
      deep: z.boolean().optional().describe("Deep pass: stale-review + orphan report (default: false)"),
      dryRun: z.boolean().optional().describe("Report what would change without changing it"),
    },
    async ({ deep, dryRun }) => {
      const report = await sweep(trilium, b(), { deep: deep ?? false, dryRun: dryRun ?? false });
      return txt(report);
    }
  );

  server.tool(
    "forget",
    `Archive a note (default) or hard-delete it (hard=true). Archiving keeps it in place,
hidden from default recall — the safe choice and the only one for anything with history.
Hard delete is refused while other notes still link here (backlinks are returned so you can
re-wire with connect() first).`,
    {
      noteId: z.string().describe("Note to forget"),
      reason: z.string().optional().describe("Why — recorded in the note before archiving"),
      hard: z.boolean().optional().describe("Permanently delete instead of archive"),
    },
    async ({ noteId, reason, hard }) => {
      if (isStructural(b(), noteId)) throw new Error("Refusing to forget a structural note");
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
        await trilium.updateNoteContent(noteId, `${current}\n<p><em>Archived ${today()}: ${escapeHtml(reason)}</em></p>`);
      }
      await trilium.updateLabelValue(noteId, "closed", today());
      await ensureArchivedFlag(trilium, note);
      return txt({ ok: true, archived: noteId, title: note.title });
    }
  );

  server.tool(
    "brain",
    `Surface the entire BrainLLM content tree — every typed note across all five content areas
(Master, LLM, Memory, Knowledge, Insights), grouped by area and sub-container, with
id/title/kind/status/dates. Use to audit what the brain contains or locate a specific note.
Structural containers and blueprints are excluded; only content notes appear.`,
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
          .then((r) => r.results.filter((n) => ownedLabel(n, "noteType") !== "blueprint"))
          .catch(() => []);
      };

      const row = (n: Note) => ({
        id: n.noteId,
        title: n.title,
        kind: labelOf(n, "noteType"),
        status: labelOf(n, "status") ?? undefined,
        created: labelOf(n, "created") ?? n.dateCreated.slice(0, 10),
        modified: n.dateModified.slice(0, 10),
        ...(hasLabel(n, "archived") ? { archived: true } : {}),
      });

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
if the structure already exists). Creates the six areas — Master (Biography/Goals/Preferences),
LLM (Responsibilities/Protocols/Diary), Memory (Sessions/Threads), Knowledge (Master/Domains),
Insights (Logs), Templates — each engraved with its purpose, and writes brainllm.json. Active
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
        } catch {
          // Stale root ID — fall through to fresh init.
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
  registerTemplatesTools(server, trilium, brainRef);

  // ── Full-mode raw surface (opt-in) ───────────────────────────────────────────
  if (mode === "full") {
    registerAdvancedTools(server, trilium);
  }
}
