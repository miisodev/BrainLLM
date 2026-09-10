import { describe, expect, test } from "bun:test";
import { withWriteLock, serializeWrites, writeLockState } from "./serialize.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

/** The handler AS THE REGISTRY NOW HOLDS IT — i.e. after serializeWrites has
 *  (or has not) wrapped it. The SDK calls whatever sits here, so invoking this
 *  is exercising the wrapper where it actually lives. This also proves the
 *  registry access pattern itself: if _registeredTools ever changed shape,
 *  the wrapper would silently engage on zero tools and these tests would
 *  catch it rather than shipping a lock that never locks. */
const registryHandler = (s: McpServer, name: string): ((args?: unknown) => Promise<unknown>) => {
  const registry = (s as unknown as { _registeredTools: Record<string, { handler: (args?: unknown) => Promise<unknown> }> })._registeredTools;
  if (!registry?.[name]) throw new Error(`tool ${name} not found in registry`);
  return (args) => registry[name].handler(args);
};

describe("withWriteLock — FIFO mutual exclusion", () => {
  test("concurrent calls run to completion one at a time, in arrival order", async () => {
    const events: string[] = [];
    const hold = (name: string, ms: number) =>
      withWriteLock(name, async () => {
        events.push(`enter:${name}`);
        await new Promise((r) => setTimeout(r, ms));
        events.push(`exit:${name}`);
      });

    // Fire three "writes" with deliberately interleaved durations — the
    // shortest last. If the lock works, entries run in submission order and
    // never overlap; if it does not, the 10ms call finishes before the 30ms
    // one and the order scrambles.
    const a = hold("slow", 30);
    const b = hold("medium", 15);
    const c = hold("fast", 5);
    await Promise.all([a, b, c]);

    expect(events).toEqual([
      "enter:slow", "exit:slow",
      "enter:medium", "exit:medium",
      "enter:fast", "exit:fast",
    ]);
  });

  test("a rejected handler does not wedge the chain", async () => {
    const boom = withWriteLock("boom", async () => {
      throw new Error("handler failed");
    });
    await expect(boom).rejects.toThrow("handler failed");

    // The next write still runs — the chain keeps the SETTLEMENT, not the
    // result, so one failing tool cannot deadlock every later one.
    let ran = false;
    await withWriteLock("after", async () => {
      ran = true;
    });
    expect(ran).toBe(true);
  });

  test("the caller receives the handler's own value", async () => {
    const value = await withWriteLock("value", async () => 42);
    expect(value).toBe(42);
  });

  test("writeLockState reports the active holder and contention", async () => {
    let inside = false;
    let contender: Promise<void> | null = null;
    const held = withWriteLock("holder", async () => {
      inside = true;
      const state = writeLockState();
      expect(state.active?.tool).toBe("holder");
      expect(state.active!.heldMs).toBeGreaterThanOrEqual(0);
      // Something else arrived while the lock was held — a contender. Fired
      // and NOT awaited here: awaiting it inside the holder would deadlock
      // (the contender cannot run until this holder returns), which is itself
      // the behavior under test — the lock really does exclude.
      contender = withWriteLock("contender", async () => {});
      await new Promise((r) => setTimeout(r, 5));
      expect(writeLockState().contentionEvents).toBeGreaterThan(0);
      inside = false;
    });
    await held;
    // Only now can the contender run — the holder has returned.
    await contender!;
    expect(inside).toBe(false);
    expect(writeLockState().active).toBeNull();
  });
});

describe("serializeWrites — registry-level handler wrapping", () => {
  test("write-classified handlers are queued; read-only handlers are not", async () => {
    const server = new McpServer({ name: "t", version: "0.0.0" });
    const order: string[] = [];
    const mk = (name: string, ms: number) => async () => {
      order.push(`enter:${name}`);
      await new Promise((r) => setTimeout(r, ms));
      order.push(`exit:${name}`);
      // A real CallToolResult shape — the SDK's handler type demands content,
      // and the point here is the wrapper, not the payload.
      return { content: [{ type: "text" as const, text: name }] };
    };

    // brain-check.mjs's own negative-testing lesson applies here too: a
    // wrapper that has only ever been seen to pass is not known to wrap.
    // So the reads are fired FIRST with the longest delay, writes after —
    // if reads were wrongly serialized, the write could not start until the
    // read finished and order would scramble.
    server.tool("recall", "read", { q: z.string() }, mk("read", 40));
    server.tool("revise", "write", { q: z.string() }, mk("write1", 20));
    server.tool("remember", "write", { q: z.string() }, mk("write2", 5));

    const { serialized, readsUntouched } = serializeWrites(server as never);
    expect(serialized).toBe(2);
    expect(readsUntouched).toBe(1);

    await Promise.all([
      registryHandler(server, "recall")({ q: "x" }),
      registryHandler(server, "revise")({ q: "x" }),
      registryHandler(server, "remember")({ q: "x" }),
    ]);

    // The contract is reads PARALLEL with everything, writes FIFO among
    // themselves — so the read's exit is LAST (the writes ran inside its
    // window), and each write still enters before the previous one exits.
    // If reads were wrongly serialized, enter:write1 would come after
    // exit:read and this order would scramble.
    expect(order).toEqual([
      "enter:read",
      "enter:write1", "exit:write1",
      "enter:write2", "exit:write2",
      "exit:read",
    ]);
  });

  test("an unclassified tool is treated as a write — the table's own convention", () => {
    const server = new McpServer({ name: "t", version: "0.0.0" });
    server.tool("mystery", "not in the table", { q: z.string() }, async () => ({ content: [{ type: "text" as const, text: "mystery" }] }));
    const { serialized } = serializeWrites(server as never);
    expect(serialized).toBe(1);
  });
});
