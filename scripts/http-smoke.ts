import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
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
      BRAINLLM_PUBLIC_URL: base,
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

  // Full OAuth browser transaction against the real router. v12.4 returned 302
  // from /authorize but the static form-action 'self' CSP made Chrome refuse the
  // callback redirect, so status-only checks missed a completely broken login.
  const callback = "http://127.0.0.1:43187/mcp/oauth/callback";
  const registration = await expectStatus("/register", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ redirect_uris: [callback], client_name: "HTTP Smoke OAuth Client" }),
  }, 201, "OAuth client registration");
  const { client_id: clientId } = await registration.json() as { client_id: string };
  const verifier = randomBytes(32).toString("base64url");
  const authorize = new URL(`${base}/authorize`);
  authorize.searchParams.set("client_id", clientId);
  authorize.searchParams.set("redirect_uri", callback);
  authorize.searchParams.set("response_type", "code");
  authorize.searchParams.set("code_challenge", createHash("sha256").update(verifier).digest("base64url"));
  authorize.searchParams.set("code_challenge_method", "S256");
  authorize.searchParams.set("resource", `${base}/mcp`);
  authorize.searchParams.set("scope", "brain");
  authorize.searchParams.set("state", "smoke-state");
  const consent = await fetch(authorize.href, { redirect: "manual" });
  if (consent.status !== 200) {
    fail(`OAuth consent: expected 200, received ${consent.status} at ${consent.url}: ${(await consent.text()).slice(0, 200)}`);
  }
  const csp = consent.headers.get("content-security-policy") ?? "";
  if (!csp.includes("form-action 'self' http://127.0.0.1:43187")) {
    fail(`OAuth consent CSP does not allow the validated callback: ${csp}`);
  }
  const consentHtml = await consent.text();
  const transaction = consentHtml.match(/name="transaction" value="([^"]+)"/)?.[1];
  if (!transaction) fail("OAuth consent transaction missing");

  const approval = await fetch(`${base}/authorize`, {
    method: "POST",
    redirect: "manual",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ transaction, password: "smoke-owner-password", decision: "approve" }),
  });
  if (approval.status !== 302) fail(`OAuth approval: expected 302, received ${approval.status}`);
  const callbackUrl = new URL(approval.headers.get("location") ?? "");
  if (`${callbackUrl.origin}${callbackUrl.pathname}` !== callback) fail("OAuth approval redirected to the wrong callback");
  if (callbackUrl.searchParams.get("state") !== "smoke-state") fail("OAuth state was not returned");
  const code = callbackUrl.searchParams.get("code");
  if (!code) fail("OAuth approval returned no authorization code");

  const token = await expectStatus("/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      code_verifier: verifier,
      redirect_uri: callback,
    }),
  }, 200, "OAuth token exchange");
  const { access_token: accessToken } = await token.json() as { access_token: string };
  const initialized = await expectStatus("/mcp", {
    method: "POST",
    headers: {
      Accept: "application/json, text/event-stream",
      "Content-Type": "application/json",
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 3,
      method: "initialize",
      params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "http-smoke", version: "1" } },
    }),
  }, 200, "OAuth-authenticated MCP initialization");
  if (!initialized.headers.get("mcp-session-id")) fail("OAuth-authenticated MCP initialization returned no session id");

  console.log("HTTP auth smoke passed: static/OAuth authentication, every transport, callback CSP, and security headers");
} finally {
  child?.kill("SIGTERM");
  rmSync(temp, { recursive: true, force: true });
}
