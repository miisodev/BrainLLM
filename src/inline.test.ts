import { describe, expect, test } from "bun:test";
import { inlineTolerantSpans } from "./normalize.js";

const slice = (src: string, s: { start: number; length: number }) => src.slice(s.start, s.start + s.length);

describe("inlineTolerantSpans", () => {
  test("matches inside a wrapping inline tag, leaving the formatting in place", () => {
    const src = "<p>State: <em>unmerged</em> on dev</p>";
    const hits = inlineTolerantSpans(src, "unmerged");
    expect(hits).toHaveLength(1);
    expect(slice(src, hits[0])).toBe("unmerged");
  });

  test("matches text split by a tag boundary and balances it", () => {
    const src = "<td><strong>Phase</strong> 2 shipped</td>";
    const hits = inlineTolerantSpans(src, "Phase 2");
    expect(hits).toHaveLength(1);
    expect(slice(src, hits[0])).toBe("<strong>Phase</strong> 2");
  });

  test("reads entities as their characters", () => {
    const src = "<p>R&amp;D&nbsp;budget</p>";
    const hits = inlineTolerantSpans(src, "R&D budget");
    expect(hits).toHaveLength(1);
  });

  test("a needle written with different inline tags still matches", () => {
    const src = "<p>Run <code>bun test</code> first</p>";
    expect(inlineTolerantSpans(src, "Run <strong>bun test</strong>")).toHaveLength(1);
  });

  test("block tags in the needle are left to the other passes", () => {
    expect(inlineTolerantSpans("<p>a</p><p>b</p>", "a</p><p>b")).toEqual([]);
  });

  test("a genuine difference is still a miss", () => {
    expect(inlineTolerantSpans("<p><em>merged</em></p>", "unmerged")).toEqual([]);
  });

  test("an unbalanceable span is dropped rather than returned half-open", () => {
    const src = "<p><strong>alpha beta</strong> gamma</p>";
    // "beta gamma" starts inside <strong> with text before it, so widening
    // cannot pull the opener in adjacently: the span is refused.
    expect(inlineTolerantSpans(src, "beta gamma")).toEqual([]);
  });
});
