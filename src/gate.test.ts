import { describe, expect, test } from "bun:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerTools } from "./tools.js";
import { EMPTY_BRAINLLM, type BrainLLMConfig } from "./config.js";
import type { TriliumClient, Note } from "./trilium.js";

// A session that crosses midnight calls session()/remarks() on a day start()
// never opened. The gate's durable home is that day's session note, and the
// close steps used to throw "today's session note was not found" until a fresh
// start() created it — stranding the close protocol. The steps now open the
// same stub start() would.

function fakeTrilium() {
  const notes = new Map<string, Note>();
  const labels = new Map<string, Record<string, string>>();
  let seq = 0;
  const noteOf = (id: string): Note => {
    const base = notes.get(id)!;
    return { ...base, attributes: Object.entries(labels.get(id) ?? {}).map(([name, value]) => ({ attributeId: `${id}-${name}`, noteId: id, type: "label", name, value, position: 0, isInheritable: false })) } as Note;
  };
  const client = {
    async searchNotes(query: string) {
      const date = /#created='([^']+)'/.exec(query)?.[1];
      const hit = [...notes.keys()].find((id) => labels.get(id)?.noteType === "session" && labels.get(id)?.created === date);
      return { results: hit ? [noteOf(hit)] : [] };
    },
    async createNote(parentNoteId: string, title: string) {
      const noteId = `n${++seq}`;
      notes.set(noteId, { noteId, title, type: "text", mime: "text/html", parentNoteIds: [parentNoteId], childNoteIds: [], attributes: [], dateCreated: "", dateModified: "" } as unknown as Note);
      labels.set(noteId, {});
      return { note: noteOf(noteId), branch: { branchId: `b${seq}` } };
    },
    async addLabel(noteId: string, name: string, value = "") { labels.get(noteId)![name] = value; },
    async updateLabelValue(noteId: string, name: string, value: string) { labels.get(noteId)![name] = value; },
    async getNote(noteId: string) { return noteOf(noteId); },
  };
  return { client: client as unknown as TriliumClient, notes, labels };
}

describe("close-gate steps after midnight", () => {
  test("remarks() on a day with no session note opens the stub and records the step", async () => {
    const { client, labels } = fakeTrilium();
    const cfg: BrainLLMConfig = { ...EMPTY_BRAINLLM, root: "root", memory: { ...EMPTY_BRAINLLM.memory, sessions: "sessions" } };
    const server = new McpServer({ name: "BrainLLM", version: "0.0.0-test" });
    registerTools(server, client, { config: cfg });
    const tool = (server as unknown as { _registeredTools: Record<string, { handler?: Function; callback?: Function }> })._registeredTools.remarks;
    const run = (tool.handler ?? tool.callback)!;

    const result = await run({}, {});
    expect(JSON.stringify(result)).not.toContain("not found");

    const sessions = [...labels.entries()].filter(([, l]) => l.noteType === "session");
    expect(sessions).toHaveLength(1);
    const [, l] = sessions[0];
    expect(l.created).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(l.gate).toMatch(/^remarks:\d+$/);
    expect(l.iconClass).toBeTruthy();

    // A second step reuses the note rather than opening another.
    await run({}, {});
    expect([...labels.values()].filter((x) => x.noteType === "session")).toHaveLength(1);
  });
});

describe("light close", () => {
  const setup = () => {
    const fake = fakeTrilium();
    const cfg: BrainLLMConfig = { ...EMPTY_BRAINLLM, root: "root", memory: { ...EMPTY_BRAINLLM.memory, sessions: "sessions" } };
    const server = new McpServer({ name: "BrainLLM", version: "0.0.0-test" });
    registerTools(server, fake.client, { config: cfg });
    const tools = (server as unknown as { _registeredTools: Record<string, { handler?: Function; callback?: Function }> })._registeredTools;
    const call = (name: string, args: object = {}) => (tools[name]!.handler ?? tools[name]!.callback)!(args, {});
    return { ...fake, call };
  };

  test("remarks() gives one short cue when nothing was written", async () => {
    const { call } = setup();
    const text = JSON.stringify(await call("remarks"));
    expect(text).toContain("light");
    expect(text).not.toContain("Capabilities");
  });

  test("a recorded write brings back the full cues", async () => {
    const { call, labels } = setup();
    await call("remarks");
    const [id] = [...labels.entries()].find(([, l]) => l.noteType === "session")!;
    labels.get(id)!.gate = `${labels.get(id)!.gate},write:9`;
    const text = JSON.stringify(await call("remarks"));
    expect(text).toContain("Capabilities");
  });

  test("close() without a write asks only for session, remarks and diary", async () => {
    const { call } = setup();
    const text = JSON.stringify(await call("close", { summary: "s", identity: "Claude · Test · Unit" }));
    expect(text).toContain("preclose_incomplete");
    expect(text).toContain("session, remarks, diary");
    expect(text).not.toContain("maintain()\\\", \\\"");
    expect(text).toContain("hint");
    expect(text).toMatch(/Call session\(\), remarks\(\), diary\(\) first/);
  });
});
