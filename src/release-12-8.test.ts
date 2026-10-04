import { describe, expect, test } from "bun:test";
import { addendumBlock, readableText } from "./normalize.js";
import { blockDiff, tableDiff } from "./diffing.js";
import { datedReferences } from "./lifecycle.js";
import { redirectTarget, consentPage } from "./oauth.js";
import { applyFindEdit } from "./tools.js";

const record =
  "<p><em>session · 2026-10-04</em></p><hr>" +
  "<h2>Addendum — 09:15</h2><h3>Claude · Code · Interactive</h3><p>First block.</p>" +
  "<h2>Addendum — 14:05</h2><h3>Claude · Code · Agent</h3><p>Second block.</p>";

describe("addendumBlock", () => {
  test("by marker time", () => {
    const r = addendumBlock(record, "14:05");
    expect(r.matched).toBe(true);
    if (r.matched) {
      expect(r.content).toContain("Second block.");
      expect(r.content).not.toContain("First block.");
      expect(r.identity).toBe("Claude · Code · Agent");
      expect(`${r.position}/${r.of}`).toBe("2/2");
    }
  });

  test("by position, negative from the end", () => {
    const first = addendumBlock(record, "1");
    const last = addendumBlock(record, "-1");
    expect(first.matched && first.content.includes("First block.")).toBe(true);
    expect(last.matched && last.content.includes("Second block.")).toBe(true);
  });

  test("a miss lists the real markers", () => {
    const r = addendumBlock(record, "23:59");
    expect(r.matched).toBe(false);
    if (!r.matched) expect(r.available).toEqual(["Addendum — 09:15", "Addendum — 14:05"]);
  });
});

describe("readableText", () => {
  test("keeps headings, list items and table rows", () => {
    const html = "<h2>Open</h2><ul><li>one</li><li>two</li></ul><table><tbody><tr><td>a</td><td>b</td></tr></tbody></table>";
    const text = readableText(html);
    expect(text).toContain("## Open");
    expect(text).toContain("- one\n- two");
    expect(text).toContain("a | b");
  });
});

describe("tableDiff", () => {
  const table = (rows: string[][]) =>
    `<table><tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join("")}</tr>`).join("")}</tbody></table>`;

  test("a changed cell is reported by row anchor and column", () => {
    const d = tableDiff(table([["Item A", "Open"], ["Item B", "Open"]]), table([["Item A", "Open"], ["Item B", "Closed"]]));
    expect(d?.changedCells).toEqual([{ row: "Item B", column: 2, before: "Open", after: "Closed" }]);
    expect(d?.rowsAdded).toEqual([]);
    expect(d?.rowsRemoved).toEqual([]);
  });

  test("added and removed rows are whole rows", () => {
    const d = tableDiff(table([["A", "1"], ["B", "2"]]), table([["A", "1"], ["C", "3"]]));
    expect(d?.rowsAdded).toEqual(["C | 3"]);
    expect(d?.rowsRemoved).toEqual(["B | 2"]);
  });

  test("no table change, no table report", () => {
    expect(tableDiff("<p>a</p>", "<p>b</p>")).toBeNull();
  });

  test("blockDiff carries the table view and drops bare closing tags", () => {
    const d = blockDiff(table([["A", "x"]]), table([["A", "y"]]));
    expect(d.tables?.changedCells).toHaveLength(1);
    expect([...(d.removed ?? []), ...(d.added ?? [])].some((l) => /^<\/[a-z]+>$/.test(l))).toBe(false);
  });
});

describe("register exemption", () => {
  const body = "<p>Timeless prose.</p><table><tbody>" +
    ["2026-09-01", "2026-09-02", "2026-09-03", "2026-09-04", "2026-09-05"].map((d) => `<tr><td>${d}</td><td>row</td></tr>`).join("") +
    "</tbody></table>";

  test("table dates count against a plain note", () => {
    expect(datedReferences(body)).toBeGreaterThanOrEqual(5);
  });

  test("a register's table dates are exempt, its prose is not", () => {
    expect(datedReferences(body, { register: true })).toBe(0);
    expect(datedReferences(`<p>On 2026-09-01 and 2026-09-02</p>${body}`, { register: true })).toBe(2);
  });
});

describe("applyFindEdit", () => {
  test("falls through to the inline-tolerant pass", () => {
    const r = applyFindEdit("<td><strong>Phase</strong> 2 shipped</td>", "Phase 2", "Phase 3");
    expect(r?.matchMode).toBe("inline-tolerant");
    expect(r?.html).toBe("<td>Phase 3 shipped</td>");
  });

  test("exact still wins when it can", () => {
    expect(applyFindEdit("<p>alpha</p>", "alpha", "beta")?.matchMode).toBe("exact");
  });
});

describe("consent screen redirect", () => {
  test("names the redirect host", () => {
    expect(redirectTarget("https://claude.ai/api/mcp/auth_callback")).toEqual({ host: "claude.ai", loopback: false });
    expect(consentPage({}, "claude.ai", undefined, true, "https://claude.ai/api/mcp/auth_callback")).toContain("sends you back to");
  });

  test("warns on a loopback redirect", () => {
    expect(redirectTarget("http://127.0.0.1:33418/callback")?.loopback).toBe(true);
    expect(redirectTarget("http://localhost/callback")?.loopback).toBe(true);
    expect(consentPage({}, "Claude Code", undefined, false, "http://localhost:5555/callback")).toContain("That address is this computer");
    expect(consentPage({}, "claude.ai", undefined, true, "https://claude.ai/cb")).not.toContain("That address is this computer");
  });
});

describe("revise refuses a dry run it cannot honour", () => {
  test("dryRun with noteId is refused before any read or write", async () => {
    const { McpServer } = await import("@modelcontextprotocol/sdk/server/mcp.js");
    const { registerTools } = await import("./tools.js");
    const touched: string[] = [];
    // Any property access on the client is a call the handler should not make.
    const trilium = new Proxy({}, { get: (_t, p) => { touched.push(String(p)); return () => Promise.reject(new Error("no I/O")); } });
    const s = new McpServer({ name: "t", version: "0" });
    registerTools(s, trilium as never, { config: { root: "r", master: {}, llm: {}, memory: {}, knowledge: {}, insights: {} } as never });
    const tool = (s as unknown as { _registeredTools: Record<string, { handler: (a: unknown, e: unknown) => Promise<{ content: Array<{ text: string }> }> }> })._registeredTools.revise!;
    const out = await tool.handler({ noteId: "abc", find: "a", within: "tr", body: "x", dryRun: true }, {});
    expect(out.content[0]!.text).toContain("dryRun= applies only to revise(domain=)");
    expect(touched).toEqual([]);
  });
});
