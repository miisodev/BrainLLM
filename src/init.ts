/**
 * init.ts — One-shot CLI bootstrapper for a fresh BrainLLM instance.
 * Run with: bun run init  (or: TRILIUM_BASE_URL=... TRILIUM_ETAPI_TOKEN=... bun run src/init.ts)
 *
 * Creates the full brain hierarchy in Trilium and writes brainllm.json next to
 * the bundle. Same code path as the bootstrap tool.
 */

import { TriliumClient } from "./trilium.js";
import { saveConfig } from "./config.js";
import { createBrainLLMStructure } from "./bootstrap.js";

const baseUrl  = process.env.TRILIUM_BASE_URL;
const password = process.env.TRILIUM_PASSWORD;
let   token    = process.env.TRILIUM_ETAPI_TOKEN;

if (!baseUrl) {
  console.error("Missing TRILIUM_BASE_URL");
  process.exit(1);
}

// Mint the ETAPI token from the password when one wasn't supplied. Setup used
// to require opening Trilium, finding Options → ETAPI, creating a token by
// hand and pasting it into an env var before anything worked at all — the
// highest-friction step in the install, and the one most likely to lose a
// first-time forker. ETAPI exposes POST /auth/login for exactly this.
if (!token) {
  if (!password) {
    console.error("Missing TRILIUM_ETAPI_TOKEN — set it, or set TRILIUM_PASSWORD and one will be created for you.");
    process.exit(1);
  }
  console.log("\n🔑 No ETAPI token supplied — requesting one from Trilium...");
  try {
    token = await TriliumClient.login(baseUrl, password);
    console.log("   Token created. Save it as TRILIUM_ETAPI_TOKEN so future runs skip this step:\n");
    console.log(`   TRILIUM_ETAPI_TOKEN=${token}\n`);
  } catch (err) {
    console.error(`   Could not create a token: ${err instanceof Error ? err.message : err}`);
    console.error("   Check TRILIUM_BASE_URL and TRILIUM_PASSWORD, or create a token manually in Options → ETAPI.");
    process.exit(1);
  }
}

const trilium = new TriliumClient(baseUrl, token);

console.log("\n🧠 Bootstrapping BrainLLM (V10)...\n");

const config = await createBrainLLMStructure(trilium);
const savedPath = saveConfig(config);

const show = (label: string, id: string) => console.log(`  ${id}  ${label}`);
show("root", config.root);
show("master", config.master.root);
show("llm", config.llm.root);
show("memory", config.memory.root);
show("knowledge", config.knowledge.root);
show("insights", config.insights.root);

console.log("\n✅ Done.");
console.log(`\nConfig written to: ${savedPath}`);
console.log("Start the MCP server — no rebuild or manual ID pasting required.\n");
