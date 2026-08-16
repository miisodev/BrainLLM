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
  escapeHtml,
  escapeQueryValue,
  escapeQueryRegex,
  stripTagsWithMap,
  repairDoubleEscaping,
  getSection,
  nearestContext,
  addendumIndex,
  queryTokens,
  looksLikeHtml,
  looksLikeEncodedHtml,
  renderBody,
  setSection,
  headingOutline,
  structureReport,
  unbalancedTags,
  tolerantFindRegex,
  spansBlockBoundary,
  looksEntityEscaped,
  fixRecordHeader,
  bumpLastUpdated,
  duplicateHeadings,
  leadingIdentification,
  upsertTableRow,
  tableRows,
  hasPlaceholderRow,
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

  test("matches across a block boundary regardless of inter-element whitespace", () => {
    // The bug this closes: whitespace between elements was escaped literally, so
    // a find authored as "</h3>\n<ol>" could never match stored "</h3><ol>" — on
    // either pass, in any whitespace variant. Three separate sessions
    // misdiagnosed it (as "non-ASCII", then "emoji") before the real constraint
    // was isolated.
    const authored = "</h3>\n<ol>";
    const rx = tolerantFindRegex(authored)!;
    expect("<h3>Plan</h3><ol><li>a</li></ol>".match(rx)?.length).toBe(1);
    expect("<h3>Plan</h3>\n\n  <ol><li>a</li></ol>".match(rx)?.length).toBe(1);
    // And the no-whitespace spelling still matches a stored newline.
    expect("<h3>Plan</h3>\n<ol>".match(tolerantFindRegex("</h3><ol>")!)?.length).toBe(1);
  });

  test("whitespace inside text stays required, so unrelated prose does not match", () => {
    const rx = tolerantFindRegex("<p>alpha beta</p>")!;
    expect("<p>alpha   beta</p>".match(rx)?.length).toBe(1);
    expect("<p>alphabeta</p>".match(rx)).toBeNull();
  });

  test("emoji in the find string are not the problem they were reported to be", () => {
    const rx = tolerantFindRegex("<li>❇️ discovered</li>")!;
    expect('<li data-list-item-id="x">❇️ discovered</li>'.match(rx)?.length).toBe(1);
  });
});

describe("find= miss diagnostics", () => {
  test("spansBlockBoundary identifies the shape that used to be unmatchable", () => {
    expect(spansBlockBoundary("</h3>\n<ol>")).toBe(true);
    expect(spansBlockBoundary("</p> <p>next")).toBe(true);
    expect(spansBlockBoundary("<p>all inside one element</p>")).toBe(false);
    expect(spansBlockBoundary("plain text")).toBe(false);
  });

  test("looksEntityEscaped catches a search string escaped by the caller", () => {
    // The inverse mistake: bodies accept escaped markup, find= does not, and
    // those two behaviours differing is exactly what caused the trip-up.
    expect(looksEntityEscaped("&lt;h3&gt;Typography&lt;/h3&gt;")).toBe(true);
    expect(looksEntityEscaped("<h3>Typography</h3>")).toBe(false);
    expect(looksEntityEscaped("plain text")).toBe(false);
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

  test("on a miss, appends at the note's OWN section level — not a hardcoded h2", () => {
    // The bug this replaces: a note built entirely from h3 sections got a stray
    // h2 appended, so a mistyped section name produced a structurally wrong
    // note rather than an error. Hit twice in one session before it was fixed.
    const r = setSection(doc, "Nonexistent Section", "<p>new</p>", "replace");
    expect(r.matched).toBe(false);
    expect(r.headingCount).toBe(0);
    expect(r.appendedAtLevel).toBe(3);
    expect(r.html).toContain("<h3>Nonexistent Section</h3>");
    expect(r.html).not.toContain("<h2>Nonexistent Section</h2>");
    expect(r.html).toContain("<p>new</p>");
    // Original content is untouched, not duplicated under the fallback heading.
    expect(r.html).toContain("<h3>Operating</h3>");
    expect(r.html.match(/Operating/g)).toHaveLength(1);
  });

  test("a miss returns the note's real headings so the caller can re-target without a read", () => {
    const r = setSection(doc, "Nonexistent Section", "<p>new</p>", "replace");
    expect(r.available).toEqual(["Operating", "Self-correction"]);
  });

  test("uses h2 for a mixed-level note, and h2 for a note with no headings at all", () => {
    expect(setSection("<h2>Top</h2><p>a</p><h3>Sub</h3><p>b</p>", "New", "<p>x</p>", "replace").appendedAtLevel).toBe(2);
    expect(setSection("<p>just prose</p>", "New", "<p>x</p>", "replace").appendedAtLevel).toBe(2);
  });

  test("occurrence= reaches a later same-text heading instead of always the first", () => {
    // Repeating a closing heading under every category is the consistency rule
    // working, and it used to make the second one unreachable: section= took the
    // first and find= could not tell two identical strings apart.
    const dup = "<h3>Notes</h3><p>first</p><h3>Notes</h3><p>second</p>";
    const r = setSection(dup, "Notes", "<p>replaced</p>", "replace", 2);
    expect(r.matched).toBe(true);
    expect(r.headingCount).toBe(2);
    expect(r.html).toContain("<p>first</p>");
    expect(r.html).toContain("<p>replaced</p>");
    expect(r.html).not.toContain("<p>second</p>");
  });

  test("occurrence beyond the range clamps to the last match rather than appending a duplicate", () => {
    const dup = "<h3>Notes</h3><p>first</p><h3>Notes</h3><p>second</p>";
    const r = setSection(dup, "Notes", "<p>replaced</p>", "replace", 9);
    expect(r.matched).toBe(true);
    expect(r.html.match(/<h3>Notes<\/h3>/g)).toHaveLength(2);
    expect(r.html).not.toContain("<p>second</p>");
  });

  test("before/after insert around the heading without touching the section body", () => {
    const before = setSection(doc, "Self-correction", "<h3>Inserted</h3>", "before");
    expect(before.matched).toBe(true);
    expect(before.html).toContain("<h3>Inserted</h3>\n<h3>Self-correction</h3>");
    expect(before.html).toContain("<p>other</p>");

    const after = setSection(doc, "Operating", "<p>note</p>", "after");
    expect(after.matched).toBe(true);
    expect(after.html).toContain("<h3>Operating</h3>\n<p>note</p>");
    // The section's own content survives — this is an insert, not a replace.
    expect(after.html).toContain("<p>old 1</p>");
  });

  test("append mode preserves existing content under the section instead of discarding it", () => {
    const r = setSection(doc, "Operating", "<p>added</p>", "append");
    expect(r.matched).toBe(true);
    expect(r.html).toContain("old 1");
    expect(r.html).toContain("<p>added</p>");
  });
});

describe("entity-encoded bodies", () => {
  test("escaped markup is decoded, not escaped a second time", () => {
    // The corruption this prevents: looksLikeHtml requires a literal '<', so an
    // entity-encoded body took the markdown path and was escaped again —
    // "&lt;h2&gt;" stored as "&amp;lt;h2&amp;gt;" and rendered as literal text,
    // with a clean write receipt. It reached eight live notes.
    const body = "&lt;h2&gt;Experience&lt;/h2&gt;&lt;p&gt;It went well.&lt;/p&gt;";
    expect(looksLikeEncodedHtml(body)).toBe(true);
    const html = toHtml(body);
    expect(html).toContain("<h2>Experience</h2>");
    expect(html).not.toContain("&amp;lt;");
  });

  test("bare ampersands exposed by the decode are re-escaped, keeping valid HTML", () => {
    expect(toHtml("&lt;p&gt;a &amp; b&lt;/p&gt;")).toBe("<p>a &amp; b</p>");
  });

  test("real HTML and plain prose are both unaffected", () => {
    expect(looksLikeEncodedHtml("<p>real</p>")).toBe(false);
    expect(looksLikeEncodedHtml("a < b and c > d")).toBe(false);
    // A stray entity that is not a whole tag stays plain text — detection needs
    // "&lt;tag&gt;", so prose about escaping is never reinterpreted as markup.
    expect(looksLikeEncodedHtml("a &lt; b")).toBe(false);
    // Already-corrupted text ("&amp;lt;") is left exactly as written rather than
    // guessed at: repairing existing notes is a deliberate act, not a side
    // effect of the next unrelated write.
    expect(looksLikeEncodedHtml("&amp;lt;p&amp;gt;twice&amp;lt;/p&amp;gt;")).toBe(false);
  });

  test("renderBody reports the decode — the mutation that used to be invisible", () => {
    const decoded = renderBody("&lt;p&gt;hi&lt;/p&gt;");
    expect(decoded.html).toBe("<p>hi</p>");
    expect(decoded.warnings.join(" ")).toContain("Entity-encoded markup decoded");
    expect(renderBody("<p>hi</p>").warnings).toEqual([]);
  });
});

describe("structural lint", () => {
  test("unbalancedTags reports what closeDangling would silently repair", () => {
    expect(unbalancedTags("<p>fine</p><ul><li>open")).toEqual(["ul", "li"]);
    expect(unbalancedTags("<p>a</p><br><hr>")).toEqual([]);
  });

  test("headingOutline carries level and occurrence index", () => {
    const nodes = headingOutline("<h2>A</h2><h3>B</h3><h3>B</h3>");
    expect(nodes).toEqual([
      { level: 2, text: "A", occurrence: 1 },
      { level: 3, text: "B", occurrence: 1 },
      { level: 3, text: "B", occurrence: 2 },
    ]);
  });

  test("structureReport surfaces duplicates, imbalance and size together", () => {
    const r = structureReport("<h3>X</h3><p>a</p><h3>X</h3><ul><li>open");
    expect(r.duplicateHeadings).toEqual(["x"]);
    expect(r.unbalancedTags).toEqual(["ul", "li"]);
    expect(r.size).toBeGreaterThan(0);
  });
});

describe("table reads", () => {
  const table = (rows: string) =>
    `<h2>Revision</h2><figure class="table"><table><thead><tr><th>Source</th></tr></thead><tbody>${rows}</tbody></table></figure>`;

  test("tableRows exposes the exact keys upsertTableRow matches on", () => {
    const doc = table("<tr><td>myclerkbook.com</td><td>✅</td><td>2026-07-17</td></tr>");
    expect(tableRows(doc, "Revision")).toEqual([["myclerkbook.com", "✅", "2026-07-17"]]);
    expect(tableRows(doc, "Nonexistent")).toEqual([]);
  });

  test("hasPlaceholderRow catches a Revision table that was never filled in", () => {
    expect(hasPlaceholderRow(table("<tr><td><em>— none yet —</em></td><td></td><td></td></tr>"), "Revision")).toBe(true);
    expect(hasPlaceholderRow(table("<tr><td>real.com</td><td>✅</td><td>2026-07-17</td></tr>"), "Revision")).toBe(false);
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


// ── Defect 19 regression: outline() and setSection() must agree on a name ────
// A heading carrying inline markup was reported by headingOutline() as its
// stripped text and refused by setSection(), which matched raw inner HTML. The
// refusal silently appended a duplicate section rather than erroring, so
// trusting outline()'s output produced three near-identical sections in one
// note before anyone noticed.
describe("setSection matches headings by text, not raw HTML", () => {
  const withCode = `<h3><code>recall(regex=)</code> — the prior defect</h3>\n<p>old body</p>`;

  test("matches a heading containing inline markup", () => {
    const out = setSection(withCode, "recall(regex=) — the prior defect", "<p>new body</p>", "replace");
    expect(out.matched).toBe(true);
    expect(out.html).toContain("new body");
    expect(out.html).not.toContain("old body");
  });

  test("does NOT append a duplicate when the heading exists", () => {
    const out = setSection(withCode, "recall(regex=) — the prior defect", "<p>new</p>", "replace");
    expect(headingOutline(out.html).length).toBe(1);
  });

  test("every name outline() reports is a name setSection() matches", () => {
    const body = [
      `<h2>Plain heading</h2><p>a</p>`,
      `<h3><code>code()</code> — mixed</h3><p>b</p>`,
      `<h3><strong>Bold</strong> and <em>italic</em></h3><p>c</p>`,
      `<h4>Entity &amp; text</h4><p>d</p>`,
    ].join("\n");
    for (const h of headingOutline(body)) {
      expect(setSection(body, h.text, "<p>x</p>", "replace").matched).toBe(true);
    }
  });

  test("still misses a heading that genuinely is not there, and reports available", () => {
    const out = setSection(withCode, "No such heading", "<p>x</p>", "replace");
    expect(out.matched).toBe(false);
    expect(out.available).toContain("recall(regex=) — the prior defect");
  });

  test("occurrence= still selects among same-text headings", () => {
    const dupes = `<h3><code>Same</code></h3><p>one</p>\n<h3>Same</h3><p>two</p>`;
    const out = setSection(dupes, "Same", "<p>edited</p>", "replace", 2);
    expect(out.matched).toBe(true);
    expect(out.headingCount).toBe(2);
    expect(out.html).toContain("one");
    expect(out.html).not.toContain("two");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// V10.3 — the three silent-wrongness defects.
//
// Each test below asserts the FAILURE mode, not just the fix. All three of
// these shipped once with a passing suite, because the suite tested what the
// code did rather than what it was for.
// ─────────────────────────────────────────────────────────────────────────────

describe("escapeHtml does not double-escape a well-formed entity", () => {
  test("leaves an existing entity alone instead of escaping its ampersand", () => {
    // The producer of the entity-corruption defect. Before v10.3 this returned
    // "&amp;nbsp;", which stores and renders as visible literal text.
    expect(escapeHtml("a&nbsp;b")).toBe("a&nbsp;b");
    expect(escapeHtml("&lt;h3&gt;")).toBe("&lt;h3&gt;");
    expect(escapeHtml("&#8212; and &#x2014;")).toBe("&#8212; and &#x2014;");
  });

  test("still escapes a bare ampersand", () => {
    expect(escapeHtml("Tom & Jerry")).toBe("Tom &amp; Jerry");
    expect(escapeHtml("a & b&nbsp;c")).toBe("a &amp; b&nbsp;c");
    // "&notanentity" has no semicolon, so it is a bare ampersand.
    expect(escapeHtml("&notanentity")).toBe("&amp;notanentity");
  });

  test("still escapes angle brackets and quotes", () => {
    expect(escapeHtml('<script>"x"</script>')).toBe("&lt;script&gt;&quot;x&quot;&lt;/script&gt;");
  });

  test("preserveEntities=false restores blanket escaping, for code blocks", () => {
    expect(escapeHtml("&amp;", false)).toBe("&amp;amp;");
    expect(escapeHtml("&nbsp;", false)).toBe("&amp;nbsp;");
  });

  test("the markdown write path no longer corrupts a copied &nbsp;", () => {
    // The real-world case: prose copied out of a prior read carries CKEditor's
    // own &nbsp;, goes back in as plain text, and took the markdown path.
    const html = toHtml("A line with a&nbsp;hard space.");
    expect(html).toContain("a&nbsp;hard");
    expect(html).not.toContain("&amp;nbsp;");
  });

  test("a fenced code block still escapes its ampersands literally", () => {
    const html = toHtml("```\nx &amp; y\n```");
    expect(html).toContain("&amp;amp;");
  });
});

describe("escapeQueryRegex preserves the regex it is given", () => {
  // String.raw throughout: these assertions are ABOUT backslashes, and writing
  // them with ordinary escapes is how the first draft of this suite silently
  // tested "(d+)" and passed.
  test("escapeQueryValue destroys backslashes — the defect, pinned", () => {
    // Kept as a regression anchor: this is what consistency() and
    // recall(regex=) used to route their patterns through, which is why
    // "(\d+) migrations" silently matched nothing while "([0-9]+)" worked.
    expect(escapeQueryValue(String.raw`(\d+) migrations`)).toBe("( d+) migrations");
  });

  test("doubles backslashes, because Trilium's lexer eats one level", () => {
    expect(escapeQueryRegex(String.raw`(\d+) migrations`)).toBe(String.raw`(\\d+) migrations`);
    expect(escapeQueryRegex(String.raw`\bword\b`)).toBe(String.raw`\\bword\\b`);
  });

  test("escapes single quotes so the pattern cannot close its own token", () => {
    expect(escapeQueryRegex("it's")).toBe(String.raw`it\'s`);
  });

  test("leaves an ordinary pattern untouched", () => {
    expect(escapeQueryRegex("([0-9]+) Titan mailboxes")).toBe("([0-9]+) Titan mailboxes");
  });
});

describe("stripTagsWithMap", () => {
  test("a phrase split by an inline tag becomes findable", () => {
    const html = "<p>we run <strong>12</strong> mailboxes</p>";
    expect(/12 mailboxes/.test(html)).toBe(false);        // the defect
    expect(/12 mailboxes/.test(stripTagsWithMap(html).text)).toBe(true);
  });

  test("inline tags leave no gap, block tags leave a space", () => {
    expect(stripTagsWithMap("Brain<strong>LLM</strong>").text).toBe("BrainLLM");
    // Both the closing and the opening block tag emit a boundary, so two
    // paragraphs are separated by two spaces. What matters is that they are
    // separated at all — "foobar" is a phrase nobody wrote.
    expect(stripTagsWithMap("<p>foo</p><p>bar</p>").text.trim()).toBe("foo  bar");
    expect(stripTagsWithMap("<p>foo</p><p>bar</p>").text).not.toContain("foobar");
  });

  test("decodes entities so a pattern written in plain text matches", () => {
    expect(stripTagsWithMap("<p>a&nbsp;b &amp; c</p>").text).toContain("a b & c");
  });

  test("the map points back at the original body", () => {
    const html = "<p>we run <strong>12</strong> mailboxes</p>";
    const { text, map } = stripTagsWithMap(html);
    expect(map.length).toBe(text.length);
    const at = text.indexOf("12");
    expect(html.slice(map[at]!, map[at]! + 2)).toBe("12");
  });
});

describe("repairDoubleEscaping", () => {
  test("unwinds exactly one level", () => {
    expect(repairDoubleEscaping("&amp;lt;h2&amp;gt;")).toBe("&lt;h2&gt;");
    expect(repairDoubleEscaping("a&amp;nbsp;b")).toBe("a&nbsp;b");
    expect(repairDoubleEscaping("&amp;amp;")).toBe("&amp;");
  });

  test("leaves real markup and ordinary escaped ampersands alone", () => {
    expect(repairDoubleEscaping("<h2>fine</h2>")).toBe("<h2>fine</h2>");
    expect(repairDoubleEscaping("Tom &amp; Jerry")).toBe("Tom &amp; Jerry");
  });

  test("one pass only — a note documenting the signature is not turned into markup", () => {
    // Two levels deep stays escaped after a single call, deliberately.
    expect(repairDoubleEscaping("&amp;amp;lt;")).toBe("&amp;lt;");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// V10.3 Phase 2 — the read side.
// ─────────────────────────────────────────────────────────────────────────────

const DOC =
  "<h2>Overview</h2><p>top matter</p>" +
  "<h2>Plan</h2><p>lead</p><h3>Step one</h3><p>a</p><h3>Step two</h3><p>b</p>" +
  "<h2>Notes</h2><p>tail</p>";

describe("getSection — the read counterpart to setSection", () => {
  test("returns one section's body, excluding its own heading", () => {
    const r = getSection(DOC, "Overview");
    expect(r.matched).toBe(true);
    expect(r.content).toBe("<p>top matter</p>");
    expect(r.content).not.toContain("<h2>Overview</h2>");
  });

  test("a parent section carries its nested headings, and says so", () => {
    const r = getSection(DOC, "Plan");
    expect(r.matched).toBe(true);
    expect(r.content).toContain("Step one");
    expect(r.content).toContain("Step two");
    expect(r.content).not.toContain("tail");
    expect(r.subsections).toEqual(["Step one", "Step two"]);
  });

  test("reads a nested heading directly, stopping at the next sibling", () => {
    const r = getSection(DOC, "Step one");
    expect(r.content).toBe("<p>a</p>");
  });

  test("a miss returns available headings, not a whole-note fallback", () => {
    const r = getSection(DOC, "No Such Section");
    expect(r.matched).toBe(false);
    expect(r.content).toBe("");
    expect(r.available).toContain("Plan");
  });

  test("read and write agree — every name getSection matches, setSection matches", () => {
    // The contract that broke before: outline() printed names section= refused.
    // Both now go through locateSection, so this invariant is structural.
    const withMarkup = "<h3><code>recall(regex=)</code> — the defect</h3><p>x</p>";
    for (const h of headingOutline(withMarkup)) {
      expect(getSection(withMarkup, h.text).matched).toBe(true);
      expect(setSection(withMarkup, h.text, "<p>y</p>", "replace").matched).toBe(true);
    }
  });

  test("occurrence= picks among same-text headings", () => {
    const dupes = "<h3>Same</h3><p>one</p><h3>Same</h3><p>two</p>";
    expect(getSection(dupes, "Same").content).toBe("<p>one</p>");
    expect(getSection(dupes, "Same", 2).content).toBe("<p>two</p>");
    expect(getSection(dupes, "Same").headingCount).toBe(2);
  });
});

describe("setSection reports what a replace displaced", () => {
  test("replacing a parent names the nested headings that went with it", () => {
    const r = setSection(DOC, "Plan", "<p>new</p>", "replace");
    expect(r.matched).toBe(true);
    expect(r.replacedSubsections).toEqual(["Step one", "Step two"]);
    expect(r.html).not.toContain("Step one");
  });

  test("replacing a leaf displaces nothing", () => {
    expect(setSection(DOC, "Overview", "<p>new</p>", "replace").replacedSubsections).toBeUndefined();
  });
});

describe('setSection mode="remove"', () => {
  test("deletes the heading and its body", () => {
    const r = setSection(DOC, "Overview", "", "remove");
    expect(r.matched).toBe(true);
    expect(r.html).not.toContain("Overview");
    expect(r.html).not.toContain("top matter");
    expect(r.html).toContain("Plan");
  });

  test("takes nested subsections with it and names them", () => {
    const r = setSection(DOC, "Plan", "", "remove");
    expect(r.replacedSubsections).toEqual(["Step one", "Step two"]);
    expect(r.html).toContain("Overview");
    expect(r.html).toContain("Notes");
    expect(r.html).not.toContain("Step two");
  });

  test("a miss leaves the body ALONE — it must not create what it was asked to delete", () => {
    const r = setSection(DOC, "No Such Section", "", "remove");
    expect(r.matched).toBe(false);
    expect(r.html).toBe(DOC);
    expect(r.html).not.toContain("No Such Section");
  });
});

describe("headingOutline reports the stored form when it differs", () => {
  test("raw appears only for headings carrying inline markup", () => {
    const html = "<h3><code>recall(regex=)</code> — the defect</h3><h3>Plain</h3>";
    const [marked, plain] = headingOutline(html);
    expect(marked!.text).toBe("recall(regex=) — the defect");
    expect(marked!.raw).toBe("<code>recall(regex=)</code> — the defect");
    expect(plain!.raw).toBeUndefined();
  });
});

describe("nearestContext", () => {
  test("shows how the stored text actually differs", () => {
    const stored = '<code spellcheck="false">maintain(deep=true)</code> weekly';
    const near = nearestContext(stored, "<code>maintain(deep=true)</code>");
    expect(near).not.toBeNull();
    expect(near!.context).toContain("spellcheck");
  });

  test("finds the surviving fragment when the tail differs", () => {
    const near = nearestContext("<p>the quick brown fox jumps</p>", "the quick brown badger");
    expect(near!.fragment).toContain("the quick brown");
    expect(near!.context).toContain("fox");
  });

  test("null when nothing of the needle is present, rather than a misleading anchor", () => {
    expect(nearestContext("<p>alpha beta</p>", "zzzznotrealzzzz")).toBeNull();
  });
});

describe("addendumIndex", () => {
  test("indexes blocks by marker and identification line", () => {
    const child =
      "<p><em>threadEntry · 2026-08-16</em></p><hr>" +
      "<h2>Addendum — 13:35</h2><h3>Claude Sonnet 5 · Claude.ai · Interactive</h3><p>First point.</p>" +
      "<h2>Addendum — 13:40</h2><h3>Claude Opus 5 · Claude Code · Interactive</h3><p>Second point.</p>";
    const blocks = addendumIndex(child);
    expect(blocks).toHaveLength(2);
    expect(blocks[0]!.marker).toBe("Addendum — 13:35");
    expect(blocks[0]!.identity).toBe("Claude Sonnet 5 · Claude.ai · Interactive");
    expect(blocks[0]!.lead).toContain("First point");
    expect(blocks[1]!.identity).toBe("Claude Opus 5 · Claude Code · Interactive");
  });

  test("the old top-of-body preview was identical across children — this is not", () => {
    const header = "<p><em>threadEntry · 2026-08-16</em></p><hr>";
    const one = addendumIndex(header + "<h2>Addendum — 09:00</h2><h3>A · X · Y</h3><p>alpha</p>");
    const two = addendumIndex(header + "<h2>Addendum — 17:00</h2><h3>B · X · Y</h3><p>beta</p>");
    expect(one[0]!.marker).not.toBe(two[0]!.marker);
    expect(one[0]!.lead).not.toBe(two[0]!.lead);
  });

  test("empty for a note with no addendum blocks", () => {
    expect(addendumIndex("<h2>Context</h2><p>just a book</p>")).toEqual([]);
  });
});
