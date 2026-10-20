import { describe, expect, test } from "bun:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerTools } from "./tools.js";
import { EMPTY_BRAINLLM, type BrainLLMConfig } from "./config.js";
import type { TriliumClient, Note } from "./trilium.js";

// v13.0.0 — the revise edit-safety surface:
//  1. within= dry runs (a stored "paragraph" holding eight logical paragraphs
//     went in one removal, 2026-10-12);
//  2. find= receipts on text another agent has drifted;
//  3. thread-append receipts that name the block marker and run heading.

interface Seed {
  id: string;
  title: string;
  content?: string;
  labels?: Record<string, string>;
}

function fakeBrain(seeds: Seed[]) {
  const notes = new Map<string, Note>();
  const contents = new Map<string, string>();
  const log = {
    revisions: [] as string[],
    contentWrites: [] as Array<{ id: string; text: string }>,
    labels: [] as Array<[string, string, string]>,
    created: [] as Array<[string, string]>,
  };
  let seq = 0;

  const mk = (id: string, title: string, labels: Record<string, string> = {}, parentNoteIds: string[] = []): Note => ({
    noteId: id, title, type: "text", mime: "text/html", isProtected: false,
    attributes: Object.entries(labels).map(([name, value], i) => ({
      attributeId: `${id}-${name}`, noteId: id, type: "label" as const, name, value, position: i, isInheritable: false,
    })),
    parentNoteIds, childNoteIds: [], parentBranchIds: [], childBranchIds: [],
    dateCreated: "2026-10-15 09:00:00.000+0200", dateModified: "2026-10-15 09:00:00.000+0200",
    utcDateCreated: "2026-10-15 07:00:00.000Z", utcDateModified: "2026-10-15 07:00:00.000Z",
  });
  const ownLabel = (n: Note, name: string) =>
    n.attributes.find((a) => a.type === "label" && a.name === name && a.noteId === n.noteId)?.value;

  for (const s of seeds) { notes.set(s.id, mk(s.id, s.title, s.labels)); contents.set(s.id, s.content ?? ""); }

  const client = {
    async getNote(id: string) { const n = notes.get(id); if (!n) throw new Error(`404: ${id}`); return n; },
    async getNoteContent(id: string) { return contents.get(id) ?? ""; },
    async createRevision(id: string) { log.revisions.push(id); return { revisionId: `rev${++seq}`, noteId: id } as unknown as never; },
    async updateNoteContent(id: string, text: string) { log.contentWrites.push({ id, text }); contents.set(id, text); },
    async updateLabelValue(id: string, name: string, value: string) {
      log.labels.push([id, name, value]);
      const n = notes.get(id);
      if (!n) return;
      const a = n.attributes.find((x) => x.type === "label" && x.name === name && x.noteId === id);
      if (a) a.value = value;
      else n.attributes.push({ attributeId: `${id}-${name}`, noteId: id, type: "label", name, value, position: 0, isInheritable: false });
    },
    async addLabel(id: string, name: string, value = "") { await client.updateLabelValue(id, name, value); },
    async searchNotes(query: string) {
      const kind = /#noteType=([\w]+)/.exec(query)?.[1];
      const created = /#created='([^']+)'/.exec(query)?.[1];
      const hits = [...notes.values()].filter((n) => {
        if (kind && ownLabel(n, "noteType") !== kind) return false;
        if (created && ownLabel(n, "created") !== created) return false;
        return true;
      });
      return { results: hits };
    },
    async createNote(parentNoteId: string, title: string, content: string) {
      const id = `n${++seq}`;
      const n = mk(id, title, {}, [parentNoteId]);
      notes.set(id, n);
      contents.set(id, content);
      log.created.push([parentNoteId, title]);
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
    master: { ...EMPTY_BRAINLLM.master, root: "master" },
    llm: { ...EMPTY_BRAINLLM.llm, root: "llm" },
    memory: { ...EMPTY_BRAINLLM.memory, root: "memroot", sessions: "sessions", threads: "threads" },
    knowledge: { ...EMPTY_BRAINLLM.knowledge, root: "knowroot" },
    insights: { ...EMPTY_BRAINLLM.insights, root: "insroot" },
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
  const revise = (args: object) => call("revise", args);
  return { ...brain, call, revise };
}

const fatParagraph = "<p>" + Array.from({ length: 8 }, (_, i) => `Paragraph ${i + 1} carries real substance here.`).join("<br>") + "</p>";
const table =
  `<h2>Register</h2><figure class="table"><table><thead><tr><th>Item</th><th>Owner</th><th>State</th></tr></thead><tbody>` +
  "<tr><td>Restore rehearsal (scheduled)</td><td>Miiso</td><td>Open</td></tr>" +
  "<tr><td>Skill re-upload</td><td>Miiso</td><td>Done</td></tr></tbody></table></figure><p>Last updated — 2026-10-01</p>";

describe("revise(within=) dry run", () => {
  test("remove previews the element's full extent and byte size, and writes nothing", async () => {
    const { revise, log } = setup([{ id: "reg", title: "Register", content: `<h2>Open</h2>${fatParagraph}<p>Tail.</p>` }]);
    const r = await revise({ noteId: "reg", find: "Paragraph 3 carries", within: "p", mode: "remove", dryRun: true });
    expect(r.ok).toBe(true);
    expect(r.dryRun).toBe(true);
    const element = r.element as { tag: string; text: string; bytes: number };
    expect(element.tag).toBe("p");
    expect(element.text).toContain("Paragraph 1 ");
    expect(element.text).toContain("Paragraph 8 "); // the whole extent, not just the anchor
    expect(element.text).not.toContain("Tail."); // the sibling paragraph is not part of it
    expect(element.bytes).toBe(Buffer.byteLength(fatParagraph, "utf8"));
    expect(String(r.before)).toContain("Paragraph 8");
    expect(String(r.after)).toMatch(/removed/i);
    expect(String(r.next)).toContain("Nothing was written");
    expect(String(r.next)).toContain("dryRun=false");
    expect(log.revisions).toEqual([]);
    expect(log.contentWrites).toEqual([]);
    expect(log.labels).toEqual([]);
    expect(log.created).toEqual([]); // no close-gate note either
  });

  test("replace previews the before/after shape; the same call without dryRun writes", async () => {
    const { revise, log } = setup([{ id: "reg", title: "Register", content: table }]);
    const r = await revise({
      noteId: "reg", find: "Restore rehearsal", within: "tr", mode: "replace",
      body: "<tr><td>Restore drill</td><td>Miiso</td><td>Done</td></tr>", dryRun: true,
    });
    expect(r.dryRun).toBe(true);
    expect(String(r.before)).toContain("Restore rehearsal");
    expect(String(r.after)).toBe("<tr><td>Restore drill</td><td>Miiso</td><td>Done</td></tr>");
    expect(log.contentWrites).toEqual([]);
    expect(log.revisions).toEqual([]);

    const w = await revise({
      noteId: "reg", find: "Restore rehearsal", within: "tr", mode: "replace",
      body: "<tr><td>Restore drill</td><td>Miiso</td><td>Done</td></tr>",
    });
    expect(w.ok).toBe(true);
    expect(log.revisions).toEqual(["reg"]);
    expect(log.contentWrites).toHaveLength(1);
  });

  test("a huge element's preview is bounded and says how much was cut", async () => {
    const giant = "<p>" + Array.from({ length: 400 }, (_, i) => `Sentence ${i} with filler words.`).join(" ") + "</p>";
    const { revise } = setup([{ id: "n", title: "Notes", content: giant }]);
    const r = await revise({ noteId: "n", find: "Sentence 5 with", within: "p", mode: "remove", dryRun: true });
    const element = r.element as { text: string; bytes: number; textTruncated?: boolean };
    expect(element.text.length).toBeLessThanOrEqual(1201);
    expect(element.textTruncated).toBe(true);
    expect(element.bytes).toBeGreaterThan(4000);
    expect(String(r.before)).toContain("more characters");
  });

  test("dryRun previews an ordinary find replacement without mutation", async () => {
    const { revise, log } = setup([{ id: "reg", title: "Register", content: table }]);
    const r = await revise({ noteId: "reg", find: "Restore rehearsal", body: "x", dryRun: true });
    expect(r.dryRun).toBe(true);
    expect(String(r.after)).toContain("x (scheduled)");
    expect(log.revisions).toEqual([]);
    expect(log.contentWrites).toEqual([]);
    expect(log.labels).toEqual([]);
    expect(log.created).toEqual([]);
  });

  test("a dry run on a miss reports the cause and writes nothing", async () => {
    const { revise, log } = setup([{ id: "reg", title: "Register", content: table }]);
    const r = await revise({ noteId: "reg", find: "no such anchor here", within: "tr", mode: "remove", dryRun: true });
    expect(r.ok).toBe(false);
    expect(r.dryRun).toBe(true);
    expect(typeof r.hint).toBe("string");
    expect(log.revisions).toEqual([]);
    expect(log.contentWrites).toEqual([]);
  });

  test("a dry run does not mark the close gate; the same call without dryRun does", async () => {
    const { revise, log } = setup([{ id: "reg", title: "Register", content: table }]);
    await revise({ noteId: "reg", find: "Restore rehearsal", within: "tr", mode: "remove", dryRun: true });
    expect(log.labels).toEqual([]); // no #gate label anywhere
    expect(log.created).toEqual([]); // no session note opened

    await revise({ noteId: "reg", find: "Restore rehearsal", within: "tr", mode: "remove" });
    expect(log.created.some(([parent]) => parent === "sessions")).toBe(true);
    expect(log.labels.some(([, name]) => name === "gate")).toBe(true);
  });

  test("a dry run of a closure resolves the thread read-only and appends nothing", async () => {
    const { revise, log } = setup([
      { id: "reg", title: "Register", content: table },
      { id: "esc", title: "Escalations", labels: { noteType: "thread" } },
    ]);
    const r = await revise({
      noteId: "reg", find: "Restore rehearsal", within: "tr", mode: "remove", dryRun: true,
      closure: { thread: "Escalations", body: "Settled by the drill." }, identity: "Claude · Test · Unit",
    });
    expect(r.dryRun).toBe(true);
    const closure = r.closure as Record<string, unknown>;
    expect(closure.thread).toBe("Escalations");
    expect(closure.threadId).toBe("esc");
    expect(String(closure.wouldAppend)).toContain("Claude · Test · Unit");
    expect(log.contentWrites).toEqual([]); // neither the register nor the thread entry
    expect(log.created).toEqual([]);
  });
});

describe("find= on drifted text", () => {
  test("a find= whose text another agent changed reports the cause and the stored text nearby", async () => {
    const { revise, log } = setup([{ id: "reg", title: "Register", content: table }]);
    const r = await revise({ noteId: "reg", find: "Restore rehearsal — never run", body: "Restore drill" });
    expect(r.ok).toBe(true);
    expect(r.replaced).toBe(0);
    expect(String(r.hint)).toContain("text genuinely differs");
    expect(String(r.storedNearby)).toContain("Restore rehearsal (scheduled)");
    expect(String(r.matchedUpTo)).toContain("Restore rehearsal");
    expect(log.contentWrites).toEqual([]);
    expect(log.revisions).toEqual([]);
  });

  test("find= inside a table cell after drift shows the stored cell and names the within= path", async () => {
    const drifted = "<table><tbody><tr><td>Phase 2 roll-out</td><td>Claude</td><td>Open</td></tr></tbody></table>";
    const { revise, log } = setup([{ id: "t", title: "Tracker", content: drifted }]);
    const r = await revise({ noteId: "t", find: "Phase 2 (paused)", body: "Phase 3" });
    expect(r.replaced).toBe(0);
    expect(String(r.hint)).toContain('within="tr"');
    expect(String(r.storedNearby)).toContain("<td>Phase 2 roll-out</td>");
    expect(log.contentWrites).toEqual([]);
  });

  test("find= inside a table cell after drift still matches through inline formatting, with the mode reported", async () => {
    const drifted = "<table><tbody><tr><td>Phase 2 — roll<strong>out</strong></td><td>Claude</td></tr></tbody></table>";
    const { revise, contents } = setup([{ id: "t", title: "Tracker", content: drifted }]);
    const r = await revise({ noteId: "t", find: "Phase 2 — rollout", body: "Phase 3 — rollout" });
    expect(r.ok).toBe(true);
    expect(r.replaced).toBe(1);
    expect(r.matchMode).toBe("inline-tolerant");
    expect(contents.get("t")).toContain("Phase 3 — rollout");
  });

  test("a pipe-separated row anchor misses but names the within= path", async () => {
    const { revise } = setup([{ id: "t", title: "Tracker", content: "<table><tbody><tr><td>Phase 2</td><td>Claude</td><td>Open</td></tr></tbody></table>" }]);
    const r = await revise({ noteId: "t", find: "Phase 2 | Claude | Open", body: "x" });
    expect(r.replaced).toBe(0);
    expect(String(r.hint)).toContain('within="tr"');
    expect(String(r.storedNearby)).toContain("Phase 2");
  });

  test("nth= past the last occurrence names that cause instead of claiming drift", async () => {
    const { revise } = setup([{ id: "t", title: "Tracker", content: "<table><tbody><tr><td>Phase 2</td><td>Claude</td></tr></tbody></table>" }]);
    const r = await revise({ noteId: "t", find: "Phase 2", body: "Phase Two", nth: 4 });
    expect(r.replaced).toBe(0);
    expect(String(r.hint)).toContain("nth=4 is past the last occurrence");
    expect(r.matchedUpTo).toBeUndefined();
    expect(r.storedNearby).toBeUndefined();
  });

  test("zero matches never returns ok:true without a hint — single find= or edits=", async () => {
    const { revise, log } = setup([{ id: "reg", title: "Register", content: table }]);
    const miss = await revise({ noteId: "reg", find: "vanished sentence of text", body: "x" });
    expect(miss.ok).toBe(true);
    expect(miss.replaced).toBe(0);
    expect(typeof miss.hint).toBe("string");
    expect((miss.hint as string).length).toBeGreaterThan(0);

    const editsMiss = await revise({ noteId: "reg", edits: [{ find: "vanished one", body: "x" }, { find: "vanished two", body: "y" }] });
    expect(editsMiss.replaced).toBe(0);
    expect(typeof editsMiss.hint).toBe("string");
    expect((editsMiss.hint as string).length).toBeGreaterThan(0);
    for (const row of editsMiss.results as Array<{ hint?: string }>) {
      expect(typeof row.hint).toBe("string");
      expect((row.hint as string).length).toBeGreaterThan(0);
    }
    expect(log.contentWrites).toEqual([]);
  });
});

describe("thread append receipts", () => {
  test("an append echoes the run heading and the block marker it wrote", async () => {
    const { revise, contents } = setup([{ id: "th", title: "Build", labels: { noteType: "thread" } }]);
    const r = await revise({ noteId: "th", body: "<h3>Claude · Test · Unit</h3><p>Did work.</p>" });
    expect(r.ok).toBe(true);
    expect(r.entryAction).toBe("created");
    expect(r.runHeading).toBe("Claude · Test · Unit");
    expect(String(r.entryMarker)).toMatch(/^Addendum — \d{2}:\d{2}$/);
    const entryId = String(r.entryId);
    expect(contents.get(entryId)).toContain(`<h2>${r.entryMarker}</h2>`);

    const r2 = await revise({ noteId: "th", body: "<h3>Claude · Test · Unit</h3><p>More work.</p>" });
    expect(r2.entryAction).toBe("appended");
    expect(String(r2.entryMarker)).toMatch(/^Addendum — \d{2}:\d{2}$/);
    expect(contents.get(entryId)).toContain("More work.");
  });

  test("a malformed run heading is refused at write time, naming the problem", async () => {
    const { revise, log } = setup([{ id: "th", title: "Build", labels: { noteType: "thread" } }]);
    const r = await revise({ noteId: "th", body: "<h3>Claude · Unit</h3><p>Did work.</p>" });
    expect(r.error).toBe("malformed_identity");
    expect(String(r.detail)).toContain("at least three");
    expect(log.created).toEqual([]);
    expect(log.contentWrites).toEqual([]);
  });

  test("a closure receipt names the block marker and run heading it appended", async () => {
    const { revise, contents } = setup([
      { id: "reg", title: "Register", content: table },
      { id: "esc", title: "Escalations", labels: { noteType: "thread" } },
    ]);
    const r = await revise({
      noteId: "reg", find: "Restore rehearsal", within: "tr", mode: "remove",
      closure: { thread: "Escalations", body: "Settled by the drill." }, identity: "Claude · Test · Unit",
    });
    const closure = r.closure as Record<string, unknown>;
    expect(closure.action).toBe("created");
    expect(closure.runHeading).toBe("Claude · Test · Unit");
    expect(String(closure.entryMarker)).toMatch(/^Addendum — \d{2}:\d{2}$/);
    expect(contents.get(String(closure.entryId))).toContain(`<h2>${closure.entryMarker}</h2>`);
  });

  test("remember(kind=thread) names the block marker and run heading it appended", async () => {
    const { call, contents } = setup([{ id: "th", title: "Build", labels: { noteType: "thread" } }]);
    const r = await call("remember", { kind: "thread", title: "Build", identity: "Claude · Test · Unit", body: "<p>Did work.</p>" });
    expect(r.action).toBe("updated");
    expect(r.entryAction).toBe("created");
    expect(r.runHeading).toBe("Claude · Test · Unit");
    expect(String(r.entryMarker)).toMatch(/^Addendum — \d{2}:\d{2}$/);
    const entryId = String(r.entryId);
    expect(contents.get(entryId)).toContain(`<h2>${r.entryMarker}</h2>`);
    expect(contents.get(entryId)).toContain("<h3>Claude · Test · Unit</h3>");

    const r2 = await call("remember", { kind: "thread", title: "Build", identity: "Claude · Test · Unit", body: "<p>More work.</p>" });
    expect(r2.entryAction).toBe("appended");
    expect(r2.entryId).toBe(entryId); // same day-child
    expect(String(r2.entryMarker)).toMatch(/^Addendum — \d{2}:\d{2}$/);
    expect(contents.get(entryId)).toContain("More work.");
  });
});


describe("Safe Changes edit plans", () => {
  test("batch preview uses sequential matches, sanitization and misses without writes", async () => {
    const h = setup([{ id: "n", title: "N", content: "<p>alpha beta</p>" }]);
    const args = { noteId: "n", edits: [{ find: "alpha", body: "gamma" }, { find: "alpha", body: "delta" }, { find: "beta", body: '<script>bad()</script>safe' }] };
    const r = await h.revise({ ...args, dryRun: true });
    expect(r.dryRun).toBe(true);
    expect(r.results).toHaveLength(3);
    expect(String(r.after)).toContain("gamma safe");
    expect(String(r.after)).not.toContain("script");
    expect(h.log.revisions).toEqual([]);
    expect(h.log.labels).toEqual([]);
    expect(h.log.created).toEqual([]);
    await h.revise(args);
    expect(h.contents.get("n")).toBe(String(r.after));
  });
  test("a no-op preview never applies title or icon", async () => {
    const h = setup([{ id: "n", title: "N", content: "<p>alpha</p>" }]);
    const r = await h.revise({ noteId: "n", find: "alpha", body: "alpha", title: "Changed", dryRun: true });
    expect(r.error).toBe("conflicting_params");
    expect(h.log.labels).toEqual([]);
  });
  for (const args of [
    { find: "alpha", body: "new" },
    { edits: [{ find: "alpha", body: "new" }] },
    { section: "Heading", body: "new" },
    { section: "Heading", mode: "remove" },
    { mode: "replace", body: "new" },
    { body: "new" },
    { find: "alpha", within: "p", body: "<p>new</p>" },
    { append: { table: "Register", row: "new | owner | state" } },
  ]) {
    test(`revision failure blocks ${JSON.stringify(args)}`, async () => {
      const h = setup([{ id: "n", title: "N", content: `<h2>Heading</h2><p>alpha</p>${table}` }]);
      h.client.createRevision = async () => { throw new Error("snapshot failure"); };
      await expect(h.revise({ noteId: "n", ...args })).rejects.toThrow("snapshot failure");
      expect(h.log.contentWrites).toEqual([]);
      expect(h.log.labels).toEqual([]);
    });
  }
});
