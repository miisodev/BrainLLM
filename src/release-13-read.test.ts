// ─────────────────────────────────────────────────────────────────────────────
// v13.0.0 "Provenance" — read-trust stream tests.
//
// Three items that all trace to the same failure: a read that says less than
// it knows, or knows less than it should.
//   1. read(ids): per-note size hints, section-scoped reads, table row counts.
//   2. start()/day(): the "changed since last session" list names its cap.
//   3. domain(): notes acknowledged through maintain(ack=) stay quiet.
// ─────────────────────────────────────────────────────────────────────────────

import { describe, expect, test } from "bun:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerTools, capChanges, sectionTableRows, CHANGES_CAP } from "./tools.js";
import { EMPTY_BRAINLLM, type BrainLLMConfig } from "./config.js";
import type { TriliumClient, Note, RecentChange } from "./trilium.js";

// ── Shared fixtures ───────────────────────────────────────────────────────────

const label = (noteId: string, name: string, value: string) =>
  ({ attributeId: `${noteId}-${name}`, noteId, type: "label" as const, name, value, position: 0, isInheritable: false });

const note = (noteId: string, labels: Record<string, string> = {}, extra: Partial<Note> = {}): Note =>
  ({
    noteId, title: noteId, type: "text", mime: "text/html", parentNoteIds: [], childNoteIds: [],
    parentBranchIds: [], childBranchIds: [],
    attributes: Object.entries(labels).map(([k, v]) => label(noteId, k, v)),
    dateCreated: "2020-01-01 00:00:00", dateModified: "2020-01-01 00:00:00",
    utcDateCreated: "2020-01-01T00:00:00Z", utcDateModified: "2020-01-01T00:00:00Z",
    isProtected: false,
    ...extra,
  }) as unknown as Note;

const labelsOf = (n: Note): Record<string, string> =>
  Object.fromEntries(n.attributes.filter((a) => a.noteId === n.noteId && a.type === "label").map((a) => [a.name, a.value]));

function harness(client: Partial<TriliumClient>, config: Partial<BrainLLMConfig> = {}) {
  const server = new McpServer({ name: "BrainLLM", version: "0.0.0-test" });
  const cfg = { ...EMPTY_BRAINLLM, root: "ROOT", ...config } as BrainLLMConfig;
  registerTools(server, client as TriliumClient, { config: cfg });
  const tools = (server as unknown as { _registeredTools: Record<string, { handler?: Function; callback?: Function }> })._registeredTools;
  return async (name: string, args: Record<string, unknown> = {}) => {
    const t = tools[name]!;
    const r = await (t.handler ?? t.callback)!(args, {});
    return JSON.parse(r.content[0].text);
  };
}

const history = (n: number): RecentChange[] =>
  Array.from({ length: n }, (_, i) => ({
    noteId: `h${i}`, title: `Note ${i}`, utcDate: "2020-01-02T00:00:00Z", date: "2020-01-02 00:00:00",
    current_title: `Note ${i}`, current_isDeleted: false, current_isProtected: false,
  }));

// ── read(): per-note size hints ───────────────────────────────────────────────

function readClient(docs: Record<string, string | { encoding: "base64"; mime: string; content: string }>) {
  return {
    getNote: (async (id: string) => {
      if (!(id in docs)) throw new Error(`no note ${id}`);
      return note(id, { noteType: "information" });
    }) as TriliumClient["getNote"],
    getNoteContentResult: (async (id: string) => docs[id]) as TriliumClient["getNoteContentResult"],
  };
}

describe("read() — every returned note carries its body size", () => {
  test("fitted notes carry chars; the overflow still defers with a size", async () => {
    const small = "<p>" + "s".repeat(100) + "</p>";
    const big1 = "a".repeat(50_000);
    const big2 = "b".repeat(50_000);
    const call = harness(readClient({ small, big1, big2 }));

    const r = await call("read", { ids: ["small", "big1", "big2"] });
    expect(r.count).toBe(2);
    expect(r.notes[0].chars).toBe(small.length);
    expect(r.notes[0].content).toBe(small);
    expect(r.notes[1].chars).toBe(big1.length);
    expect(r.notes[1].content).toBe(big1);
    expect(r.deferred).toHaveLength(1);
    expect(r.deferred[0]).toMatchObject({ id: "big2", size: big2.length });
    expect(r.hint).toContain("section=");
  });

  test("a missing id stays a missing entry, without a forged size", async () => {
    const call = harness(readClient({ small: "<p>x</p>" }));
    const r = await call("read", { ids: ["small", "ghost"] });
    expect(r.notes[0].chars).toBe("<p>x</p>".length);
    expect(r.notes[1].missing).toBe(true);
    expect(r.notes[1].chars).toBeUndefined();
  });

  test("text=true keeps chars as the stored body's size", async () => {
    const doc = "<h2>Head</h2><p>" + "x".repeat(500) + "</p>";
    const call = harness(readClient({ doc }));
    const r = await call("read", { ids: ["doc"], text: true });
    expect(r.notes[0].chars).toBe(doc.length);
    expect(r.notes[0].content.length).toBeLessThan(doc.length);
    expect(r.notes[0].content).toContain("## Head");
  });
});

// ── read(): section-scoped multi-read ─────────────────────────────────────────

describe("read() — section= returns one section per note", () => {
  const register =
    "<h2>Open</h2>" +
    "<table><thead><tr><th>Item</th><th>State</th></tr></thead><tbody>" +
    "<tr><td>one</td><td>Open</td></tr><tr><td>two</td><td>Open</td></tr><tr><td>three</td><td>Open</td></tr>" +
    "</tbody></table>" +
    "<h2>Closed</h2><p>" + "c".repeat(4000) + "</p>";

  test("the section comes back alone, chars describes the whole body, tableRows counts the table", async () => {
    const call = harness(readClient({ register }));
    const r = await call("read", { ids: ["register"], section: "Open" });
    expect(r.notes[0].matched).toBe(true);
    expect(r.notes[0].section).toBe("Open");
    expect(r.notes[0].content).toContain("<table");
    expect(r.notes[0].content).not.toContain("<h2>Closed</h2>");
    expect(r.notes[0].chars).toBe(register.length);
    expect(r.notes[0].tableRows).toBe(3);
    expect(r.notes[0].available).toBeUndefined();
  });

  test("a table-free section carries no tableRows", async () => {
    const call = harness(readClient({ register }));
    const r = await call("read", { ids: ["register"], section: "Closed" });
    expect(r.notes[0].content).toContain("c".repeat(4000));
    expect(r.notes[0].tableRows).toBeUndefined();
    expect(r.notes[0].chars).toBe(register.length);
  });

  test("a section miss names the real headings and empties the content", async () => {
    const call = harness(readClient({ register }));
    const r = await call("read", { ids: ["register"], section: "Nope" });
    expect(r.notes[0].matched).toBe(false);
    expect(r.notes[0].content).toBe("");
    expect(r.notes[0].available).toEqual(["Open", "Closed"]);
    expect(r.notes[0].chars).toBe(register.length);
  });

  test("occurrence= picks among repeated headings, and the first read points at them", async () => {
    const doc = "<h2>Same</h2><p>first</p><h2>Same</h2><p>second</p>";
    const call = harness(readClient({ doc }));
    const first = await call("read", { ids: ["doc"], section: "Same" });
    expect(first.notes[0].content).toBe("<p>first</p>");
    expect(first.notes[0].headingCount).toBe(2);
    expect(first.notes[0].hint).toContain("occurrence=");

    const second = await call("read", { ids: ["doc"], section: "Same", occurrence: 2 });
    expect(second.notes[0].content).toBe("<p>second</p>");
    expect(second.notes[0].hint).toBeUndefined();
  });

  test("text=true applies inside the section", async () => {
    const call = harness(readClient({ register }));
    const r = await call("read", { ids: ["register"], section: "Open", text: true });
    expect(r.notes[0].content).toContain("one | Open");
    expect(r.notes[0].content).not.toContain("<table");
    expect(r.notes[0].chars).toBe(register.length);
  });

  test("binary content refuses sectioning with a reason, and reads whole otherwise", async () => {
    const binary = { encoding: "base64" as const, mime: "image/png", content: "QUJD" };
    const call = harness(readClient({ img: binary }));
    const sectioned = await call("read", { ids: ["img"], section: "Open" });
    expect(sectioned.notes[0].matched).toBe(false);
    expect(sectioned.notes[0].hint).toContain("Binary");

    const whole = await call("read", { ids: ["img"] });
    expect(whole.notes[0].contentEncoding).toBe("base64");
    expect(whole.notes[0].chars).toBe("QUJD".length);
  });
});

// ── capChanges: the helper behind start() and day() ───────────────────────────

describe("capChanges — a capped list says so", () => {
  test("under the cap no marker is added", () => {
    const r = capChanges([1, 2, 3]);
    expect(r.changes).toEqual([1, 2, 3]);
    expect("changesTruncated" in r).toBe(false);
  });

  test("exactly at the cap still no marker", () => {
    const r = capChanges(Array.from({ length: CHANGES_CAP }, (_, i) => i));
    expect(r.changes).toHaveLength(CHANGES_CAP);
    expect(r.changesTruncated).toBeUndefined();
  });

  test("past the cap the marker carries shown and total", () => {
    const r = capChanges(Array.from({ length: 31 }, (_, i) => i));
    expect(r.changes).toHaveLength(CHANGES_CAP);
    expect(r.changesTruncated).toEqual({ shown: CHANGES_CAP, total: 31 });
  });
});

// ── day(): the change list reports its cap end-to-end ─────────────────────────

describe("day() — the change list reports its cap", () => {
  const cfg: BrainLLMConfig = {
    ...EMPTY_BRAINLLM,
    root: "ROOT",
    memory: { ...EMPTY_BRAINLLM.memory, sessions: "SESSIONS" },
    insights: { ...EMPTY_BRAINLLM.insights, logs: "LOGS" },
  };
  const prev = note("prev", { noteType: "session", created: "2020-01-01" }, { title: "previous session" });

  const dayClient = (changes: RecentChange[]): Partial<TriliumClient> => ({
    searchNotes: (async (query: string) => {
      const kind = /#noteType=([a-z]+)/.exec(query)?.[1];
      const created = /#created='([^']+)'/.exec(query)?.[1];
      const hits = [prev].filter((n) => {
        const l = labelsOf(n);
        if (kind && l.noteType !== kind) return false;
        if (created && l.created !== created) return false;
        return true;
      });
      return { results: hits };
    }) as unknown as TriliumClient["searchNotes"],
    getNoteContent: (async () => "<p>previous session body</p>") as TriliumClient["getNoteContent"],
    getNoteHistory: (async () => changes) as TriliumClient["getNoteHistory"],
  });

  test("more than 25 changes comes back capped, with changesTruncated", async () => {
    const call = harness(dayClient(history(30)), cfg);
    const r = await call("day");
    expect(r.changes).toHaveLength(CHANGES_CAP);
    expect(r.changesTruncated).toEqual({ shown: CHANGES_CAP, total: 30 });
  });

  test("a list under the cap carries no marker", async () => {
    const call = harness(dayClient(history(10)), cfg);
    const r = await call("day");
    expect(r.changes).toHaveLength(10);
    expect(r.changesTruncated).toBeUndefined();
  });
});

// ── start(): same list, same marker ───────────────────────────────────────────

describe("start() — the change list reports its cap", () => {
  function startClient(changes: RecentChange[]): TriliumClient {
    const notes = new Map<string, Note>();
    const labels = new Map<string, Record<string, string>>();
    const contents = new Map<string, string>();
    let seq = 0;
    const put = (n: Note) => { notes.set(n.noteId, n); labels.set(n.noteId, labelsOf(n)); };
    const prev = note("prev", { noteType: "session", created: "2020-01-01" }, { title: "previous session" });
    put(prev);
    contents.set("prev", "<p>previous session body</p>");
    const noteOf = (id: string): Note =>
      ({ ...notes.get(id)!, attributes: Object.entries(labels.get(id) ?? {}).map(([k, v]) => label(id, k, v)) }) as Note;

    const client = {
      async searchNotes(query: string) {
        const kind = /#noteType=([a-z]+)/.exec(query)?.[1];
        const created = /#created='([^']+)'/.exec(query)?.[1];
        if (!kind && !created) return { results: [] }; // the iconless sweep et al.
        const hits = [...notes.keys()].filter((id) => {
          const l = labels.get(id) ?? {};
          if (kind && l.noteType !== kind) return false;
          if (created && l.created !== created) return false;
          return true;
        });
        return { results: hits.map(noteOf) };
      },
      async getNote(id: string) { if (!notes.has(id)) throw new Error(`no note ${id}`); return noteOf(id); },
      async getNoteContent(id: string) { return contents.get(id) ?? ""; },
      async getNoteContentResult(id: string) { return contents.get(id) ?? ""; },
      async getNoteHistory() { return changes; },
      async createNote(parentNoteId: string, title: string, content: string) {
        const id = `new-${++seq}`;
        notes.set(id, note(id, {}, { title, parentNoteIds: [parentNoteId] }));
        labels.set(id, {});
        contents.set(id, content);
        return { note: noteOf(id), branch: { branchId: `b-${seq}` } };
      },
      async addLabel(id: string, name: string, value = "") { const l = labels.get(id) ?? {}; l[name] = value; labels.set(id, l); },
      async updateLabelValue(id: string, name: string, value: string) { const l = labels.get(id) ?? {}; l[name] = value; labels.set(id, l); },
    };
    return client as unknown as TriliumClient;
  }

  const cfg: BrainLLMConfig = {
    ...EMPTY_BRAINLLM,
    root: "ROOT",
    memory: { ...EMPTY_BRAINLLM.memory, sessions: "SESSIONS" },
  };

  test("more than 25 changes comes back capped, with changesTruncated", async () => {
    const call = harness(startClient(history(30)), cfg);
    const r = await call("start");
    expect(r.status).toBe("ready");
    expect(r.changesSinceLastSession).toHaveLength(CHANGES_CAP);
    expect(r.changesTruncated).toEqual({ shown: CHANGES_CAP, total: 30 });
  });

  test("a list under the cap carries no marker", async () => {
    const call = harness(startClient(history(4)), cfg);
    const r = await call("start");
    expect(r.changesSinceLastSession).toHaveLength(4);
    expect(r.changesTruncated).toBeUndefined();
  });
});

// ── domain(): maintain(ack=) parity ───────────────────────────────────────────

describe("domain() — acknowledged notes stay quiet", () => {
  const acked = note("acked", { noteType: "information", reviewed: "blob-acked" }, { blobId: "blob-acked", title: "acked note" });
  const changed = note("changed", { noteType: "information", reviewed: "blob-before" }, { blobId: "blob-after", title: "changed note" });
  const plain = note("plain", { noteType: "information" }, { title: "never reviewed" });

  const client: Partial<TriliumClient> = {
    searchNotes: (async (query: string, opts?: { includeArchivedNotes?: boolean }) => {
      if (query.startsWith("#noteType=domain")) return { results: [] };
      if (opts?.includeArchivedNotes) return { results: [] };
      return { results: [acked, changed, plain] };
    }) as unknown as TriliumClient["searchNotes"],
  };

  test("the acked note does not re-flag; a changed or never-reviewed one does", async () => {
    const call = harness(client);
    const r = await call("domain", { name: "Read Trust" });
    const rows = r.groups.information as Array<{ id: string; stale?: true }>;
    const find = (id: string) => rows.find((x) => x.id === id)!;
    expect(find("acked").stale).toBeUndefined();
    expect(find("changed").stale).toBe(true);
    expect(find("plain").stale).toBe(true);
    expect(r.stale).toContain("2 note(s)");
  });
});

// ── sectionTableRows: the pure count behind tableRows ─────────────────────────

describe("sectionTableRows", () => {
  test("counts tbody rows, not the header", () => {
    const html = "<table><thead><tr><th>a</th><th>b</th></tr></thead><tbody><tr><td>1</td><td>2</td></tr><tr><td>3</td><td>4</td></tr></tbody></table>";
    expect(sectionTableRows(html)).toBe(2);
  });

  test("without a tbody the header row is still excluded", () => {
    const html = "<table><thead><tr><th>a</th></tr></thead><tr><td>1</td></tr></table>";
    expect(sectionTableRows(html)).toBe(1);
  });

  test("no table, no count", () => {
    expect(sectionTableRows("<p>no table here</p>")).toBeUndefined();
  });
});
