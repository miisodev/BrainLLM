import { describe, expect, test } from "bun:test";
import { containingElement, editWithin, elementSpans } from "./elements.js";

const table =
  "<h2>Open</h2><figure class=\"table\"><table><tbody>" +
  "<tr><td><strong>Restore rehearsal</strong> never run</td><td>Miiso</td></tr>" +
  "<tr><td>Skill re-upload</td><td>Miiso</td></tr>" +
  "</tbody></table></figure><p>Closing line</p>";

const hitsOf = (html: string, needle: string) => {
  const out: Array<{ start: number; length: number }> = [];
  for (let at = html.indexOf(needle); at !== -1; at = html.indexOf(needle, at + needle.length)) out.push({ start: at, length: needle.length });
  return out;
};

describe("elementSpans / containingElement", () => {
  test("finds every row and the innermost container", () => {
    expect(elementSpans(table, "tr")).toHaveLength(2);
    const at = table.indexOf("Skill");
    const tr = containingElement(table, "tr", at, at + 5)!;
    expect(table.slice(tr.start, tr.end)).toBe("<tr><td>Skill re-upload</td><td>Miiso</td></tr>");
  });

  test("does not confuse <tr> with <track> or similar prefixes", () => {
    const html = "<track src=\"x\"><tr><td>a</td></tr>";
    expect(elementSpans(html, "tr")).toHaveLength(1);
  });
});

describe("editWithin", () => {
  test("replaces the row containing a short anchor", () => {
    const r = editWithin(table, hitsOf(table, "Restore"), "tr", "replace", "<tr><td>Done</td><td>Claude</td></tr>");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.html).toContain("<tr><td>Done</td><td>Claude</td></tr><tr><td>Skill re-upload");
      expect(r.html).not.toContain("Restore rehearsal");
    }
  });

  test("inserts a row after and removes a row", () => {
    const after = editWithin(table, hitsOf(table, "Skill"), "tr", "after", "<tr><td>New</td><td>-</td></tr>");
    expect(after.ok && after.html.includes("Miiso</td></tr><tr><td>New</td>")).toBe(true);
    const removed = editWithin(table, hitsOf(table, "Skill"), "tr", "remove", "");
    expect(removed.ok && !removed.html.includes("Skill")).toBe(true);
  });

  test("refuses an anchor that sits in more than one row unless nth picks one", () => {
    const amb = editWithin(table, hitsOf(table, "Miiso"), "tr", "remove", "");
    expect(amb.ok).toBe(false);
    if (!amb.ok) {
      expect(amb.reason).toBe("ambiguous");
      expect(amb.elements).toHaveLength(2);
    }
    const second = editWithin(table, hitsOf(table, "Miiso"), "tr", "remove", "", 2);
    expect(second.ok && second.html.includes("Restore") && !second.html.includes("Skill")).toBe(true);
  });

  test("reports no_match and no_element distinctly", () => {
    expect(editWithin(table, [], "tr", "remove", "")).toMatchObject({ ok: false, reason: "no_match" });
    expect(editWithin(table, hitsOf(table, "Closing"), "tr", "remove", "")).toMatchObject({ ok: false, reason: "no_element" });
  });
});
