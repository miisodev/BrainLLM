/**
 * elements.ts — locate the element that contains a short anchor in stored HTML,
 * so an edit can name a table row (or list item, paragraph, cell) by a few
 * words inside it instead of by its full stored markup. Pure: no I/O.
 */

/** Element tags revise(within=) can act on. */
export const WITHIN_TAGS = ["tr", "td", "th", "li", "p", "blockquote", "figure", "table", "ul", "ol"] as const;
export type WithinTag = (typeof WITHIN_TAGS)[number];

export interface ElementSpan {
  start: number;
  end: number;
}

/** Every [start, end) span of a `tag` element in `html`, nesting-aware. */
export function elementSpans(html: string, tag: string): ElementSpan[] {
  const rx = new RegExp(`<(/?)${tag}(?=[\\s>/])[^>]*>`, "gi");
  const spans: ElementSpan[] = [];
  const open: number[] = [];
  let m: RegExpExecArray | null;
  while ((m = rx.exec(html)) !== null) {
    if (m[1] === "/") {
      const start = open.pop();
      if (start !== undefined) spans.push({ start, end: m.index + m[0].length });
    } else if (!m[0].endsWith("/>")) {
      open.push(m.index);
    }
  }
  return spans.sort((a, b) => a.start - b.start);
}

/** The innermost `tag` element that wholly contains [from, to), or null. */
export function containingElement(html: string, tag: string, from: number, to: number): ElementSpan | null {
  let best: ElementSpan | null = null;
  for (const s of elementSpans(html, tag)) {
    if (s.start <= from && s.end >= to && (!best || s.end - s.start < best.end - best.start)) best = s;
  }
  return best;
}

export type WithinResult =
  | { ok: true; html: string; element: string; matches: number }
  | { ok: false; reason: "no_match" | "no_element" | "ambiguous"; matches: number; elements?: string[] };

/** Find `anchor` (exact, or through markup via the tag-stripped text the
 *  caller's matcher supplies as spans), take the `tag` element containing it,
 *  and replace it with `body`, insert `body` before or after it, or remove it.
 *  Distinct elements containing the anchor must be exactly one unless `nth`
 *  picks one, so a short anchor can never hit the wrong row silently. */
export function editWithin(
  html: string,
  hits: Array<{ start: number; length: number }>,
  tag: string,
  action: "replace" | "before" | "after" | "remove",
  body: string,
  nth?: number
): WithinResult {
  if (!hits.length) return { ok: false, reason: "no_match", matches: 0 };
  const seen = new Map<number, ElementSpan>();
  for (const h of hits) {
    const el = containingElement(html, tag, h.start, h.start + h.length);
    if (el) seen.set(el.start, el);
  }
  const elements = [...seen.values()].sort((a, b) => a.start - b.start);
  if (!elements.length) return { ok: false, reason: "no_element", matches: hits.length };
  const preview = (s: ElementSpan) => html.slice(s.start, Math.min(s.end, s.start + 160));
  let target: ElementSpan | undefined;
  if (nth !== undefined) target = elements[nth - 1];
  else if (elements.length === 1) target = elements[0];
  if (!target) return { ok: false, reason: "ambiguous", matches: elements.length, elements: elements.slice(0, 10).map(preview) };
  const el = html.slice(target.start, target.end);
  const out =
    action === "replace" ? html.slice(0, target.start) + body + html.slice(target.end)
    : action === "remove" ? html.slice(0, target.start) + html.slice(target.end)
    : action === "before" ? html.slice(0, target.start) + body + html.slice(target.start)
    : html.slice(0, target.end) + body + html.slice(target.end);
  return { ok: true, html: out, element: el, matches: elements.length };
}
