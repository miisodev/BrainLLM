import { describe, expect, test } from "bun:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerTools } from "./tools.js";
import { EMPTY_BRAINLLM, type BrainLLMConfig } from "./config.js";
import type { TriliumClient, Note } from "./trilium.js";
import { localToday } from "./time.js";

// V13.0.0 "Provenance" — session()/close()/start() behaviour:
//   1. "light" means ONLY a close with no content written; the stubs mode of a
//      normal session() receipt no longer borrows the word (three diarists read
//      `mode: "light"` as the light close and skipped addendum()/maintain()).
//   2. the write gate retries and is repaired from in-process evidence, never
//      silently downgraded by one failed label write.
//   3. newDay is about the interactive day: overnight agent addenda must not
//      make the morning session skip day() (2026-10-07).
//   4. session(continuing=true) mirrors close(continuing=true).

const TODAY = localToday();

function brainConfig(): BrainLLMConfig {
  return {
    ...EMPTY_BRAINLLM,
    root: "root",
    master: { root: "master", biography: "bio", goals: "goals", preferences: "prefs" },
    llm: { root: "llm", responsibilities: "resp", protocols: "proto", selfcorrection: "", diary: "" },
    memory: { root: "memory", sessions: "sessions", threads: "threads", metaThread: "" },
    insights: { root: "insights", logs: "logs" },
  };
}

function fakeBrain() {
  const notes = new Map<string, Note>();
  const contents = new Map<string, string>();
  const labels = new Map<string, Record<string, string>>();
  const noteReads: string[] = [];
  let seq = 0;
  let gateWriteFailures = 0;

  const baseNote = (noteId: string, title: string, parentNoteId: string): Note =>
    ({ noteId, title, type: "text", mime: "text/html", parentNoteIds: [parentNoteId], childNoteIds: [], attributes: [], dateCreated: `${TODAY} 00:00:00.000+0000`, dateModified: `${TODAY} 00:00:00.000+0000` } as unknown as Note);

  const noteOf = (id: string): Note => {
    if (!notes.has(id)) throw new Error(`no note ${id}`);
    return {
      ...notes.get(id)!,
      attributes: Object.entries(labels.get(id) ?? {}).map(([name, value]) => ({ attributeId: `${id}-${name}`, noteId: id, type: "label", name, value, position: 0, isInheritable: false })),
    } as Note;
  };

  const setLabel = (noteId: string, name: string, value: string) => {
    if (!labels.has(noteId)) labels.set(noteId, {});
    labels.get(noteId)![name] = value;
  };

  const client = {
    async searchNotes(query: string) {
      const date = /#created='([^']+)'/.exec(query)?.[1];
      const kind = ["session", "diary", "log"].find((k) => query.includes(`#noteType=${k}`));
      if (kind) {
        const hits = [...notes.keys()].filter((id) => labels.get(id)?.noteType === kind && (!date || labels.get(id)?.created === date));
        return { results: hits.map(noteOf) };
      }
      return { results: [] as Note[] };
    },
    async createNote(parentNoteId: string, title: string, content?: string) {
      const noteId = `n${++seq}`;
      notes.set(noteId, baseNote(noteId, title, parentNoteId));
      labels.set(noteId, {});
      if (content !== undefined) contents.set(noteId, content);
      return { note: noteOf(noteId), branch: { branchId: `b${seq}` } };
    },
    async addLabel(noteId: string, name: string, value = "") { setLabel(noteId, name, value); },
    async updateLabelValue(noteId: string, name: string, value: string) {
      // Simulate Trilium failing the WRITE mark only (an empty gate serializes
      // the write step alone). Other gate writes behave, as in production the
      // session step's write propagating an error is pre-existing behaviour.
      if (name === "gate" && /^write:\d+$/.test(value) && gateWriteFailures > 0) {
        gateWriteFailures--;
        throw new Error("label write failed");
      }
      setLabel(noteId, name, value);
    },
    async getNote(noteId: string) { noteReads.push(noteId); return noteOf(noteId); },
    async getNoteContent(noteId: string) { return contents.get(noteId) ?? ""; },
    async getNoteHistory() { return [] as Array<{ noteId: string; title: string; current_title: string; date: string; current_isDeleted?: boolean }>; },
    async getNoteRevisions() { return [] as unknown[]; },
    async createRevision() { return {}; },
    async updateNoteContent(noteId: string, content: string) { contents.set(noteId, content); },
    async createBackup() { return {}; },
    async deleteAttribute() { return {}; },
    async addRelation() { return {}; },
  };

  return {
    client: client as unknown as TriliumClient,
    notes,
    contents,
    labels,
    noteReads,
    failGateWrites: (n: number) => { gateWriteFailures = n; },
    addNote: (id: string, noteLabels: Record<string, string>, content = "") => {
      notes.set(id, baseNote(id, id, "p"));
      labels.set(id, { ...noteLabels });
      contents.set(id, content);
    },
  };
}

function harness() {
  const fake = fakeBrain();
  // The five fetched singletons — session()'s full path reads them.
  fake.addNote("bio", { noteType: "information" }, "<p>bio</p>");
  fake.addNote("goals", { noteType: "information" }, "<p>goals</p>");
  fake.addNote("prefs", { noteType: "information" }, "<p>prefs</p>");
  fake.addNote("resp", { noteType: "information" }, "<p>resp</p>");
  fake.addNote("proto", { noteType: "information" }, "<p>proto</p>");
  const server = new McpServer({ name: "BrainLLM", version: "0.0.0-test" });
  registerTools(server, fake.client, { config: brainConfig() });
  const tools = (server as unknown as { _registeredTools: Record<string, { handler?: Function; callback?: Function }> })._registeredTools;
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r = await (tools[name]!.handler ?? tools[name]!.callback)!(args, {});
    return JSON.parse(r.content[0].text);
  };
  return { ...fake, call };
}

const sessionLabels = (h: ReturnType<typeof harness>) => [...h.labels.values()].find((l) => l.noteType === "session")!;
const addendum = "<h2>Addendum — 09:00</h2><p>Morning stretch.</p>";

describe("newDay after an overnight agent batch", () => {
  test("agent-scoped addenda do not make the day look started", async () => {
    const h = harness();
    h.addNote("sess", { noteType: "session", created: TODAY, scope: "agent" }, "<h2>Addendum — 03:00</h2><p>Overnight batch.</p>");
    const r = await h.call("start");
    expect(r.newDay).toBe(true);
    expect(r.newDayHint).toContain("day()");
  });

  test("an interactive close stamp makes the day not new", async () => {
    const h = harness();
    h.addNote("sess", { noteType: "session", created: TODAY, scope: "interactive", interactive: "09:12" }, addendum);
    const r = await h.call("start");
    expect(r.newDay).toBeUndefined();
  });

  test("an addendum with no close record either way reads as new — a redundant day() beats a skipped one", async () => {
    const h = harness();
    h.addNote("sess", { noteType: "session", created: TODAY }, "<h2>Addendum — 03:00</h2><p>Closed before the label existed.</p>");
    const r = await h.call("start");
    expect(r.newDay).toBe(true);
  });

  test("a day with no session note is new, and start() opens the stub", async () => {
    const h = harness();
    const r = await h.call("start");
    expect(r.newDay).toBe(true);
    expect([...h.labels.values()].some((l) => l.noteType === "session")).toBe(true);
  });

  test("day() reads the same signal: agent addenda do not make its newDay false", async () => {
    const h = harness();
    h.addNote("sess", { noteType: "session", created: TODAY, scope: "agent" }, "<h2>Addendum — 03:00</h2><p>Overnight batch.</p>");
    const r = await h.call("day");
    expect(r.newDay).toBe(true);
  });

  test("day() agrees with start() after an interactive close: newDay false", async () => {
    const h = harness();
    h.addNote("sess", { noteType: "session", created: TODAY, scope: "interactive", interactive: "09:12" }, addendum);
    const r = await h.call("day");
    expect(r.newDay).toBe(false);
  });
});

describe("write-gate hardening", () => {
  const writeOnce = (h: ReturnType<typeof harness>) => h.call("label", { noteId: "bio", name: "status", value: "active" });

  test("a successful content write marks the durable gate", async () => {
    const h = harness();
    h.addNote("sess", { noteType: "session", created: TODAY }, "");
    await writeOnce(h);
    expect(sessionLabels(h).gate).toMatch(/write:\d+/);
  });

  test("a first mark failure absorbed by the retry still yields the full close", async () => {
    const h = harness();
    h.addNote("sess", { noteType: "session", created: TODAY }, "");
    h.failGateWrites(1);
    await writeOnce(h);
    expect(sessionLabels(h).gate).toMatch(/write:\d+/);
    const r = await h.call("session");
    expect(r.closeMode).toBeUndefined();
    expect(r.singletons).toBe("stubs");
    expect(r.gateNote).toBeUndefined();
    expect(r.pending.addendums).toBe(0);
  });

  test("a double failure is repaired by session() from in-process evidence", async () => {
    const h = harness();
    h.addNote("sess", { noteType: "session", created: TODAY }, "");
    h.failGateWrites(2);
    await writeOnce(h);
    expect(sessionLabels(h).gate ?? "").not.toContain("write");
    const r = await h.call("session");
    expect(r.closeMode).toBeUndefined();
    expect(r.singletons).toBe("stubs");
    expect(r.gateNote).toBeUndefined();
    expect(sessionLabels(h).gate).toContain("write:");
  });

  test("when every mark fails the close is still full, and the receipt says the gate could not be recorded", async () => {
    const h = harness();
    h.addNote("sess", { noteType: "session", created: TODAY }, "");
    h.failGateWrites(9);
    await writeOnce(h);
    const r = await h.call("session");
    expect(r.closeMode).toBeUndefined();
    expect(r.singletons).toBe("stubs");
    expect(r.gateNote).toContain("could not be recorded");
    expect(sessionLabels(h).gate ?? "").not.toContain("write");
  });

  test("a truly empty session still gets the light close", async () => {
    const h = harness();
    h.addNote("sess", { noteType: "session", created: TODAY }, "");
    const r = await h.call("session");
    expect(r.closeMode).toBe("light");
    expect(r.note).toContain("no content was written this session");
    expect(r.singletons).toBeUndefined();
    expect(sessionLabels(h).scope).toBe("interactive");
    expect(sessionLabels(h).gate).toContain("session:");
  });

  test("the stubs mode of a written session no longer borrows the word light", async () => {
    const h = harness();
    h.addNote("sess", { noteType: "session", created: TODAY }, "");
    await writeOnce(h);
    const r = await h.call("session");
    expect(r.singletons).toBe("stubs");
    expect(r.mode).toBeUndefined();
    expect(JSON.stringify(r)).not.toContain("\"closeMode\"");
  });
});

describe("session(continuing=true)", () => {
  test("refuses continuing on the day's first session", async () => {
    const h = harness();
    const r = await h.call("session", { continuing: true });
    expect(r.error).toBe("not_a_continuation");
    expect(r.hint).toContain("full pre-close protocol");
  });

  test("a continuation that wrote nothing still closes light, flagged as continuing", async () => {
    const h = harness();
    h.addNote("sess", { noteType: "session", created: TODAY }, addendum);
    const r = await h.call("session", { continuing: true });
    expect(r.continuing).toBe(true);
    expect(r.closeMode).toBe("light");
    expect(r.note).toContain("no content was written this session");
  });

  test("a continuation with a write gets the short review and still marks the session step", async () => {
    const h = harness();
    h.addNote("sess", { noteType: "session", created: TODAY }, addendum);
    await h.call("label", { noteId: "bio", name: "status", value: "active" });
    h.noteReads.length = 0;
    const r = await h.call("session", { continuing: true });
    expect(r.continuing).toBe(true);
    expect(r.master).toBeUndefined();
    expect(r.llm).toBeUndefined();
    expect(r.audit).toBeUndefined();
    expect(r.next.join(" ")).toContain("close(continuing=true)");
    const text = JSON.stringify(r);
    expect(text).not.toContain("Update master singletons");
    expect(text).not.toContain("Audit the singletons");
    expect(h.noteReads).not.toContain("bio");
    expect(sessionLabels(h).gate).toContain("session:");
    expect(sessionLabels(h).scope).toBe("interactive");
  });
});

describe("interactive vs agent close stamping", () => {
  test("an interactive close stamps #interactive; the next start() sees the day as started", async () => {
    const h = harness();
    h.addNote("sess", { noteType: "session", created: TODAY }, "");
    await h.call("label", { noteId: "bio", name: "status", value: "active" });
    await h.call("session");
    const r = await h.call("close", { summary: "Second stretch of the day.", identity: "Claude · Test · Interactive", force: true, backup: false });
    expect(r.noteId).toBe("sess");
    expect(sessionLabels(h).interactive).toBeTruthy();
    const s = await h.call("start");
    expect(s.newDay).toBeUndefined();
  });

  test("an agent close does not stamp; the morning start() still sees the day as new despite the addendum", async () => {
    const h = harness();
    h.addNote("sess", { noteType: "session", created: TODAY }, "");
    await h.call("label", { noteId: "bio", name: "status", value: "active" });
    await h.call("session", { scope: "agent" });
    await h.call("close", { summary: "Overnight batch.", identity: "Claude · Test · Agent", force: true, backup: false });
    expect(sessionLabels(h).interactive).toBeUndefined();
    const s = await h.call("start");
    expect(s.newDay).toBe(true);
  });
});
