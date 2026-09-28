import { describe, expect, test } from "bun:test";
import { renderBody, looksLikeHtml } from "./normalize.js";

// CKEditor-native bodies. A body that mixed an HTML block with markdown used to
// be stored whole as HTML: the markdown sat in the note as literal asterisks
// and dashes, and a placeholder like <venture> was deleted as an "unsupported
// element". Both were found in use (diary, 2026-09-26).

describe("mixed HTML and markdown bodies become native HTML", () => {
  test("markdown after an HTML block is converted, with a receipt note", () => {
    const { html, warnings } = renderBody("<p>Intro.</p>\n- **one**\n- two");
    expect(html).toContain("<p>Intro.</p>");
    expect(html).toContain("<ul><li><strong>one</strong></li><li>two</li></ul>");
    expect(html).not.toContain("**");
    expect(warnings.some((w) => w.startsWith("Converted 1 text run"))).toBe(true);
  });

  test("real inline tags inside a converted run stay markup", () => {
    const { html } = renderBody("<h2>Setup</h2>\n- run <code>bun test</code> first\n- see <a href=\"https://example.com\">docs</a>");
    expect(html).toContain("<li>run <code>bun test</code> first</li>");
    expect(html).toContain('<a href="https://example.com">docs</a>');
  });

  test("a fenced block in a converted run shows its tags as text", () => {
    const { html } = renderBody("<p>Example:</p>\n```\n<b>bold</b>\n```");
    expect(html).toContain("<pre><code>&lt;b&gt;bold&lt;/b&gt;</code></pre>");
  });

  test("text inside an open block is never reinterpreted", () => {
    const body = "<pre><code>- not a list\n\n**not bold**</code></pre>";
    const { html, warnings } = renderBody(body);
    expect(html).toBe(body);
    expect(warnings.some((w) => w.startsWith("Converted"))).toBe(false);
  });

  test("a caller's NUL characters cannot collide with protected inline tags", () => {
    const { html } = renderBody("<p>x</p>\n- <code>a</code> then \u00000\u0000 again");
    expect(html).toBe("<p>x</p>\n<ul><li><code>a</code> then 0 again</li></ul>");
  });

  test("a pure-HTML body passes through without a conversion note", () => {
    const body = "<h2>A</h2>\n\n<p>One.</p>\n<ul><li>x</li></ul>";
    const { html, warnings } = renderBody(body);
    expect(html).toBe(body);
    expect(warnings).toEqual([]);
  });
});

describe("placeholders are prose, not markup", () => {
  test("a markdown body with a placeholder stays markdown and keeps it as text", () => {
    expect(looksLikeHtml("Mirror to Docs/<venture>/ nightly")).toBe(false);
    const { html } = renderBody("Mirror to **Docs/<venture>/** nightly");
    expect(html).toBe("<p>Mirror to <strong>Docs/&lt;venture&gt;/</strong> nightly</p>");
  });

  test("a placeholder inside HTML is kept as text, with a receipt note", () => {
    const { html, warnings } = renderBody("<p>Mirror to Docs/<venture>/ nightly</p>");
    expect(html).toBe("<p>Mirror to Docs/&lt;venture&gt;/ nightly</p>");
    expect(warnings).toContain("Kept <venture> as text — not an HTML element");
  });

  test("a real element the editor cannot hold is still stripped", () => {
    const { html, warnings } = renderBody("<section><p>kept</p></section>");
    expect(html).toBe("<p>kept</p>");
    expect(warnings).toContain("Stripped unsupported <section> element");
  });
});
