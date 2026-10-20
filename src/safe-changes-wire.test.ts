import { expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { coerceToolArgs } from "./coerce.js";
import { registerTools } from "./tools.js";
import { EMPTY_BRAINLLM } from "./config.js";
import { TriliumClient, type Note } from "./trilium.js";

// Real MCP serialization and real ETAPI HTTP requests, against a disposable
// loopback backend. No production URL, token or data is loaded.
test("Safe Changes wire contract: previews, coverage and failed snapshots", async () => {
  const note = { noteId: "note00000001", title: "Register", type: "text", mime: "text/html", parentNoteIds: ["root"], childNoteIds: [],
    attributes: [{ attributeId: "a", noteId: "note00000001", type: "label", name: "noteType", value: "information", position: 0, isInheritable: false }],
    dateCreated: "2026-10-01 00:00:00", dateModified: "2026-10-01 00:00:00" } as unknown as Note;
  const body = "<p>ProductHunt alpha</p>";
  const mutations: string[] = [];
  const backend = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch(req) {
    const path = new URL(req.url).pathname;
    if (req.headers.get("authorization") !== "Bearer disposable") return new Response("unauthorized", { status: 401 });
    if (req.method !== "GET") { mutations.push(`${req.method} ${path}`); return new Response("revision unavailable", { status: 503 }); }
    if (path === "/etapi/notes") return Response.json({ results: [note] });
    if (path === "/etapi/notes/note00000001") return Response.json(note);
    if (path === "/etapi/notes/note00000001/content") return new Response(body, { headers: { "content-type": "text/html" } });
    return new Response("missing", { status: 404 });
  } });
  const server = new McpServer({ name: "BrainLLM", version: "wire-test" });
  const trilium = new TriliumClient(`http://127.0.0.1:${backend.port}`, "disposable");
  registerTools(server, trilium, { config: { ...EMPTY_BRAINLLM, root: "root" } });
  coerceToolArgs(server);
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "safe-changes-test", version: "1" });
  try {
    await server.connect(a);
    await client.connect(b);
    const listed = await client.listTools();
    const schema = listed.tools.find((t) => t.name === "revise")!.inputSchema;
    expect(schema.properties).toHaveProperty("moves");
    expect((schema.properties as any).dryRun.type).toBe("boolean");
    expect((schema.properties as any).moves.type).toBe("array");
    const preview = await client.callTool({ name: "revise", arguments: { noteId: "note00000001", edits: [{ find: "alpha", body: "beta" }], dryRun: "true" } });
    const p = JSON.parse((preview.content as any)[0].text);
    expect(p.dryRun).toBe(true);
    expect(p.after).toBe("<p>ProductHunt beta</p>");
    expect(mutations).toEqual([]);
    const scan = await client.callTool({ name: "consistency", arguments: { pattern: "ProductHunt" } });
    expect(JSON.parse((scan.content as any)[0].text).coverage.complete).toBe(true);
    const failed = await client.callTool({ name: "revise", arguments: { noteId: "note00000001", find: "alpha", body: "beta" } });
    expect(failed.isError).toBe(true);
    expect(mutations).toEqual(["POST /etapi/notes/note00000001/revision"]); // no PUT and no write retry
  } finally {
    await client.close();
    await server.close();
    await backend.stop(true);
  }
});
