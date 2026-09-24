import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EMPTY_BRAINLLM } from "../src/config.ts";

const root = join(import.meta.dir, "..");
const port = 40_000 + Math.floor(Math.random() * 20_000);
const base = `http://127.0.0.1:${port}`;
const temp = mkdtempSync(join(tmpdir(), "brainllm-http-smoke-"));
const configPath = join(temp, "brainllm.json");
writeFileSync(configPath, JSON.stringify({ ...EMPTY_BRAINLLM, version: 10 }));

let child: ChildProcess | undefined;
const fail = (message: string): never => { throw new Error(message); };

async function waitForHealth(): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      const response = await fetch(`${base}/health`);
      if (response.status === 200 && (await response.text()) === "OK") return;
    } catch { /* the child is still starting */ }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  fail("HTTP smoke server did not become healthy");
}

async function expectStatus(path: string, init: RequestInit, status: number, label: string): Promise<Response> {
  const response = await fetch(`${base}${path}`, init);
  if (response.status !== status) fail(`${label}: expected ${status}, received ${response.status}`);
  return response;
}

try {
  child = spawn("bun", ["run", "src/index.ts"], {
    cwd: root,
    env: {
      ...process.env,
      TRILIUM_BASE_URL: "http://127.0.0.1:1",
      TRILIUM_ETAPI_TOKEN: "smoke-etapi-token",
      MCP_AUTH_TOKEN: "smoke-static-token",
      BRAINLLM_OWNER_PASSWORD: "smoke-owner-password",
      BRAINLLM_MODE: "core",
      BRAINLLM_CONFIG: configPath,
      PORT: String(port),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  await waitForHealth();

  const unauthenticatedMcp = await expectStatus("/mcp", { headers: { Accept: "text/event-stream" } }, 401, "unauthenticated /mcp");
  if (!unauthenticatedMcp.headers.get("www-authenticate")) fail("unauthenticated /mcp did not return WWW-Authenticate");
  if (unauthenticatedMcp.headers.get("x-frame-options") !== "DENY") fail("security headers missing from /mcp");

  await expectStatus("/sse", { headers: { Accept: "text/event-stream" } }, 401, "unauthenticated /sse");
  await expectStatus("/messages", { method: "POST", body: "{}" }, 401, "unauthenticated /messages");
  await expectStatus("/mcp", {
    method: "POST",
    headers: { Accept: "application/json, text/event-stream", "Content-Type": "application/json", Authorization: "Bearer smoke-static-token" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
  }, 400, "authenticated uninitialized /mcp");

  const largeBody = JSON.stringify({
    jsonrpc: "2.0",
    id: 2,
    method: "initialize",
    params: { padding: "x".repeat(5 * 1024 * 1024) },
  });
  await expectStatus("/mcp", {
    method: "POST",
    headers: { Accept: "application/json, text/event-stream", "Content-Type": "application/json", Authorization: "Bearer smoke-static-token" },
    body: largeBody,
  }, 400, "5 MiB authenticated MCP body");

  const preflight = await expectStatus("/mcp", { method: "OPTIONS" }, 204, "CORS preflight");
  if (preflight.headers.get("x-content-type-options") !== "nosniff") fail("security headers missing from preflight");

  console.log("HTTP auth smoke passed: /mcp, /sse, /messages, authorized transport, and security headers");
} finally {
  child?.kill("SIGTERM");
  rmSync(temp, { recursive: true, force: true });
}
