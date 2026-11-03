import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EMPTY_BRAINLLM } from "../src/config.ts";
import { generateTotp, parseTotpSecret } from "../src/totp.ts";
import { READINESS_DEFAULTS } from "../src/operability.ts";

const root = join(import.meta.dir, "..");
const mfa = process.env.BRAINLLM_SMOKE_MFA === "1";
// Public fixture seed, never an operator credential.
const fixtureSeed = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";
const port = 40_000 + Math.floor(Math.random() * 20_000);
const dependencyPort = port + 1;
const base = `http://127.0.0.1:${port}`;
const dependencyBase = `http://127.0.0.1:${dependencyPort}`;
const temp = mkdtempSync(join(tmpdir(), "brainllm-http-smoke-"));
const configPath = join(temp, "brainllm.json");
writeFileSync(configPath, JSON.stringify({ ...EMPTY_BRAINLLM, version: 10 }));

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// A real HTTP dependency, not a stubbed trilium client: /ready must fail and
// recover through the same getAppInfo request the product makes. The health
// tool keeps the same endpoint slow later, so shutdown has in-flight work.
let appInfoMode: "ok" | "fail" = "fail";
let appInfoDelayMs = 0;
let signalAppInfoStarted: (() => void) | null = null;
const nextAppInfoStart = () => new Promise<void>((resolve) => { signalAppInfoStarted = resolve; });

const dependency = Bun.serve({
  port: dependencyPort,
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/etapi/app-info") {
      const notify = signalAppInfoStarted;
      signalAppInfoStarted = null;
      notify?.();
      if (appInfoDelayMs > 0) await sleep(appInfoDelayMs);
      if (appInfoMode === "fail") {
        return new Response(JSON.stringify({ error: "dependency unavailable" }), {
          status: 503,
          headers: { "Content-Type": "application/json" },
        });
      }
      return Response.json({ appVersion: "13.3.0", dbVersion: 1, buildDate: "2026-01-01" });
    }
    if (url.pathname === "/etapi/notes") return Response.json({ results: [] });
    return new Response("not found", { status: 404 });
  },
});

let child: ChildProcess | undefined;
let stderr = "";
const fail = (message: string): never => { throw new Error(message); };
const expectSecretFree = (body: string, label: string): void => {
  for (const sentinel of [
    "smoke-etapi-token",
    "smoke-static-token",
    "smoke-owner-password",
    "smoke-oauth-secret",
    fixtureSeed,
    dependencyBase,
    "dependency unavailable",
    "SENTINEL",
  ]) {
    if (body.includes(sentinel)) fail(`${label} leaked ${sentinel}`);
  }
};

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

function waitForExit(proc: ChildProcess, timeoutMs: number): Promise<{ code: number | null; signal: string | null }> {
  if (proc.exitCode !== null || proc.signalCode !== null) {
    return Promise.resolve({ code: proc.exitCode, signal: proc.signalCode });
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`HTTP smoke server did not exit within ${timeoutMs}ms`));
    }, timeoutMs);
    proc.once("close", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    });
  });
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
      TRILIUM_BASE_URL: dependencyBase,
      TRILIUM_ETAPI_TOKEN: "smoke-etapi-token",
      MCP_AUTH_TOKEN: "smoke-static-token",
      BRAINLLM_OWNER_PASSWORD: "smoke-owner-password",
      BRAINLLM_OWNER_TOTP_SECRET: mfa ? fixtureSeed : "",
      BRAINLLM_OAUTH_SECRET: "smoke-oauth-secret-at-least-32-characters",
      BRAINLLM_PUBLIC_URL: base,
      BRAINLLM_MODE: "core",
      BRAINLLM_CONFIG: configPath,
      PORT: String(port),
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  child.stderr?.on("data", (chunk) => { stderr += chunk.toString(); });
  await waitForHealth();

  // Liveness stays unconditional; readiness is the dependency-aware door.
  const health = await expectStatus("/health", {}, 200, "liveness while Trilium is unavailable");
  if ((await health.text()) !== "OK") fail("health response changed");
  const unavailable = await expectStatus("/ready", {}, 503, "readiness while Trilium is unavailable");
  const unavailableBody = await unavailable.text();
  if (unavailableBody !== '{"status":"unavailable"}') fail(`readiness returned an unexpected body: ${unavailableBody}`);
  expectSecretFree(unavailableBody, "unavailable readiness body");
  if (unavailable.headers.get("cache-control") !== "no-store") fail("readiness must not be cached by intermediaries");

  appInfoMode = "ok";
  await sleep(READINESS_DEFAULTS.failureTtlMs + 250);
  const ready = await expectStatus("/ready", {}, 200, "readiness after Trilium recovers");
  const readyBody = await ready.text();
  if (readyBody !== '{"status":"ready"}') fail(`readiness returned an unexpected body: ${readyBody}`);
  expectSecretFree(readyBody, "ready readiness body");

  const favicon = await expectStatus("/favicon.ico", {}, 200, "public connector favicon");
  if (!favicon.headers.get("content-type")?.includes("image/vnd.microsoft.icon")) fail("favicon has the wrong media type");
  const ico = Buffer.from(await favicon.arrayBuffer());
  if (ico.readUInt16LE(2) !== 1 || ico.readUInt16LE(4) !== 4) fail("favicon is not a four-frame ICO");
  const landing = await (await fetch(`${base}/`)).text();
  if (!landing.includes('rel="icon"') || !landing.includes('/favicon.ico?brand=brainllm')) fail("landing page omits BrainLLM favicon discovery");
  const resource = await (await fetch(`${base}/.well-known/oauth-protected-resource`)).json() as Record<string, unknown>;
  if (resource.resource_name !== "BrainLLM" || resource.resource_documentation !== base) fail("OAuth discovery omits instance brand identity");

  const unauthenticatedMcp = await expectStatus("/mcp", { headers: { Accept: "text/event-stream" } }, 401, "unauthenticated /mcp");
  if (!unauthenticatedMcp.headers.get("www-authenticate")) fail("unauthenticated /mcp did not return WWW-Authenticate");
  if (unauthenticatedMcp.headers.get("x-frame-options") !== "DENY") fail("security headers missing from /mcp");

  // Claude's hosted connector has been observed sending its post-token MCP
  // requests to `/` even when the configured resource is `/mcp`. The root must
  // therefore be a protocol alias, not the HTML landing page, for MCP-shaped
  // requests — including the unauthenticated discovery probe.
  const unauthenticatedRootMcp = await expectStatus("/", {
    method: "POST",
    headers: { Accept: "application/json, text/event-stream", "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
  }, 401, "unauthenticated root MCP compatibility alias");
  if (!unauthenticatedRootMcp.headers.get("www-authenticate")) fail("unauthenticated root MCP alias did not return WWW-Authenticate");
  const rootPage = await fetch(`${base}/`, { headers: { Accept: "text/html" } });
  if (rootPage.status !== 200 || !rootPage.headers.get("content-type")?.includes("text/html")) {
    fail("root browser request no longer serves the landing page");
  }

  await expectStatus("/sse", { headers: { Accept: "text/event-stream" } }, 401, "unauthenticated /sse");
  await expectStatus("/messages", { method: "POST", body: "{}" }, 401, "unauthenticated /messages");
  await expectStatus("/mcp", {
    method: "POST",
    headers: { Accept: "application/json, text/event-stream", "Content-Type": "application/json", Authorization: "Bearer smoke-static-token" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
  }, 400, "authenticated uninitialized /mcp");

  const rootInitialized = await expectStatus("/", {
    method: "POST",
    headers: { Accept: "application/json, text/event-stream", "Content-Type": "application/json", Authorization: "Bearer smoke-static-token" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 2,
      method: "initialize",
      params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "http-smoke-root", version: "1" } },
    }),
  }, 200, "authenticated root MCP compatibility alias");
  if (!rootInitialized.headers.get("mcp-session-id")) fail("root MCP compatibility alias returned no session id");
  const initBody = await rootInitialized.text();
  const initLine = initBody.startsWith("{") ? initBody : initBody.split("\n").find((line) => line.startsWith("data: "))?.slice(6);
  if (!initLine) fail("initialize returned no server info");
  const info = JSON.parse(initLine!).result.serverInfo;
  if (info.name !== "BrainLLM" || info.websiteUrl !== base) fail("hosted handshake does not identify its own BrainLLM instance");
  if (!info.icons?.every((icon: {src: string}) => new URL(icon.src).origin === base && icon.src.includes("brand=brainllm"))) fail("hosted connector icons are not same-origin with brand cache keys");


  const invalidArguments = await expectStatus("/mcp", {
    method: "POST",
    headers: {
      Accept: "application/json, text/event-stream", "Content-Type": "application/json",
      Authorization: "Bearer smoke-static-token", "mcp-session-id": rootInitialized.headers.get("mcp-session-id")!,
      "mcp-protocol-version": "2025-11-25",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 29, method: "tools/call", params: { name: "template", arguments: { kind: "invalid-fixture" } } }),
  }, 200, "SDK input rejection");
  if (!(await invalidArguments.text()).includes('"isError":true')) fail("invalid tool arguments were not rejected");
  await expectStatus("/ready", {}, 200, "client input errors must not trigger operational alerts");

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

  // Full OAuth browser transaction against the real router. A 302 answer to the
  // consent POST is subject to form-action across the whole redirect chain, and
  // twice that froze a login that had succeeded (v12.4, then Android Studio's
  // onward redirect). The POST now answers with a handoff page instead.
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
  if (!csp.includes("form-action 'self';")) {
    fail(`OAuth consent CSP should keep form-action to its own origin: ${csp}`);
  }
  const consentHtml = await consent.text();
  const transaction = consentHtml.match(/name="transaction" value="([^"]+)"/)?.[1];
  if (!transaction) fail("OAuth consent transaction missing");

  const approvalFields = { transaction, password: "smoke-owner-password", decision: "approve", totp: "" };
  if (mfa) {
    if (!consentHtml.includes('name="totp"')) fail("MFA consent omitted code field");
    const refused = await fetch(`${base}/authorize`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(approvalFields),
    });
    if (refused.status !== 401 || (await refused.text()).includes('http-equiv="refresh"')) fail("MFA granted password-only consent");
    const parsed = parseTotpSecret(fixtureSeed);
    if ("error" in parsed) fail("invalid smoke fixture");
    approvalFields.totp = generateTotp(parsed.key, Date.now());
  }
  const approval = await fetch(`${base}/authorize`, {
    method: "POST",
    redirect: "manual",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(approvalFields),
  });
  if (approval.status !== 200) fail(`OAuth approval: expected a 200 handoff page, received ${approval.status}`);
  const refresh = (await approval.text()).match(/<meta http-equiv="refresh" content="0;url=([^"]+)">/)?.[1];
  if (!refresh) fail("OAuth approval page has no handoff refresh");
  const callbackUrl = new URL(refresh!.replaceAll("&amp;", "&"));
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
  const { access_token: accessToken, refresh_token: refreshToken } = await token.json() as { access_token: string; refresh_token: string };

  // Refresh tokens are stored by hash: the store on the volume must never
  // contain a working credential in the clear.
  const store = readFileSync(configPath.replace(/\.json$/, "") + ".oauth.json", "utf8");
  if (store.includes(refreshToken)) fail("the OAuth store holds a refresh token in the clear");
  const rotated = await expectStatus("/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken }),
  }, 200, "OAuth refresh");
  const { refresh_token: successor } = await rotated.json() as { refresh_token: string };
  if (!successor || successor === refreshToken) fail("refresh did not rotate the token");
  await expectStatus("/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken }),
  }, 400, "reuse of a rotated refresh token");
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
  const sessionId = initialized.headers.get("mcp-session-id");
  if (!sessionId) fail("OAuth-authenticated MCP initialization returned no session id");

  // Exercise the exact compatibility path used by the hosted Claude connector:
  // after OAuth succeeds, its MCP initialization can arrive at the origin root.
  const oauthRootInitialized = await expectStatus("/", {
    method: "POST",
    headers: {
      Accept: "application/json, text/event-stream",
      "Content-Type": "application/json",
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 4,
      method: "initialize",
      params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "http-smoke-oauth-root", version: "1" } },
    }),
  }, 200, "OAuth-authenticated root MCP compatibility alias");
  if (!oauthRootInitialized.headers.get("mcp-session-id")) fail("OAuth-authenticated root MCP alias returned no session id");

  // ── Graceful drain with a real in-flight request ──────────────────────────
  // The health tool starts with getAppInfo. Slow that dependency down, wait
  // until the tool has actually reached it, then signal the server. Readiness
  // must turn draining while the accepted call is still allowed to finish;
  // shutdown must wait for it rather than truncate the response.
  appInfoMode = "ok";
  appInfoDelayMs = 1_500;
  const appInfoStarted = nextAppInfoStart();
  const inFlight = fetch(`${base}/mcp`, {
    method: "POST",
    headers: {
      Accept: "application/json, text/event-stream",
      "Content-Type": "application/json",
      Authorization: `Bearer ${accessToken}`,
      "mcp-session-id": sessionId,
      "mcp-protocol-version": "2025-11-25",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 5,
      method: "tools/call",
      params: { name: "health", arguments: {} },
    }),
  });
  await appInfoStarted;
  child.kill("SIGTERM");

  let draining: Response | undefined;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      const response = await fetch(`${base}/ready`);
      if (response.status === 503) {
        draining = response;
        break;
      }
      await response.text();
    } catch { /* the listener may already be closing */ }
    await sleep(20);
  }
  if (!draining) fail("readiness did not report draining during shutdown");
  const drainingBody = await draining.text();
  if (drainingBody !== '{"status":"draining"}') fail(`draining readiness returned an unexpected body: ${drainingBody}`);
  expectSecretFree(drainingBody, "draining readiness body");

  const inFlightResponse = await inFlight;
  const inFlightBody = await inFlightResponse.text();
  if (inFlightResponse.status !== 200 || !inFlightBody.includes("appVersion")) {
    fail(`in-flight tool call was truncated during shutdown: ${inFlightResponse.status}`);
  }
  const exit = await waitForExit(child, 15_000);
  if (exit.code !== 0 || exit.signal !== null) fail(`graceful shutdown exited code=${exit.code} signal=${exit.signal}`);
  if (!stderr.includes('"event":"shutdown"') || !stderr.includes('"phase":"drained"')) {
    fail("graceful shutdown did not log a drained completion");
  }
  if (!stderr.includes('"tool":"health"')) fail("tool operation metadata was not logged");
  expectSecretFree(stderr, "operator logs");

  console.log(`HTTP auth smoke passed (MFA=${mfa}): static/OAuth authentication, every transport, consent handoff, root MCP compatibility, security headers, readiness, and graceful drain`);
} finally {
  child?.kill("SIGKILL");
  await dependency.stop(true);
  rmSync(temp, { recursive: true, force: true });
}
