import { describe, expect, test } from "bun:test";
import { sweep } from "./lifecycle.js";
import { EMPTY_BRAINLLM, type BrainLLMConfig } from "./config.js";
import type { TriliumClient, Note } from "./trilium.js";

// maintain(deep, domain="BrainLLM") reported near-duplicate subject pairs from
// the myClerkBook and Bard domains (found in use, 2026-09-28): the domain
// duplicate passes grouped every domain's notes and never consulted the scope.

const note = (noteId: string, title: string, domain: string): Note =>
  ({
    noteId, title, type: "text", mime: "text/html", parentNoteIds: ["dom"], childNoteIds: [], parentBranchIds: ["b"],
    attributes: [
      { attributeId: `${noteId}-t`, noteId, type: "label", name: "noteType", value: "information", position: 0, isInheritable: false },
      { attributeId: `${noteId}-d`, noteId, type: "label", name: "domain", value: domain, position: 0, isInheritable: false },
    ],
    dateCreated: "2026-09-01 00:00:00.000+0000", dateModified: "2026-09-28 00:00:00.000+0000",
    utcDateCreated: "", utcDateModified: "", isProtected: false, blobId: "x",
  }) as unknown as Note;

const infoNotes = [
  note("m1", "Email Templates", "myclerkbook"),
  note("m2", "Email Authentication", "myclerkbook"),
  note("m3", "Email Templates", "myclerkbook"),
  note("b1", "Tool Surface", "brainllm"),
  note("b2", "Session Protocol", "brainllm"),
];

// Every other pass sees an empty brain; only the domain search returns notes.
const trilium = new Proxy({} as Record<string, unknown>, {
  get: (_t, prop) => {
    if (prop === "searchNotes") {
      return async (q: string) => ({ results: q.includes("#noteType=information") ? infoNotes : [] });
    }
    if (prop === "getNoteContent") return async () => "<p>body</p>";
    if (prop === "getNote") return async (id: string) => infoNotes.find((n) => n.noteId === id) ?? note(id, id, "none");
    if (prop === "then") return undefined;
    return async () => [];
  },
}) as unknown as TriliumClient;

const cfg: BrainLLMConfig = {
  ...EMPTY_BRAINLLM,
  root: "root",
  knowledge: { root: "k", master: "", domains: "dom" },
};

describe("a domain-scoped deep sweep stays in its lane", () => {
  test("no duplicate or near-duplicate flag names another domain", async () => {
    const report = await sweep(trilium, cfg, { deep: true, dryRun: true, domain: "BrainLLM" });
    const dupes = report.flagged.filter((f) => /duplicate/.test(f));
    expect(dupes.filter((f) => f.includes("myclerkbook"))).toEqual([]);
  });

  test("an unscoped sweep still reports them", async () => {
    const report = await sweep(trilium, cfg, { deep: true, dryRun: true });
    const dupes = report.flagged.filter((f) => /duplicate/.test(f) && f.includes("myclerkbook"));
    expect(dupes.some((f) => f.startsWith("duplicate: 'Email Templates'"))).toBe(true);
    expect(dupes.some((f) => f.startsWith("near-duplicate subject"))).toBe(true);
  });
});
