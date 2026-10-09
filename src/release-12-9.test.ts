import { describe, expect, test } from "bun:test";
import { renderBody, sanitizeHtml, tableShapeIssues, identityProblem, structureReport, visibleTextSpans, closedBlockTag, triliumSearchForm } from "./normalize.js";
import { editWithin } from "./elements.js";
import { applyFindEdit } from "./tools.js";
import { sealText, sealRecord, recordIntact, dayDigest } from "./seal.js";

describe("find and within", () => {
  const table =
    "<table><thead><tr><th>Item</th><th>Owner</th><th>State</th></tr></thead><tbody>" +
    "<tr><td><strong>Phase 2</strong></td><td>Claude</td><td>Open</td></tr>" +
    "<tr><td>Phase 3</td><td>Miiso</td><td>Done</td></tr></tbody></table>";

  test("within=tr matches a row by its visible text, pipes as cell boundaries", () => {
    const hits = visibleTextSpans(table, "Phase 2 | Claude | Open", "tr");
    expect(hits.length).toBe(1);
    const r = editWithin(table, hits, "tr", "remove", "");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.html).not.toContain("Phase 2");
      expect(r.html).toContain("Phase 3");
    }
  });

  test("quotes match in any spelling", () => {
    const html = "<p>He said “ship it” today.</p>";
    expect(applyFindEdit(html, 'said "ship it" today', "said ok today")?.html).toBe("<p>He said ok today.</p>");
    expect(applyFindEdit(html, 'said \\"ship it\\" today', "x")).not.toBeNull();
  });

  test("closedBlockTag names the element a find closes", () => {
    expect(closedBlockTag("Phase 2</strong></li>")).toBe("li");
    expect(closedBlockTag("plain text")).toBeNull();
  });
});

describe("triliumSearchForm", () => {
  test("drops the middle dot and accents the way Trilium's content normaliser does", () => {
    expect(triliumSearchForm("Thalia · 2026")).toBe("Thalia  2026");
    expect(triliumSearchForm("café")).toBe("cafe");
  });
  test("keeps the em dash, which is not a diacritic, and ASCII regex syntax", () => {
    expect(triliumSearchForm("Build — Thalia")).toBe("Build — Thalia");
    expect(triliumSearchForm("^Run `x` \\d+")).toBe("^Run `x` \\d+");
  });
});

describe("record seals", () => {
  test("appends keep a record intact; rewrites do not", () => {
    const sealed = sealRecord(sealText("<h2>Addendum — 09:00</h2><p>First block.</p>"));
    expect(recordIntact(sealText("<h2>Addendum — 09:00</h2><p>First block.</p><h2>Addendum — 14:00</h2><p>Later.</p>"), sealed)).toBe(true);
    expect(recordIntact(sealText("<h2>Addendum — 09:00</h2><p>First block, edited.</p>"), sealed)).toBe(false);
  });

  test("markup re-serialization is not a change", () => {
    const sealed = sealRecord(sealText("<p>a &amp; b</p>"));
    expect(recordIntact(sealText('<p spellcheck="false">a &amp; b</p>'), sealed)).toBe(true);
  });

  test("the digest chains and is order-independent over records", () => {
    const a = dayDigest("genesis", "2026-10-09", { x: [3, "aa"], y: [4, "bb"] });
    const b = dayDigest("genesis", "2026-10-09", { y: [4, "bb"], x: [3, "aa"] });
    expect(a).toBe(b);
    expect(dayDigest("other", "2026-10-09", { x: [3, "aa"], y: [4, "bb"] })).not.toBe(a);
  });
});

describe("placeholders never truncate a body", () => {
  test("a markdown body naming <template> keeps everything after it", () => {
    const r = renderBody("Fill in <template> first.\n\nThen the **second** paragraph survives.");
    expect(r.html).toContain("&lt;template&gt;");
    expect(r.html).toContain("second</strong> paragraph survives");
  });

  test("an HTML body with a stray placeholder keeps its tail", () => {
    const r = renderBody("<p>Use <select> here.</p><p>Tail paragraph.</p>");
    expect(r.html).toContain("Tail paragraph.");
    expect(r.html).toContain("&lt;select&gt;");
  });

  test("mixed bodies escape non-structural tags in their markdown runs", () => {
    const r = renderBody("<p>Lead.</p>\nWrite <title> and <form> as needed.\n\nMore text.");
    expect(r.html).toContain("&lt;title&gt;");
    expect(r.html).toContain("&lt;form&gt;");
    expect(r.html).toContain("More text.");
  });

  test("an unclosed script still takes its code with it, and says how much", () => {
    const r = sanitizeHtml("<p>before</p><script>alert(1)");
    expect(r.html).not.toContain("alert");
    expect(r.warnings.join(" ")).toMatch(/characters removed/);
  });

  test("a closed forbidden block is still removed whole", () => {
    const r = sanitizeHtml("<p>a</p><form><p>x</p></form><p>b</p>");
    expect(r.html).not.toContain("x</p>");
    expect(r.html).toContain("<p>b</p>");
  });
});

describe("tableShapeIssues", () => {
  const head = "<table><thead><tr><th>Item</th><th>Owner</th><th>State</th></tr></thead><tbody>";
  test("a row with pipes inside one cell is named", () => {
    const issues = tableShapeIssues(`${head}<tr><td>Thing | Claude | Open</td></tr></tbody></table>`);
    expect(issues.length).toBe(1);
    expect(issues[0]).toContain("1 cell(s), its header has 3");
  });
  test("a well-formed table is clean, colspan counted", () => {
    expect(tableShapeIssues(`${head}<tr><td>a</td><td>b</td><td>c</td></tr><tr><td colspan="3">wide</td></tr></tbody></table>`)).toEqual([]);
  });
  test("rowspan covers the cells of the rows below it", () => {
    const kinds =
      "<table><thead><tr><th>Area</th><th>Kinds</th><th>Behaviour</th></tr></thead><tbody>" +
      '<tr><td>Master</td><td>biography</td><td rowspan="2">Singletons</td></tr>' +
      "<tr><td>LLM</td><td>diary</td></tr>" +
      "<tr><td>Memory</td><td>session</td><td>Records</td></tr></tbody></table>";
    expect(tableShapeIssues(kinds)).toEqual([]);
    // Once the span ends, a short row is short again.
    expect(tableShapeIssues(kinds.replace("<td>Records</td>", ""))).toEqual(['row "Memory" has 2 cell(s), its header has 3']);
  });
  test("structureReport carries the finding", () => {
    expect(structureReport(`${head}<tr><td>a</td></tr></tbody></table>`).tableShape.length).toBe(1);
  });
});

describe("identityProblem", () => {
  test("accepts the canonical shapes", () => {
    expect(identityProblem("Claude Opus 5.5 · Claude Code · Interactive")).toBeNull();
    expect(identityProblem("Claude Opus 5.5 · Claude Code · Theron · Run 2")).toBeNull();
  });
  test("refuses the overnight draft line", () => {
    expect(identityProblem("Addendum — 07:30? Actually compute later — R6 · Open items")).not.toBeNull();
  });
  test("refuses too few parts and empty parts", () => {
    expect(identityProblem("Claude · Code")).toContain("at least three");
    expect(identityProblem("Claude ·  · Code")).toContain("at least three");
  });
});
