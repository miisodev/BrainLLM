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
} from "./normalize.js";

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
