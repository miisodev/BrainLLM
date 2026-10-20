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
import { readFileSync, statSync, writeFileSync } from "fs";

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

// A .ico response must be an ICO container, not PNG bytes under an ICO name.
// Embed PNG frames at the sizes favicon decoders actually request.
const sizes = [16, 32, 48, 64];
const frames = await Promise.all(sizes.map((size) => sharp(svg, { density: 384 }).resize(size, size).png().toBuffer()));
const directory = Buffer.alloc(6 + frames.length * 16);
directory.writeUInt16LE(1, 2);
directory.writeUInt16LE(frames.length, 4);
let offset = directory.length;
for (let i = 0; i < frames.length; i++) {
  const at = 6 + i * 16;
  directory[at] = sizes[i]!;
  directory[at + 1] = sizes[i]!;
  directory.writeUInt16LE(1, at + 4);
  directory.writeUInt16LE(32, at + 6);
  directory.writeUInt32LE(frames[i]!.length, at + 8);
  directory.writeUInt32LE(offset, at + 12);
  offset += frames[i]!.length;
}
writeFileSync(join(PUBLIC, "favicon.ico"), Buffer.concat([directory, ...frames]));
console.log(`  favicon.ico       ${kb(join(PUBLIC, "favicon.ico"))}   ICO with 16/32/48/64px frames`);

console.log("\nDone. Commit public/ — the image is built from it at deploy time.");
