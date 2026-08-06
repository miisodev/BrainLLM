/**
 * icons.ts — regenerate the served icon sizes from the source artwork.
 *
 * Run with: bun run icons
 *
 * The source is the SVG, not the PNG: rasterising the vector at each target
 * size gives clean edges, where downscaling a 500px raster softens them. The
 * 500x500 / 84KB original was being served into a 16px favicon slot, which is
 * ~80KB of transfer for a handful of visible pixels — and the MCP spec notes
 * clients may cap icon size outright, so a heavy icon risks not rendering at
 * all.
 *
 * Outputs are committed, because the Dockerfile copies public/ into the image
 * and the server has no image toolchain at runtime.
 */

import sharp from "sharp";
import { join, dirname } from "path";
import { readFileSync, statSync } from "fs";

const PUBLIC = join(dirname(import.meta.dir), "public");
const SOURCE = join(PUBLIC, "BrainLLM.svg");

/** Each size exists for a named consumer — no speculative extras. */
const TARGETS: Array<{ size: number; file: string; why: string }> = [
  { size: 64,  file: "icon-64.png",  why: "favicon — the 16-32px slot at 2x" },
  { size: 128, file: "icon-128.png", why: "connector list rows" },
  { size: 180, file: "icon-180.png", why: "apple-touch-icon" },
  { size: 512, file: "icon-512.png", why: "high-DPI and the serverInfo default" },
  // The README/OG image. Previously a hand-exported raster that drifted from
  // the SVG — it was still the old traced artwork after the mark changed.
  // Generating it here means every brand raster has one source.
  { size: 512, file: "BrainLLM.png", why: "README header and og:image" },
];

const svg = readFileSync(SOURCE);
const kb = (p: string) => (statSync(p).size / 1024).toFixed(1) + "KB";

console.log(`source: BrainLLM.svg (${kb(SOURCE)})\n`);

for (const { size, file, why } of TARGETS) {
  const out = join(PUBLIC, file);
  await sharp(svg, { density: 384 })
    .resize(size, size, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png({ compressionLevel: 9, palette: true })
    .toFile(out);
  console.log(`  ${file.padEnd(15)} ${String(size).padStart(3)}px  ${kb(out).padStart(8)}   ${why}`);
}

console.log("\nDone. Commit public/ — the image is built from it at deploy time.");
