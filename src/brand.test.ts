import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import { BRAND, MARK_GRID, markSvg, brandIcons } from "./brand.js";

const root = join(import.meta.dir, "..");
const json = (file: string) => JSON.parse(readFileSync(join(root, file), "utf-8"));

describe("brand surfaces agree", () => {
  test("the description fits the MCP registry's 100-character limit", () => {
    expect(BRAND.description.length).toBeLessThanOrEqual(100);
  });

  test("package.json, manifest.json and server.json carry the brand description and website", () => {
    expect(json("package.json").description).toBe(BRAND.description);
    expect(json("manifest.json").description).toBe(BRAND.description);
    expect(json("server.json").description).toBe(BRAND.description);
    expect(json("package.json").homepage).toBe(BRAND.website);
    expect(json("server.json").websiteUrl).toBe(BRAND.website);
  });

  test("no surface calls the product a second brain", () => {
    for (const file of ["package.json", "manifest.json", "server.json"]) {
      expect(readFileSync(join(root, file), "utf-8").toLowerCase()).not.toContain("second brain");
    }
  });

  test("the inline mark matches the source artwork's lit nodes", () => {
    const svg = readFileSync(join(root, "public", "BrainLLM.svg"), "utf-8");
    const lit = [...svg.split('<g fill="#3f3f46">')[0]!.matchAll(/<circle cx="(\d+)" cy="(\d+)"/g)].map((m) => `${m[1]},${m[2]}`);
    const fromGrid = MARK_GRID.flatMap((on, i) => (on ? [`${164 + (i % 3) * 92},${164 + Math.floor(i / 3) * 92}`] : []));
    expect(new Set(fromGrid)).toEqual(new Set(lit));
    expect(markSvg().match(/<circle/g)).toHaveLength(9);
  });
});


test("connector icons are same-origin with a distinct brand cache key", () => {
  const icons = brandIcons("https://memory.example");
  expect(icons[0]!.mimeType).toBe("image/png");
  for (const icon of icons) {
    const u = new URL(icon.src);
    expect(u.origin).toBe("https://memory.example");
    expect(u.searchParams.get("brand")).toBe("brainllm");
  }
});

test("favicon is an ICO container with valid PNG frame offsets", () => {
  const ico = readFileSync(join(root, "public/favicon.ico"));
  expect(ico.readUInt16LE(0)).toBe(0);
  expect(ico.readUInt16LE(2)).toBe(1);
  expect(ico.readUInt16LE(4)).toBe(4);
  for (let i = 0; i < 4; i++) {
    const at = 6 + 16 * i;
    const offset = ico.readUInt32LE(at + 12);
    const length = ico.readUInt32LE(at + 8);
    expect(offset + length).toBeLessThanOrEqual(ico.length);
    expect(ico.subarray(offset, offset + 8).toString("hex")).toBe("89504e470d0a1a0a");
  }
});
