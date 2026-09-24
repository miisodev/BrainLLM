/**
 * trilium.test.ts — unit tests for the pure search-query helpers.
 * Run with: bun test src/trilium.test.ts   (no live Trilium required)
 */

import { describe, expect, test } from "bun:test";
import { buildBacklinkQuery, backlinkRelationNames, isOwnedAttribute, relationSnippet, type Note } from "./trilium.js";
import { RelationTypes } from "./types.js";

describe("buildBacklinkQuery", () => {
  test("ORs one ~relation.noteId clause per relation name", () => {
    expect(buildBacklinkQuery("abc123", ["relatesTo", "extends"])).toBe(
      '~relatesTo.noteId = "abc123" OR ~extends.noteId = "abc123"'
    );
  });

  test("single relation name yields a single clause with no OR", () => {
    expect(buildBacklinkQuery("xyz789", ["supports"])).toBe('~supports.noteId = "xyz789"');
  });

  test("deduplicates relation names so a clause is not repeated", () => {
    expect(buildBacklinkQuery("n1", ["relatesTo", "relatesTo"])).toBe('~relatesTo.noteId = "n1"');
  });

  test("rejects unsafe custom relation identifiers instead of injecting DSL", () => {
    expect(() => buildBacklinkQuery("abc123", ["relatesTo", "my-rel", "x y"])).toThrow("cannot be safely queried");
  });

  test("no relation names yields an empty query (caller must skip the search)", () => {
    expect(buildBacklinkQuery("abc123", [])).toBe("");
  });
});

describe("backlinkRelationNames", () => {
  test("always includes the full canonical relation vocabulary", () => {
    const names = backlinkRelationNames([]);
    for (const canonical of RelationTypes) {
      expect(names).toContain(canonical);
    }
  });

  test("unions discovered custom relation names with the canonical set", () => {
    expect(backlinkRelationNames(["myCustomRel"])).toContain("myCustomRel");
  });

  test("excludes the internal template relation but keeps custom names", () => {
    const names = backlinkRelationNames(["template", "realRel"]);
    expect(names).not.toContain("template");
    expect(names).toContain("realRel");
  });

  test("does not duplicate a discovered name that is already canonical", () => {
    expect(backlinkRelationNames(["relatesTo"]).filter((n) => n === "relatesTo")).toHaveLength(1);
  });
});

describe("attribute ownership", () => {
  const note = {
    noteId: "child123",
    attributes: [
      { noteId: "parent123", type: "label", name: "status", value: "active" },
      { noteId: "child123", type: "label", name: "status", value: "dormant" },
      { noteId: "parent123", type: "relation", name: "supports", value: "other123" },
      { noteId: "child123", type: "relation", name: "extends", value: "other123" },
    ],
  } as unknown as Note;

  test("identifies owned versus inherited attributes", () => {
    expect(isOwnedAttribute(note, note.attributes[0])).toBe(false);
    expect(isOwnedAttribute(note, note.attributes[1])).toBe(true);
  });

  test("relation snippets never present inherited edges as owned", () => {
    expect(relationSnippet(note)).toEqual([{ relation: "extends", toNoteId: "other123" }]);
  });
});
