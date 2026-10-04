// ─────────────────────────────────────────────────────────────────────────────
// BrainLLM — result size cap
//
// Hosted clients refuse tool results past roughly 150,000 characters, and a
// brain grows: start(depth="full"), brain(), assembly() and graph() all scale
// with it. Each large read already offers a narrower form (section=, limit=,
// block=, ids=), but nothing guaranteed that a result would fit. This pass
// does, for every tool at once: a result over the cap is cut at the cap and
// ends with a plain note naming the narrower reads, rather than being refused
// by the client with nothing returned at all.
//
// Same post-registration pattern as serializeWrites(): handlers are wrapped on
// the registry, so no call site changes.
// ─────────────────────────────────────────────────────────────────────────────

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

/** Characters of text a single tool result may carry. Below the hosted
 *  ~150k ceiling with room for the transport envelope. */
export const RESULT_CHAR_CAP = 140_000;

type TextResult = { content?: Array<{ type: string; text?: string }> };

/** Cut any text block that would push a result past `cap`. Pure. */
export function capResult<T extends TextResult>(result: T, tool: string, cap = RESULT_CHAR_CAP): T {
  const blocks = result?.content;
  if (!Array.isArray(blocks)) return result;
  const total = blocks.reduce((n, b) => n + (b.type === "text" ? (b.text?.length ?? 0) : 0), 0);
  if (total <= cap) return result;
  let budget = cap;
  const content = blocks.map((b) => {
    if (b.type !== "text" || !b.text) return b;
    if (budget <= 0) return { ...b, text: "" };
    const text = b.text.length > budget ? b.text.slice(0, budget) : b.text;
    budget -= text.length;
    return { ...b, text };
  });
  const note =
    `\n\n[BrainLLM: ${tool}() returned ${total.toLocaleString("en-US")} characters, cut at ${cap.toLocaleString("en-US")} to fit the client's limit. ` +
    `Narrow the read: section= for one heading, block= for one addendum, limit= for fewer entries, or fewer ids=.]`;
  content.push({ type: "text", text: note });
  return { ...result, content };
}

/** Wrap every registered tool so its result never exceeds the cap. */
export function capToolResults(server: McpServer, cap = RESULT_CHAR_CAP): number {
  const registry = (server as unknown as {
    _registeredTools?: Record<string, { handler?: (...args: unknown[]) => unknown }>;
  })._registeredTools;
  if (!registry) return 0;
  let wrapped = 0;
  for (const [name, tool] of Object.entries(registry)) {
    const inner = tool.handler;
    if (typeof inner !== "function") continue;
    tool.handler = async (...args: unknown[]) => capResult((await inner(...args)) as TextResult, name, cap);
    wrapped++;
  }
  return wrapped;
}
