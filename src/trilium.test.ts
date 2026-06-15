/**
 * trilium.test.ts — unit tests for the pure search-query helpers.
 * Run with: bun test src/trilium.test.ts   (no live Trilium required)
 */

import { describe, expect, test } from "bun:test";
import { buildBacklinkQuery, backlinkRelationNames } from "./trilium.js";
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
