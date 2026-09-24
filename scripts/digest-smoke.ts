/**
 * scripts/digest-smoke.ts — print the start orientation digest
 * against the live brain. Verification helper; safe (read-only).
 */

import { TriliumClient } from "../src/trilium.js";
import { buildDigest } from "../src/lifecycle.js";
import { configFilePath, loadConfig } from "../src/config.js";

const baseUrl = process.env.TRILIUM_BASE_URL;
const token = process.env.TRILIUM_ETAPI_TOKEN;
if (!baseUrl || !token) {
  console.error("Missing TRILIUM_BASE_URL or TRILIUM_ETAPI_TOKEN");
  process.exit(1);
}
const cfg = loadConfig();
if (!cfg) {
  console.error(`Could not read a valid brain config at ${configFilePath()}`);
  process.exit(1);
}

const digest = await buildDigest(new TriliumClient(baseUrl, token), cfg);
console.log(JSON.stringify(digest, null, 2));
