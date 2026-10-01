import { describe, expect, test } from "bun:test";
import { checkedDate, rollingBackupName } from "./time.js";

describe("rollingBackupName", () => {
  test("maps a date to its weekday slot, so seven slots repeat weekly", () => {
    expect(rollingBackupName("2026-10-01")).toBe("brainllm-thu");
    expect(rollingBackupName("2026-10-04")).toBe("brainllm-sun");
    expect(rollingBackupName("2026-10-08")).toBe(rollingBackupName("2026-10-01"));
  });

  test("rejects impossible dates", () => {
    expect(() => rollingBackupName("2026-02-30")).toThrow();
  });
});

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
