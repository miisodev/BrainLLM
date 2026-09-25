/**
 * init.ts — One-shot CLI bootstrapper for a fresh BrainLLM instance.
 * Run with: bun run init  (or: TRILIUM_BASE_URL=... TRILIUM_ETAPI_TOKEN=... bun run src/init.ts)
 *
 * Creates the full brain hierarchy in Trilium and writes brainllm.json next to
 * the bundle. Same code path as the bootstrap tool.
 */

import { TriliumClient } from "./trilium.js";
import { discoverBrainLLM, loadCachedToken, loadConfig, saveCachedToken, saveConfig } from "./config.js";
import { createBrainLLMStructure } from "./bootstrap.js";

const baseUrl  = process.env.TRILIUM_BASE_URL;
const password = process.env.TRILIUM_PASSWORD;
const explicitToken = process.env.TRILIUM_ETAPI_TOKEN;
let   token    = explicitToken ?? loadCachedToken();
const showToken = process.argv.includes("--show-token");
const reinitialize = process.argv.includes("--reinitialize");

if (!baseUrl) {
  console.error("Missing TRILIUM_BASE_URL");
  process.exit(1);
}

// Reuse a cached token before minting a new one. This matters for idempotence:
// a second `bun run init` with TRILIUM_PASSWORD must not add another token to
// Trilium's token list merely because the caller omitted the env var.
if (token && !explicitToken) {
  try {
    await new TriliumClient(baseUrl, token).getAppInfo();
    console.error("[brainllm] Reusing the cached ETAPI token.");
  } catch {
    token = null;
  }
}

// Mint the ETAPI token from the password when neither an explicit nor a valid
// cached token was supplied. Setup used to require opening Trilium, finding
// Options → ETAPI, creating a token by hand and pasting it into an env var
// before anything worked at all — the highest-friction step in the install, and
// the one most likely to lose a first-time forker. ETAPI exposes POST
// /auth/login for exactly this.
if (!token) {
  if (!password) {
    console.error("Missing TRILIUM_ETAPI_TOKEN — set it, or set TRILIUM_PASSWORD and one will be created for you.");
    process.exit(1);
  }
  console.log("\n🔑 No ETAPI token supplied — requesting one from Trilium...");
  try {
    token = await TriliumClient.login(baseUrl, password);
    const tokenPath = saveCachedToken(token);
    console.log("   Token created and cached with owner-only file permissions.");
    console.log(`   Cache path: ${tokenPath ?? "(cache write unavailable)"}`);
    if (showToken) {
      console.log(`   TRILIUM_ETAPI_TOKEN=${token}\n`);
    } else {
      console.log("   The token was not printed. Re-run with --show-token only if you explicitly need to copy it.\n");
    }
  } catch (err) {
    console.error(`   Could not create a token: ${err instanceof Error ? err.message : err}`);
    console.error("   Check TRILIUM_BASE_URL and TRILIUM_PASSWORD, or create a token manually in Options → ETAPI.");
    process.exit(1);
  }
}

const trilium = new TriliumClient(baseUrl, token);

const configured = loadConfig();
let discovered: typeof configured = null;
let configuredRootAlive = false;
if (!reinitialize) {
  if (configured?.root) {
    try {
      await trilium.getNote(configured.root);
      configuredRootAlive = true;
      discovered = await discoverBrainLLM(trilium);
      if (!discovered) {
        throw new Error("the configured BrainLLM root exists but its required hierarchy is incomplete; run bootstrap() to repair it (or pass --reinitialize only for an intentional second tree)");
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!message.includes("404") || configuredRootAlive) throw error;
    }
  }
  discovered ??= await discoverBrainLLM(trilium);
}
if (discovered) {
  const savedPath = saveConfig(discovered);
  console.log(`\n✅ BrainLLM is already initialized; config refreshed at: ${savedPath}`);
  console.log("No duplicate tree was created. Use --reinitialize only when you intentionally want a second hierarchy.\n");
  process.exit(0);
}

console.log("\n🧠 Bootstrapping BrainLLM (v12.5.0)...\n");

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
