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

// ── Icons ─────────────────────────────────────────────────────────────────────

/** Normalize an icon request to a Trilium boxicons class. Accepts a full class
 *  ("bx bx-brain", "bx bxs-heart", "bx bxl-github") or a bare name ("brain" →
 *  "bx bx-brain"). Returns "" for blank/unusable input so callers can no-op. */
export function normalizeIcon(raw: string): string {
  const s = decodeEntities(raw).trim().toLowerCase().replace(/\s+/g, " ");
  if (!s) return "";
  if (/^bx bx[sl]?-[a-z0-9-]+$/.test(s)) return s;
  const name = s
    .replace(/^bx[sl]?-/, "")
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return name ? `bx bx-${name}` : "";
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
 *  numbered lists, fenced code blocks, GFM tables, bold/italic/inline code/links. */
export function toHtml(body: string): string {
  if (!body.trim()) return "<p></p>";
  if (looksLikeHtml(body)) return body;

  const lines = body.replace(/\r\n/g, "\n").split("\n");
  const out: string[] = [];
  let para: string[] = [];
  let list: { tag: "ul" | "ol"; items: string[] } | null = null;
  let code: string[] | null = null;
  let tableBuffer: string[] = [];

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
  const flushTable = () => {
    if (!tableBuffer.length) return;
    const rows = tableBuffer.map((l) =>
      l.replace(/^\s*\||\|\s*$/g, "").split("|").map((c) => c.trim())
    );
    if (rows.length >= 2 && rows[1].every((c) => /^[-: ]+$/.test(c))) {
      const headers = rows[0];
      const bodyRows = rows.slice(2);
      const head = `<thead><tr>${headers.map((h) => `<th>${inlineMd(escapeHtml(h))}</th>`).join("")}</tr></thead>`;
      const body = bodyRows.length
        ? `<tbody>${bodyRows.map((r) => `<tr>${headers.map((_, i) => `<td>${inlineMd(escapeHtml(r[i] ?? ""))}</td>`).join("")}</tr>`).join("")}</tbody>`
        : "";
      out.push(`<table>${head}${body}</table>`);
    } else {
      for (const l of tableBuffer) para.push(l.trim());
      flushPara();
    }
    tableBuffer = [];
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
      flushPara(); flushList(); flushTable();
      code = [];
      continue;
    }

    if (/^\s*\|/.test(line)) {
      flushPara(); flushList();
      tableBuffer.push(line);
      continue;
    }
    if (tableBuffer.length) flushTable();

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
      flushPara(); flushList(); flushTable();
      continue;
    }

    flushList();
    para.push(line.trim());
  }
  if (code !== null) out.push(`<pre><code>${escapeHtml(code.join("\n"))}</code></pre>`);
  flushTable();
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

// ── HTML sanitization ─────────────────────────────────────────────────────────

/** Elements that are self-closing and never pushed onto the tag stack. */
const VOID_ELEMENTS = new Set([
  "area","base","br","col","embed","hr","img","input",
  "link","meta","param","source","track","wbr",
]);

/** Close unclosed block-level tags at the end of an HTML string.
 *  Stack-based pass — adequate for the structured content this codebase produces. */
export function closeDangling(html: string): string {
  const stack: string[] = [];
  const re = /<\/?([a-zA-Z][a-zA-Z0-9-]*)(?:\s[^>]*)?\/?>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const tag = m[1].toLowerCase();
    const full = m[0];
    if (VOID_ELEMENTS.has(tag) || full.endsWith("/>")) continue;
    if (full.startsWith("</")) {
      const i = stack.lastIndexOf(tag);
      if (i !== -1) stack.splice(i, 1);
    } else {
      stack.push(tag);
    }
  }
  if (!stack.length) return html;
  return html.trimEnd() + stack.reverse().map((t) => `</${t}>`).join("");
}

export interface SanitizeResult {
  html: string;
  /** Every mutation made — included in tool returns so the LLM knows what changed. */
  warnings: string[];
}

/** Sanitize LLM-supplied HTML for Trilium / CKEditor 5 compatibility.
 *  Always returns renderable content. Reports every mutation in `warnings`
 *  so callers can surface issues without failing the write.
 *
 *  Rules applied in order:
 *  1. Strip forbidden content blocks (script/style/iframe/form/object/…)
 *  2. Strip forbidden void tags (input/embed)
 *  3. Strip style= and on* attributes
 *  4. Demote <h1> → <h2>  (h1 is reserved for the Trilium note title)
 *  5. Demote <h5>/<h6> → <h4>  (CKEditor 5 supports h2–h4 only)
 *  6. Replace <div> → <p>  (CKEditor 5 uses paragraph blocks, not divs)
 *  7. Normalize <br> runs → paragraph separators; lone <br> → space
 *  8. Close dangling open block tags at the end */
export function sanitizeHtml(html: string): SanitizeResult {
  const warnings: string[] = [];
  let s = html;
  let n = 0;

  // 1. Strip forbidden content blocks (opening tag + inner content + closing tag).
  n = 0;
  s = s.replace(
    /<(script|style|noscript|iframe|form|object|applet|select|textarea|button)(\s[^>]*)?>[\s\S]*?<\/\1>/gi,
    () => { n++; return ""; },
  );
  if (n) warnings.push(`Stripped ${n} forbidden element block(s) — script/style/iframe/form/object/select/textarea/button`);

  // 2. Strip forbidden void/lone tags.
  n = 0;
  s = s.replace(/<\/?(input|embed)(\s[^>]*)?\/?>/gi, () => { n++; return ""; });
  if (n) warnings.push(`Stripped ${n} forbidden lone tag(s) — input/embed`);

  // 3. Strip style= attributes.
  n = 0;
  s = s.replace(/\s+style\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, () => { n++; return ""; });
  if (n) warnings.push(`Stripped ${n} style= attribute(s) — use semantic elements instead`);

  // 4. Strip on* event attributes.
  n = 0;
  s = s.replace(/\s+on[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, () => { n++; return ""; });
  if (n) warnings.push(`Stripped ${n} on* event attribute(s)`);

  // 5. Demote <h1> → <h2>.
  n = 0;
  s = s.replace(/<(\/?)h1(\s[^>]*)?>/gi, (_, close, attrs) => { n++; return `<${close}h2${attrs ?? ""}>`; });
  if (n) warnings.push(`Demoted ${n} <h1> to <h2> — h1 is reserved for the Trilium note title`);

  // 6. Demote <h5>/<h6> → <h4>.
  n = 0;
  s = s.replace(/<(\/?)h[56](\s[^>]*)?>/gi, (_, close, attrs) => { n++; return `<${close}h4${attrs ?? ""}>`; });
  if (n) warnings.push(`Demoted ${n} <h5>/<h6> to <h4> — CKEditor 5 supports h2–h4 only`);

  // 7. Replace <div> → <p> (attributes are not carried over — div attrs don't apply to p).
  n = 0;
  s = s.replace(/<(\/?)div(\s[^>]*)?>/gi, (_, close) => { n++; return `<${close}p>`; });
  if (n) warnings.push(`Replaced ${n} <div> with <p> — CKEditor 5 uses paragraph blocks`);

  // 8. Normalize <br> — runs become paragraph separators; lone <br> becomes a space.
  if (/<br[\s/>]/i.test(s) || s.includes("<br>")) {
    const before = s;
    s = s.replace(/<br\s*\/?>(\s*<br\s*\/?>)+/gi, "</p><p>");
    s = s.replace(/<br\s*\/?>/gi, " ");
    if (s !== before) warnings.push("<br> normalized to paragraph separators");
  }

  // 9. Close dangling open block tags at end of content.
  const closed = closeDangling(s);
  if (closed !== s) {
    warnings.push("Closed unclosed block tag(s) at end of content");
    s = closed;
  }

  return { html: s.trim() || "<p></p>", warnings };
}

/** Append one or more HTML block sections to existing note content.
 *  Closes any dangling open tags in `current` before appending, so new
 *  sections are never swallowed inside an unclosed element. */
export function safeAppend(current: string, ...blocks: string[]): string {
  return [closeDangling(current.trimEnd()), ...blocks].filter(Boolean).join("\n");
}

// ── Targeted-find helpers ─────────────────────────────────────────────────────

/** Build an attribute-tolerant regex from an exact find string, for the
 *  find= fallback path. CKEditor re-serializes stored HTML with injected
 *  attributes (spellcheck="false" on <code>, data-list-item-id on <li>, …),
 *  so text authored verbatim stops exact-matching after one storage
 *  round-trip. This relaxes every OPENING tag in the find string to accept
 *  any attributes; text segments and closing tags stay literal. Returns null
 *  when the find string contains no tags (nothing to relax — an exact miss
 *  is a genuine miss). */
export function tolerantFindRegex(find: string): RegExp | null {
  const OPEN_TAG = /<([a-zA-Z][a-zA-Z0-9-]*)((?:\s[^<>]*)?)(\/?)>/g;
  if (!OPEN_TAG.test(find)) return null;
  OPEN_TAG.lastIndex = 0;
  const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  let out = "";
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = OPEN_TAG.exec(find)) !== null) {
    out += esc(find.slice(last, m.index));
    out += `<${esc(m[1])}(?:\\s[^>]*)?${m[3] ? "\\/?" : ""}>`;
    last = m.index + m[0].length;
  }
  out += esc(find.slice(last));
  try {
    return new RegExp(out, "g");
  } catch {
    return null;
  }
}

// ── Dated-record headers ──────────────────────────────────────────────────────

/** Correct the meta-line date of a dated record (diary/session/log) to the
 *  note's canonical date. Guards against rewrite residue — a body replace
 *  that carried a stale "<em>session · 2026-07-14</em>" header from an older
 *  note. Only the header's date is touched; absent/unrecognized headers pass
 *  through unchanged. */
export function fixRecordHeader(html: string, kind: string, date: string): { html: string; fixed: boolean } {
  const re = new RegExp(`^(\\s*<p><em>${kind}\\s*·\\s*)(\\d{4}-\\d{2}-\\d{2})(</em></p>)`, "i");
  const m = re.exec(html);
  if (!m || m[2] === date) return { html, fixed: false };
  return { html: html.replace(re, `$1${date}$3`), fixed: true };
}

// ── Last-updated stamps ───────────────────────────────────────────────────────

/** Bump a note's "Last updated" line to `date`, preserving the note's own
 *  separator and date style (ISO "2026-07-16" or US "7/16/2026"). Server-owned
 *  in V9: any content write through the tools keeps the stamp current, so the
 *  model never hand-maintains dates. No-op when the note has no such line. */
export function bumpLastUpdated(html: string, date: string): { html: string; bumped: boolean } {
  const re = /(Last updated\s*(?:[-:–]|&ndash;|&mdash;)\s*)(\d{4}-\d{2}-\d{2}|\d{1,2}\/\d{1,2}\/\d{4})/i;
  const m = re.exec(html);
  if (!m) return { html, bumped: false };
  const iso = /^\d{4}-\d{2}-\d{2}$/.test(m[2]);
  const [y, mo, d] = date.split("-");
  const formatted = iso ? date : `${Number(mo)}/${Number(d)}/${y}`;
  if (m[2] === formatted) return { html, bumped: false };
  return { html: html.replace(re, `$1${formatted}`), bumped: true };
}

// ── Structure checks ──────────────────────────────────────────────────────────

/** True when the body opens with the canonical identification line — an h3
 *  whose text carries the "LLM · environment · agent/mode" separator pattern.
 *  The write tools for chronological records (diary, session via close, thread
 *  addendums) require either identity= or a body that already leads with this. */
export function leadingIdentification(html: string): boolean {
  const m = /^(?:\s|<p>(?:\s|&nbsp;)*<\/p>)*<h3(?:\s[^>]*)?>([\s\S]*?)<\/h3>/i.exec(html);
  if (!m) return false;
  const text = decodeEntities(m[1].replace(/<[^>]+>/g, "")).trim();
  return text.includes("·");
}

/** Duplicated heading texts (h2–h4, normalized) in an HTML body — the tell of
 *  a template/body collision or a section edit that appended instead of
 *  replacing. Addendum/Withdrawn/Recovered markers are exempt, and detection is
 *  scoped WITHIN each addendum block: chronological records legitimately repeat
 *  identification lines and section names across blocks (every addendum carries
 *  its own h3 identity and its own h4 sections) — only a heading duplicated
 *  inside one block, or in the pre-addendum head, is a real collision. */
export function duplicateHeadings(html: string): string[] {
  const MARKER = /<h2(?:\s[^>]*)?>\s*(?:Addendum|Withdrawn|Recovered|Reopened)\s*(?:—|–|-)[^<]*<\/h2>/gi;
  const segments = html.split(MARKER);
  const dupes = new Set<string>();
  const re = /<h([2-4])(?:\s[^>]*)?>([\s\S]*?)<\/h\1>/gi;
  for (const segment of segments) {
    const seen = new Set<string>();
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(segment)) !== null) {
      const text = decodeEntities(m[2].replace(/<[^>]+>/g, "")).replace(/\s+/g, " ").trim().toLowerCase();
      if (!text) continue;
      if (seen.has(text)) dupes.add(text);
      seen.add(text);
    }
  }
  return [...dupes];
}

/** Replace or append within a heading section (h2/h3/h4 tried in order, first
 *  match wins). Appends as a new h2 section if the heading isn't found at any
 *  level. The match tolerates attributes on the heading tag and surrounding/
 *  case-different whitespace in the heading text (a plain string ===
 *  '<h3>Heading</h3>' comparison silently missed either of those and fell
 *  through to the append-new-section fallback — which is how a "replace"
 *  could silently produce a duplicate heading instead of erroring). Reports
 *  whether a match was found and how many same-text headings exist at the
 *  matched level, so the caller can surface ambiguity instead of guessing.
 *  Closes dangling open tags in `html` before slicing — prevents string
 *  surgery from cutting inside an unclosed element. */
export function setSection(
  html: string,
  heading: string,
  content: string,
  mode: "replace" | "append"
): { html: string; matched: boolean; headingCount: number } {
  html = closeDangling(html);
  const escaped = heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  for (const level of [2, 3, 4]) {
    const tag = `h${level}`;
    const openRe = new RegExp(`<${tag}(?:\\s[^>]*)?>\\s*${escaped}\\s*</${tag}>`, "i");
    const match = openRe.exec(html);
    if (!match) continue;

    const headingCount = html.split(openRe).length - 1;
    const after = match.index + match[0].length;
    const nextMatch = html.slice(after).search(new RegExp(`<h[2-${level}]`));
    const end = nextMatch === -1 ? html.length : after + nextMatch;
    const existing = html.slice(after, end).trim();
    const inner = mode === "append" && existing ? `${existing}\n${content}` : content;
    return {
      html: `${html.slice(0, after)}\n${inner}\n${html.slice(end)}`,
      matched: true,
      headingCount,
    };
  }
  return {
    html: `${html}\n<h2>${heading}</h2>\n${content}`,
    matched: false,
    headingCount: 0,
  };
}

// ── Table row upsert ──────────────────────────────────────────────────────────

export interface UpsertRowResult {
  html: string;
  /** An existing row was found (by key) and its cells replaced in place. */
  matched: boolean;
  /** A new row was appended — either no existing row matched, or a single
   *  "— none yet —" placeholder row was replaced by it. */
  created: boolean;
}

/** Upsert one row of a table nested under a heading section (h2/h3/h4, tried
 *  in that order), keyed by the normalized text of its first cell — e.g. the
 *  per-domain Sources note's Revision table (Source | Marker | Date), keyed
 *  by source name. `key` and `cells` are plain text; this escapes and wraps
 *  them in <td> itself — never pass pre-rendered HTML.
 *
 *  Matching is structural, not literal: `<table>`/`<tr>`/`<td>` are matched
 *  with any attributes (`[^>]*`), and a cell's text is compared with its own
 *  inner tags stripped. This tolerates CKEditor 5 injecting `colgroup`,
 *  `style`, or `class="ck-table-resized"` into the table once a human opens
 *  the note in the Trilium UI (TableColumnResize / TableProperties /
 *  GeneralHtmlSupport are enabled there) — the same class of drift
 *  `tolerantFindRegex` exists to survive for literal find= matches, handled
 *  here by parsing structure instead of matching a literal string.
 *
 *  A single existing "— none yet —" / empty-first-cell placeholder row is
 *  replaced rather than left alongside a real one. No section, no table, or
 *  no <tbody> found → no-op (matched and created both false). */
export function upsertTableRow(
  html: string,
  heading: string,
  key: string,
  cells: string[]
): UpsertRowResult {
  const noop = { html, matched: false, created: false };
  const escapedHeading = heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  let headingEnd = -1;
  let level = 2;
  for (const l of [2, 3, 4]) {
    const re = new RegExp(`<h${l}(?:\\s[^>]*)?>\\s*${escapedHeading}\\s*</h${l}>`, "i");
    const m = re.exec(html);
    if (m) { headingEnd = m.index + m[0].length; level = l; break; }
  }
  if (headingEnd === -1) return noop;

  const nextHeadingOffset = html.slice(headingEnd).search(new RegExp(`<h[2-${level}]`));
  const sectionEnd = nextHeadingOffset === -1 ? html.length : headingEnd + nextHeadingOffset;
  const section = html.slice(headingEnd, sectionEnd);

  const tableMatch = /<table[^>]*>[\s\S]*?<\/table>/i.exec(section);
  if (!tableMatch) return noop;
  const table = tableMatch[0];

  const bodyMatch = /<tbody[^>]*>([\s\S]*?)<\/tbody>/i.exec(table);
  if (!bodyMatch) return noop;
  const tbody = bodyMatch[1];

  const cellText = (row: string): string => {
    const m = /<td[^>]*>([\s\S]*?)<\/td>/i.exec(row);
    return m ? decodeEntities(m[1].replace(/<[^>]+>/g, "")).replace(/\s+/g, " ").trim().toLowerCase() : "";
  };
  const keyNorm = decodeEntities(key).replace(/\s+/g, " ").trim().toLowerCase();

  const rowRe = /<tr[^>]*>[\s\S]*?<\/tr>/gi;
  let matchedRow: { start: number; end: number } | null = null;
  let placeholderRow: { start: number; end: number } | null = null;
  let m: RegExpExecArray | null;
  while ((m = rowRe.exec(tbody)) !== null) {
    const text = cellText(m[0]);
    const span = { start: m.index, end: m.index + m[0].length };
    if (text === keyNorm) { matchedRow = span; break; }
    if (!placeholderRow && (text === "" || text === "— none yet —")) placeholderRow = span;
  }

  const newRow = `<tr>${[key, ...cells].map((c) => `<td>${escapeHtml(c)}</td>`).join("")}</tr>`;
  const target = matchedRow ?? placeholderRow;
  const newTbody = target
    ? tbody.slice(0, target.start) + newRow + tbody.slice(target.end)
    : tbody + newRow;

  const newTable = table.slice(0, bodyMatch.index) + `<tbody>${newTbody}</tbody>` + table.slice(bodyMatch.index + bodyMatch[0].length);
  const newSection = section.slice(0, tableMatch.index) + newTable + section.slice(tableMatch.index + table.length);
  return {
    html: html.slice(0, headingEnd) + newSection + html.slice(sectionEnd),
    matched: !!matchedRow,
    created: !matchedRow,
  };
}
