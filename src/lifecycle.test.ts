import { describe, expect, test } from "bun:test";
import { applyResolution, isContainer } from "./lifecycle.js";
import { labelPlan } from "./router.js";
import { RESOLUTION_ANCHOR } from "./templates.js";
import { ownedLabel, type Note, type Attribute } from "./trilium.js";
import { EMPTY_BRAINLLM } from "./config.js";

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

// ── Helper ─────────────────────────────────────────────────────────────────────

function makeTestNote(noteId: string, attrs: Array<{ noteId?: string; name: string; value: string; isInheritable?: boolean }>): Note {
  return {
    noteId,
    title: "test",
    type: "text",
    mime: "text/html",
    isProtected: false,
    attributes: attrs.map((a, i): Attribute => ({
      attributeId: `attr-${i}`,
      noteId: a.noteId ?? noteId,
      type: "label",
      name: a.name,
      value: a.value,
      position: i,
      isInheritable: a.isInheritable ?? false,
    })),
    parentNoteIds: [],
    childNoteIds: [],
    parentBranchIds: [],
    childBranchIds: [],
    dateCreated: "2026-01-01 00:00:00",
    dateModified: "2026-01-01 00:00:00",
    utcDateCreated: "2026-01-01T00:00:00Z",
    utcDateModified: "2026-01-01T00:00:00Z",
  };
}

describe("ownedLabel — owned vs. inherited attribute", () => {
  test("returns the owned kind, ignoring an inherited attribute from another note", () => {
    const note = makeTestNote("THREAD_001", [
      { noteId: "OTHER_001", name: "noteType", value: "inherited-kind", isInheritable: true },
      { noteId: "THREAD_001", name: "noteType", value: "thread" },
    ]);
    expect(ownedLabel(note, "noteType")).toBe("thread");
  });

  test("returns undefined when the label only exists as inherited", () => {
    const note = makeTestNote("THREAD_001", [
      { noteId: "OTHER_001", name: "noteType", value: "inherited-kind", isInheritable: true },
    ]);
    expect(ownedLabel(note, "noteType")).toBeUndefined();
  });

  test("returns the owned value when there is no inheritance", () => {
    const note = makeTestNote("NOTE_001", [
      { noteId: "NOTE_001", name: "noteType", value: "thread" },
    ]);
    expect(ownedLabel(note, "noteType")).toBe("thread");
  });
});

describe("isContainer — revise() protection", () => {
  const contentId = "THREAD_CONTENT_001";

  test("returns false for a content note (revise should succeed)", () => {
    expect(isContainer(EMPTY_BRAINLLM, contentId)).toBe(false);
  });

  test("returns true for a structural container (revise should be refused)", () => {
    const cfg = { ...EMPTY_BRAINLLM, memory: { ...EMPTY_BRAINLLM.memory, threads: "THREADS_CONTAINER" } };
    expect(isContainer(cfg, "THREADS_CONTAINER")).toBe(true);
  });
});
