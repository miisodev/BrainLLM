import { describe, expect, test } from "bun:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerTools } from "./tools.js";
import { fitWithinBody } from "./elements.js";
import { renderMarkup, sanitizeHtml } from "./normalize.js";
import { EMPTY_BRAINLLM, type BrainLLMConfig } from "./config.js";
import type { TriliumClient, Note } from "./trilium.js";

// v13.3.4 — the three tool defects v13.3.3's release notes deferred:
//  1. revise(find=, within="td") with a plain-text body dropped the cell's
//     <td> wrapper, leaving a malformed row (2026-11-04); inspect(find=) also
//     truncated long stored rows at 600 characters;
//  2. a batch read returned an empty body for a non-empty note (2026-11-19);
//  3. an inline-code placeholder (`<ol start>` in backticks) was parsed as an
//     element in a mixed body (2026-11-09).

interface Seed {
  id: string;
  title: string;
  content?: string;
  labels?: Record<string, string>;
}

function fakeBrain(seeds: Seed[], contentResult?: (id: string) => string | object) {
  const notes = new Map<string, Note>();
  const contents = new Map<string, string>();
  let seq = 0;

  const mk = (id: string, title: string, labels: Record<string, string> = {}): Note => ({
    noteId: id, title, type: "text", mime: "text/html", isProtected: false,
    attributes: Object.entries(labels).map(([name, value], i) => ({
      attributeId: `${id}-${name}`, noteId: id, type: "label" as const, name, value, position: i, isInheritable: false,
    })),
    parentNoteIds: [], childNoteIds: [], parentBranchIds: [], childBranchIds: [],
    dateCreated: "2026-11-20 09:00:00.000+0200", dateModified: "2026-11-20 09:00:00.000+0200",
    utcDateCreated: "2026-11-20 07:00:00.000Z", utcDateModified: "2026-11-20 07:00:00.000Z",
  });

  for (const s of seeds) {
    notes.set(s.id, mk(s.id, s.title, s.labels ?? {}));
    contents.set(s.id, s.content ?? "");
  }

  const client = {
    async getNote(id: string) { const n = notes.get(id); if (!n) throw new Error(`404: ${id}`); return n; },
    async getNoteContent(id: string) { return contents.get(id) ?? ""; },
    async getNoteContentResult(id: string) { return contentResult ? contentResult(id) : (contents.get(id) ?? ""); },
    async getNoteAttachments() { return []; },
    async createRevision() { return { revisionId: `rev${++seq}`, noteId: "x" } as unknown as never; },
    async getNoteRevisions() { return []; },
    async getRevisionContent(revisionId: string) { throw new Error(`404 revision ${revisionId}`); },
    async updateNoteContent(id: string, text: string) { contents.set(id, text); },
    async updateLabelValue() {},
    async addLabel() {},
    async addRelation() { return null; },
    async searchNotes() { return { results: [] as Note[] }; },
    async createNote(parentNoteId: string, title: string, content: string) {
      const id = `n${++seq}`;
      const n = mk(id, title);
      notes.set(id, n);
      contents.set(id, content);
      return { note: n, branch: { branchId: `b${seq}` } };
    },
  };

  return { client: client as unknown as TriliumClient, notes, contents };
}

function setup(seeds: Seed[], contentResult?: (id: string) => string | object) {
  const brain = fakeBrain(seeds, contentResult);
  const cfg: BrainLLMConfig = {
    ...EMPTY_BRAINLLM,
    root: "root",
    memory: { ...EMPTY_BRAINLLM.memory, root: "memroot", sessions: "sessions", threads: "threads" },
    knowledge: { ...EMPTY_BRAINLLM.knowledge, root: "knowroot", domains: "domainsRoot" },
  };
  const server = new McpServer({ name: "BrainLLM", version: "0.0.0-test" });
  registerTools(server, brain.client, { config: cfg });
  const tools = (server as unknown as {
    _registeredTools: Record<string, { handler?: (...a: unknown[]) => Promise<{ content: Array<{ text: string }> }> }>;
  })._registeredTools;
  const call = async (name: string, args: object = {}) => {
    const out = await tools[name]!.handler!(args, {});
    return JSON.parse(out.content[0]!.text) as Record<string, unknown>;
  };
  return { ...brain, call };
}

describe("fitWithinBody — a plain within= body keeps its element's tag", () => {
  test("cell text is wrapped in the cell's own tag", () => {
    expect(fitWithinBody("New value", "td")).toBe("<td>New value</td>");
    expect(fitWithinBody("New value", "th")).toBe("<th>New value</th>");
  });

  test("a body that already opens with the right tag passes through untouched", () => {
    expect(fitWithinBody("<td>New value</td>", "td")).toBe("<td>New value</td>");
    expect(fitWithinBody("<tr><td>a</td></tr>", "tr")).toBe("<tr><td>a</td></tr>");
    expect(fitWithinBody("<p>x</p>", "p")).toBe("<p>x</p>");
  });

  test("a row of bare cells gains its <tr>; bare row text becomes one cell", () => {
    expect(fitWithinBody("<td>a</td><td>b</td>", "tr")).toBe("<tr><td>a</td><td>b</td></tr>");
    expect(fitWithinBody("Open", "tr")).toBe("<tr><td>Open</td></tr>");
  });

  test("other tags wrap; full-markup elements are written as given", () => {
    expect(fitWithinBody("x", "li")).toBe("<li>x</li>");
    expect(fitWithinBody("x", "blockquote")).toBe("<blockquote>x</blockquote>");
    expect(fitWithinBody("x", "table")).toBe("x");
    expect(fitWithinBody("x", "ul")).toBe("x");
  });
});

describe("revise(within='td') — the malformed-row defect", () => {
  const ROW = "<table><tbody><tr><td>Old value</td><td>Claude</td></tr></tbody></table>";

  test("a plain-text body stores a well-formed cell, not a bare text node", async () => {
    const t = setup([{ id: "reg1", title: "Register", content: ROW, labels: { noteType: "information" } }]);
    const res = await t.call("revise", { noteId: "reg1", find: "Old value", within: "td", body: "New value" });
    expect(res.ok).toBe(true);
    const stored = t.contents.get("reg1")!;
    expect(stored).toContain("<td>New value</td>");
    expect(stored).not.toMatch(/<tr>\s*New value/);
    // The row keeps its two cells.
    expect((stored.match(/<td>/g) ?? []).length).toBe(2);
  });

  test("a body already wrapped in <td> is written exactly as given", async () => {
    const t = setup([{ id: "reg1", title: "Register", content: ROW, labels: { noteType: "information" } }]);
    const res = await t.call("revise", { noteId: "reg1", find: "Old value", within: "td", body: "<td>New value</td>" });
    expect(res.ok).toBe(true);
    expect(t.contents.get("reg1")).toContain("<td>New value</td>");
  });

  test("a replace that would write back the same cell reports unchanged, no write", async () => {
    const t = setup([{ id: "reg1", title: "Register", content: ROW, labels: { noteType: "information" } }]);
    const res = await t.call("revise", { noteId: "reg1", find: "Old value", within: "td", body: "Old value" });
    expect(res.unchanged).toBe(true);
  });

  test("a plain-text row replace produces a one-cell row, not text inside <table>", async () => {
    const t = setup([{ id: "reg1", title: "Register", content: ROW, labels: { noteType: "information" } }]);
    const res = await t.call("revise", { noteId: "reg1", find: "Claude", within: "tr", body: "Open" });
    expect(res.ok).toBe(true);
    const stored = t.contents.get("reg1")!;
    expect(stored).toContain("<tr><td>Open</td></tr>");
    expect(stored).not.toMatch(/<\/tr>\s*Open|<tr>\s*Open\s*<\/tr>/);
  });

  test("the dry run previews the wrapped result before anything is written", async () => {
    const t = setup([{ id: "reg1", title: "Register", content: ROW, labels: { noteType: "information" } }]);
    const res = await t.call("revise", { noteId: "reg1", find: "Old value", within: "td", body: "New value", dryRun: true });
    expect(res.dryRun).toBe(true);
    expect(res.after).toBe("<td>New value</td>");
    expect(t.contents.get("reg1")).toBe(ROW);
  });
});

describe("inspect(find=) — the full stored element", () => {
  test("a long row is returned in full, not cut at 600 characters", async () => {
    const longCell = "x".repeat(900);
    const row = `<table><tbody><tr><td>${longCell}</td></tr></tbody></table>`;
    const t = setup([{ id: "reg1", title: "Register", content: row, labels: { noteType: "information" } }]);
    const res = await t.call("inspect", { noteId: "reg1", find: "xxx" });
    const report = res.findReport as { matches: Array<{ stored: string; storedTruncated?: boolean }> };
    expect(report.matches[0]!.stored).toContain(longCell);
    expect(report.matches[0]!.storedTruncated).toBeUndefined();
  });

  test("a pathological element is bounded and says so", async () => {
    const hugeCell = "y".repeat(6_000);
    const row = `<table><tbody><tr><td>${hugeCell}</td></tr></tbody></table>`;
    const t = setup([{ id: "reg1", title: "Register", content: row, labels: { noteType: "information" } }]);
    const res = await t.call("inspect", { noteId: "reg1", find: "yyy" });
    const report = res.findReport as { matches: Array<{ stored: string; storedTruncated?: boolean; storedBytes?: number }> };
    expect(report.matches[0]!.storedTruncated).toBe(true);
    expect(report.matches[0]!.storedBytes).toBeGreaterThan(6_000);
  });
});

describe("read(ids) — an empty body is never silent", () => {
  test("an empty read carries emptyContent and a verify hint", async () => {
    const t = setup([{ id: "note0001", title: "Empty note" }]);
    const res = await t.call("read", { ids: ["note0001"] });
    const entry = (res.notes as Array<Record<string, unknown>>)[0]!;
    expect(entry.content).toBe("");
    expect(entry.emptyContent).toBe(true);
    expect(entry.hint).toContain("inspect");
  });

  test("a non-empty read carries no marker", async () => {
    const t = setup([{ id: "note0001", title: "Full note", content: "<p>3,022 characters of method</p>" }]);
    const res = await t.call("read", { ids: ["note0001"] });
    const entry = (res.notes as Array<Record<string, unknown>>)[0]!;
    expect(entry.content).toContain("3,022");
    expect(entry.emptyContent).toBeUndefined();
  });
});

describe("inline code spans — the placeholder-parsing defect", () => {
  test("a tag-shaped placeholder in backticks stores as text in a mixed body", () => {
    // A body carrying a real tag takes the mixed path; the span must survive it.
    const { html } = renderMarkup("<p>keep</p>\n\na numbered `<ol start>` changes the list");
    expect(html).toContain("<code>&lt;ol start&gt;</code>");
    expect(html).not.toMatch(/<ol[\s>]/);
    expect(html).not.toContain("</ol>");
  });

  test("a pure markdown body with the span takes the same path and stays text", () => {
    // looksLikeStructuralHtml sees the tag-shaped text inside the backticks;
    // the span must still be literal, not markup.
    const { html } = renderMarkup("a numbered `<ol start>` changes the list");
    expect(html).toContain("<code>&lt;ol start&gt;</code>");
    expect(html).not.toMatch(/<ol[\s>]/);
    expect(html).not.toContain("</ol>");
  });

  test("the stored form is sanitize-quiet and idempotent", () => {
    const { html } = renderMarkup("<p>keep</p>\n\na numbered `<ol start>` changes the list");
    const again = sanitizeHtml(html);
    expect(again.warnings).toEqual([]);
    expect(again.html).toBe(html);
  });

  test("a code span inside a fenced block stays literal fence content", () => {
    const body = "```\nuse `<ol start>` here\n```";
    const { html } = renderMarkup(body);
    expect(html).toContain("<pre><code>");
    expect(html).not.toMatch(/<ol[\s>]/);
  });

  test("a real tag outside the span is still kept as markup", () => {
    const { html } = renderMarkup("<p><strong>bold</strong></p>\n\na numbered `<ol start>` changes");
    expect(html).toContain("<strong>bold</strong>");
    expect(html).toContain("<code>&lt;ol start&gt;</code>");
  });
});
