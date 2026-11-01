import { describe, expect, test } from "bun:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerTools } from "./tools.js";
import { editWithin, pipeParagraphHint } from "./elements.js";
import { identityAuthor, identityRun, identityHeadings, upsertTableRow } from "./normalize.js";
import { EMPTY_BRAINLLM, type BrainLLMConfig } from "./config.js";
import type { TriliumClient, Note } from "./trilium.js";

// v13.2.0 — the team's asks from the 2026-10-29 → 2026-11-01 diaries:
//  1. within= all=true acts on every element an anchor sits in;
//  2. revision[].from= renames a Sources key when a source moves;
//  3. a dated-thread append names the author's previous block (and its Run N);
//  4. read(ids, sizes=true) plans a bulk read without the bodies;
//  5. Sources receipts stop echoing a long key list; the dry run warns about
//     loose prose before it lands;
//  6. diff(since, summaryOnly=true) lists changed notes without their lines;
//  7. a within="tr" anchor inside a "a | b | c" paragraph says what it is.

interface Seed {
  id: string;
  title: string;
  content?: string;
  labels?: Record<string, string>;
  parent?: string;
  revisions?: Array<{ revisionId: string; dateCreated: string; content: string }>;
}

function fakeBrain(seeds: Seed[]) {
  const notes = new Map<string, Note>();
  const contents = new Map<string, string>();
  const revisionStore = new Map<string, Array<{ revisionId: string; dateCreated: string; content: string }>>();
  const log = { revisions: [] as string[], contentWrites: [] as string[], reads: [] as string[] };
  let seq = 0;

  const mk = (id: string, title: string, labels: Record<string, string> = {}, parentNoteIds: string[] = []): Note => ({
    noteId: id, title, type: "text", mime: "text/html", isProtected: false,
    attributes: Object.entries(labels).map(([name, value], i) => ({
      attributeId: `${id}-${name}`, noteId: id, type: "label" as const, name, value, position: i, isInheritable: false,
    })),
    parentNoteIds, childNoteIds: [], parentBranchIds: [], childBranchIds: [],
    dateCreated: "2026-10-15 09:00:00.000+0200", dateModified: "2026-11-01 09:00:00.000+0200",
    utcDateCreated: "2026-10-15 07:00:00.000Z", utcDateModified: "2026-11-01 07:00:00.000Z",
  });
  const ownLabel = (n: Note, name: string) =>
    n.attributes.find((a) => a.type === "label" && a.name === name && a.noteId === n.noteId)?.value;

  for (const s of seeds) {
    notes.set(s.id, mk(s.id, s.title, s.labels, s.parent ? [s.parent] : []));
    contents.set(s.id, s.content ?? "");
    if (s.revisions) revisionStore.set(s.id, s.revisions);
  }

  const client = {
    async getNote(id: string) { const n = notes.get(id); if (!n) throw new Error(`404: ${id}`); return n; },
    async getNoteContent(id: string) { log.reads.push(id); return contents.get(id) ?? ""; },
    async getNoteContentResult(id: string) { return contents.get(id) ?? ""; },
    async createRevision(id: string) { log.revisions.push(id); return { revisionId: `rev${++seq}`, noteId: id } as unknown as never; },
    async getNoteRevisions(id: string) {
      return (revisionStore.get(id) ?? []).map((r) => ({ revisionId: r.revisionId, dateCreated: r.dateCreated, contentLength: r.content.length }));
    },
    async getRevisionContent(revisionId: string) {
      for (const list of revisionStore.values()) for (const r of list) if (r.revisionId === revisionId) return r.content;
      throw new Error(`404 revision ${revisionId}`);
    },
    async updateNoteContent(id: string, text: string) { log.contentWrites.push(id); contents.set(id, text); },
    async updateLabelValue(id: string, name: string, value: string) {
      const n = notes.get(id);
      if (!n) return;
      const a = n.attributes.find((x) => x.type === "label" && x.name === name && x.noteId === id);
      if (a) a.value = value;
      else n.attributes.push({ attributeId: `${id}-${name}`, noteId: id, type: "label", name, value, position: 0, isInheritable: false });
    },
    async addLabel(id: string, name: string, value = "") { await client.updateLabelValue(id, name, value); },
    async addRelation() { return null; },
    async searchNotes(query: string, opts?: { ancestorNoteId?: string }) {
      const kind = /#noteType=([\w]+)/.exec(query)?.[1];
      const created = /#created='([^']+)'/.exec(query)?.[1];
      const domain = /#domain='([^']+)'/.exec(query)?.[1];
      const hits = [...notes.values()].filter((n) => {
        if (kind && ownLabel(n, "noteType") !== kind) return false;
        if (created && ownLabel(n, "created") !== created) return false;
        if (domain && ownLabel(n, "domain") !== domain) return false;
        if (kind === "threadEntry" && opts?.ancestorNoteId && !n.parentNoteIds.includes(opts.ancestorNoteId)) return false;
        return true;
      });
      return { results: hits };
    },
    async createNote(parentNoteId: string, title: string, content: string) {
      const id = `n${++seq}`;
      const n = mk(id, title, {}, [parentNoteId]);
      notes.set(id, n);
      contents.set(id, content);
      return { note: n, branch: { branchId: `b${seq}` } };
    },
  };

  return { client: client as unknown as TriliumClient, notes, contents, log };
}

function setup(seeds: Seed[]) {
  const brain = fakeBrain(seeds);
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

const REVISION_NOTE =
  "<h2>Sources</h2><ul><li>Old docs — the old site</li></ul><h2>Revision</h2>" +
  "<table><thead><tr><th>Source</th><th>Marker</th><th>Date</th></tr></thead><tbody>" +
  "<tr><td>Old docs</td><td>✅</td><td>2026-10-01</td></tr>" +
  "<tr><td>Stale mirror A</td><td>❇️</td><td>2026-09-01</td></tr>" +
  "<tr><td>Stale mirror B</td><td>❇️</td><td>2026-09-02</td></tr>" +
  "<tr><td>Keep me</td><td>✅</td><td>2026-10-02</td></tr>" +
  "</tbody></table>";

describe("editWithin(all) — every element an anchor sits in", () => {
  const html = "<table><tbody><tr><td>Stale A</td></tr><tr><td>Keep</td></tr><tr><td>Stale B</td></tr></tbody></table>";
  const hits = [...html.matchAll(/Stale/g)].map((m) => ({ start: m.index!, length: 5 }));

  test("without all, two rows are ambiguous; with it, both go and the rest stays", () => {
    expect(editWithin(html, hits, "tr", "remove", "").ok).toBe(false);
    const res = editWithin(html, hits, "tr", "remove", "", undefined, true);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.matches).toBe(2);
    expect(res.html).toBe("<table><tbody><tr><td>Keep</td></tr></tbody></table>");
  });

  test("replace and insert apply to each element, offsets intact", () => {
    const res = editWithin(html, hits, "tr", "after", "<tr><td>+</td></tr>", undefined, true);
    expect(res.ok && res.html.split("<td>+</td>").length).toBe(3);
  });

  test("a nested match is covered by its outer element, never edited twice", () => {
    const nested = "<ul><li>Stale <ul><li>Stale inner</li></ul></li><li>Keep</li></ul>";
    const h = [...nested.matchAll(/Stale/g)].map((m) => ({ start: m.index!, length: 5 }));
    const res = editWithin(nested, h, "li", "remove", "", undefined, true);
    expect(res.ok && res.matches).toBe(1);
    expect(res.ok && res.html).toBe("<ul><li>Keep</li></ul>");
  });
});

describe("revise within= all=true", () => {
  const seed = () => setup([{ id: "src1", title: "Sources", labels: { noteType: "sources" }, content: REVISION_NOTE }]);

  test("the dry run lists every row it would remove and writes nothing", async () => {
    const { call, contents, log } = seed();
    const r = await call("revise", { noteId: "src1", find: "Stale mirror", within: "tr", mode: "remove", all: true, dryRun: true });
    expect(r.ok).toBe(true);
    expect(r.matchedElements).toBe(2);
    expect((r.elements as string[]).join(" ")).toContain("Stale mirror B");
    expect(contents.get("src1")).toBe(REVISION_NOTE);
    expect(log.revisions).toEqual([]);
  });

  test("the real run removes both rows in one revision and one write", async () => {
    const { call, contents, log } = seed();
    const r = await call("revise", { noteId: "src1", find: "Stale mirror", within: "tr", mode: "remove", all: true });
    expect(r.ok).toBe(true);
    expect(r.elements).toBe(2);
    expect(contents.get("src1")).not.toContain("Stale mirror");
    expect(contents.get("src1")).toContain("Keep me");
    expect(log.revisions).toEqual(["src1"]);
    expect(log.contentWrites).toEqual(["src1"]);
  });

  test("an ambiguous anchor's hint now names all=true", async () => {
    const { call } = seed();
    const r = await call("revise", { noteId: "src1", find: "Stale mirror", within: "tr", mode: "remove" });
    expect(r.reason).toBe("ambiguous");
    expect(String(r.hint)).toContain("all=true");
  });

  test("all= refuses nth=, closure= and a missing within=", async () => {
    const { call } = seed();
    expect((await call("revise", { noteId: "src1", find: "Stale", within: "tr", mode: "remove", all: true, nth: 1 })).error).toBe("conflicting_params");
    expect((await call("revise", { noteId: "src1", find: "Stale", all: true, body: "x" })).error).toBe("conflicting_params");
    expect((await call("revise", {
      noteId: "src1", find: "Stale", within: "tr", mode: "remove", all: true,
      closure: { thread: "Escalations", body: "x" }, identity: "Claude · Test · Unit",
    })).error).toBe("conflicting_params");
  });
});

describe("pipe-delimited paragraphs are named for what they are", () => {
  test("the hint fires for a roster line, not for ordinary prose", () => {
    const roster = "<p>Facebook | myClerkBook | 2 followers</p>";
    const at = roster.indexOf("Facebook");
    expect(pipeParagraphHint(roster, [{ start: at, length: 8 }], "tr")).toContain('within="p"');
    const prose = "<p>Facebook is quiet</p>";
    expect(pipeParagraphHint(prose, [{ start: 3, length: 8 }], "tr")).toBeNull();
    expect(pipeParagraphHint(roster, [{ start: at, length: 8 }], "li")).toBeNull();
  });

  test("revise within=tr on a roster line returns that hint", async () => {
    const { call } = setup([{ id: "mc", title: "Marketing Channels", content: "<h2>Roster</h2><p>Facebook | myClerkBook | 2 followers</p>" }]);
    const r = await call("revise", { noteId: "mc", find: "Facebook", within: "tr", mode: "after", body: "<tr><td>x</td></tr>" });
    expect(r.reason).toBe("no_element");
    expect(String(r.hint)).toContain("\"|\" separators");
  });
});

describe("Sources key rename — revision[].from", () => {
  test("upsertTableRow rekeys the matched row and never creates on a miss", () => {
    const out = upsertTableRow(REVISION_NOTE, "Revision", "New docs", ["✅", "2026-11-01"], "Old docs");
    expect(out.matched).toBe(true);
    expect(out.html).toContain("<tr><td>New docs</td><td>✅</td><td>2026-11-01</td></tr>");
    expect(out.html).not.toContain("<td>Old docs</td>");
    const miss = upsertTableRow(REVISION_NOTE, "Revision", "New docs", ["✅", "2026-11-01"], "Nowhere");
    expect(miss.matched || miss.created).toBe(false);
    expect(miss.html).toBe(REVISION_NOTE);
  });

  const seed = () =>
    setup([
      { id: "dom", title: "Acme", labels: { noteType: "domain", domain: "acme" }, parent: "domainsRoot" },
      { id: "src1", title: "Sources", labels: { noteType: "sources" }, content: REVISION_NOTE, parent: "dom" },
    ]);

  test("remember(sources) renames the row in place", async () => {
    const { call, contents } = seed();
    const r = await call("remember", { kind: "sources", domain: "Acme", revision: [{ source: "New docs", from: "Old docs", marker: "✅", date: "2026-11-01" }] });
    expect(r.revision).toEqual(["renamed: Old docs → New docs"]);
    const html = contents.get("src1")!;
    expect(html).toContain("<td>New docs</td>");
    expect(html).not.toContain("<td>Old docs</td>");
    expect(html.match(/<tr>/g)!.length).toBe(5); // header + four rows, none added
  });

  test("the dry run previews the rename; refusals name their cause and write nothing", async () => {
    const { call, contents, log } = seed();
    const dry = await call("remember", { kind: "sources", domain: "Acme", dryRun: true, revision: [{ source: "New docs", from: "Old docs", marker: "✅" }] });
    expect(dry.revision).toEqual(["would rename: Old docs → New docs"]);
    expect(contents.get("src1")).toBe(REVISION_NOTE);
    const refused = await call("remember", {
      kind: "sources", domain: "Acme",
      revision: [{ source: "Keep me", from: "Old docs", marker: "✅" }, { source: "X", from: "Nowhere", marker: "✅" }],
    });
    expect((refused.refused as string[]).length).toBe(2);
    expect((refused.refused as string[])[0]).toContain("already has a row");
    expect((refused.refused as string[])[1]).toContain("no Revision row");
    expect(contents.get("src1")).toBe(REVISION_NOTE);
    expect(log.revisions).toEqual([]);
  });

  test("the dry run warns before a loose prose body lands", async () => {
    const { call } = seed();
    const dry = await call("remember", { kind: "sources", domain: "Acme", dryRun: true, body: "<p>Some loose remark about a source</p>" });
    expect(String(dry.placementHint)).toContain("loose block");
  });

  test("an add beside a long key list sends a note, not the whole list", async () => {
    const rows = Array.from({ length: 40 }, (_, i) => `<tr><td>Source ${i}</td><td>✅</td><td>2026-10-01</td></tr>`).join("");
    const big = `<h2>Sources</h2><ul><li>x</li></ul><h2>Revision</h2><table><thead><tr><th>Source</th><th>Marker</th><th>Date</th></tr></thead><tbody>${rows}</tbody></table>`;
    const { call } = setup([
      { id: "dom", title: "Acme", labels: { noteType: "domain", domain: "acme" }, parent: "domainsRoot" },
      { id: "src1", title: "Sources", labels: { noteType: "sources" }, content: big, parent: "dom" },
    ]);
    const r = await call("remember", { kind: "sources", domain: "Acme", revision: [{ source: "Brand new thing", marker: "❇️" }] });
    expect(r.revision).toEqual(["added: Brand new thing"]);
    expect(r.revisionKeys).toBeUndefined();
    expect(r.revisionRows).toBe(41);
    expect(String(r.revisionKeysNote)).toContain("40 existing keys");
  });
});

describe("previous same-author block on a dated-thread append", () => {
  test("identity helpers separate the author from its run number", () => {
    expect(identityAuthor("Claude Opus 5.5 · Claude Code desktop · Theron · Run 18"))
      .toBe(identityAuthor("Claude Opus 5.5 ·  Claude Code desktop · Theron · Run 17"));
    expect(identityAuthor("Claude · Desk · Theron")).not.toBe(identityAuthor("Claude · Desk · Thalia · Run 2"));
    expect(identityRun("Claude · Desk · Theron · Run 18")).toBe(18);
    expect(identityRun("Claude · Desk · Theron")).toBeNull();
    expect(identityHeadings("<h2>Addendum — 05:00</h2><h3>A · B · C</h3><p>x</p><h2>Addendum — 06:00</h2>\n<h3>D · E · F</h3>"))
      .toEqual(["A · B · C", "D · E · F"]);
  });

  const day = (d: string, blocks: string[]) =>
    `<p><em>threadEntry · ${d}</em></p>` + blocks.map((b, i) => `<h2>Addendum — 0${i + 5}:00</h2>\n<h3>${b}</h3><p>work</p>`).join("");

  test("a Run N append finds the author's last run on an earlier day", async () => {
    const { call } = setup([
      { id: "th", title: "myClerkBook", labels: { noteType: "thread" } },
      { id: "e1", title: "[2026-10-30]", labels: { noteType: "threadEntry", created: "2026-10-30" }, parent: "th", content: day("2026-10-30", ["Claude · Desk · Theron · Run 16"]) },
      { id: "e2", title: "[2026-10-31]", labels: { noteType: "threadEntry", created: "2026-10-31" }, parent: "th", content: day("2026-10-31", ["Claude · Desk · Theron · Run 17", "Claude · Desk · Thalia · Run 17"]) },
    ]);
    const r = await call("remember", { kind: "thread", title: "myClerkBook", identity: "Claude · Desk · Theron · Run 18", body: "<p>Run 18.</p>", date: "2026-11-01" });
    expect(r.previousRun).toEqual({ heading: "Claude · Desk · Theron · Run 17", date: "2026-10-31", run: 17 });
  });

  test("today's own earlier block wins without reading other days", async () => {
    const { call, log } = setup([
      { id: "th", title: "Build", labels: { noteType: "thread" } },
      { id: "e1", title: "[2026-10-31]", labels: { noteType: "threadEntry", created: "2026-10-31" }, parent: "th", content: day("2026-10-31", ["Claude · Desk · Theron · Run 2"]) },
      { id: "e2", title: "[2026-11-01]", labels: { noteType: "threadEntry", created: "2026-11-01" }, parent: "th", content: day("2026-11-01", ["Claude · Desk · Theron · Run 3"]) },
    ]);
    const r = await call("remember", { kind: "thread", title: "Build", identity: "Claude · Desk · Theron · Run 4", body: "<p>More.</p>", date: "2026-11-01" });
    expect(r.previousRun).toEqual({ heading: "Claude · Desk · Theron · Run 3", date: "2026-11-01", run: 3 });
    expect(log.reads).not.toContain("e1");
  });

  test("an identity without Run N looks only at today, and a first block reports nothing", async () => {
    const { call, log } = setup([
      { id: "th", title: "Build", labels: { noteType: "thread" } },
      { id: "e1", title: "[2026-10-31]", labels: { noteType: "threadEntry", created: "2026-10-31" }, parent: "th", content: day("2026-10-31", ["Claude · Desk · Release"]) },
    ]);
    const r = await call("remember", { kind: "thread", title: "Build", identity: "Claude · Desk · Release", body: "<p>New.</p>", date: "2026-11-01" });
    expect(r.previousRun).toBeUndefined();
    expect(log.reads).not.toContain("e1");
  });
});

describe("read(ids, sizes=true)", () => {
  const body = "<h2>Open</h2><p>" + "x".repeat(500) + "</p><h3>Detail</h3><p>y</p><h2>Closed</h2><p>z</p>";

  test("returns sizes and headings with section sizes, no bodies", async () => {
    const { call } = setup([{ id: "big", title: "Backlog", labels: { noteType: "information" }, content: body }]);
    const r = await call("read", { ids: ["big"], sizes: true });
    const n = (r.notes as Array<Record<string, unknown>>)[0]!;
    expect(n.chars).toBe(body.length);
    expect(n.content).toBeUndefined();
    const headings = n.headings as Array<{ heading: string; level: number; chars: number }>;
    expect(headings.map((h) => h.heading)).toEqual(["Open", "Detail", "Closed"]);
    expect(headings[0]!.chars).toBeGreaterThan(500);
  });

  test("sizes= does not combine with section= or text=", async () => {
    const { call } = setup([{ id: "big", title: "Backlog", content: body }]);
    expect((await call("read", { ids: ["big"], sizes: true, section: "Open" })).error).toBe("conflicting_params");
  });
});

describe("diff(since, summaryOnly=true)", () => {
  test("lists each changed note with writes and size change, no lines", async () => {
    const { call } = setup([
      {
        id: "cs", title: "Current State", labels: { noteType: "information" }, content: "<p>after, longer body</p>",
        revisions: [{ revisionId: "r1", dateCreated: "2026-11-01 08:00:00.000+0200", content: "<p>before</p>" }],
      },
    ]);
    const r = await call("diff", { since: "2026-11-01", summaryOnly: true });
    const n = (r.notes as Array<Record<string, unknown>>)[0]!;
    expect(n.writes).toBe(1);
    expect(n.sizeChange).toBe("<p>after, longer body</p>".length - "<p>before</p>".length);
    expect(n.added).toBeUndefined();
    expect(n.removed).toBeUndefined();
  });

  test("summaryOnly= needs since= without noteId", async () => {
    const { call } = setup([{ id: "cs", title: "Current State", content: "<p>x</p>" }]);
    expect((await call("diff", { noteId: "cs", since: "today", summaryOnly: true })).error).toBe("conflicting_params");
    expect((await call("diff", { noteId: "cs", summaryOnly: true })).error).toBe("conflicting_params");
  });
});
