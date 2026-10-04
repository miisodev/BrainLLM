import { describe, expect, test } from "bun:test";
import { capResult } from "./cap.js";

describe("capResult", () => {
  test("leaves a result under the cap untouched", () => {
    const r = { content: [{ type: "text", text: "small" }] };
    expect(capResult(r, "t", 100)).toBe(r);
  });

  test("cuts an oversized result at the cap and says how to narrow it", () => {
    const r = { content: [{ type: "text", text: "x".repeat(500) }] };
    const out = capResult(r, "brain", 100);
    expect(out.content[0]!.text!.length).toBe(100);
    expect(out.content[1]!.text).toContain("brain() returned 500 characters");
    expect(out.content[1]!.text).toContain("section=");
  });

  test("the budget spans several text blocks", () => {
    const r = { content: [{ type: "text", text: "a".repeat(80) }, { type: "text", text: "b".repeat(80) }] };
    const out = capResult(r, "t", 100);
    expect(out.content[0]!.text!.length + out.content[1]!.text!.length).toBe(100);
  });
});
