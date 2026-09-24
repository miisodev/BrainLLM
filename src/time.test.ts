import { describe, expect, test } from "bun:test";
import { checkedDate } from "./time.js";

describe("checkedDate", () => {
  test("accepts real ISO calendar dates", () => {
    expect(checkedDate("2026-09-24")).toBe("2026-09-24");
  });

  test("rejects injection-shaped and impossible dates", () => {
    for (const value of ["2026-02-30", "2026-1-01", "2026-09-24' OR 1=1", "not-a-date"]) {
      expect(() => checkedDate(value)).toThrow();
    }
  });
});
