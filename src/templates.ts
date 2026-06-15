// ─────────────────────────────────────────────────────────────────────────────
// BrainLLM — structured note content generators (V5, minimal)
//
// Structure-phase scope: enough to seed the tree and produce well-formed notes.
// The rich per-kind blueprint protocols (structure, format, lifecycle and
// maintenance) are authored in the templates phase and wired via ~template.
// ─────────────────────────────────────────────────────────────────────────────

import { escapeHtml } from "./normalize.js";
import type { AnyKind } from "./types.js";

export const RESOLUTION_ANCHOR = "<h2>Resolution</h2>";
export const OPEN_RESOLUTION = `${RESOLUTION_ANCHOR}\n<p><em>— open —</em></p>`;

function metaLine(parts: Array<string | undefined>): string {
  const cleaned = parts.filter((p): p is string => !!p && p.trim().length > 0);
  return `<p><em>${cleaned.map(escapeHtml).join(" · ")}</em></p>\n<hr>`;
}

export interface TemplateOpts {
  date: string;     // ISO YYYY-MM-DD
  body: string;     // normalized HTML body (may be empty)
  domain?: string;  // display name for domain-scoped notes
}

// Threads are the one kind that still resolves in V5, so they carry the anchor.
const RESOLVABLE = new Set<AnyKind>(["thread"]);

// Singleton kinds whose enforced structure (a section skeleton) is seeded at
// bootstrap and maintained in place.
export const STRUCTURED_SINGLETONS = new Set<AnyKind>([
  "biography", "goals", "preferences", "responsibilities", "protocols",
]);

/** The enforced structure for a note of a kind — the contract its blueprint's
 *  Example documents. The model supplies content; this owns the shape. Kinds
 *  without a bespoke structure fall back to a meta line + body (+ Resolution
 *  anchor when resolvable). */
export function contentFor(kind: AnyKind, o: TemplateOpts): string {
  switch (kind) {
    case "thread":
      return [
        metaLine(["thread", `opened ${o.date}`]),
        "<h2>Context</h2>", o.body || "<p></p>",
        "<h2>Log</h2>", `<h3>${escapeHtml(o.date)}</h3>\n<p>Thread opened.</p>`,
        OPEN_RESOLUTION,
      ].join("\n");
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
        "<p><em>❇️ discovered &amp; credible · ✅ used in this domain's information.</em></p>",
        o.body || "<ul></ul>",
      ].join("\n");
    case "log":
      return [
        metaLine(["log", o.date]),
        "<h2>Created</h2>\n<p></p>", "<h2>Updated</h2>\n<p></p>", "<h2>Deleted</h2>\n<p></p>",
      ].join("\n");
    default: {
      const parts = [metaLine([kind, o.domain ? `domain: ${o.domain}` : undefined, o.date]), o.body || "<p></p>"];
      if (RESOLVABLE.has(kind)) parts.push(OPEN_RESOLUTION);
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
