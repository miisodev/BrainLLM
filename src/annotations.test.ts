import { describe, expect, test } from "bun:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerTools } from "./tools.js";
import { registerAdvancedTools } from "./tools-advanced.js";
import { TOOL_ANNOTATIONS, applyToolAnnotations } from "./annotations.js";
import type { TriliumClient } from "./trilium.js";
import type { BrainLLMConfig } from "./config.js";

// Registration only builds the schemas — no handler runs — so the client and
// config never need to be real.
const stubTrilium = {} as TriliumClient;
const stubBrain = { config: {} as BrainLLMConfig };

// Composed the same way index.ts composes them: core is core, and full mode is
// core PLUS the raw surface. Keeping the two registrations separate is what
// makes "which tools does this mode have" answerable by reading one function.
function register(mode: "core" | "full"): McpServer {
  const s = new McpServer({ name: "BrainLLM", version: "0.0.0-test" });
  registerTools(s, stubTrilium, stubBrain);
  if (mode === "full") registerAdvancedTools(s, stubTrilium, stubBrain);
  return s;
}

const namesOf = (s: McpServer): string[] =>
  Object.keys((s as unknown as { _registeredTools: Record<string, unknown> })._registeredTools);

describe("every registered tool is classified", () => {
  // The mechanism already fails SAFE — an unclassified tool is treated as a
  // write and logged to stderr. That is why this went unnoticed: assembly,
  // claim and diff shipped unclassified across three releases, the warning was
  // printed on every boot, and the server's stderr is a Railway container log
  // nobody tails. A safe default plus an unread notification is indistinguishable
  // from correctness right up until someone checks.
  //
  // The failure this catches is not "a write is exposed as a read" — the
  // default prevents that. It is the reverse: a genuine READ stuck in the write
  // bucket, so it prompts on every call, so the user answers "always allow"
  // once and stops reading the prompts. Same shape as a maintenance flag that
  // always fires.
  for (const mode of ["core", "full"] as const) {
    test(`${mode} mode leaves nothing unclassified`, () => {
      const { unclassified, annotated } = applyToolAnnotations(register(mode));
      expect(unclassified).toEqual([]);
      expect(annotated).toBeGreaterThan(0);
    });
  }

  test("core registers every core tool in the table", () => {
    const names = namesOf(register("core"));
    for (const name of names) expect(TOOL_ANNOTATIONS[name]).toBeDefined();
  });

  test("the table has no entries for tools that do not exist", () => {
    // A stale entry is harmless at runtime and a lie in review — it makes the
    // table read as covering a surface it does not.
    const registered = new Set(namesOf(register("full")));
    const orphans = Object.keys(TOOL_ANNOTATIONS).filter((n) => !registered.has(n));
    expect(orphans).toEqual([]);
  });

  test("hints are internally consistent", () => {
    for (const [name, hints] of Object.entries(TOOL_ANNOTATIONS)) {
      if (hints.readOnlyHint === true) {
        // A read that also claims to destroy something is a contradiction, and
        // the read-only group is the one users grant blanket permission to.
        expect(`${name}:${hints.destructiveHint ?? false}`).toBe(`${name}:false`);
      }
    }
  });
});

describe("the core/raw boundary", () => {
  test("the two surfaces are disjoint", () => {
    // Enforced at runtime too — the SDK throws on a duplicate name — but stated
    // here because it is now a property of how they are COMPOSED rather than an
    // accident of one function calling the other.
    const core = new Set(namesOf(register("core")));
    const full = namesOf(register("full"));
    expect(full.length).toBe(core.size + full.filter((n) => !core.has(n)).length);
  });

  test("the counts match what the docs claim", () => {
    // A tripwire, deliberately. These numbers appear in README, BLUEPRINT and
    // three pages of the landing site, nothing derives them, and they have gone
    // stale on three separate releases. Adding a tool SHOULD fail this test —
    // that is the reminder to update the places that state the count.
    const core = namesOf(register("core")).length;
    const raw = namesOf(register("full")).length - core;
    expect({ core, raw, total: core + raw }).toEqual({ core: 42, raw: 33, total: 75 });
  });
});

describe("the tools added in 10.3–10.4 are classified correctly", () => {
  test("assembly and diff are reads — they write nothing", () => {
    expect(TOOL_ANNOTATIONS.assembly?.readOnlyHint).toBe(true);
    expect(TOOL_ANNOTATIONS.diff?.readOnlyHint).toBe(true);
  });

  test("claim is a write, because two of its four modes write", () => {
    expect(TOOL_ANNOTATIONS.claim?.readOnlyHint).toBe(false);
    expect(TOOL_ANNOTATIONS.claim?.destructiveHint).toBe(false);
    // Deliberately NOT idempotent: each verification appends a dated line.
    expect(TOOL_ANNOTATIONS.claim?.idempotentHint).toBeUndefined();
  });
});
