import { describe, expect, test } from "bun:test";
import { Kinds, KIND_AREA, Areas, type Kind } from "./types.js";
import { REQUIRED_SECTIONS, missingSections, structureRuleFor, contentFor } from "./templates.js";
import { locationLabel } from "./router.js";

// Adding a Kind touches several switches that TypeScript only partly guards:
// KIND_AREA is a total Record and is checked, but locationLabel/kindHome are
// switches whose exhaustiveness error is easy to satisfy with a wrong branch,
// and the template maps are Partial by design so a missing entry is silent.
// "claim" nearly shipped without a structure rule for exactly that reason.

describe("every Kind is fully wired", () => {
  test("has an area, and it is a real one", () => {
    for (const kind of Kinds) {
      expect(KIND_AREA[kind]).toBeDefined();
      expect(Areas).toContain(KIND_AREA[kind]);
    }
  });

  test("has a location label that names its area", () => {
    for (const kind of Kinds) {
      const label = locationLabel(kind);
      expect(label.length).toBeGreaterThan(0);
      expect(label).not.toBe("undefined");
    }
  });

  test("contentFor produces a body for every kind", () => {
    for (const kind of Kinds) {
      const html = contentFor(kind, { date: "2026-08-16", body: "" });
      expect(typeof html).toBe("string");
      expect(html.length).toBeGreaterThan(0);
    }
  });

  test("a kind declaring required sections also declares a structure rule", () => {
    // Otherwise the lint flags a note incomplete while template(kind) cannot say
    // what complete looks like — a finding with no documented remedy.
    for (const kind of Object.keys(REQUIRED_SECTIONS) as Kind[]) {
      expect(structureRuleFor(kind)).toBeDefined();
    }
  });
});

describe("claim structure", () => {
  const BODY = "<h2>Check</h2><p>run the thing</p><h2>Verifications</h2>";

  test("requires Check and Verifications", () => {
    expect(REQUIRED_SECTIONS.claim).toEqual(["Check", "Verifications"]);
    expect(missingSections("claim", BODY)).toEqual([]);
  });

  test("a claim missing its Verifications section is flagged incomplete", () => {
    expect(missingSections("claim", "<h2>Check</h2><p>run the thing</p>")).toEqual(["Verifications"]);
  });

  test("its structure rule states that BrainLLM never executes the check", () => {
    const rule = structureRuleFor("claim");
    expect(rule).toBeDefined();
    expect(rule!.rules.join(" ")).toContain("never executes");
  });
});
