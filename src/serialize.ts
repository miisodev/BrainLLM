// ─────────────────────────────────────────────────────────────────────────────
// BrainLLM — write serialization
//
// One write-tool call at a time, process-wide.
//
// Every write tool is a read-modify-write over shared notes: fetch content →
// transform in memory → PUT it back. JavaScript's single thread makes each
// handler LOOK atomic, but every `await` is a yield point — two concurrent
// sessions (two agents on one hosted instance, an agent and an interactive
// session, start()'s stub creation racing another session's close()) can both
// read the same body, transform their own copy, and each PUT a full body the
// other's write never saw. The loser is silently discarded: no error, no
// conflict, a receipt that says the write landed. Trilium revisions keep the
// lost text recoverable, but nothing ever told either caller the brain forked.
//
// Reads stay fully parallel — they don't mutate, and the fix must not tax the
// 80% of calls that never write.
//
// Scope, stated honestly: this isolates writes against EACH OTHER through this
// server. A human editing in the Trilium UI during the (sub-second) window a
// handler holds between its read and its PUT is outside any lock we hold —
// revisions remain the recovery story there.
//
// The lock is a whole-handler wrapper applied by re-writing `handler` on the
// registered tool objects — the same post-registration pass pattern
// applyToolAnnotations() uses, rather than touching 50+ `server.tool()`
// call sites. Classification comes from TOOL_ANNOTATIONS: absent means WRITE
// (the table's own convention — the safe default is the one that serializes).
// ─────────────────────────────────────────────────────────────────────────────

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { TOOL_ANNOTATIONS } from "./annotations.js";

// The queue. Every serialized call chains onto the previous one regardless of
// its outcome — a rejected handler must not wedge the chain, so the link we
// keep is the settle (not the result) while the caller still gets the real
// promise back.
let chain: Promise<unknown> = Promise.resolve();

let active: { tool: string; startedAt: number } | null = null;
let contentionEvents = 0;

/** Run `fn` under the global write lock. FIFO — arrival order is execution
 *  order, so a burst of concurrent writes from several sessions lands in a
 *  deterministic sequence rather than whatever the event loop settles first. */
export function withWriteLock<T>(tool: string, fn: () => Promise<T>): Promise<T> {
  if (active) contentionEvents++;
  const run = async (): Promise<T> => {
    active = { tool, startedAt: Date.now() };
    try {
      return await fn();
    } finally {
      active = null;
    }
  };
  const result = chain.then(run, run);
  chain = result.then(
    () => undefined,
    () => undefined
  );
  return result;
}

/** Wrap every write-classified tool's handler in the lock. Applied once per
 *  server instance inside createServer(); the chain itself is module-level,
 *  so every session on this process shares one queue — which is the point:
 *  the sessions are the concurrent writers. */
export function serializeWrites(server: McpServer): { serialized: number; readsUntouched: number } {
  const registry = (server as unknown as {
    _registeredTools?: Record<string, { handler?: unknown }>;
  })._registeredTools;
  if (!registry) return { serialized: 0, readsUntouched: 0 };

  let serialized = 0;
  let readsUntouched = 0;
  for (const [name, tool] of Object.entries(registry)) {
    const hints = TOOL_ANNOTATIONS[name];
    const isWrite = !hints?.readOnlyHint; // absent = write, per the table's convention
    if (!isWrite || typeof tool.handler !== "function") {
      if (!isWrite) readsUntouched++;
      continue;
    }
    const original = tool.handler as (this: unknown, ...args: never[]) => Promise<unknown>;
    tool.handler = function (this: unknown, ...args: never[]) {
      return withWriteLock(name, () => original.apply(this, args));
    };
    serialized++;
  }
  return { serialized, readsUntouched };
}

/** What is holding the lock right now, if anything — surfaced to operators
 *  (and to tests) rather than living only in a log line. */
export function writeLockState(): { active: { tool: string; heldMs: number } | null; contentionEvents: number } {
  return {
    active: active ? { tool: active.tool, heldMs: Date.now() - active.startedAt } : null,
    contentionEvents,
  };
}
