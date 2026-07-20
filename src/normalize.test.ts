import { describe, expect, test } from "bun:test";
import {
  decodeEntities,
  normalizeTitle,
  titleKey,
  sameTitle,
  slugify,
  titleCaseSlug,
  toHtml,
  toText,
  queryTokens,
  looksLikeHtml,
  setSection,
  tolerantFindRegex,
  fixRecordHeader,
  bumpLastUpdated,
  duplicateHeadings,
  leadingIdentification,
  upsertTableRow,
} from "./normalize.js";

describe("tolerantFindRegex", () => {
  test("null for tag-free find strings", () => {
    expect(tolerantFindRegex("plain text only")).toBeNull();
  });
  test("matches stored HTML with CKEditor-injected attributes", () => {
    const authored = '<code>maintain(deep=true)</code> weekly';
    const stored = '<code spellcheck="false">maintain(deep=true)</code> weekly, and more';
    const rx = tolerantFindRegex(authored);
    expect(rx).not.toBeNull();
    expect(stored.match(rx!)?.length).toBe(1);
  });
  test("relaxed list items match data-list-item-id injection", () => {
    const authored = "<li>Pinboard push</li>";
    const stored = '<ul><li data-list-item-id="e1abc">Pinboard push</li></ul>';
    expect(stored.match(tolerantFindRegex(authored)!)?.length).toBe(1);
  });
  test("regex specials in text segments stay literal", () => {
    const rx = tolerantFindRegex("<p>cost (R500k) + 20%</p>");
    expect('<p class="x">cost (R500k) + 20%</p>'.match(rx!)?.length).toBe(1);
    expect("<p>cost R500k + 20%</p>".match(rx!)).toBeNull();
  });
});

describe("fixRecordHeader", () => {
  test("corrects a stale header date", () => {
    const r = fixRecordHeader("<p><em>session · 2026-07-14</em></p><hr><p>x</p>", "session", "2026-07-16");
    expect(r.fixed).toBe(true);
    expect(r.html).toContain("session · 2026-07-16");
  });
  test("no-op when the date is already correct or the header is absent", () => {
    expect(fixRecordHeader("<p><em>diary · 2026-07-16</em></p>", "diary", "2026-07-16").fixed).toBe(false);
    expect(fixRecordHeader("<p>no header here</p>", "diary", "2026-07-16").fixed).toBe(false);
  });
});

describe("bumpLastUpdated", () => {
  test("bumps an ISO stamp", () => {
    const r = bumpLastUpdated("<p>Last updated: 2026-07-01</p><p>body</p>", "2026-07-16");
    expect(r.bumped).toBe(true);
    expect(r.html).toContain("Last updated: 2026-07-16");
  });
  test("preserves US-style stamps", () => {
    const r = bumpLastUpdated("<h4>Last updated - 7/1/2026</h4>", "2026-07-16");
    expect(r.bumped).toBe(true);
    expect(r.html).toContain("Last updated - 7/16/2026");
  });
  test("no-op without a stamp or when already current", () => {
    expect(bumpLastUpdated("<p>nothing here</p>", "2026-07-16").bumped).toBe(false);
    expect(bumpLastUpdated("<h4>Last updated - 2026-07-16</h4>", "2026-07-16").bumped).toBe(false);
  });
});

describe("leadingIdentification", () => {
  test("detects a leading identification h3", () => {
    expect(leadingIdentification("<h3>Claude Fable 5 · Cowork · Interactive</h3><p>body</p>")).toBe(true);
    expect(leadingIdentification('<p>&nbsp;</p><h3 class="x">Claude Sonnet 5 · Claude Code · Analysis Agent · Run 6</h3>')).toBe(true);
  });
  test("rejects bodies without it", () => {
    expect(leadingIdentification("<p>prose first</p><h3>Claude · Cowork</h3>")).toBe(false);
    expect(leadingIdentification("<h3>Just A Heading</h3><p>no separator</p>")).toBe(false);
    expect(leadingIdentification("<h2>Wrong Level · Anyway</h2>")).toBe(false);
  });
});

describe("duplicateHeadings", () => {
  test("flags duplicated section headings", () => {
    const dupes = duplicateHeadings("<h2>Context</h2><p>a</p><h2>Context</h2><p>b</p><h3>Goal</h3>");
    expect(dupes).toEqual(["context"]);
  });
  test("addendum markers are exempt; attributes tolerated", () => {
    const html = '<h2>Addendum — 10:00</h2><p>a</p><h2>Addendum — 11:00</h2><h2 class="x">Plan</h2><h2>Plan</h2>';
    expect(duplicateHeadings(html)).toEqual(["plan"]);
  });
  test("headings repeating ACROSS addendum blocks are fine (chronological records)", () => {
    const html =
      "<h2>Context</h2><h3>Goal</h3>" +
      "<h2>Addendum — 2026-07-16</h2><h3>Claude · Cowork</h3><h4>Next</h4>" +
      "<h2>Addendum — 2026-07-16</h2><h3>Claude · Cowork</h3><h4>Next</h4>";
    expect(duplicateHeadings(html)).toEqual([]);
  });
});

describe("decodeEntities", () => {
  test("decodes named entities", () => {
    expect(decodeEntities("Ventures &amp; Platforms")).toBe("Ventures & Platforms");
  });
  test("collapses double-escaping", () => {
    expect(decodeEntities("A &amp;amp; B")).toBe("A & B");
  });
  test("decodes numeric entities", () => {
    expect(decodeEntities("&#8212; and &#x2014;")).toBe("— and —");
  });
  test("leaves unknown entities alone", () => {
    expect(decodeEntities("&notathing;")).toBe("&notathing;");
  });
});

describe("normalizeTitle", () => {
  test("strips RESOLVED suffix and implies status", () => {
    const r = normalizeTitle('What is "pinboard"? — RESOLVED');
    expect(r.title).toBe('What is "pinboard"?');
    expect(r.impliedStatus).toBe("resolved");
  });
  test("'partially resolved' means still active", () => {
    const r = normalizeTitle("Firebase vs Supabase — partially resolved");
    expect(r.title).toBe("Firebase vs Supabase");
    expect(r.impliedStatus).toBe("active");
  });
  test("decodes entities in titles", () => {
    const r = normalizeTitle("Miiso — Active Ventures &amp; Platforms");
    expect(r.title).toBe("Miiso — Active Ventures & Platforms");
    expect(r.impliedStatus).toBeUndefined();
  });
  test("keeps legitimate em-dash subtitles", () => {
    const r = normalizeTitle("BrainLLM — the second brain MCP");
    expect(r.title).toBe("BrainLLM — the second brain MCP");
    expect(r.impliedStatus).toBeUndefined();
  });
  test("collapses whitespace and caps length at a word boundary", () => {
    const long = "word ".repeat(60);
    const r = normalizeTitle(long);
    expect(r.title.length).toBeLessThanOrEqual(121);
    expect(r.title.endsWith("…")).toBe(true);
  });
});

describe("titleKey / sameTitle", () => {
  test("same key for punctuation/case variants", () => {
    expect(titleKey("Firebase vs. Supabase!")).toBe(titleKey("firebase vs supabase"));
  });
  test("prefix match counts as same note", () => {
    expect(sameTitle("myClerkBook", "myClerkBook brief")).toBe(true);
  });
  test("short prefixes do not collide", () => {
    expect(sameTitle("wall-e", "wall-e v2 rewrite plan")).toBe(false);
  });
  test("different titles differ", () => {
    expect(sameTitle("Firebase decision", "Supabase decision")).toBe(false);
  });
});

describe("slugify", () => {
  test("slugs to lowercase kebab", () => {
    expect(slugify("Machine Learning")).toBe("machine-learning");
    expect(slugify("machine_learning ")).toBe("machine-learning");
  });
  test("ampersand becomes and", () => {
    expect(slugify("AI & Tooling")).toBe("ai-and-tooling");
  });
  test("titleCaseSlug round-trips for display", () => {
    expect(titleCaseSlug("machine-learning")).toBe("Machine Learning");
  });
});

describe("toHtml", () => {
  test("passes HTML through untouched", () => {
    expect(toHtml("<p>hi</p>")).toBe("<p>hi</p>");
  });
  test("converts markdown-ish plain text", () => {
    const html = toHtml("# Heading\n\nSome **bold** text.\n\n- one\n- two");
    expect(html).toContain("<h2>Heading</h2>");
    expect(html).toContain("<strong>bold</strong>");
    expect(html).toContain("<ul><li>one</li><li>two</li></ul>");
  });
  test("escapes raw angle brackets in plain text", () => {
    expect(toHtml("a < b and c > d")).toBe("<p>a &lt; b and c &gt; d</p>");
  });
  test("fenced code blocks survive verbatim", () => {
    const html = toHtml("```\nconst x = 1 < 2;\n```");
    expect(html).toBe("<pre><code>const x = 1 &lt; 2;</code></pre>");
  });
  test("numbered lists become ol", () => {
    expect(toHtml("1. first\n2. second")).toBe("<ol><li>first</li><li>second</li></ol>");
  });
});

describe("toText", () => {
  test("strips tags, decodes entities, joins blocks", () => {
    const text = toText("<h2>Summary</h2><p>Shipped &amp; tested.</p>");
    expect(text).toBe("Summary · Shipped & tested.");
  });
  test("caps length at a word boundary", () => {
    const text = toText(`<p>${"word ".repeat(100)}</p>`, 50);
    expect(text.length).toBeLessThanOrEqual(51);
    expect(text.endsWith("…")).toBe(true);
  });
});

describe("queryTokens", () => {
  test("drops stop words and short tokens", () => {
    expect(queryTokens("what is the wall-e deployment strategy")).toEqual([
      "wall-e", "deployment", "strategy",
    ]);
  });
  test("caps token count", () => {
    expect(queryTokens("alpha beta gamma delta epsilon zeta", 4)).toHaveLength(4);
  });
});

describe("looksLikeHtml", () => {
  test("detects tags", () => {
    expect(looksLikeHtml("<p>x</p>")).toBe(true);
    expect(looksLikeHtml("a < b")).toBe(false);
  });
});

describe("setSection", () => {
  const doc = "<h3>Operating</h3><p>old 1</p><p>old 2</p><h3>Self-correction</h3><p>other</p>";

  test("replaces an h3 section in place, leaving the heading and later sections intact", () => {
    const r = setSection(doc, "Operating", "<p>new</p>", "replace");
    expect(r.matched).toBe(true);
    expect(r.headingCount).toBe(1);
    expect(r.html).toContain("<h3>Operating</h3>");
    expect(r.html).toContain("<p>new</p>");
    expect(r.html).not.toContain("old 1");
    expect(r.html).toContain("<h3>Self-correction</h3>");
    expect(r.html).toContain("<p>other</p>");
    // Exactly one "Operating" heading — not duplicated.
    expect(r.html.match(/Operating/g)).toHaveLength(1);
  });

  test("matches a heading carrying attributes on the tag — the literal bug report", () => {
    // Trilium/CKEditor can emit e.g. <h3 dir="auto">Operating</h3>; a plain
    // '<h3>Operating</h3>' string match misses this and used to silently
    // fall through to appending a brand-new duplicate heading.
    const withAttrs = doc.replace("<h3>Operating</h3>", '<h3 dir="auto">Operating</h3>');
    const r = setSection(withAttrs, "Operating", "<p>new</p>", "replace");
    expect(r.matched).toBe(true);
    expect(r.html.match(/Operating/g)).toHaveLength(1);
  });

  test("matches case-insensitively and tolerates surrounding whitespace", () => {
    const messy = doc.replace("<h3>Operating</h3>", "<h3> operating </h3>");
    const r = setSection(messy, "Operating", "<p>new</p>", "replace");
    expect(r.matched).toBe(true);
    expect(r.html).toContain("<p>new</p>");
  });

  test("flags ambiguity when multiple headings share the same text", () => {
    const dup = doc + "<h3>Operating</h3><p>old 3</p>";
    const r = setSection(dup, "Operating", "<p>new</p>", "replace");
    expect(r.matched).toBe(true);
    expect(r.headingCount).toBe(2);
  });

  test("reports matched:false and appends a new h2 when no heading is found at any level", () => {
    const r = setSection(doc, "Nonexistent Section", "<p>new</p>", "replace");
    expect(r.matched).toBe(false);
    expect(r.headingCount).toBe(0);
    expect(r.html).toContain("<h2>Nonexistent Section</h2>");
    expect(r.html).toContain("<p>new</p>");
    // Original content is untouched, not duplicated under the fallback heading.
    expect(r.html).toContain("<h3>Operating</h3>");
    expect(r.html.match(/Operating/g)).toHaveLength(1);
  });

  test("append mode preserves existing content under the section instead of discarding it", () => {
    const r = setSection(doc, "Operating", "<p>added</p>", "append");
    expect(r.matched).toBe(true);
    expect(r.html).toContain("old 1");
    expect(r.html).toContain("<p>added</p>");
  });
});

describe("upsertTableRow", () => {
  const revisionTable = (rows: string) =>
    `<h2>Revision</h2><figure class="table"><table><thead><tr><th>Source</th><th>Marker</th><th>Date</th></tr></thead><tbody>${rows}</tbody></table></figure>`;

  test("replaces an existing row in place by key, leaving other rows untouched", () => {
    const doc = revisionTable(
      "<tr><td>myclerkbook.com</td><td>✅</td><td>2026-07-17</td></tr>" +
      "<tr><td>Vercel (myclerkbook)</td><td>✅</td><td>2026-07-17</td></tr>"
    );
    const r = upsertTableRow(doc, "Revision", "Vercel (myclerkbook)", ["✅", "2026-07-19"]);
    expect(r.matched).toBe(true);
    expect(r.created).toBe(false);
    // Re-verified row updated, old date gone...
    expect(r.html).toContain("<td>Vercel (myclerkbook)</td><td>✅</td><td>2026-07-19</td>");
    expect(r.html).not.toContain("<td>Vercel (myclerkbook)</td><td>✅</td><td>2026-07-17</td>");
    // ...untouched row survives, and there is still exactly one Vercel row.
    expect(r.html).toContain("<td>myclerkbook.com</td><td>✅</td><td>2026-07-17</td>");
    expect(r.html.match(/Vercel \(myclerkbook\)/g)).toHaveLength(1);
  });

  test("appends a new row when the key isn't found", () => {
    const doc = revisionTable("<tr><td>myclerkbook.com</td><td>✅</td><td>2026-07-17</td></tr>");
    const r = upsertTableRow(doc, "Revision", "Supabase (myclerkbook)", ["✅", "2026-07-19"]);
    expect(r.matched).toBe(false);
    expect(r.created).toBe(true);
    expect(r.html).toContain("<td>myclerkbook.com</td>");
    expect(r.html).toContain("<td>Supabase (myclerkbook)</td><td>✅</td><td>2026-07-19</td>");
  });

  test("replaces the '— none yet —' placeholder instead of appending alongside it", () => {
    const doc = revisionTable('<tr><td><em>— none yet —</em></td><td></td><td></td></tr>');
    const r = upsertTableRow(doc, "Revision", "myclerkbook.com", ["✅", "2026-07-17"]);
    expect(r.created).toBe(true);
    expect(r.html).not.toContain("none yet");
    // Exactly one row in the BODY — the thead's own <tr> of <th>s is separate.
    const tbody = /<tbody>([\s\S]*?)<\/tbody>/.exec(r.html)?.[1] ?? "";
    expect(tbody.match(/<tr>/g)).toHaveLength(1);
  });

  test("attribute-tolerant: matches through CKEditor-injected table/row/cell attributes", () => {
    // TableColumnResize / TableProperties / GeneralHtmlSupport (enabled in
    // Trilium's CKEditor build) can inject colgroup, style, and class once a
    // note is opened in the UI — matching must survive that, like
    // tolerantFindRegex does for literal find= text.
    const doc =
      '<h2>Revision</h2><figure class="table ck-widget"><table class="ck-table-resized" style="width:400px">' +
      '<colgroup><col style="width:50%"><col style="width:25%"><col style="width:25%"></colgroup>' +
      '<thead><tr><th>Source</th><th>Marker</th><th>Date</th></tr></thead>' +
      '<tbody><tr style="height:20px"><td class="ck-cell">myclerkbook.com</td><td>✅</td><td>2026-07-17</td></tr></tbody>' +
      '</table></figure>';
    const r = upsertTableRow(doc, "Revision", "myclerkbook.com", ["✅", "2026-07-19"]);
    expect(r.matched).toBe(true);
    expect(r.html).toContain("2026-07-19");
    // The colgroup/style scaffolding around the table survives untouched.
    expect(r.html).toContain('<colgroup>');
    expect(r.html).toContain('class="ck-table-resized"');
  });

  test("key matching is case-insensitive and whitespace-tolerant", () => {
    const doc = revisionTable("<tr><td> MyClerkBook.com </td><td>✅</td><td>2026-07-17</td></tr>");
    const r = upsertTableRow(doc, "Revision", "myclerkbook.com", ["✅", "2026-07-19"]);
    expect(r.matched).toBe(true);
    expect(r.html).toContain("2026-07-19");
  });

  test("cell values are escaped, not treated as HTML", () => {
    const doc = revisionTable("");
    const r = upsertTableRow(doc, "Revision", 'Tom & Jerry\'s <docs>', ["✅", "2026-07-19"]);
    expect(r.html).toContain("Tom &amp; Jerry's &lt;docs&gt;");
  });

  test("no-op when the heading isn't present", () => {
    const doc = "<h2>Sources</h2><p>no revision section here</p>";
    const r = upsertTableRow(doc, "Revision", "myclerkbook.com", ["✅", "2026-07-19"]);
    expect(r.matched).toBe(false);
    expect(r.created).toBe(false);
    expect(r.html).toBe(doc);
  });

  test("no-op when the section has no table", () => {
    const doc = "<h2>Revision</h2><p>not a table yet</p>";
    const r = upsertTableRow(doc, "Revision", "myclerkbook.com", ["✅", "2026-07-19"]);
    expect(r.matched).toBe(false);
    expect(r.created).toBe(false);
    expect(r.html).toBe(doc);
  });
});
