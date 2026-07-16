// ─────────────────────────────────────────────────────────────────────────────
// BrainLLM — structured note content generators (V9)
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

function metaLine(parts: Array<string | undefined>): string {
  const cleaned = parts.filter((p): p is string => !!p && p.trim().length > 0);
  return `<p><em>${cleaned.map(escapeHtml).join(" · ")}</em></p>\n<hr>`;
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
  "biography", "goals", "preferences", "responsibilities", "protocols",
]);

const hasHeading = (html: string, text: string) =>
  new RegExp(`<h[2-4](?:\\s[^>]*)?>\\s*${text}\\s*</h[2-4]>`, "i").test(html);

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
      return ["<h2>Operating</h2>", o.body || "<p></p>", "<h2>Self-correction</h2>\n<p></p>"].join("\n");
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

/** The canonical structure per content kind — the single machine-readable
 *  home of the conventions previously maintained by hand. The template tool
 *  serves these; the write paths enforce what can be enforced server-side. */
export const STRUCTURE_RULES: Partial<Record<AnyKind | "singleton", StructureRule>> = {
  singleton: {
    structure: [
      "`Last updated - <date>` (h4) — server-maintained on every write",
      "Minimal h3 sections; tables for reference data; numbered bold-lead paragraphs for rule/duty lists",
    ],
    rules: [
      "Timeless: no dated incidents, no month-specific references — current-state only, merged in place",
      "Replace sections (revise section=/find=), never append dated addendum markers",
    ],
  },
  diary: {
    structure: [
      "`Addendum — HH:mm` (h2, server-written)",
      "Identification line (h3): `LLM · environment · agent/mode [· Run N]` — pass identity= and the server injects it",
      "**Experience** (h4) — unfiltered first-person remarks",
      "**BrainLLM** (h4) — remarks on BrainLLM itself (bugs, friction, roadmap)",
    ],
    rules: [
      "One note per day, every write lands as a timestamped addendum block",
      "The identification line is ENFORCED: pass identity= (or lead the body with the h3) — diary() refuses otherwise",
      "The closing entry is written at the close-protocol step, after remarks()",
    ],
  },
  session: {
    structure: [
      "`Addendum — HH:mm` (h2, server-written)",
      "Identification line (h3): same format as diary — pass identity= on close()",
      "**Summary** (h4-equivalent, server-rendered) — factual prose",
      "**Learned** — durable bullets [+ further detail sections as warranted]",
    ],
    rules: [
      "Written by close() only; one note per day; chronological record",
      "The identification line is ENFORCED: pass identity= on close() (or lead the summary with the h3) — close() refuses otherwise",
    ],
  },
  thread: {
    structure: [
      "Server header (thread · opened <date>)",
      "**Context** (h2) → **Goal** (h3) — the goal statement, queried from the user at creation (goal= is required)",
      "Further h3 context subsections as needed",
      "`Addendum — YYYY-MM-DD` blocks (h2), each with an identification line (h3) + h4 sections",
      "**Resolution** (h2) — exactly one, always the bottom section, owned by resolve()",
    ],
    rules: [
      "remember(kind=thread) requires goal= (or a body already carrying the Context structure)",
      "Thread appends require the identification line: pass identity= on remember()/revise() (or lead the body with the h3) — the write is refused otherwise",
      "Bodies must not carry their own Resolution heading — resolve() owns it",
      "At the close protocol: unthreaded forward/unfinished work prompts the user for thread creation",
    ],
  },
  sources: {
    structure: [
      "Server header (sources · domain: <name>)",
      "`Last updated - <date>` (h4) — server-maintained",
      "**Sources** (h2): the ❇️/✅ legend line, then the full source list — every source (URL, doc, file, …) listed and marked individually with just its emoji; related sources grouped under h3 subheadings",
      "**Revision** (h2): a Source | Marker | Date table recording current markers' dates",
    ],
    rules: [
      "One maintained Sources note per domain — auto-created with the domain book",
      "A clean maintained document: writes merge into the Sources section, never dated addendum stacks",
      "Marker dates live in the Revision table, not inline in the list",
    ],
  },
  information: {
    structure: [
      "Server header (information · domain · date)",
      "`Last updated: <date>` line — server-maintained once present",
      "Minimal h3 sections — current-state truth, revised in place",
    ],
    rules: [
      "One consolidated note per sub-category — never one note per day/run; no dates or run numbers in titles",
      "Every claim traces to a Sources-note entry (the sources gate)",
    ],
  },
  user: {
    structure: [
      "Server header (user · date)",
      "`Last updated - <date>` (h4) — server-maintained once present",
      "Minimal h3 sections, tables for reference/comparative data",
    ],
    rules: ["Current-state, merged in place; titles ≤ 4 words"],
  },
  log: {
    structure: ["Server header (log · date)", "**Created** / **Updated** / **Deleted** (h2) lists"],
    rules: ["Auto-generated by close(); regenerated in place, never stacked"],
  },
};

/** Resolve the structure rule for a kind (singletons share one rule). */
export function structureRuleFor(kind: AnyKind): StructureRule | undefined {
  if (STRUCTURED_SINGLETONS.has(kind)) return STRUCTURE_RULES.singleton;
  return STRUCTURE_RULES[kind];
}
