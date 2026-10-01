import { describe, expect, test } from "bun:test";
import { blockDiff, firstRevisionSince, revisionsSince } from "./diffing.js";
import { localToday, sinceCutoff } from "./time.js";

const revs = [
  { revisionId: "r3", dateCreated: "2026-10-01 16:40:12.000+0200" },
  { revisionId: "r2", dateCreated: "2026-10-01 09:05:00.000+0200" },
  { revisionId: "r1", dateCreated: "2026-09-30 22:10:00.000+0200" },
];

describe("revision selection", () => {
  test("keeps revisions at or after the cutoff and picks the earliest", () => {
    expect(revisionsSince(revs, "2026-10-01 00:00").map((r) => r.revisionId)).toEqual(["r3", "r2"]);
    expect(firstRevisionSince(revs, "2026-10-01 00:00")?.revisionId).toBe("r2");
    expect(firstRevisionSince(revs, "2026-10-01 10:00")?.revisionId).toBe("r3");
    expect(firstRevisionSince(revs, "2026-10-02 00:00")).toBeNull();
  });
});

describe("blockDiff", () => {
  test("reports identical bodies", () => {
    expect(blockDiff("<p>a</p>", "<p>a</p>").identical).toBe(true);
  });

  test("isolates the changed block with context", () => {
    const d = blockDiff("<p>a</p><p>b</p><p>c</p>", "<p>a</p><p>B</p><p>c</p>");
    expect(d.removed).toEqual(["<p>b</p>"]);
    expect(d.added).toEqual(["<p>B</p>"]);
    expect(d.contextBefore).toEqual(["<p>a</p>"]);
    expect(d.contextAfter).toEqual(["<p>c</p>"]);
  });

  test("caps long change lists", () => {
    const before = Array.from({ length: 30 }, (_, i) => `<p>${i}</p>`).join("");
    const d = blockDiff(before, "", 1, 5);
    expect(d.removed).toHaveLength(6);
    expect(d.removed?.[5]).toContain("25 more");
  });
});

describe("sinceCutoff", () => {
  test("accepts today, session, dates and local datetimes", () => {
    expect(sinceCutoff("today")).toBe(`${localToday()} 00:00`);
    expect(sinceCutoff("session")).toBe(`${localToday()} 00:00`);
    expect(sinceCutoff("2026-10-01")).toBe("2026-10-01 00:00");
    expect(sinceCutoff("2026-10-01 14:30")).toBe("2026-10-01 14:30");
    expect(sinceCutoff("2026-10-01T14:30")).toBe("2026-10-01 14:30");
  });

  test("rejects anything that could reach a search expression malformed", () => {
    expect(sinceCutoff("yesterday")).toBeNull();
    expect(sinceCutoff("2026-02-30")).toBeNull();
    expect(sinceCutoff("2026-10-01 25:00")).toBeNull();
    expect(sinceCutoff("2026-10-01' OR '1")).toBeNull();
  });
});
