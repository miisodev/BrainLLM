import { describe, expect, test } from "bun:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerTools } from "./tools.js";
import { EMPTY_BRAINLLM, type BrainLLMConfig } from "./config.js";
import type { TriliumClient, Note } from "./trilium.js";

// BrainLLM v13 "Provenance" release anchors.
//
// consistency() judged captured value groups directly, so one note whose cell
// held two true figures (a master hash and a branch hash, 2026-10-12) was
// reported as DISAGREEMENT with itself. Values are now grouped BY NOTE first:
// several distinct values from one note are that note's compound fact, and
// only values no note ever asserts together count as cross-note divergence.
//
// claim() needed two calls to record a failed verification and then retire
// the claim (2026-10-11). retire=true now composes with the verifying call:
// holds=+evidence= are written exactly as before, then the claim is archived.

const cfg: BrainLLMConfig = {
  ...EMPTY_BRAINLLM,
  root: "root",
  master: { root: "m", biography: "m1", goals: "m2", preferences: "m3" },
  llm: { root: "l", responsibilities: "l1", protocols: "l2", selfcorrection: "l3", diary: "l4" },
  memory: { root: "mem", sessions: "sessions", threads: "t", metaThread: "" },
  knowledge: { root: "k", master: "k1", domains: "k2" },
  insights: { root: "insights", logs: "logs" },
};

interface SeedNote {
  title: string;
  labels?: Record<string, string>;
  content?: string;
  dateModified?: string;
}

/** An in-memory Trilium just complete enough for consistency() and claim(). */
function fakeBrain(seed: Record<string, SeedNote> = {}) {
  const notes = new Map<string, Note>();
  const labels = new Map<string, Record<string, string>>();
  const contents = new Map<string, string>();
  const revisions: string[] = [];
  let seq = 0;

  const noteOf = (id: string): Note => {
    const base = notes.get(id)!;
    return {
      ...base,
      attributes: Object.entries(labels.get(id) ?? {}).map(([name, value]) => ({
        attributeId: `${id}-${name}`,
        noteId: id,
        type: "label",
        name,
        value,
        position: 0,
        isInheritable: false,
      })),
    } as unknown as Note;
  };

  const search = (pred: (id: string) => boolean) => ({ results: [...notes.keys()].filter(pred).map(noteOf) });

  const client = {
    async searchNotes(query: string) {
      if (query.includes("note.title = 'Claims'")) return search((id) => notes.get(id)!.title === "Claims");
      if (query.includes("#noteType=claim")) return search((id) => labels.get(id)?.noteType === "claim");
      if (query.includes("#noteType=session")) return search((id) => labels.get(id)?.noteType === "session");
      return search((id) => Boolean(labels.get(id)?.noteType));
    },
    async getNote(id: string) {
      if (!notes.has(id)) throw new Error(`no note ${id}`);
      return noteOf(id);
    },
    async getNoteContent(id: string) {
      return contents.get(id) ?? "";
    },
    async updateNoteContent(id: string, html: string) {
      contents.set(id, html);
    },
    async createRevision(id: string) {
      revisions.push(id);
    },
    async addLabel(id: string, name: string, value = "") {
      labels.set(id, { ...(labels.get(id) ?? {}), [name]: value });
    },
    async updateLabelValue(id: string, name: string, value: string) {
      labels.set(id, { ...(labels.get(id) ?? {}), [name]: value });
    },
    async createNote(parentNoteId: string, title: string, content: string) {
      const id = `new${++seq}`;
      notes.set(id, { noteId: id, title, type: "text", mime: "text/html", parentNoteIds: [parentNoteId], childNoteIds: [], attributes: [], dateCreated: "2026-10-15 00:00:00", dateModified: "2026-10-15 00:00:00" } as unknown as Note);
      labels.set(id, {});
      contents.set(id, content);
      return { note: noteOf(id), branch: { branchId: `b${seq}` } };
    },
  };

  for (const [id, s] of Object.entries(seed)) {
    notes.set(id, { noteId: id, title: s.title, type: "text", mime: "text/html", parentNoteIds: [], childNoteIds: [], attributes: [], dateCreated: "2026-10-01 00:00:00", dateModified: s.dateModified ?? "2026-10-01 00:00:00" } as unknown as Note);
    labels.set(id, { ...(s.labels ?? {}) });
    contents.set(id, s.content ?? "");
  }

  return { client: client as unknown as TriliumClient, labels, contents, revisions };
}

function setup(seed: Record<string, SeedNote> = {}) {
  const fake = fakeBrain(seed);
  const server = new McpServer({ name: "BrainLLM", version: "0.0.0-test" });
  registerTools(server, fake.client, { config: cfg });
  const tools = (server as unknown as { _registeredTools: Record<string, { handler?: Function; callback?: Function }> })._registeredTools;
  const call = async (name: string, args: object = {}) => {
    const out = (await (tools[name]!.handler ?? tools[name]!.callback)!(args, {})) as { content: Array<{ text: string }> };
    return JSON.parse(out.content[0]!.text) as Record<string, unknown>;
  };
  return { ...fake, call };
}

describe("consistency() judges captured values by note", () => {
  const pattern = "hash ([a-f0-9]{6})";
  const note = (content: string) => ({ title: "Anchors", labels: { noteType: "information" }, content });

  test("one note with two values in one cell is a compound fact, not a disagreement", async () => {
    const { call } = setup({
      n1: note("<h2>Hashes</h2><table><tbody><tr><td>master hash abc123, branch hash def456</td></tr></tbody></table>"),
    });
    const json = await call("consistency", { pattern });
    expect(json.agreement).toBe("unanimous");
    expect(json.distinctValues).toBe(2);
    expect(json.note as string).toContain("compound fact");
    expect(json.note as string).not.toContain("DIFFERENT");
  });

  test("two notes asserting different values still flag", async () => {
    const { call } = setup({
      n1: note("<p>the master hash abc123 is deployed</p>"),
      n2: note("<p>the branch hash def456 is current</p>"),
    });
    const json = await call("consistency", { pattern });
    expect(json.agreement).toBe("DISAGREEMENT");
    expect((json.groups as unknown[]).length).toBe(2);
  });

  test("the same value across notes stays unanimous", async () => {
    const { call } = setup({
      n1: note("<p>the master hash abc123 is deployed</p>"),
      n2: note("<p>the master hash abc123 is current</p>"),
    });
    const json = await call("consistency", { pattern });
    expect(json.agreement).toBe("unanimous");
    expect(json.distinctValues).toBe(1);
  });

  test("a note holding both values reconciles a note that names only one", async () => {
    const { call } = setup({
      n1: note("<p>master hash abc123, branch hash def456</p>"),
      n2: note("<p>master hash abc123</p>"),
    });
    const json = await call("consistency", { pattern });
    expect(json.agreement).toBe("unanimous");
  });

  test("values split so that no note states them together still flag", async () => {
    const { call } = setup({
      n1: note("<p>master hash abc123, branch hash def456</p>"),
      n2: note("<p>branch hash def456, tag hash 998877</p>"),
    });
    const json = await call("consistency", { pattern });
    expect(json.agreement).toBe("DISAGREEMENT");
  });
});

describe("claim() one-call retract", () => {
  const seedClaim = () => ({
    claims: { title: "Claims" },
    c1: {
      title: "The parse pipeline runs before validation",
      labels: { noteType: "claim", created: "2026-10-01", interval: "30", claimState: "holding", verified: "2026-10-05", iconClass: "bx bx-check-shield" },
      content: "<h2>Check</h2><p>run the parser test suite</p><h2>Verifications</h2><p><strong>2026-10-05 — HOLDS</strong>: all green</p>",
    },
  });

  test("holds=false + evidence + retire records the failure and archives in one call", async () => {
    const { call, labels, contents, revisions } = setup(seedClaim());
    const json = await call("claim", { claimId: "c1", holds: false, evidence: "parser test failed: validation ran first", retire: true });

    expect(json.ok).toBe(true);
    expect(json.action).toBe("marked-broken");
    expect(json.retired).toBe(true);
    expect(json.state).toBe("broken");

    // Half one: the verification, written exactly as a verify-only call writes it.
    expect(contents.get("c1")).toContain("BROKEN");
    expect(contents.get("c1")).toContain("parser test failed: validation ran first");
    expect(labels.get("c1")!.claimState).toBe("broken");
    expect(labels.get("c1")!.verified).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(revisions).toContain("c1");

    // Half two: the retirement.
    expect(labels.get("c1")!.archived).toBe("");

    // The receipt is classified as a write: the gate recorded the write step.
    const session = [...labels.entries()].find(([, l]) => l.noteType === "session" && l.gate);
    expect(session?.[1].gate).toBe("write:1");
  });

  test("retire= alone still archives without touching the Verifications section", async () => {
    const { call, labels, contents, revisions } = setup(seedClaim());
    const before = contents.get("c1");
    const json = await call("claim", { claimId: "c1", retire: true });
    expect(json.action).toBe("retired");
    expect(labels.get("c1")!.archived).toBe("");
    expect(labels.get("c1")!.claimState).toBe("holding");
    expect(contents.get("c1")).toBe(before);
    expect(revisions).not.toContain("c1");
  });

  test("a verification without evidence is still refused, retire or not", async () => {
    const { call, labels } = setup(seedClaim());
    const json = await call("claim", { claimId: "c1", holds: false, retire: true });
    expect(json.error).toBe("missing_param");
    expect(labels.get("c1")!.archived).toBeUndefined();
    expect(labels.get("c1")!.claimState).toBe("holding");
  });

  test("verify alone is unchanged: no archived label", async () => {
    const { call, labels } = setup(seedClaim());
    const json = await call("claim", { claimId: "c1", holds: true, evidence: "parser test passed" });
    expect(json.action).toBe("verified");
    expect(json.retired).toBeUndefined();
    expect(labels.get("c1")!.archived).toBeUndefined();
    expect(labels.get("c1")!.claimState).toBe("holding");
  });
});


describe("Safe Changes consistency coverage", () => {
  const n = (content: string) => ({ title: "N", labels: { noteType: "information" }, content });
  test("default reaches matches beyond the old 60-note boundary", async () => {
    const seed: Record<string, SeedNote> = {};
    for (let i = 0; i < 80; i++) seed[`n${i}`] = n(i === 79 ? "target phrase" : "other");
    const h = setup(seed);
    const r = await h.call("consistency", { pattern: "target phrase" });
    expect(r.notesExamined).toBe(80);
    expect((r.coverage as any).complete).toBe(true);
    expect(r.agreement).toBe("unanimous");
    const limited = await h.call("consistency", { pattern: "target phrase", limit: 60 });
    expect((limited.coverage as any).truncated).toBe(true);
    expect(limited.scan).toBe("bounded");
  });
  test("case-insensitive comparison groups spellings but explicit case preserves them", async () => {
    const h = setup({ a: n("ProductHunt"), b: n("producthunt") });
    const r = await h.call("consistency", { pattern: "[Pp]roduct[Hh]unt" });
    expect(r.agreement).toBe("unanimous");
    expect((r.groups as any[])[0].spellings).toEqual(["ProductHunt", "producthunt"]);
    expect((await h.call("consistency", { pattern: "[Pp]roduct[Hh]unt", caseSensitive: true })).agreement).toBe("DISAGREEMENT");
  });
  test("failed body reads report incomplete rather than unanimous", async () => {
    const h = setup({ a: n("amount 3"), b: n("amount 4") });
    h.client.getNoteContent = async (id) => { if (id === "b") throw new Error("offline"); return "amount 3"; };
    const r = await h.call("consistency", { pattern: "amount ([0-9]+)" });
    expect(r.agreement).toBe("incomplete");
    expect((r.coverage as any).failed).toEqual(["b"]);
    const subject = await h.call("consistency", { subject: "amount" });
    expect((subject.coverage as any).complete).toBe(false);
  });
  test("acquisition failure propagates instead of looking empty", async () => {
    const h = setup(); h.client.searchNotes = async () => { throw new Error("search down"); };
    await expect(h.call("consistency", { pattern: "x" })).rejects.toThrow("search down");
    await expect(h.call("consistency", { subject: "target" })).rejects.toThrow("search down");
  });
  test("lossy fast mode cannot establish unanimity", async () => {
    const h = setup({ a: n("value 3") });
    const r = await h.call("consistency", { pattern: "value ([0-9]+)", fast: true });
    expect(r.agreement).toBe("incomplete");
    expect((r.coverage as any).prefilter).toBe("lossy");
  });
});
