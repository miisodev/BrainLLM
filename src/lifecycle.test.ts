import { describe, expect, test } from "bun:test";
import { applyResolution } from "./lifecycle.js";
import { labelPlan } from "./router.js";
import { RESOLUTION_ANCHOR } from "./templates.js";

describe("applyResolution", () => {
  test("replaces the anchor tail", () => {
    const html = `<p>intro</p>\n${RESOLUTION_ANCHOR}\n<p><em>— open —</em></p>`;
    const out = applyResolution(html, "<p>We chose Supabase.</p>", "2026-06-10");
    expect(out).toContain("<p>intro</p>");
    expect(out).toContain("We chose Supabase.");
    expect(out).toContain("Closed 2026-06-10");
    expect(out).not.toContain("— open —");
  });
  test("appends when no anchor exists", () => {
    const out = applyResolution("<p>legacy note</p>", "<p>answer</p>", "2026-06-10");
    expect(out).toContain("<p>legacy note</p>");
    expect(out).toContain(RESOLUTION_ANCHOR);
    expect(out).toContain("<p>answer</p>");
  });
});

describe("labelPlan (V5)", () => {
  test("every note gets noteType and created", () => {
    const flat = labelPlan("knowledge", {}, "2026-06-10").map((l) => `${l.name}=${l.value}`);
    expect(flat).toContain("noteType=knowledge");
    expect(flat).toContain("created=2026-06-10");
  });
  test("thread gets an active status; non-thread kinds do not", () => {
    const thread = labelPlan("thread", {}, "2026-06-10").map((l) => `${l.name}=${l.value}`);
    expect(thread).toContain("status=active");
    const info = labelPlan("information", { domain: "Tech" }, "2026-06-10").map((l) => `${l.name}=${l.value}`);
    expect(info.some((f) => f.startsWith("status="))).toBe(false);
  });
  test("domain-scoped kinds get a slugged domain label", () => {
    const flat = labelPlan("information", { domain: "Distributed Systems" }, "2026-06-10").map((l) => `${l.name}=${l.value}`);
    expect(flat).toContain("domain=distributed-systems");
  });
  test("topics are slugged and deduped", () => {
    const flat = labelPlan("knowledge", { topics: ["AI Tooling", "ai-tooling", "Infra"] }, "2026-06-10").map((l) => `${l.name}=${l.value}`);
    expect(flat.filter((f) => f === "topic=ai-tooling")).toHaveLength(1);
    expect(flat).toContain("topic=infra");
  });
});
