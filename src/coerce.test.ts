import { describe, expect, test } from "bun:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { coerceToolArgs } from "./coerce.js";

/** The schema AS THE SDK PARSES IT AT CALL TIME — mcp.js re-normalizes
 *  tool.inputSchema on every tools/call (`schemaToParse = inputObj ?? …`),
 *  so parsing the registered schema directly is exercising the exact parse
 *  the caller's arguments go through. */
const registeredSchema = (s: McpServer, name: string): z.ZodTypeAny => {
  const registry = (s as unknown as { _registeredTools: Record<string, { inputSchema: z.ZodTypeAny }> })._registeredTools;
  if (!registry?.[name]) throw new Error(`tool ${name} not found in registry`);
  return registry[name].inputSchema;
};

describe("coerceToolArgs — string-encoded params through a strict schema", () => {
  test("string-encoded booleans, numbers and arrays parse where they previously failed", () => {
    const server = new McpServer({ name: "t", version: "0.0.0" });
    server.tool(
      "demo",
      "demo",
      {
        strict: z.boolean().optional(),
        deep: z.boolean().optional(),
        nth: z.number().optional(),
        edits: z.array(z.object({ find: z.string(), body: z.string() })).optional(),
        body: z.string().optional(),
      },
      async () => ({ content: [{ type: "text" as const, text: "ok" }] })
    );

    // The observed failure, 2026-09-03: these exact calls were rejected with
    // "Expected boolean, received string" / "Expected array, received string".
    // Prove the defect first — the ORIGINAL schema rejects string encodings.
    const before = registeredSchema(server, "demo");
    expect(() => before.parse({ strict: "true" })).toThrow();
    expect(() => before.parse({ edits: '[{"find":"a","body":"b"}]' })).toThrow();

    const report = coerceToolArgs(server as never);
    expect(report.tools).toEqual(["demo"]);
    expect(report.fields).toBe(4); // strict, deep, nth, edits — body is untouched

    // After coercion the same strings parse to the declared types.
    const after = registeredSchema(server, "demo");
    const parsed = after.parse({
      strict: "true",
      deep: "false",
      nth: "2",
      edits: '[{"find":"a","body":"b"}]',
      body: "true",
    });
    expect(parsed).toEqual({
      strict: true,
      deep: false,
      nth: 2,
      edits: [{ find: "a", body: "b" }],
      body: "true", // string-declared: a body whose text is "true" stays text
    });
  });

  test("already-typed values pass through untouched", () => {
    const server = new McpServer({ name: "t", version: "0.0.0" });
    server.tool("typed", "t", { flag: z.boolean().optional(), count: z.number().optional() }, async () => ({ content: [{ type: "text" as const, text: "ok" }] }));
    coerceToolArgs(server as never);
    const schema = registeredSchema(server, "typed");
    expect(schema.parse({ flag: true, count: 5 })).toEqual({ flag: true, count: 5 });
  });

  test("a non-numeric string for a number field is left for Zod to reject", () => {
    const server = new McpServer({ name: "t", version: "0.0.0" });
    server.tool("num", "n", { count: z.number().optional() }, async () => ({ content: [{ type: "text" as const, text: "ok" }] }));
    coerceToolArgs(server as never);
    expect(() => registeredSchema(server, "num").parse({ count: "five" })).toThrow();
  });

  test("a JSON-looking string that is not an array stays a string", () => {
    const server = new McpServer({ name: "t", version: "0.0.0" });
    server.tool("arr", "a", { list: z.array(z.string()).optional() }, async () => ({ content: [{ type: "text" as const, text: "ok" }] }));
    coerceToolArgs(server as never);
    // Not parseable as an array — coercion declines, strict parse rejects.
    expect(() => registeredSchema(server, "arr").parse({ list: "not json [" })).toThrow();
  });
});