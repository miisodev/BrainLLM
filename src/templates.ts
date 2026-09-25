// ─────────────────────────────────────────────────────────────────────────────
// BrainLLM — structured note content generators (V10)
//
// The enforced content skeleton per kind, plus the canonical structure rules
// served by the template tool. The model supplies content; this owns shape.
// Headings are h2–h4 only (h1 is the Trilium note title; h5/h6 are demoted
// by sanitizeHtml).
// ─────────────────────────────────────────────────────────────────────────────

import { escapeHtml } from "./normalize.js";
import type { AnyKind } from "./types.js";

export const RESOLUTION_ANCHOR = "<h2>Resolution</h2>";
const OPEN_RESOLUTION = `${RESOLUTION_ANCHOR}\n<p><em>— open —</em></p>`;

/** True when a body carries EXACTLY one Resolution and it is still the empty
 *  "— open —" placeholder that contentFor() itself writes.
 *
 *  The guard on thread writes used to refuse any body containing a Resolution
 *  heading at all — which meant remember() wrote a structure that revise()
 *  then refused to accept back, and template("thread") documented a skeleton
 *  neither path agreed on. A thread created through remember() carried the
 *  placeholder; a thread repaired through revise() could not be given one, so
 *  the two diverged structurally. Restoring parity needed full-mode surgery.
 *
 *  The guard's real intent is to stop a SECOND Resolution being smuggled in,
 *  or a FILLED one being written where resolve() should own the outcome. An
 *  idempotent empty placeholder is structure, not content, so it is allowed. */
export function isOpenResolutionOnly(html: string): boolean {
  const headings = html.match(/<h[2-4](?:\s[^>]*)?>\s*Resolution\s*<\/h[2-4]>/gi) ?? [];
  if (headings.length !== 1) return false;
  const idx = html.search(/<h[2-4](?:\s[^>]*)?>\s*Resolution\s*<\/h[2-4]>/i);
  const after = html
    .slice(idx)
    .replace(/<h[2-4](?:\s[^>]*)?>\s*Resolution\s*<\/h[2-4]>/i, "")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/gi, " ")
    .trim();
  return after === "" || after === "— open —" || after === "- open -";
}

function metaLine(parts: Array<string | undefined>): string {
  const cleaned = parts.filter((p): p is string => !!p && p.trim().length > 0);
  // Explicit arrow, not a point-free `.map(escapeHtml)`: escapeHtml now takes a
  // second parameter, and map would hand it the array index — escaping the
  // first part one way and every other part the other.
  return `<p><em>${cleaned.map((p) => escapeHtml(p)).join(" · ")}</em></p>\n<hr>`;
}

export interface TemplateOpts {
  date: string;     // ISO YYYY-MM-DD
  body: string;     // normalized HTML body (may be empty)
  domain?: string;  // display name for domain-scoped notes
  goal?: string;    // thread: the goal statement (queried from the user at creation)
}

// Singleton kinds whose enforced structure (a section skeleton) is seeded at
// bootstrap and maintained in place.
export const STRUCTURED_SINGLETONS = new Set<AnyKind>([
  "biography", "goals", "preferences", "responsibilities", "protocols", "selfcorrection",
]);

const hasHeading = (html: string, text: string) =>
  new RegExp(`<h[2-4](?:\\s[^>]*)?>\\s*${text}\\s*</h[2-4]>`, "i").test(html);

/** The sections a note of each kind MUST carry to be structurally complete.
 *
 *  The structural lint checked well-formedness — duplicate headings, unbalanced
 *  tags — and never completeness, so a thread that had lost its Resolution
 *  section entirely, a Sources note with no Revision table, and an information
 *  note with no header all passed every check the server had. Each of those is
 *  mechanically checkable against the skeleton the server already writes, which
 *  is the point: the shape is server policy, so a note drifting off it is a
 *  server-detectable defect rather than a matter of taste.
 *
 *  Records (diary/session/log/threadEntry) are deliberately absent — they are
 *  append-only and their shape is per-block, not per-note. */
export const REQUIRED_SECTIONS: Partial<Record<AnyKind, readonly string[]>> = {
  thread: ["Context", "Resolution"],
  sources: ["Sources", "Revision"],
  selfcorrection: ["Corrections"],
  claim: ["Check", "Verifications"],
};

/** Which of a kind's required sections are missing from a body. */
export function missingSections(kind: AnyKind, html: string): string[] {
  const required = REQUIRED_SECTIONS[kind];
  if (!required) return [];
  return required.filter((section) => !hasHeading(html, section));
}

/** The enforced structure for a note of a kind. The model supplies content;
 *  this owns the shape. Thread and sources carry the canonical structures
 *  documented in STRUCTURE_RULES; a body that already carries a structural
 *  heading is not double-wrapped (the V8 duplicate-Context bug). */
export function contentFor(kind: AnyKind, o: TemplateOpts): string {
  switch (kind) {
    case "thread": {
      const parts = [metaLine(["thread", `opened ${o.date}`])];
      if (hasHeading(o.body, "Context")) {
        // Body already carries the canonical structure — don't double-wrap.
        parts.push(o.body);
      } else {
        parts.push("<h2>Context</h2>");
        parts.push(`<h3>Goal</h3>\n${o.goal ? `<p>${escapeHtml(o.goal)}</p>` : o.body || "<p>To be determined.</p>"}`);
        if (o.goal && o.body) parts.push(o.body);
      }
      if (!o.body.includes(RESOLUTION_ANCHOR)) parts.push(OPEN_RESOLUTION);
      return parts.join("\n");
    }
    case "biography":
      return ["<h2>Overview</h2>", o.body || "<p></p>", "<h2>Background</h2>\n<p></p>", "<h2>Present</h2>\n<p></p>"].join("\n");
    case "goals":
      return ["<h2>Near-term</h2>", o.body || "<p></p>", "<h2>Long-term</h2>\n<p></p>"].join("\n");
    case "preferences":
      return ["<h2>Communication</h2>", o.body || "<p></p>", "<h2>Working style</h2>\n<p></p>", "<h2>Tools and stack</h2>\n<p></p>"].join("\n");
    case "responsibilities":
      return ["<h2>Core</h2>", o.body || "<p></p>", "<h2>Current priorities</h2>\n<p></p>"].join("\n");
    case "protocols":
      // Self-correction moved to its own singleton in V12; a fresh brain must
      // not create the heading here or the content splits across both notes.
      return ["<h2>Operating</h2>", o.body || "<p></p>"].join("\n");
    case "selfcorrection":
      return ["<h2>Corrections</h2>", o.body || "<p></p>"].join("\n");
    case "domain":
      return domainContent(o.domain ?? "");
    case "sources":
      return [
        metaLine(["sources", o.domain ? `domain: ${o.domain}` : undefined]),
        `<h4>Last updated - ${escapeHtml(o.date)}</h4>`,
        "<h2>Sources</h2>",
        "<p><em>❇️ discovered &amp; credible · ✅ used in this domain's information. Every source (URL, doc, file, …) listed and marked individually with just its emoji; related sources grouped under h3 subheadings.</em></p>",
        o.body || "<p><em>— none yet —</em></p>",
        "<h2>Revision</h2>",
        '<figure class="table"><table><thead><tr><th>Source</th><th>Marker</th><th>Date</th></tr></thead><tbody><tr><td><em>— none yet —</em></td><td></td><td></td></tr></tbody></table></figure>',
      ].join("\n");
    case "diary":
      return [
        metaLine(["diary", o.date]),
        o.body || "<p></p>",
      ].join("\n");
    case "threadEntry":
      return [
        metaLine(["threadEntry", o.date]),
        o.body || "<p></p>",
      ].join("\n");
    case "log":
      return [
        metaLine(["log", o.date]),
        "<h2>Created</h2>\n<p></p>", "<h2>Updated</h2>\n<p></p>", "<h2>Deleted</h2>\n<p></p>",
      ].join("\n");
    default: {
      const parts = [metaLine([kind, o.domain ? `domain: ${o.domain}` : undefined, o.date]), o.body || "<p></p>"];
      return parts.join("\n");
    }
  }
}

export function domainContent(name: string): string {
  return `<p><em>Knowledge domain: <strong>${escapeHtml(name)}</strong> — information notes and a sources note live in this book.</em></p>`;
}

// ── Engraved purpose (written into structural notes at bootstrap) ────────────

export function purposeContent(purpose: string): string {
  return `<p><em>${escapeHtml(purpose)}</em></p>`;
}

// ── Canonical structure rules — served by the template tool ──────────────────

export interface StructureRule {
  /** Top-to-bottom structure description. */
  structure: string[];
  /** Hard rules enforced or expected on writes of this kind. */
  rules: string[];
}

/** The universal content rules every maintained kind is held to. */
const TIMELESS = [
  "Timeless: what is true regardless of date. No state, version, status, incident or decision history — state lives in the domain's Current State note, history and decisions in thread entries and sessions, where the date is native",
  "One sentence is enough if one sentence says it; drop what is rarely relevant to the work",
  "Merged in place (revise section=/find=), never appended as dated addendum blocks",
];

/** The canonical structure per content kind — served by template(); the write
 *  paths enforce what can be enforced server-side. */
export const STRUCTURE_RULES: Partial<Record<AnyKind | "singleton", StructureRule>> = {
  singleton: {
    structure: [
      "`Last updated - <date>` (h4) — server-maintained on every write",
      "Minimal h3 sections; tables for reference data; short bold-lead rules for rule/duty lists",
    ],
    rules: [
      ...TIMELESS,
      "LLM singletons derive from the master ones: responsibilities serve goals and preferences, protocols serve responsibilities, self-correction holds only general rules learned from mistakes",
    ],
  },
  diary: {
    structure: [
      "`Addendum — HH:mm` (h2, server-written)",
      "Identification line (h3): `LLM · environment · agent/mode [· Run N]` — pass identity=",
      "**Experience** (h4), then **BrainLLM** (h4)",
    ],
    rules: [
      "One note per day; every write is a timestamped addendum block",
      "identity= is enforced; the closing entry is written after remarks()",
    ],
  },
  session: {
    structure: [
      "`Addendum — HH:mm` (h2, server-written)",
      "Identification line (h3) — pass identity= on close()",
      "**Summary**, then **Learned**",
    ],
    rules: ["Written by close() only; one note per day; identity= is enforced"],
  },
  thread: {
    structure: [
      "A book note: header (thread · opened <date>) → **Context** (h2) → **Goal** (h3): what the thread is for, in a sentence or two → optional h3 standing constraints → **Resolution** (h2), last, owned by resolve()",
      "Shape **dated** (default): one `[yyyy-mm-dd]` child per active day, made of `Addendum — HH:mm` blocks with an identification line — the thread's history",
      "Shape **collection** (#threadShape=collection, set with remember(shape=\"collection\")): one titled child per item, each a maintained document edited in place — e.g. an ideas list",
    ],
    rules: [
      "Creating a thread requires goal= (ask the user)",
      "The book holds purpose, never progress: no status, dates, decisions or narrative — those are dated children or sessions. One exception: a register thread (e.g. Escalations) keeps its single maintained register table in the book",
      "Dated: appends land in today's child (identity= required). Collection: add with remember(kind=\"threadEntry\", thread=, title=), change with revise(<entry id>)",
      "Only resolve() writes the Resolution",
    ],
  },
  threadEntry: {
    structure: [
      "Dated: header (threadEntry · <date>), then `Addendum — HH:mm` blocks with an identification line",
      "Collection: a titled maintained document — minimal h2/h3 sections",
    ],
    rules: [
      "Dated entries are created by appending to the thread and are records (never rewritten)",
      "Collection entries dedup by title within their thread and are edited in place",
    ],
  },
  sources: {
    structure: [
      "Header (sources · domain) → `Last updated` (h4)",
      "**Sources** (h2): the ❇️/✅ legend, then every source listed individually with its emoji, grouped under h3s",
      "**Revision** (h2): Source | Marker | Date, one row per source",
    ],
    rules: [
      "One per domain, created with the domain; merged via remember(kind=\"sources\"), never stacked",
      "Revision rows upsert by source name via revision=[{source, marker, date}]; the name must match the Sources list exactly",
    ],
  },
  information: {
    structure: [
      "Header (information · domain · date) → `Last updated` line (server-maintained)",
      "Minimal h3 sections",
    ],
    rules: [
      ...TIMELESS,
      "Exception: the note titled **Current State** holds the domain's measured state — latest value only, with the date it was measured",
      "One note per sub-category; no dates or run numbers in titles (≤ 4 words); every claim traces to the Sources note",
    ],
  },
  user: {
    structure: ["Header (user · date) → `Last updated` (h4) → minimal h3 sections, tables for reference data"],
    rules: [...TIMELESS, "Titles ≤ 4 words"],
  },
  log: {
    structure: ["Header (log · date) → **Created** / **Updated** / **Deleted** (h2) lists"],
    rules: ["Generated by close(); regenerated in place"],
  },
  claim: {
    structure: [
      "**Check** (h2) — how to verify, as inert text (command, query, path, URL)",
      "**Verifications** (h2) — one dated HOLDS/BROKEN line per check, with evidence",
    ],
    rules: [
      "Only claim() writes claims; the title is the assertion and the dedup key",
      "BrainLLM never executes the check — the agent runs it and reports back with evidence",
    ],
  },
};

/** Resolve the structure rule for a kind (singletons share one rule). */
export function structureRuleFor(kind: AnyKind): StructureRule | undefined {
  if (STRUCTURED_SINGLETONS.has(kind)) return STRUCTURE_RULES.singleton;
  return STRUCTURE_RULES[kind];
}
