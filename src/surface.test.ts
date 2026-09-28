import { describe, expect, test } from "bun:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerMemoryTools, MEMORY_INDEX_DEFAULT, MEMORY_INDEX_CHAR_BUDGET } from "./tools-memory.js";
import { registerKnowledgeTools } from "./tools-knowledge.js";
import { EMPTY_BRAINLLM } from "./config.js";
import type { TriliumClient, Note } from "./trilium.js";

const label = (noteId: string, name: string, value: string) =>
  ({ attributeId: `${noteId}-${name}`, noteId, type: "label", name, value, position: 0, isInheritable: false });

const note = (noteId: string, labels: Record<string, string>, extra: Partial<Note> = {}): Note =>
  ({
    noteId, title: noteId, type: "text", mime: "text/html", parentNoteIds: ["p"], childNoteIds: [],
    attributes: Object.entries(labels).map(([k, v]) => label(noteId, k, v)),
    dateCreated: "2026-09-01 00:00:00.000+0000", dateModified: "2026-09-01 00:00:00.000+0000",
    utcDateCreated: "", utcDateModified: "", isProtected: false, parentBranchIds: ["b"], blobId: "x",
    ...extra,
  }) as unknown as Note;

function server(trilium: Partial<TriliumClient>) {
  const s = new McpServer({ name: "BrainLLM", version: "0.0.0-test" });
  const ref = { config: { ...EMPTY_BRAINLLM, root: "root" } };
  registerMemoryTools(s, trilium as TriliumClient, ref);
  registerKnowledgeTools(s, trilium as TriliumClient, ref);
  const tools = (s as unknown as { _registeredTools: Record<string, { handler?: Function; callback?: Function }> })._registeredTools;
  return async (name: string, args: Record<string, unknown>) => {
    const t = tools[name];
    const r = await (t.handler ?? t.callback)!(args, {});
    return JSON.parse(r.content[0].text);
  };
}

describe("memory() bounds a dated thread's index", () => {
  const entries = Array.from({ length: 45 }, (_, i) => note(`e${i}`, { noteType: "threadEntry", created: `2026-08-${String((i % 28) + 1).padStart(2, "0")}` }));
  const book = note("t", { noteType: "thread" }, { childNoteIds: entries.map((e) => e.noteId) });
  let requestedLimit: number | undefined;
  const trilium: Partial<TriliumClient> = {
    getNote: (async (id: string) => (id === "t" ? book : entries.find((e) => e.noteId === id)!)) as TriliumClient["getNote"],
    getNoteContent: (async () => "<p>goal</p>") as TriliumClient["getNoteContent"],
    getNoteContentResult: (async () => "<p>goal</p>") as TriliumClient["getNoteContentResult"],
    searchNotes: (async (_q: string, opts?: { limit?: number }) => {
      requestedLimit = opts?.limit;
      return { results: entries.slice(0, opts?.limit ?? entries.length) };
    }) as unknown as TriliumClient["searchNotes"],
  };
  const call = server(trilium);

  test(`defaults to the newest ${MEMORY_INDEX_DEFAULT} with the total and a pointer to the rest`, async () => {
    const r = await call("memory", { id: "t" });
    expect(requestedLimit).toBe(MEMORY_INDEX_DEFAULT);
    expect(r.children).toHaveLength(MEMORY_INDEX_DEFAULT);
    expect(r.totalChildren).toBe(45);
    expect(r.more).toContain("limit=");
  });

  test("limit= widens the index, and a complete index carries no pointer", async () => {
    const r = await call("memory", { id: "t", limit: 100 });
    expect(r.children).toHaveLength(45);
    expect(r.more).toBeUndefined();
  });

  test("noteId= is accepted as an alias of id", async () => {
    const r = await call("memory", { noteId: "t", limit: 5 });
    expect(r.children).toHaveLength(5);
  });

  test("a call with neither returns an informational error, not a throw", async () => {
    const r = await call("memory", {});
    expect(r.error).toBe("missing_id");
  });
});

describe("memory() keeps a busy thread's default index under its size budget", () => {
  // Found against the live brain: 30 of myClerkBook's 35 days still indexed to
  // 58k characters, because each day carries many long addendum leads.
  const busyDay = "<h2>Addendum — 09:00</h2><h3>who</h3><p>" + "x".repeat(3000) + "</p>";
  const entries = Array.from({ length: 40 }, (_, i) => note(`d${i}`, { noteType: "threadEntry", created: "2026-09-01" }));
  const book = note("t", { noteType: "thread" }, { childNoteIds: entries.map((e) => e.noteId) });
  const call = server({
    getNote: (async (id: string) => (id === "t" ? book : entries[0])) as TriliumClient["getNote"],
    getNoteContent: (async (id: string) => (id === "t" ? "<p>goal</p>" : busyDay.repeat(16))) as TriliumClient["getNoteContent"],
    getNoteContentResult: (async () => "<p>goal</p>") as TriliumClient["getNoteContentResult"],
    searchNotes: (async (_q: string, opts?: { limit?: number }) => ({ results: entries.slice(0, opts?.limit ?? 40) })) as unknown as TriliumClient["searchNotes"],
  });

  test("the default stops at the budget and says how much remains", async () => {
    const r = await call("memory", { id: "t" });
    expect(JSON.stringify(r.children).length).toBeLessThanOrEqual(MEMORY_INDEX_CHAR_BUDGET + 2);
    expect(r.children.length).toBeLessThan(MEMORY_INDEX_DEFAULT);
    expect(r.children.length).toBeGreaterThan(0);
    expect(r.more).toContain(`of 40`);
  });

  test("an explicit limit is honoured past the budget", async () => {
    const r = await call("memory", { id: "t", limit: 20 });
    expect(r.children).toHaveLength(20);
  });
});

describe("knowledge() accepts noteId as an alias of id", () => {
  const info = note("k", { noteType: "information" });
  const call = server({
    getNote: (async () => info) as TriliumClient["getNote"],
    getNoteContent: (async () => "<p>body</p>") as TriliumClient["getNoteContent"],
    getNoteContentResult: (async () => "<p>body</p>") as TriliumClient["getNoteContentResult"],
  });

  test("id and noteId read the same note", async () => {
    const a = await call("knowledge", { id: "k" });
    const b = await call("knowledge", { noteId: "k" });
    expect(b).toEqual(a);
  });
});
