import { describe, expect, test } from "bun:test";
import {
  RECALL_STRATEGIES,
  SEARCH_FAILURE_NOTE,
  capWarning,
  dominantStrategy,
  passageAround,
  tokenPassage,
  withinModifiedWindow,
} from "./tools.js";

// v13.0.0 “Provenance” — recall's four fidelity upgrades: per-hit matchedBy +
// evidence, since=/until= windows, saturated-strategy warnings, and a receipt
// that distinguishes a backend failure from a genuine no-match.

describe("recall since=/until= (withinModifiedWindow)", () => {
  const stamp = (d: string, t = "12:00:00.000+0200") => `${d} ${t}`;

  test("no bounds keeps every note", () => {
    expect(withinModifiedWindow(stamp("2020-01-01"))).toBe(true);
  });

  test("a date-only since includes its whole day and excludes earlier days", () => {
    expect(withinModifiedWindow(stamp("2026-10-15", "00:00:00.000+0200"), "2026-10-15")).toBe(true);
    expect(withinModifiedWindow(stamp("2026-10-15", "23:59:59.000+0200"), "2026-10-15")).toBe(true);
    expect(withinModifiedWindow(stamp("2026-10-14", "23:59:59.000+0200"), "2026-10-15")).toBe(false);
  });

  test("a date-only until is inclusive of its whole day", () => {
    expect(withinModifiedWindow(stamp("2026-10-15", "23:59:59.000+0200"), undefined, "2026-10-15")).toBe(true);
    expect(withinModifiedWindow(stamp("2026-10-16", "00:00:00.000+0200"), undefined, "2026-10-15")).toBe(false);
  });

  test("timestamp bounds compare exactly", () => {
    expect(withinModifiedWindow(stamp("2026-10-15", "09:59:00.000+0200"), "2026-10-15T10:00:00+02:00")).toBe(false);
    expect(withinModifiedWindow(stamp("2026-10-15", "10:00:00.000+0200"), "2026-10-15T10:00:00+02:00")).toBe(true);
    expect(withinModifiedWindow(stamp("2026-10-15", "10:00:00.000+0200"), undefined, "2026-10-15T10:00:00+02:00")).toBe(true);
    expect(withinModifiedWindow(stamp("2026-10-15", "10:00:01.000+0200"), undefined, "2026-10-15T10:00:00+02:00")).toBe(false);
  });

  test("both bounds form a window", () => {
    expect(withinModifiedWindow(stamp("2026-10-10"), "2026-10-01", "2026-10-15")).toBe(true);
    expect(withinModifiedWindow(stamp("2026-09-30"), "2026-10-01", "2026-10-15")).toBe(false);
    expect(withinModifiedWindow(stamp("2026-10-16"), "2026-10-01", "2026-10-15")).toBe(false);
  });

  test("an unparseable note stamp is kept, never silently excluded", () => {
    expect(withinModifiedWindow("not a date", "2026-01-01", "2026-12-31")).toBe(true);
  });
});

describe("recall passage extraction (passageAround / tokenPassage)", () => {
  test("clamps at the text edges without ellipses", () => {
    expect(passageAround("short body", 0, 5)).toBe("short body");
    expect(passageAround("short body", 6, 4)).toBe("short body");
  });

  test("windows a middle match with ellipses, collapsed whitespace and a bound", () => {
    const text = `${"a ".repeat(100)}MATCHED   passage${" b".repeat(100)}`;
    const out = passageAround(text, text.indexOf("MATCHED"), "MATCHED".length);
    expect(out.startsWith("…")).toBe(true);
    expect(out.endsWith("…")).toBe(true);
    expect(out).toContain("MATCHED passage");
    expect(out.length).toBeLessThanOrEqual(200);
  });

  test("tokenPassage quotes around the longest token that occurs", () => {
    const text = `${"filler ".repeat(30)}alpha bravo charlie ${"tail ".repeat(30)}`;
    expect(tokenPassage(text, ["charlie", "alpha"])).toContain("alpha bravo charlie");
  });

  test("tokenPassage is case-insensitive and null when no token occurs", () => {
    expect(tokenPassage("The Tool Surface note", ["surface"])).toContain("Tool Surface");
    expect(tokenPassage("nothing relevant here", ["absent"])).toBeNull();
    expect(tokenPassage("", ["absent"])).toBeNull();
  });
});

describe("recall matchedBy (dominantStrategy)", () => {
  test("picks the heaviest contributing strategy", () => {
    expect(dominantStrategy(new Map([["label", 3], ["title", 4]]))).toBe("title");
    expect(dominantStrategy(new Map([["text", 1], ["label", 3]]))).toBe("label");
  });

  test("ties go to the earlier strategy in RECALL_STRATEGIES", () => {
    expect(dominantStrategy(new Map([["text", 2], ["title", 2]]))).toBe("title");
    expect(dominantStrategy(new Map([["fuzzy", 0.5], ["text", 0.5]]))).toBe("text");
  });

  test("an empty contribution map has no strategy", () => {
    expect(dominantStrategy(new Map())).toBeNull();
  });

  test("the strategy names include the regex path", () => {
    expect(RECALL_STRATEGIES).toContain("regex");
    expect(RECALL_STRATEGIES).toContain("ordered");
  });
});

describe("recall receipts for saturation and backend failure", () => {
  test("no saturation means no cap warning", () => {
    expect(capWarning([])).toBeNull();
    expect(capWarning(new Set())).toBeNull();
  });

  test("a saturated strategy is named in the cap warning", () => {
    const one = capWarning(new Set(["text"]));
    expect(one).toContain("30-candidate cap");
    expect(one).toContain("text strategy");
    const many = capWarning(["title", "label", "title"]);
    expect(many).toContain("label, title strategies");
    expect(many).toContain("narrow with domain= or kinds=");
  });

  test("the failure note is distinct from the no-match copy", () => {
    expect(SEARCH_FAILURE_NOTE).toContain("backend failure");
    expect(SEARCH_FAILURE_NOTE).toContain("NOT a verdict");
    expect(SEARCH_FAILURE_NOTE).not.toContain("No matches for this query");
    expect(SEARCH_FAILURE_NOTE).toContain("Retry");
  });
});
