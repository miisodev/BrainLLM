/**
 * scripts/digest-smoke.ts — print the start orientation digest
 * against the live brain. Verification helper; safe (read-only).
 */

import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { TriliumClient } from "../src/trilium.js";
import { buildDigest } from "../src/lifecycle.js";
import { DEFAULT_POLICY } from "../src/types.js";
import type { BrainLLMConfig } from "../src/config.js";

const baseUrl = process.env.TRILIUM_BASE_URL!;
const token = process.env.TRILIUM_ETAPI_TOKEN!;
const here = dirname(fileURLToPath(import.meta.url));
const parsed = JSON.parse(readFileSync(join(here, "..", "dist", "brainllm.json"), "utf-8"));
const cfg: BrainLLMConfig = { ...parsed, policy: { ...DEFAULT_POLICY, ...(parsed.policy ?? {}) } };

const digest = await buildDigest(new TriliumClient(baseUrl, token), cfg);
console.log(JSON.stringify(digest, null, 2));
