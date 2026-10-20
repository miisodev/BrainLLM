import { describe, expect, test } from "bun:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerTools } from "./tools.js";
import { nearestKey, findTable, appendRowToTable, fitRowCells, rowCells } from "./normalize.js";
import { EMPTY_BRAINLLM, type BrainLLMConfig } from "./config.js";
import type { TriliumClient, Note } from "./trilium.js";

// ── v13.0.0 "Provenance" — registers and sources conveniences ─────────────────
//
// 1. Sources near-duplicate keys: a new Revision row whose key sits one word
//    from an existing one comes back with didYouMean, and the sources upsert
//    has a dry run.
// 2. closure={note} moves a closed register row into another register's table,
//    shaped to that table.
// 3. append={table, row} adds one row without locating an anchor row first.

describe("nearestKey — near-duplicate source keys", () => {
  test("the compound duplicate that motivated this: a qualifier added to a name", () => {
    const near = nearestKey("OpenRouter management API", ["OpenRouter API", "Stripe Billing"]);
    expect(near).toEqual({ key: "OpenRouter API", distance: 1, reason: "compound" });
  });

  test("typos are still caught by edit distance, scaling with length", () => {
    const near = nearestKey("Coudflare Pages", ["Cloudflare Pages"]);
    expect(near?.key).toBe("Cloudflare Pages");
    expect(near?.reason).toBe("typo");
    expect(near?.distance).toBe(1);
  });

  test("unrelated keys suggest nothing, and neither does an exact match", () => {
    expect(nearestKey("Stripe Billing", ["OpenRouter API"])).toBeNull();
    expect(nearestKey("Anything", [])).toBeNull();
    expect(nearestKey("Cloudflare", ["cloudflare"])).toBeNull();
  });
});

describe("findTable / appendRowToTable", () => {
  const note =
    '<h4>Last updated - 2026-10-10</h4><h2>Backlog</h2>' +
    "<table><thead><tr><th>Item</th><th>Owner</th><th>State</th></tr></thead><tbody>" +
    "<tr><td>Old item</td><td>Miiso</td><td>Open</td></tr></tbody></table>" +
    '<h2>Revision</h2><table><thead><tr><th>Source</th><th>Marker</th><th>Date</th></tr></thead><tbody>' +
    "<tr><td><em>— none yet —</em></td><td></td><td></td></tr></tbody></table>";

  test("the named heading's table is the one that grows, at the end of its tbody", () => {
    const spot = findTable(note, "Backlog");
    expect(spot?.columns).toBe(3);
    const out = appendRowToTable(note, spot!, ["Ship v13", "Claude", "Open"]);
    expect(out).toContain("<tr><td>Ship v13</td><td>Claude</td><td>Open</td></tr></tbody>");
    expect(out.indexOf("Ship v13")).toBeGreaterThan(out.indexOf("Old item"));
    // The other table is untouched.
    expect(out.split("— none yet —").length).toBe(2);
  });

  test("a lone placeholder row is replaced, not followed", () => {
    const spot = findTable(note, "Revision");
    const out = appendRowToTable(note, spot!, ["OpenRouter API", "✅", "2026-10-15"]);
    expect(out).not.toContain("— none yet —");
    expect(out).toContain("<tr><td>OpenRouter API</td><td>✅</td><td>2026-10-15</td></tr>");
  });

  test("no heading means the note's first table; absent tables return null", () => {
    expect(findTable(note)).not.toBeNull();
    expect(findTable(note, "Nowhere")).toBeNull();
    expect(findTable("<p>no tables here</p>", undefined)).toBeNull();
  });

  test("columns honour colspan; the row shape is the first row's", () => {
    const wide = '<h2>T</h2><table><tbody><tr><td colspan="3">wide</td></tr><tr><td>a</td></tr></tbody></table>';
    expect(findTable(wide, "T")?.columns).toBe(3);
  });
});

describe("fitRowCells / rowCells", () => {
  test("a narrower row pads to the table's shape", () => {
    expect(fitRowCells(["a", "b"], 3)).toEqual(["a", "b", ""]);
    expect(fitRowCells(["a", "b", "c"], 3)).toEqual(["a", "b", "c"]);
  });

  test("a wider row is refused rather than silently losing data", () => {
    expect(fitRowCells(["a", "b", "c", "d"], 3)).toBeNull();
    expect(fitRowCells(["a"], 0)).toBeNull();
  });

  test("rowCells reads the inner HTML of each stored cell", () => {
    expect(rowCells('<tr class="x"><td><strong>Case A</strong></td><td>Miiso</td></tr>'))
      .toEqual(["<strong>Case A</strong>", "Miiso"]);
    expect(rowCells("<tr><td>only</td></tr>")).toEqual(["only"]);
  });
});

// ── Handler-level tests against a fake Trilium ────────────────────────────────

interface FakeNoteSeed {
  id: string;
  title: string;
  content: string;
  labels?: Record<string, string>;
  parent?: string;
}

function fakeTrilium(seeds: FakeNoteSeed[]) {
  interface Row extends FakeNoteSeed {
    labels: Record<string, string>;
  }
  const notes = new Map<string, Row>();
  for (const s of seeds) notes.set(s.id, { ...s, labels: { ...(s.labels ?? {}) } });
  let seq = 0;
  const created: string[] = [];
  const revisions: string[] = [];

  const toNote = (n: Row): Note =>
    ({
      noteId: n.id,
      title: n.title,
      type: "text",
      mime: "text/html",
      parentNoteIds: n.parent ? [n.parent] : [],
      childNoteIds: [...notes.values()].filter((c) => c.parent === n.id).map((c) => c.id),
      attributes: Object.entries(n.labels).map(([name, value], i) => ({
        attributeId: `${n.id}-${name}`,
        noteId: n.id,
        type: "label" as const,
        name,
        value,
        position: i,
        isInheritable: false,
      })),
      dateCreated: "2026-10-15 10:00:00",
      dateModified: "2026-10-15 10:00:00",
    }) as unknown as Note;

  const client = {
    async getNote(id: string) {
      const n = notes.get(id);
      if (!n) throw new Error(`no note ${id}`);
      return toNote(n);
    },
    async getNoteContent(id: string) {
      const n = notes.get(id);
      if (!n) throw new Error(`no note ${id}`);
      return n.content;
    },
    async updateNoteContent(id: string, content: string) {
      notes.get(id)!.content = content;
    },
    async createRevision(id: string) {
      revisions.push(id);
    },
    async updateLabelValue(id: string, name: string, value: string) {
      notes.get(id)!.labels[name] = value;
    },
    async addLabel(id: string, name: string, value = "") {
      notes.get(id)!.labels[name] = value;
    },
    async patchNote(id: string, patch: { title?: string }) {
      if (patch.title) notes.get(id)!.title = patch.title;
    },
    async createNote(parentId: string, title: string, content: string) {
      const id = `new${++seq}`;
      created.push(`${title} <- ${parentId}`);
      notes.set(id, { id, title, content, labels: {}, parent: parentId });
      return { note: toNote(notes.get(id)!), branch: {} };
    },
    async searchNotes(query: string, opts?: { ancestorNoteId?: string }) {
      const out: Row[] = [];
      if (query.startsWith("note.title = ")) {
        const want = /^note\.title = '(.*)'$/.exec(query)?.[1] ?? "";
        for (const n of notes.values()) if (n.title.toLowerCase() === want.toLowerCase()) out.push(n);
      } else if (query.includes("#noteType=domain")) {
        const slug = /#domain='([^']+)'/.exec(query)?.[1];
        for (const n of notes.values()) if (n.labels.noteType === "domain" && n.labels.domain === slug) out.push(n);
      } else if (query.includes("#noteType=sources")) {
        for (const n of notes.values()) if (n.labels.noteType === "sources" && (!opts?.ancestorNoteId || n.parent === opts.ancestorNoteId)) out.push(n);
      } else if (query.includes("#noteType=threadEntry")) {
        const date = /#created='([^']+)'/.exec(query)?.[1];
        for (const n of notes.values()) if (n.labels.noteType === "threadEntry" && n.labels.created === date && n.parent === opts?.ancestorNoteId) out.push(n);
      } else if (query.includes("#noteType=thread")) {
        for (const n of notes.values()) if (n.labels.noteType === "thread" && (!opts?.ancestorNoteId || n.parent === opts.ancestorNoteId)) out.push(n);
      }
      return { results: out.map(toNote) };
    },
  };

  return { client: client as unknown as TriliumClient, notes, created, revisions };
}

function harness(fake: ReturnType<typeof fakeTrilium>, cfg: Partial<BrainLLMConfig> = {}) {
  const config: BrainLLMConfig = {
    ...EMPTY_BRAINLLM,
    root: "root",
    knowledge: { ...EMPTY_BRAINLLM.knowledge, domains: "domainsRoot" },
    ...cfg,
  };
  const server = new McpServer({ name: "BrainLLM", version: "0.0.0-test" });
  registerTools(server, fake.client, { config });
  const tools = (server as unknown as { _registeredTools: Record<string, { handler?: Function; callback?: Function }> })._registeredTools;
  const call = async (name: string, args: object) => {
    const out = (await (tools[name]!.handler ?? tools[name]!.callback)!(args, {})) as { content: Array<{ text: string }> };
    return JSON.parse(out.content[0]!.text) as Record<string, unknown>;
  };
  return { call };
}

const REGISTER_ROW_NOTE =
  '<h4>Last updated - 2026-10-12</h4><h2>Open cases</h2>' +
  "<table><thead><tr><th>Case</th><th>Owner</th><th>Date</th></tr></thead><tbody>" +
  "<tr><td>Case A</td><td>Miiso</td><td>2026-10-01</td></tr></tbody></table>";

describe("revise append= — one-call row append", () => {
  const seed = () => {
    const fake = fakeTrilium([
      {
        id: "regBacklog",
        title: "Backlog",
        labels: { register: "", noteType: "information" },
        content:
          '<h4>Last updated - 2026-10-10</h4><h2>Backlog</h2>' +
          "<table><thead><tr><th>Item</th><th>Owner</th><th>State</th><th>Date</th></tr></thead><tbody>" +
          "<tr><td>Old item</td><td>Miiso</td><td>Open</td><td>2026-10-01</td></tr></tbody></table>",
      },
      {
        id: "regSkeleton",
        title: "Skeleton",
        labels: { register: "" },
        content:
          '<h2>Revision</h2><table><thead><tr><th>Source</th><th>Marker</th><th>Date</th></tr></thead><tbody>' +
          "<tr><td><em>— none yet —</em></td><td></td><td></td></tr></tbody></table>",
      },
    ]);
    return { ...fake, call: harness(fake).call };
  };

  test("appends one row with pipes as cell boundaries", async () => {
    const { call, notes, revisions } = seed();
    const out = await call("revise", {
      noteId: "regBacklog",
      append: { table: "Backlog", row: "Ship v13 | Claude | Open | 2026-10-15" },
      date: "2026-10-15",
    });
    expect(out.ok).toBe(true);
    expect(out.mode).toBe("append-row:Backlog");
    expect(out.row).toBe("Ship v13 | Claude | Open | 2026-10-15");
    expect(out.cells).toBe(4);
    const content = notes.get("regBacklog")!.content;
    expect(content).toContain("<tr><td>Ship v13</td><td>Claude</td><td>Open</td><td>2026-10-15</td></tr></tbody>");
    expect(content).toContain("Last updated - 2026-10-15");
    expect(revisions).toContain("regBacklog");
    expect(notes.get("regBacklog")!.labels.updated).toBe("2026-10-15");
  });

  test("replaces a lone placeholder row instead of following it", async () => {
    const { call, notes } = seed();
    const out = await call("revise", {
      noteId: "regSkeleton",
      append: { table: "Revision", row: "OpenRouter API | ✅ | 2026-10-15" },
      date: "2026-10-15",
    });
    expect(out.ok).toBe(true);
    expect(notes.get("regSkeleton")!.content).not.toContain("— none yet —");
    expect(notes.get("regSkeleton")!.content).toContain("<td>OpenRouter API</td>");
  });

  test("a missing table refuses before any write", async () => {
    const { call, notes, revisions } = seed();
    const before = notes.get("regBacklog")!.content;
    const out = await call("revise", { noteId: "regBacklog", append: { table: "Backlogg", row: "a | b" }, date: "2026-10-15" });
    expect(out.error).toBe("table_not_found");
    expect(String(out.hint)).toContain('did you mean "Backlog"');
    expect(notes.get("regBacklog")!.content).toBe(before);
    expect(revisions).toEqual([]);
  });

  test("append= composes with nothing else", async () => {
    const { call, notes } = seed();
    const out = await call("revise", { noteId: "regBacklog", append: { table: "Backlog", row: "a | b" }, find: "Old item", body: "x" });
    expect(out.error).toBe("conflicting_params");
    expect(notes.get("regBacklog")!.content).toContain("Old item");
  });
});

describe("revise closure={note} — the row moves into another register", () => {
  const seed = () =>
    fakeTrilium([
      { id: "regOpen", title: "Open cases", labels: { register: "" }, content: REGISTER_ROW_NOTE },
      {
        id: "regDecisions",
        title: "Decisions",
        labels: { register: "" },
        content:
          '<h4>Last updated - 2026-10-10</h4><h2>Decisions</h2>' +
          "<table><thead><tr><th>Decision</th><th>Owner</th><th>Date</th></tr></thead><tbody>" +
          "<tr><td>Older decision</td><td>Miiso</td><td>2026-09-01</td></tr></tbody></table>",
      },
      { id: "plainNote", title: "Plain note", content: "<p>no register here</p>" },
    ]);

  test("the removed row is appended, shaped to the target table", async () => {
    const fake = seed();
    const call = harness(fake).call;
    const out = await call("revise", {
      noteId: "regOpen",
      find: "Case A",
      within: "tr",
      mode: "remove",
      closure: { note: "Decisions" },
      date: "2026-10-15",
    });
    expect(out.ok).toBe(true);
    const closure = out.closure as Record<string, unknown>;
    expect(closure.noteId).toBe("regDecisions");
    expect(closure.note).toBe("Decisions");
    expect(closure.action).toBe("appended");
    expect(closure.row).toBe("Case A | Miiso | 2026-10-01");
    // Out of the source register, into the target's tbody end.
    expect(fake.notes.get("regOpen")!.content).not.toContain("Case A");
    const target = fake.notes.get("regDecisions")!.content;
    expect(target).toContain("<tr><td>Case A</td><td>Miiso</td><td>2026-10-01</td></tr></tbody>");
    expect(target.indexOf("Case A")).toBeGreaterThan(target.indexOf("Older decision"));
  });

  test("dryRun previews the register target and writes nothing", async () => {
    const fake = seed();
    const call = harness(fake).call;
    const before = fake.notes.get("regOpen")!.content;
    const out = await call("revise", {
      noteId: "regOpen",
      find: "Case A",
      within: "tr",
      mode: "remove",
      closure: { note: "Decisions" },
      dryRun: true,
      date: "2026-10-15",
    });
    expect(out.ok).toBe(true);
    expect(out.dryRun).toBe(true);
    const closure = out.closure as Record<string, unknown>;
    expect(closure.noteId).toBe("regDecisions");
    expect(closure.note).toBe("Decisions");
    expect(closure.action).toBe("would-append");
    expect(closure.row).toBe("Case A | Miiso | 2026-10-01");
    // Nothing moved anywhere.
    expect(fake.notes.get("regOpen")!.content).toBe(before);
    expect(fake.notes.get("regDecisions")!.content).not.toContain("Case A");
    expect(fake.revisions).toEqual([]);
  });

  test("a narrower row is refused unless explicit destination cells are supplied", async () => {
    const fake = seed();
    fake.notes.set("regFour", {
      id: "regFour",
      title: "Four-column register",
      labels: { register: "" },
      content:
        '<h2>Rules</h2><table><thead><tr><th>Rule</th><th>Note</th><th>Date</th><th>Origin</th></tr></thead><tbody>' +
        "<tr><td>Old</td><td>-</td><td>2026-09-01</td><td>-</td></tr></tbody></table>",
    });
    fake.notes.set("regOpen2", { id: "regOpen2", title: "Open cases 2", labels: { register: "" }, content: REGISTER_ROW_NOTE });
    const call = harness(fake).call;
    const out = await call("revise", {
      noteId: "regOpen2",
      find: "Case A",
      within: "tr",
      mode: "remove",
      closure: { note: "Four-column register" },
      date: "2026-10-15",
    });
    expect(out.error).toBe("row_shape");
    expect(fake.notes.get("regOpen2")!.content).toContain("Case A");
    const shaped = await call("revise", { noteId: "regOpen2", find: "Case A", within: "tr", mode: "remove",
      closure: { note: "Four-column register", row: ["Case A", "Miiso", "2026-10-01", "Settled"] } });
    expect(shaped.ok).toBe(true);
    expect(fake.notes.get("regFour")!.content).toContain("<td>Settled</td>");
  });

  test("a wider row refuses before the row moves", async () => {
    const fake = seed();
    fake.notes.set("regTwo2", {
      id: "regTwo2",
      title: "Two-cell register 2",
      labels: { register: "" },
      content: '<h2>Rules</h2><table><thead><tr><th>Rule</th><th>Date</th></tr></thead><tbody><tr><td>Old</td><td>2026-09-01</td></tr></tbody></table>',
    });
    fake.notes.set("regWide", {
      id: "regWide",
      title: "Wide register",
      labels: { register: "" },
      content: '<h2>Open</h2><table><thead><tr><th>A</th><th>B</th><th>C</th><th>D</th></tr></thead><tbody><tr><td>a</td><td>b</td><td>c</td><td>d</td></tr><tr><td>Wide case</td><td>x</td><td>y</td><td>z</td></tr></tbody></table>',
    });
    const call = harness(fake).call;
    const out = await call("revise", {
      noteId: "regWide",
      find: "Wide case",
      within: "tr",
      mode: "remove",
      closure: { note: "Two-cell register 2" },
      date: "2026-10-15",
    });
    expect(out.error).toBe("row_shape");
    expect(fake.notes.get("regWide")!.content).toContain("Wide case");
    expect(fake.notes.get("regTwo2")!.content).not.toContain("Wide case");
  });

  test("an unknown or table-less target refuses before the row moves", async () => {
    const fake = seed();
    const call = harness(fake).call;
    const missing = await call("revise", {
      noteId: "regOpen",
      find: "Case A",
      within: "tr",
      mode: "remove",
      closure: { note: "No such register" },
      date: "2026-10-15",
    });
    expect(missing.error).toBe("not_found");
    const noTable = await call("revise", {
      noteId: "regOpen",
      find: "Case A",
      within: "tr",
      mode: "remove",
      closure: { note: "Plain note" },
      date: "2026-10-15",
    });
    expect(noTable.error).toBe("no_table");
    expect(fake.notes.get("regOpen")!.content).toContain("Case A");
  });

  test("closure still needs exactly one target and a thread still needs body and identity", async () => {
    const fake = seed();
    const call = harness(fake).call;
    const both = await call("revise", {
      noteId: "regOpen",
      find: "Case A",
      within: "tr",
      mode: "remove",
      closure: { thread: "Escalations", body: "x", note: "Decisions" },
    });
    expect(both.error).toBe("conflicting_params");
    const threadNoBody = await call("revise", {
      noteId: "regOpen",
      find: "Case A",
      within: "tr",
      mode: "remove",
      closure: { thread: "Escalations" },
    });
    expect(threadNoBody.error).toBe("missing_param");
    expect(fake.notes.get("regOpen")!.content).toContain("Case A");
  });

  test("the existing {thread, body} variant is unchanged", async () => {
    const fake = seed();
    fake.notes.set("regThread", { id: "regThread", title: "Escalations", labels: { noteType: "thread", status: "active" }, parent: "memRoot", content: "<h2>Goal</h2><p>Close the cases.</p>" });
    const call = harness(fake, { memory: { ...EMPTY_BRAINLLM.memory, root: "memRoot" } }).call;
    const noIdentity = await call("revise", {
      noteId: "regOpen",
      find: "Case A",
      within: "tr",
      mode: "remove",
      closure: { thread: "Escalations", body: "Ruled: shipped." },
      date: "2026-10-15",
    });
    expect(noIdentity.error).toBe("missing_identity");
    expect(fake.notes.get("regOpen")!.content).toContain("Case A");

    const out = await call("revise", {
      noteId: "regOpen",
      find: "Case A",
      within: "tr",
      mode: "remove",
      closure: { thread: "Escalations", body: "Ruled: shipped." },
      identity: "Claude · Test · Unit",
      date: "2026-10-15",
    });
    expect(out.ok).toBe(true);
    const closure = out.closure as Record<string, unknown>;
    expect(closure.thread).toBe("Escalations");
    expect(closure.action).toBe("created");
    expect(fake.notes.get("regOpen")!.content).not.toContain("Case A");
    const entry = fake.notes.get(String(closure.entryId))!;
    expect(entry.content).toContain("Closed:");
    expect(entry.content).toContain("Ruled: shipped.");
  });
});

describe("sources upsert — dry run and didYouMean", () => {
  const sourcesContent =
    '<h4>Last updated - 2026-10-10</h4><h2>Sources</h2><p><em>❇️ discovered · ✅ used</em></p>' +
    "<h3>APIs</h3><ul><li>OpenRouter API ❇️</li></ul>" +
    '<h2>Revision</h2><table><thead><tr><th>Source</th><th>Marker</th><th>Date</th></tr></thead><tbody>' +
    "<tr><td>OpenRouter API</td><td>❇️</td><td>2026-10-01</td></tr></tbody></table>";

  const seed = () =>
    fakeTrilium([
      { id: "domTech", title: "Technology", content: "", labels: { noteType: "domain", domain: "technology" } },
      { id: "srcTech", title: "Sources", labels: { noteType: "sources" }, parent: "domTech", content: sourcesContent },
    ]);

  test("a new key near an existing one comes back with didYouMean", async () => {
    const fake = seed();
    const call = harness(fake).call;
    const out = await call("remember", {
      kind: "sources",
      domain: "Technology",
      revision: [{ source: "OpenRouter management API", marker: "❇️" }],
      date: "2026-10-15",
    });
    expect(out.action).toBe("maintained");
    expect((out.revision as string[])[0]).toBe("added: OpenRouter management API");
    expect(out.didYouMean).toBe("OpenRouter API");
    expect(String(out.didYouMeanNote)).toContain('"OpenRouter management API" → "OpenRouter API"');
    expect(fake.notes.get("srcTech")!.content).toContain("<td>OpenRouter management API</td>");
  });

  test("re-verifying an existing key is an update, with no didYouMean", async () => {
    const fake = seed();
    const call = harness(fake).call;
    const out = await call("remember", {
      kind: "sources",
      domain: "Technology",
      revision: [{ source: "OpenRouter API", marker: "✅" }],
      date: "2026-10-15",
    });
    expect((out.revision as string[])[0]).toBe("updated: OpenRouter API");
    expect(out.didYouMean).toBeUndefined();
    expect(fake.notes.get("srcTech")!.content).toContain("<td>✅</td>");
  });

  test("dryRun previews the row change and the near key, writing nothing", async () => {
    const fake = seed();
    const call = harness(fake).call;
    const before = fake.notes.get("srcTech")!.content;
    const out = await call("remember", {
      kind: "sources",
      domain: "Technology",
      revision: [{ source: "OpenRouter management API", marker: "❇️" }],
      dryRun: true,
      date: "2026-10-15",
    });
    expect(out.dryRun).toBe(true);
    expect(out.action).toBe("dry_run");
    expect((out.revision as string[])[0]).toBe("would add: OpenRouter management API");
    expect(out.didYouMean).toBe("OpenRouter API");
    expect(String(out.next)).toContain("Nothing was written");
    expect(fake.notes.get("srcTech")!.content).toBe(before);
    expect(fake.revisions).toEqual([]);
  });

  test("dryRun on a domain that does not exist yet creates nothing", async () => {
    const fake = seed();
    const call = harness(fake).call;
    const sizeBefore = fake.notes.size;
    const out = await call("remember", { kind: "sources", domain: "New Domain", revision: [{ source: "x", marker: "❇️" }], dryRun: true });
    expect(String(out.wouldCreate)).toContain("canonical Sources note");
    expect(fake.notes.size).toBe(sizeBefore);
    expect(fake.created).toEqual([]);
  });

  test("dryRun elsewhere is refused before any write", async () => {
    const fake = seed();
    const call = harness(fake).call;
    const out = await call("remember", { kind: "preferences", body: "Prefer tabs.", dryRun: true });
    expect(out.error).toBe("conflicting_params");
    expect(fake.notes.get("srcTech")!.content).toBe(sourcesContent);
  });
});


describe("Safe Changes register failure boundaries", () => {
  const seed = () => fakeTrilium([
    { id: "source", title: "Source", labels: { noteType: "information" }, content: REGISTER_ROW_NOTE.replace("</tbody>", "<tr><td>Case B</td><td>Sol</td><td>2026-10-02</td></tr></tbody>") },
    { id: "dest", title: "Destination", labels: { noteType: "information" }, content: '<h2>Closed</h2><table><thead><tr><th>Case</th><th>Owner</th><th>Date</th></tr></thead><tbody></tbody></table>' },
  ]);
  const args = { noteId: "source", find: "Case A", within: "tr", mode: "remove", closure: { note: "Destination", table: "Closed" } };

  test("source snapshot failure does not touch destination or source", async () => {
    const f = seed();
    f.client.createRevision = async () => { throw new Error("snapshot unavailable"); };
    await expect(harness(f).call("revise", args)).rejects.toThrow("snapshot unavailable");
    expect(f.notes.get("source")!.content).toContain("Case A");
    expect(f.notes.get("dest")!.content).not.toContain("Case A");
  });
  for (const failure of ["revision", "content", "label"]) {
    test(`destination ${failure} failure retains source`, async () => {
      const f = seed();
      const originalRevision = f.client.createRevision.bind(f.client);
      const originalWrite = f.client.updateNoteContent.bind(f.client);
      const originalLabel = f.client.updateLabelValue.bind(f.client);
      f.client.createRevision = async (id) => { if (id === "dest" && failure === "revision") throw new Error("injected"); return originalRevision(id); };
      f.client.updateNoteContent = async (id, body) => { if (id === "dest" && failure === "content") throw new Error("injected"); return originalWrite(id, body); };
      f.client.updateLabelValue = async (id, key, value) => { if (id === "dest" && failure === "label") throw new Error("injected"); return originalLabel(id, key, value); };
      const r = await harness(f).call("revise", args);
      expect(r.error).toBe("closure_destination_failed");
      expect(r.source).toBe("retained");
      expect(f.notes.get("source")!.content).toContain("Case A");
    });
  }
  test("lost source response can retry without duplicating destination", async () => {
    const f = seed();
    const original = f.client.updateNoteContent.bind(f.client);
    let fail = true;
    f.client.updateNoteContent = async (id, body) => { if (id === "source" && fail) { fail = false; throw new Error("source unavailable"); } return original(id, body); };
    const call = harness(f).call;
    expect((await call("revise", args)).error).toBe("closure_source_failed");
    expect(f.notes.get("source")!.content).toContain("Case A");
    expect(f.notes.get("dest")!.content).toContain("Case A");
    expect((await call("revise", args)).ok).toBe(true);
    expect(f.notes.get("dest")!.content.split("Case A")).toHaveLength(2);
    expect(f.notes.get("source")!.content).not.toContain("Case A");
  });
  test("same-note move writes removal and insertion together", async () => {
    const f = seed();
    f.notes.get("source")!.content += f.notes.get("dest")!.content;
    const writes: string[] = [];
    const original = f.client.updateNoteContent.bind(f.client);
    f.client.updateNoteContent = async (id, body) => { writes.push(id); return original(id, body); };
    const r = await harness(f).call("revise", { ...args, closure: { note: "Source", table: "Closed" } });
    expect(r.ok).toBe(true);
    expect(writes).toEqual(["source"]);
    const html = f.notes.get("source")!.content;
    expect(html.indexOf("Case A")).toBeGreaterThan(html.indexOf("Closed"));
    expect(html.split("Case A")).toHaveLength(2);
  });
  test("ambiguous destination tables refuse before snapshots", async () => {
    const f = seed();
    f.notes.get("dest")!.content += f.notes.get("dest")!.content.replace("Closed", "Other");
    const r = await harness(f).call("revise", { ...args, closure: { note: "Destination" } });
    expect(r.error).toBe("ambiguous_table");
    expect(f.revisions).toEqual([]);
  });
  test("batch preflights every move and previews without side effects", async () => {
    const f = seed(); const call = harness(f).call;
    const batch = { noteId: "source", within: "tr", mode: "remove", closure: args.closure, moves: [{ find: "Case A" }, { find: "Case B" }] };
    expect((await call("revise", { ...batch, dryRun: true })).written).toBe(0);
    expect(f.revisions).toEqual([]);
    expect((await call("revise", { ...batch, moves: [{ find: "Case A" }, { find: "Missing" }] })).error).toBe("batch_preflight");
    expect(f.revisions).toEqual([]);
    const result = await call("revise", batch);
    expect(result.written).toBe(2);
    expect(f.notes.get("source")!.content).not.toContain("Case A");
    expect(f.notes.get("source")!.content).not.toContain("Case B");
    expect(f.notes.get("dest")!.content).toContain("Case A");
    expect(f.notes.get("dest")!.content).toContain("Case B");
  });
  test("a lost destination response can retry without duplication", async () => {
    const f = seed();
    const original = f.client.updateNoteContent.bind(f.client);
    let fail = true;
    f.client.updateNoteContent = async (id, body) => {
      await original(id, body);
      if (id === "dest" && fail) { fail = false; throw new Error("response lost after acceptance"); }
    };
    const call = harness(f).call;
    expect((await call("revise", args)).error).toBe("closure_destination_failed");
    expect(f.notes.get("source")!.content).toContain("Case A");
    expect((await call("revise", args)).ok).toBe(true);
    expect(f.notes.get("dest")!.content.split("Case A")).toHaveLength(2);
  });
  test("a failed later batch move reports completed progress and stops", async () => {
    const f = seed();
    const original = f.client.updateNoteContent.bind(f.client);
    f.client.updateNoteContent = async (id, body) => {
      if (id === "dest" && body.includes("Case B")) throw new Error("second destination write failed");
      return original(id, body);
    };
    const r = await harness(f).call("revise", { noteId: "source", within: "tr", mode: "remove", closure: args.closure, moves: [{ find: "Case A" }, { find: "Case B" }] });
    expect(r.error).toBe("batch_stopped");
    expect(r.partial).toBe(true);
    expect(r.results).toHaveLength(2);
    expect(f.notes.get("source")!.content).not.toContain("Case A");
    expect(f.notes.get("source")!.content).toContain("Case B");
    expect(f.notes.get("dest")!.content).toContain("Case A");
    expect(f.notes.get("dest")!.content).not.toContain("Case B");
  });
  test("overlapping batch anchors are rejected without writes", async () => {
    const f = seed();
    const r = await harness(f).call("revise", { noteId: "source", within: "tr", mode: "remove", closure: args.closure, moves: [{ find: "Case A" }, { find: "Case A" }] });
    expect(r.error).toBe("overlapping_moves");
    expect(f.revisions).toEqual([]);
  });
});
