// ─────────────────────────────────────────────────────────────────────────────
// BrainLLM — blueprint protocol notes (Templates area)
//
// Each blueprint documents a note type's Structure, Format, Lifecycle,
// Maintenance, and a worked Example. Structure + format are ENFORCED by the core
// tools (contentFor); lifecycle + maintenance are guidance. The Example is
// generated from contentFor, so the documented shape always matches what the
// tools produce.
// ─────────────────────────────────────────────────────────────────────────────

import type { AnyKind, Area } from "./types.js";
import { contentFor } from "./templates.js";

export interface Blueprint {
  kind: AnyKind;
  area: Area;
  title: string;
}

export const BLUEPRINTS: Blueprint[] = [
  // Master
  { kind: "biography", area: "master", title: "Biography" },
  { kind: "goals", area: "master", title: "Goals" },
  { kind: "preferences", area: "master", title: "Preferences" },
  // LLM
  { kind: "responsibilities", area: "llm", title: "Responsibilities" },
  { kind: "protocols", area: "llm", title: "Protocols" },
  { kind: "diary", area: "llm", title: "Diary" },
  // Memory
  { kind: "session", area: "memory", title: "Session" },
  { kind: "thread", area: "memory", title: "Thread" },
  // Knowledge
  { kind: "knowledge", area: "knowledge", title: "Knowledge" },
  { kind: "domain", area: "knowledge", title: "Domain" },
  { kind: "information", area: "knowledge", title: "Information" },
  { kind: "sources", area: "knowledge", title: "Sources" },
  // Insights
  { kind: "log", area: "insights", title: "Log" },
];

// ── Builders ────────────────────────────────────────────────────────────────

function header(kind: string, area: string): string {
  return `<p><em>Blueprint · ${kind} · ${area}</em></p>\n<hr>`;
}

function blueprint(
  kind: string,
  area: string,
  parts: { structure: string; format: string; lifecycle: string; maintenance: string; example: string }
): string {
  return [
    header(kind, area),
    "<h2>Structure</h2>", parts.structure,
    "<h2>Format</h2>", parts.format,
    "<h2>Lifecycle</h2>", parts.lifecycle,
    "<h2>Maintenance</h2>", parts.maintenance,
    "<h2>Example</h2>", parts.example,
  ].join("\n");
}

export function blueprintContent(kind: AnyKind): string {
  const b = BUILDERS[kind];
  return b ? b() : `${header(String(kind), "—")}\n<p><em>Blueprint to be authored.</em></p>`;
}

const BUILDERS: Partial<Record<AnyKind, () => string>> = {
  // ── Master ────────────────────────────────────────────────────────────────
  biography: () => blueprint("biography", "Master", {
    structure: "<p>Three maintained sections:</p><ul><li><strong>Overview</strong> — a tight, current who-they-are paragraph.</li><li><strong>Background</strong> — history and trajectory.</li><li><strong>Present</strong> — current roles, situation, and what they're doing now.</li></ul><p>Goals and preferences live in their own Master notes; biographical facts that fit none of these go to Knowledge/Master.</p>",
    format: "<p>Prose under each heading. Current-state, not a changelog — a living profile, not a diary.</p>",
    lifecycle: "<p>A single note, seeded with its section skeleton at bootstrap. <strong>Maintained</strong> continuously via <code>revise()</code>; never resolved or archived — it lives for the brain's lifetime.</p>",
    maintenance: "<p>Replace stale facts rather than appending contradictions — keep one coherent current truth. Revisions preserve history, so prune freely. If a fact is really a goal or a preference, route it there instead.</p>",
    example: contentFor("biography", { date: "", body: "<p>Kevin \"Miiso\" Novo — founder &amp; CEO and full-stack engineer; primary venture myClerkBook.</p>" }),
  }),
  goals: () => blueprint("goals", "Master", {
    structure: "<p>Two horizons:</p><ul><li><strong>Near-term</strong> — goals being actively pursued now.</li><li><strong>Long-term</strong> — longer-range aims.</li></ul>",
    format: "<p>Bullets or short prose per horizon. State the goal plainly; no status decoration.</p>",
    lifecycle: "<p>A single note, seeded at bootstrap. Maintained via <code>revise()</code> as goals shift; never resolved.</p>",
    maintenance: "<p>Promote goals from Long-term to Near-term as they come into focus; retire achieved or abandoned goals rather than accumulating dead ones. Responsibilities derive from this — keep it honest.</p>",
    example: contentFor("goals", { date: "", body: "<p>Ship myClerkBook to its first paying users.</p>" }),
  }),
  preferences: () => blueprint("preferences", "Master", {
    structure: "<p>Three sections:</p><ul><li><strong>Communication</strong> — how they like to be communicated with.</li><li><strong>Working style</strong> — how they like to work.</li><li><strong>Tools and stack</strong> — tooling and technology preferences.</li></ul>",
    format: "<p>Bullets per section. Durable preferences only — a one-off choice is not a preference.</p>",
    lifecycle: "<p>A single note, seeded at bootstrap. Maintained via <code>revise()</code>; never resolved.</p>",
    maintenance: "<p>Replace superseded preferences; keep each section tight. If something is really a goal or biographical fact, route it there.</p>",
    example: contentFor("preferences", { date: "", body: "<p>Direct and concise — no preamble, lead with the answer.</p>" }),
  }),
  // ── LLM ───────────────────────────────────────────────────────────────────
  responsibilities: () => blueprint("responsibilities", "LLM", {
    structure: "<p>Two sections:</p><ul><li><strong>Core</strong> — standing duties to the master/user.</li><li><strong>Current priorities</strong> — duties tied to the active goals.</li></ul>",
    format: "<p>Bullets. Each responsibility should be traceable to a goal or preference.</p>",
    lifecycle: "<p>A single note, seeded at bootstrap. Re-derived as Master's goals and preferences change (via <code>revise()</code>); never resolved.</p>",
    maintenance: "<p>When goals shift, update Current priorities; keep Core stable. Don't let it drift from the user's actual goals — this note is the contract.</p>",
    example: contentFor("responsibilities", { date: "", body: "<p>Protect the master's time — surface only what needs a decision, with a recommendation.</p>" }),
  }),
  protocols: () => blueprint("protocols", "LLM", {
    structure: "<p>Two sections:</p><ul><li><strong>Operating</strong> — how the assistant works.</li><li><strong>Self-correction</strong> — how it catches and fixes its own mistakes.</li></ul>",
    format: "<p>Imperative, actionable protocols as a list. Each one earns its place.</p>",
    lifecycle: "<p>A single note, seeded at bootstrap. Maintained via <code>revise()</code> as protocols are learned or refined; never resolved.</p>",
    maintenance: "<p>Add a protocol when a recurring mistake or a better way is found; prune obsolete ones. Keep them concrete, not aspirational.</p>",
    example: contentFor("protocols", { date: "", body: "<p>Verify against source before asserting — never answer from memory alone on a fact that can be checked.</p>" }),
  }),
  diary: () => blueprint("diary", "LLM", {
    structure: "<p>Intentionally free-form — a single dated entry, no imposed sections. Raw and unfiltered.</p>",
    format: "<p>First-person prose. Written honestly; for the assistant and the master both.</p>",
    lifecycle: "<p>One note per day. Created when there's something worth recording. Kept as a record — not resolved or aged.</p>",
    maintenance: "<p>None enforced. It's a record, not a maintained document — don't sanitise or rewrite it.</p>",
    example: contentFor("diary", { date: "2026-01-15", body: "<p>Spent the day overhauling the brain's structure with Miiso. Caught a real ETAPI landmine by reading the source rather than trusting the spec — satisfying.</p>" }),
  }),
  // ── Memory ────────────────────────────────────────────────────────────────
  session: () => blueprint("session", "Memory", {
    structure: "<p>Two sections, built by <code>close</code>:</p><ul><li><strong>Summary</strong> — what happened this session.</li><li><strong>Learned</strong> — durable takeaways.</li></ul>",
    format: "<p>Summary is prose; Learned is a bullet list. One note per day; same-day calls append a timestamped addendum.</p>",
    lifecycle: "<p>Created by <code>close</code> at session close; idempotent per date. Not individually resolved.</p>",
    maintenance: "<p>Don't hand-edit — <code>close</code> owns it. Durable learnings should also be <code>remember()</code>-ed as knowledge.</p>",
    example: contentFor("session", { date: "2026-01-15", body: "<h2>Summary</h2>\n<p>Designed the V5 template system and authored the blueprint set.</p>\n<h2>Learned</h2>\n<ul><li>Trilium ETAPI's validateAndPatch only validates keys present in the request body.</li></ul>" }),
  }),
  thread: () => blueprint("thread", "Memory", {
    structure: "<p>Three sections, in order:</p><ul><li><strong>Context</strong> — why this work exists and its current scope.</li><li><strong>Log</strong> — dated progress entries (an <code>h3</code> date + what changed), newest appended.</li><li><strong>Resolution</strong> — the outcome, written on close; reads <em>— open —</em> until then.</li></ul>",
    format: "<p>Context is prose. Each Log entry is an <code>h3</code> date heading followed by substantive progress. Exactly one Resolution section, always last.</p>",
    lifecycle: "<p>Created <strong>active</strong> when work will span sessions. <code>revise()</code> appends Log entries and reactivates it if dormant. <code>resolve()</code> writes the Resolution and archives it in place. Untouched it goes <strong>dormant</strong>, then <strong>archived</strong> — degraded, never deleted.</p>",
    maintenance: "<p>Keep Context current as scope shifts. The Log is for real progress, not noise. Resolve honestly when work concludes <em>or is abandoned</em> — \"overtaken by events\" is a valid outcome.</p>",
    example: contentFor("thread", { date: "2026-01-15", body: "<p>Migrating myClerkBook's data layer from Firebase to Supabase — tracking the cutover across sessions.</p>" }),
  }),
  // ── Knowledge ─────────────────────────────────────────────────────────────
  knowledge: () => blueprint("knowledge", "Knowledge", {
    structure: "<p>A titled note capturing one discrete piece of knowledge about the master/user that doesn't fit Biography / Goals / Preferences. Free-form prose body.</p>",
    format: "<p>Title names the subject; body is prose. Wire related notes with relations rather than duplicating.</p>",
    lifecycle: "<p>Created when such a fact surfaces; maintained via <code>revise()</code>; not aged.</p>",
    maintenance: "<p>Keep current. If it turns out to be biographical, a goal, or a preference, route it to the primary Master area instead.</p>",
    example: contentFor("knowledge", { date: "2026-01-15", body: "<p>Thabani — past client; their project was delivered and paid in full.</p>" }),
  }),
  domain: () => blueprint("domain", "Knowledge", {
    structure: "<p>A domain book — a container holding one <strong>Sources</strong> note and the sub-category <strong>information</strong> notes for that domain. Its own content is a one-line domain descriptor.</p>",
    format: "<p>Auto-created on first use, named for the domain (slugged in <code>#domain</code>).</p>",
    lifecycle: "<p>Created on demand when knowledge for a new domain is stored; persists.</p>",
    maintenance: "<p>Keep sub-categories coherent; fold or split information notes as the domain grows.</p>",
    example: contentFor("domain", { date: "", domain: "Technology", body: "" }),
  }),
  information: () => blueprint("information", "Knowledge", {
    structure: "<p>A sub-category note (titled by sub-category) holding learned information for a domain — beyond or conflicting with training data. Prose body.</p>",
    format: "<p>Title = sub-category; body is prose; cite the domain's Sources entries (❇️/✅).</p>",
    lifecycle: "<p>Created and maintained as knowledge accrues; deduped <em>within its domain</em>; not aged.</p>",
    maintenance: "<p>Keep current and sourced; split overlong notes into sub-categories; remove what's superseded.</p>",
    example: contentFor("information", { date: "2026-01-15", domain: "Technology", body: "<p>TriliumNext ETAPI marks <code>attributeId</code> mandatory on create, but <code>validateAndPatch</code> only validates keys present in the body — so omitting it still works.</p>" }),
  }),
  sources: () => blueprint("sources", "Knowledge", {
    structure: "<p>The domain's single Sources registry — a list of credible sources, each marked ❇️ (discovered &amp; credible) or ✅ (used in this domain's information).</p>",
    format: "<p>One source per bullet, prefixed with its marker and a link or citation.</p>",
    lifecycle: "<p>One per domain, seeded when the domain is created; appended as sources are found; not aged.</p>",
    maintenance: "<p>Promote ❇️ → ✅ when a source is actually used; remove dead or discredited sources; keep it deduped.</p>",
    example: contentFor("sources", { date: "", domain: "Technology", body: "<ul><li>✅ TriliumNext source — apps/server/src/etapi/attributes.ts</li><li>❇️ Trilium ETAPI OpenAPI spec</li></ul>" }),
  }),
  // ── Insights ──────────────────────────────────────────────────────────────
  log: () => blueprint("log", "Insights", {
    structure: "<p>Three sections — <strong>Created</strong>, <strong>Updated</strong>, <strong>Deleted</strong> — listing the brain content that changed that day.</p>",
    format: "<p>Each section a list of notes (title + id). Auto-generated; not hand-written.</p>",
    lifecycle: "<p>One note per day, generated automatically (target 22:00) from Trilium's change history; not aged.</p>",
    maintenance: "<p>None — derived data, regenerated rather than edited.</p>",
    example: contentFor("log", { date: "2026-01-15", body: "" }),
  }),
};
