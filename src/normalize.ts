// ─────────────────────────────────────────────────────────────────────────────
// BrainLLM — normalization layer
//
// Everything the model emits passes through here before it is stored.
// Titles, topics, label values, and body markup are deterministic server
// policy — the model supplies content, this module owns its form.
// ─────────────────────────────────────────────────────────────────────────────

import type { Status } from "./types.js";

// ── HTML entities ─────────────────────────────────────────────────────────────

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ",
  mdash: "—", ndash: "–", hellip: "…", rsquo: "'", lsquo: "'",
  rdquo: '"', ldquo: '"', middot: "·", bull: "•",
};

/** Decode HTML entities (named + numeric), repeatedly, so double-escaped
 *  titles like "&amp;amp;" collapse all the way down to "&". */
export function decodeEntities(s: string): string {
  let prev = s;
  for (let i = 0; i < 3; i++) {
    const next = prev
      .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(parseInt(n, 10)))
      .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
      .replace(/&([a-z]+);/gi, (m, name) => NAMED_ENTITIES[name.toLowerCase()] ?? m);
    if (next === prev) break;
    prev = next;
  }
  return prev;
}

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// ── Titles ────────────────────────────────────────────────────────────────────

// Status words the model bakes into titles ("Foo — RESOLVED"). Stripped on
// write and on sweep; the implied status is surfaced so it lands in #status
// where it belongs.
const SUFFIX_STATUS: Array<[RegExp, Status | "active"]> = [
  [/\s*[—–\-:(]\s*(?:partially|partly)\s+(?:resolved|answered|done)\s*\)?\s*$/i, "active"],
  [/\s*[—–\-:(]\s*(?:resolved|answered|closed|done|decided|completed|fixed)\s*\)?\s*$/i, "resolved"],
  [/\s*[—–\-:(]\s*superseded\s*\)?\s*$/i, "superseded"],
];

export interface NormalizedTitle {
  title: string;
  /** Status implied by a stripped suffix, if any. "active" means the suffix
   *  said "partially resolved" — i.e. explicitly still open. */
  impliedStatus?: Status;
}

const MAX_TITLE_LENGTH = 120;

export function normalizeTitle(raw: string): NormalizedTitle {
  let title = decodeEntities(raw).replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
  let impliedStatus: Status | undefined;

  for (const [pattern, status] of SUFFIX_STATUS) {
    if (pattern.test(title)) {
      title = title.replace(pattern, "").trim();
      impliedStatus = status;
      break;
    }
  }

  if (title.length > MAX_TITLE_LENGTH) {
    const cut = title.slice(0, MAX_TITLE_LENGTH);
    const lastSpace = cut.lastIndexOf(" ");
    title = (lastSpace > 60 ? cut.slice(0, lastSpace) : cut).trimEnd() + "…";
  }

  return { title, impliedStatus };
}

/** Canonical dedup key: two titles with the same key are the same note. */
export function titleKey(title: string): string {
  return decodeEntities(title)
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")   // strip diacritics
    .replace(/[^a-z0-9\s]/g, " ")      // punctuation → space
    .replace(/\s+/g, " ")
    .trim();
}

/** True when two titles identify the same note: identical keys, or one key
 *  is a word-boundary prefix of the other (catches "Foo" vs "Foo — RESOLVED"
 *  leftovers and "Project X" vs "Project X brief"). */
export function sameTitle(a: string, b: string): boolean {
  const ka = titleKey(a);
  const kb = titleKey(b);
  if (!ka || !kb) return false;
  if (ka === kb) return true;
  const [shorter, longer] = ka.length <= kb.length ? [ka, kb] : [kb, ka];
  return shorter.length >= 8 && longer.startsWith(shorter + " ");
}

// ── Topic / domain slugs ──────────────────────────────────────────────────────

/** Slug label values so "Machine Learning", "machine_learning" and
 *  "Machine-Learning " cannot fork the taxonomy. */
export function slugify(raw: string): string {
  return decodeEntities(raw)
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

/** Display form of a domain folder: "machine-learning" → "Machine Learning". */
export function titleCaseSlug(slug: string): string {
  return slug
    .split("-")
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

// ── Body markup ───────────────────────────────────────────────────────────────

const HTML_TAG = /<\/?[a-z][a-z0-9-]*(\s[^<>]*)?>/i;

export function looksLikeHtml(body: string): boolean {
  return HTML_TAG.test(body);
}

function inlineMd(escaped: string): string {
  return escaped
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[\s(])\*([^*\s][^*]*)\*/g, "$1<em>$2</em>")
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2">$1</a>');
}

/** Deterministic minimal markdown/plain-text → Trilium HTML. Bodies that
 *  already contain HTML tags pass through untouched. Supports paragraphs,
 *  #/##/### headings (mapped to h2/h3/h4 — h1 is the note title), -/* lists,
 *  numbered lists, fenced code blocks, bold/italic/inline code/links. */
export function toHtml(body: string): string {
  if (!body.trim()) return "<p></p>";
  if (looksLikeHtml(body)) return body;

  const lines = body.replace(/\r\n/g, "\n").split("\n");
  const out: string[] = [];
  let para: string[] = [];
  let list: { tag: "ul" | "ol"; items: string[] } | null = null;
  let code: string[] | null = null;

  const flushPara = () => {
    if (para.length) {
      out.push(`<p>${inlineMd(escapeHtml(para.join(" ")))}</p>`);
      para = [];
    }
  };
  const flushList = () => {
    if (list) {
      out.push(`<${list.tag}>${list.items.map((i) => `<li>${i}</li>`).join("")}</${list.tag}>`);
      list = null;
    }
  };

  for (const line of lines) {
    if (code !== null) {
      if (/^```/.test(line)) {
        out.push(`<pre><code>${escapeHtml(code.join("\n"))}</code></pre>`);
        code = null;
      } else {
        code.push(line);
      }
      continue;
    }
    if (/^```/.test(line)) {
      flushPara(); flushList();
      code = [];
      continue;
    }

    const heading = line.match(/^(#{1,4})\s+(.+)$/);
    if (heading) {
      flushPara(); flushList();
      const level = Math.min(heading[1].length + 1, 4); // # → h2
      out.push(`<h${level}>${inlineMd(escapeHtml(heading[2].trim()))}</h${level}>`);
      continue;
    }

    const bullet = line.match(/^\s*[-*]\s+(.+)$/);
    const numbered = line.match(/^\s*\d+[.)]\s+(.+)$/);
    if (bullet || numbered) {
      flushPara();
      const tag = bullet ? "ul" : "ol";
      const item = inlineMd(escapeHtml((bullet ?? numbered)![1].trim()));
      if (!list || list.tag !== tag) { flushList(); list = { tag, items: [] }; }
      list.items.push(item);
      continue;
    }

    if (!line.trim()) {
      flushPara(); flushList();
      continue;
    }

    flushList();
    para.push(line.trim());
  }
  if (code !== null) out.push(`<pre><code>${escapeHtml(code.join("\n"))}</code></pre>`);
  flushPara(); flushList();

  return out.join("\n") || "<p></p>";
}

/** HTML → readable plain text, for recall snippets and digests. */
export function toText(html: string, maxLength = 300): string {
  const text = decodeEntities(
    html
      .replace(/<(style|script)[\s\S]*?<\/\1>/gi, " ")
      .replace(/<(h[1-6]|p|li|div|tr|br)[^>]*>/gi, "\n")
      .replace(/<[^>]+>/g, "")
  )
    .replace(/[ \t]+/g, " ")
    .replace(/\s*\n\s*/g, " · ")
    .replace(/(\s*·\s*)+/g, " · ")
    .replace(/^\s*·\s*|\s*·\s*$/g, "")
    .trim();
  if (text.length <= maxLength) return text;
  const cut = text.slice(0, maxLength);
  const lastSpace = cut.lastIndexOf(" ");
  return (lastSpace > maxLength * 0.6 ? cut.slice(0, lastSpace) : cut) + "…";
}

/** Escape a value for embedding inside a quoted Trilium search string. */
export function escapeQueryValue(s: string): string {
  return s.replace(/["\\]/g, " ").replace(/\s+/g, " ").trim();
}

/** Tokenize a recall query into significant search terms. */
export function queryTokens(query: string, max = 4): string[] {
  const STOP = new Set(["the","and","for","with","that","this","what","when","where","how","why","are","was","were","from","into","about","over","under","does","did","has","have","had","its","his","her","their","our","your","you","not"]);
  return [...new Set(
    decodeEntities(query)
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, " ")
      .split(/\s+/)
      .filter((t) => t.length > 2 && !STOP.has(t))
  )].slice(0, max);
}
