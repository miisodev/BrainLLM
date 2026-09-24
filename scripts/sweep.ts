/**
 * scripts/sweep.ts — headless maintenance sweep
 *
 * Runs the same sweep the maintain tool exposes, without an MCP client:
 *   bun run scripts/sweep.ts [--deep] [--dry-run]
 *
 * Requires TRILIUM_BASE_URL and TRILIUM_ETAPI_TOKEN. Uses the same
 * BRAINLLM_CONFIG-aware config loader as the runtime server.
 */

import { TriliumClient } from "../src/trilium.js";
import { sweep } from "../src/lifecycle.js";
import { configFilePath, loadConfig } from "../src/config.js";

const baseUrl = process.env.TRILIUM_BASE_URL;
const token = process.env.TRILIUM_ETAPI_TOKEN;
if (!baseUrl || !token) {
  console.error("Missing TRILIUM_BASE_URL or TRILIUM_ETAPI_TOKEN");
  process.exit(1);
}

const configPath = configFilePath();
const cfg = loadConfig();
if (!cfg) {
  console.error(`Could not read a valid brain config at ${configPath}`);
  process.exit(1);
}

const deep = process.argv.includes("--deep");
const dryRun = process.argv.includes("--dry-run");

console.log(`Sweep: deep=${deep} dryRun=${dryRun} config=${configPath}\n`);

const trilium = new TriliumClient(baseUrl, token);
const report = await sweep(trilium, cfg, { deep, dryRun });

const section = (name: string, lines: string[]) => {
  if (!lines.length) return;
  console.log(`${name} (${lines.length}):`);
  for (const line of lines) console.log(`  • ${line}`);
  console.log();
};

console.log(`Scanned: ${report.scanned}\n`);
section("Fixed", report.fixed);
section("Transitions", report.transitions);
section("Deleted", report.deleted);
section("Flagged", report.flagged);

if (dryRun) console.log("Dry run — nothing was changed.");
