#!/usr/bin/env bun
// The shebang names bun deliberately, not node. This server uses Bun.serve,
// Bun.file and Bun.main directly, so it does not run on node — an `npx
// brainllm` that resolved to node would fail at startup with an obscure
// ReferenceError. package.json declares the same requirement in `engines`,
// and manifest.json in `compatibility.runtimes`.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { join, dirname } from "path";
import { TriliumClient } from "./trilium.js";
import { registerTools } from "./tools.js";
import { serializeWrites } from "./serialize.js";
import { FixedWindowRateLimiter } from "./rate-limit.js";
import { coerceToolArgs } from "./coerce.js";
import { registerAdvancedTools } from "./tools-advanced.js";
import { applyToolAnnotations } from "./annotations.js";
import { BunSseServerTransport } from "./sse.js";
import { loadConfig, discoverBrainLLM, saveConfig, configFilePath, loadCachedToken, saveCachedToken, EMPTY_BRAINLLM } from "./config.js";
import {
  oauthEnabled, baseUrl as publicBaseUrl, protectedResourceMetadata, authorizationServerMetadata,
  handleAuthorize, handleToken, handleRegister, validateAccessToken, wwwAuthenticate, landingPage,
} from "./oauth.js";

const baseUrl = process.env.TRILIUM_BASE_URL;

if (!baseUrl) {
  console.error("Missing TRILIUM_BASE_URL environment variable.");
  process.exit(1);
}

// ── Credential resolution ─────────────────────────────────────────────────────
// An explicit token always wins. Failing that, a password mints one — because a
// container deploy has the same chicken-and-egg as a local install (the server
// needs a token; the token can only be made once Trilium has a password) and no
// UI to resolve it in. Without this the container simply crash-loops on a
// missing variable, which is a poor first experience for the deploy path most
// forkers actually take. The minted token is cached beside the config file so a
// restart reuses it instead of adding a new entry to Trilium's token list on
// every redeploy.

async function resolveToken(url: string): Promise<string> {
  const explicit = process.env.TRILIUM_ETAPI_TOKEN;
  if (explicit) return explicit;

  const password = process.env.TRILIUM_PASSWORD;
  if (!password) {
    console.error(
      "Missing TRILIUM_ETAPI_TOKEN. Set it, or set TRILIUM_PASSWORD and BrainLLM will create a token on first start."
    );
    process.exit(1);
  }

  const cached = loadCachedToken();
  if (cached) {
    const ok = await new TriliumClient(url, cached).getAppInfo().then(() => true).catch(() => false);
    if (ok) {
      console.error("[brainllm] Reusing the cached ETAPI token.");
      return cached;
    }
    console.error("[brainllm] Cached ETAPI token no longer works — requesting a new one.");
  }

  try {
    const minted = await TriliumClient.login(url, password);
    const saved = saveCachedToken(minted);
    console.error(
      saved
        ? `[brainllm] Created an ETAPI token from TRILIUM_PASSWORD and cached it at ${saved}.`
        : "[brainllm] Created an ETAPI token from TRILIUM_PASSWORD, but could not cache it — a new one will be created on each restart. Set BRAINLLM_CONFIG to a writable path on a persistent volume, or set TRILIUM_ETAPI_TOKEN explicitly."
    );
    return minted;
  } catch (err) {
    console.error(`[brainllm] Could not create an ETAPI token: ${err instanceof Error ? err.message : err}`);
    console.error("[brainllm] Check TRILIUM_BASE_URL and TRILIUM_PASSWORD, or set TRILIUM_ETAPI_TOKEN directly.");
    process.exit(1);
  }
}

const trilium = new TriliumClient(baseUrl, await resolveToken(baseUrl));

// ── Resolve brain config ───────────────────────────────────────────────────
// Priority: brainllm.json file → auto-discovery from Trilium → empty (bootstrap needed)

let brain = loadConfig();

if (!brain) {
  console.error("[brainllm] No brainllm.json — attempting auto-discovery from Trilium...");
  try {
    brain = await discoverBrainLLM(trilium);
  } catch (err) {
    console.error(`[brainllm] Auto-discovery failed: ${err}`);
  }
  if (brain) {
    try {
      saveConfig(brain);
      console.error(`[brainllm] Auto-discovered. Config written to: ${configFilePath()}`);
    } catch (err) {
      console.error(`[brainllm] Auto-discovered but could not persist config: ${err}`);
    }
  } else if (!brain) {
    console.error("[brainllm] BrainLLM not found in Trilium. Run the bootstrap tool to initialize.");
  }
}

// brainRef is a mutable container — bootstrap updates config in-place
// so subsequent tool calls in the same session see the new IDs immediately.
const brainRef = { config: brain ?? EMPTY_BRAINLLM };

// ── Transport ─────────────────────────────────────────────────────────────────

const port      = process.env.PORT ? parseInt(process.env.PORT, 10) : null;
const authToken = process.env.MCP_AUTH_TOKEN;

// BRAINLLM_MODE=core (default): the 44 brain-aware tools (34 universal verbs + 10 surface reads).
// BRAINLLM_MODE=full: additionally registers the 33 raw ETAPI tools, for 77.
const mode: "core" | "full" = process.env.BRAINLLM_MODE === "full" ? "full" : "core";
const allowUnauthenticatedHttp = process.env.BRAINLLM_ALLOW_UNAUTHENTICATED_HTTP === "true";
if (port && !authToken && !oauthEnabled() && !allowUnauthenticatedHttp) {
  console.error("HTTP mode requires MCP_AUTH_TOKEN or BRAINLLM_OWNER_PASSWORD. Set BRAINLLM_ALLOW_UNAUTHENTICATED_HTTP=true only for a trusted, isolated network.");
  process.exit(1);
}

// Brand identity advertised in the MCP handshake (serverInfo.icons). Clients
// that render server icons show the BrainLLM logo in their connector list and
// beside its tool calls.
//
// The icons MUST be served from the server's own origin. The MCP spec directs
// clients to "verify that icon URIs are from the same origin as the server" —
// it minimises the risk of leaking usage data to a third party — so pointing at
// raw.githubusercontent.com, as this used to, gets the icons silently dropped
// and no icon renders at all. In HTTP mode they are served from /icon.png and
// /icon.svg below. Under stdio there is no server origin to compare against, so
// the public repo URLs remain the only option there.
//
// PNG is listed first deliberately: clients MUST support image/png but only
// SHOULD support image/svg+xml, and MAY refuse SVG outright because it can
// carry executable content. Leading with the format everyone renders means the
// icon shows even where SVG is disallowed.
const REPO_RAW = "https://raw.githubusercontent.com/miisodev/BrainLLM/main/public";

// Several sizes are offered so a client picks what it renders rather than
// downscaling a large one — the spec says clients should select the most
// appropriate icon for their UI.
function brandingIcons(origin: string | null) {
  const at = (file: string) => (origin ? `${origin}/${file}` : `${REPO_RAW}/${file}`);
  return [
    { src: at("icon-128.png"), mimeType: "image/png", sizes: ["128x128"] },
    { src: at("icon-512.png"), mimeType: "image/png", sizes: ["512x512"] },
    { src: origin ? `${origin}/icon.svg` : `${REPO_RAW}/BrainLLM.svg`, mimeType: "image/svg+xml", sizes: ["any"] },
  ];
}

function createServer(origin: string | null = null): McpServer {
  const s = new McpServer({
    name: "BrainLLM",
    title: "BrainLLM",
    version: "12.4.2",
    icons: brandingIcons(origin),
  });
  // The two surfaces, composed here rather than nested inside registerTools —
  // so what each mode actually contains is visible at the point the decision is
  // made, not behind a flag halfway down another module.
  registerTools(s, trilium, brainRef);
  if (mode === "full") registerAdvancedTools(s, trilium, brainRef);

  // Coerce string-encoded booleans/numbers/arrays before the SDK's strict Zod
  // parse sees them — some clients serialize params as strings, and the
  // observed failure put strict= out of reach on exactly the writes that need it.
  const coerced = coerceToolArgs(s);
  if (coerced.fields) {
    console.error(`[brainllm] Param coercion: ${coerced.fields} field(s) across ${coerced.tools.length} tool(s)`);
  }

  // Group the surface into read-only vs write/destructive for the client's
  // permission UI. Without it every tool is "Other", and the only choice on
  // offer is allow-all-77 or approve-every-call.
  const { unclassified } = applyToolAnnotations(s);
  if (unclassified.length) {
    console.error(`[brainllm] Unclassified tools, treated as writes: ${unclassified.join(", ")}`);
  }
  // Serialize write-classified handlers behind a process-wide FIFO lock. Each
  // HTTP session builds its own server instance, but the lock chain is
  // module-level — so two agents (an interactive session and an automated run,
  // say) writing through one hosted process queue instead of racing, and a
  // read-modify-write can no longer silently discard the other's write.
  const serialized = serializeWrites(s);
  if (serialized.serialized) {
    console.error(`[brainllm] Write serialization: ${serialized.serialized} write handler(s) queued, ${serialized.readsUntouched} read(s) untouched`);
  }
  return s;
}

if (port) {
  // ── HTTP mode — Railway / remote connector ────────────────────────────────
  // Each MCP session gets its own transport + server instance.
  // Sessions are keyed by the mcp-session-id header the client echoes back.

  interface SessionEntry {
    transport: WebStandardStreamableHTTPServerTransport;
    lastUsed: number;
  }

  const sessions = new Map<string, SessionEntry>();

  // Legacy SSE sessions — same lifecycle as streamable-HTTP sessions, keyed by
  // the transport's own session id (the one the client echoes on /messages).
  const sseSessions = new Map<string, { transport: BunSseServerTransport; lastUsed: number }>();

  // CORS for browser-based MCP clients (Inspector web, web-standard fetch
  // transports). Exposing mcp-session-id is load-bearing: without it a browser
  // client can never read the session id off the initialize response, so every
  // follow-up request starts a fresh session.
  const CORS_HEADERS: Record<string, string> = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, mcp-session-id, mcp-protocol-version, last-event-id",
    "Access-Control-Expose-Headers": "mcp-session-id, WWW-Authenticate",
    "Access-Control-Max-Age": "86400",
  };
  // The OAuth consent page accepts a password and is reachable from a browser;
  // it must not be framed, interpreted as a document, or used as a referrer.
  // Keep these on every HTTP response, including errors and discovery metadata.
  const SECURITY_HEADERS: Record<string, string> = {
    "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'; img-src 'self' data:",
    "X-Frame-Options": "DENY",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
    "Strict-Transport-Security": "max-age=31536000; includeSubDomains",
  };
  const withCors = (res: Response): Response => {
    for (const [k, v] of Object.entries({ ...CORS_HEADERS, ...SECURITY_HEADERS })) {
      // The OAuth handler owns a route-specific CSP: its validated external
      // callback must be allowed in form-action, while every other response
      // gets the locked-down default above. Never overwrite that route-specific
      // policy here — doing so is what made v12.4 return 302s Chrome refused to follow.
      if (k === "Content-Security-Policy" && res.headers.has(k)) continue;
      res.headers.set(k, v);
    }
    return res;
  };

  // Public endpoints have deliberately different budgets: an owner-password
  // guess is more expensive than a metadata read, while a busy MCP client must
  // not be mistaken for an attacker behind a shared NAT.
  const rateLimiters = {
    authorize: new FixedWindowRateLimiter(30, 15 * 60_000),
    token: new FixedWindowRateLimiter(120, 15 * 60_000),
    register: new FixedWindowRateLimiter(30, 60 * 60_000),
    transport: new FixedWindowRateLimiter(600, 15 * 60_000),
  };
  const rateLimited = (limiter: FixedWindowRateLimiter, key: string): Response | null => {
    const decision = limiter.allow(key);
    if (decision.allowed) return null;
    return withCors(new Response(JSON.stringify({
      error: "rate_limited",
      error_description: "Too many requests. Retry after the indicated delay.",
    }), {
      status: 429,
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
        "Retry-After": String(decision.retryAfterSeconds),
      },
    }));
  };
  const clientKey = (req: Request, server: { requestIP(request: Request): { address: string } | null }): string =>
    server.requestIP(req)?.address ?? req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";
  const MAX_HTTP_SESSIONS = 1_000;

  // Evict sessions idle past 1 hour — clients that drop without sending DELETE
  // would otherwise accumulate forever in the map. An evicted SSE transport is
  // closed rather than dropped, so its stream ends and its onclose runs.
  const SESSION_TTL_MS = 60 * 60 * 1000;
  setInterval(() => {
    const cutoff = Date.now() - SESSION_TTL_MS;
    for (const [id, entry] of sessions) {
      if (entry.lastUsed < cutoff) {
        sessions.delete(id);
        entry.transport.close().catch(() => {});
      }
    }
    for (const [id, entry] of sseSessions) {
      if (entry.lastUsed < cutoff) {
        sseSessions.delete(id);
        entry.transport.close().catch(() => {});
      }
    }
  }, 15 * 60 * 1000).unref();

  Bun.serve({
    port,
    // 50 MB cap — prevents runaway memory on large note writes in HTTP mode.
    maxRequestBodySize: 50 * 1024 * 1024,
    async fetch(req: Request, server): Promise<Response> {
      const url = new URL(req.url);
      const requestKey = clientKey(req, server);

      if (req.method === "OPTIONS") {
        return withCors(new Response(null, { status: 204 }));
      }

      if (url.pathname === "/health") {
        return withCors(new Response("OK"));
      }

      // ── Brand assets ────────────────────────────────────────────────────────
      // Served from our own origin so the icons in serverInfo pass the client's
      // same-origin check. Public and unauthenticated by design: the spec tells
      // clients to fetch icons WITHOUT credentials, so an authenticated icon
      // route would never load.
      // /favicon.ico matters more than it looks. When a host serves no favicon,
      // clients fall back to the registrable domain's — so brainllm.miiso.dev
      // with no icon of its own rendered miiso.dev's site logo in the connector
      // list, which is worse than no icon: it looks deliberate and wrong.
      //
      // Each route serves the size its consumer actually renders. Handing a
      // 512px image to a 16px favicon slot is ~80KB of transfer for a few dozen
      // visible pixels, and the spec lets clients cap icon size outright — so an
      // oversized icon risks not rendering at all.
      const ICON_ROUTES: Record<string, string> = {
        "/favicon.ico": "icon-64.png",
        "/favicon.png": "icon-64.png",
        "/apple-touch-icon.png": "icon-180.png",
        "/icon-64.png": "icon-64.png",
        "/icon-128.png": "icon-128.png",
        "/icon-512.png": "icon-512.png",
        "/icon.png": "icon-512.png",
        "/icon.svg": "BrainLLM.svg",
      };
      const asset = ICON_ROUTES[url.pathname];
      if (asset) {
        const file = Bun.file(join(dirname(Bun.main), "..", "public", asset));
        if (!(await file.exists())) return withCors(new Response("Not Found", { status: 404 }));
        return withCors(new Response(file, {
          headers: {
            "Content-Type": asset.endsWith(".svg") ? "image/svg+xml" : "image/png",
            "Cache-Control": "public, max-age=86400",
            // The icon is untrusted-input surface for the client; make sure a
            // renderer can't be talked into treating it as anything else.
            "X-Content-Type-Options": "nosniff",
          },
        }));
      }

      // ── OAuth 2.1 / CIMD surface ────────────────────────────────────────────
      // Served only when an owner password is configured. Claude.ai's custom
      // connector UI offers OAuth or nothing — it has no field for a static
      // bearer token — so without these endpoints the hosted Claude surfaces
      // cannot connect at all, however good the token is.
      const oauthOn = oauthEnabled();
      const base = publicBaseUrl(req);
      const json = (body: unknown, status = 200): Response =>
        withCors(new Response(JSON.stringify(body), {
          status,
          headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
        }));

      if (oauthOn) {
        // RFC 9728 §3.1: clients try the path-suffixed variant first when the
        // resource URL has a path component, so both are served. RFC 8414's
        // path-insertion rule applies to the AS metadata the same way — some
        // discovery implementations derive it from the resource path rather
        // than the issuer, and refusing the variant reads as "no OAuth here".
        if (url.pathname === "/.well-known/oauth-protected-resource" ||
            url.pathname === "/.well-known/oauth-protected-resource/mcp") {
          return json(protectedResourceMetadata(base));
        }
        if (url.pathname === "/.well-known/oauth-authorization-server" ||
            url.pathname === "/.well-known/oauth-authorization-server/mcp" ||
            url.pathname === "/.well-known/openid-configuration") {
          return json(authorizationServerMetadata(base));
        }
        if (url.pathname === "/authorize") {
          const limited = rateLimited(rateLimiters.authorize, requestKey);
          if (limited) return limited;
          return withCors(await handleAuthorize(req, base));
        }
        if (url.pathname === "/token") {
          const limited = rateLimited(rateLimiters.token, requestKey);
          if (limited) return limited;
          return withCors(await handleToken(req, base));
        }
        // RFC 7591 dynamic registration — clients without CIMD support
        // (opencode, MCP TS SDK ≤1.29) refuse to proceed without it.
        if (url.pathname === "/register") {
          const limited = rateLimited(rateLimiters.register, requestKey);
          if (limited) return limited;
          return withCors(await handleRegister(req));
        }
      }

      // The root names the server instead of 404ing — a human or a probing
      // client landing on the origin gets the endpoint and the auth contract.
      //
      // Claude's hosted connector has a post-token path quirk: after a
      // successful exchange it can send the MCP JSON-RPC requests to `/`
      // instead of the configured `/mcp`. Serving the landing page for that
      // request returns HTTP 200 with HTML, which Claude reports as a server
      // connection error even though OAuth succeeded. Keep the human page for
      // ordinary browser GETs, but route protocol-shaped requests at the root
      // through the exact same authenticated streamable-HTTP handler as /mcp.
      const rootMcpRequest = url.pathname === "/" && (
        req.method !== "GET" ||
        req.headers.has("mcp-session-id") ||
        req.headers.has("mcp-protocol-version") ||
        (req.headers.get("accept") ?? "").includes("application/json") ||
        (req.headers.get("accept") ?? "").includes("text/event-stream")
      );
      if (url.pathname === "/" && !rootMcpRequest) {
        return withCors(new Response(landingPage(base, oauthOn, true), {
          headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
        }));
      }

      const isMcpEndpoint = url.pathname === "/mcp" || rootMcpRequest;
      if (!isMcpEndpoint && url.pathname !== "/sse" && url.pathname !== "/messages") {
        return withCors(new Response("Not Found", { status: 404 }));
      }
      const transportLimit = rateLimited(rateLimiters.transport, requestKey);
      if (transportLimit) return transportLimit;

      // ── Authentication ──────────────────────────────────────────────────────
      // Two credentials are accepted, deliberately. A static MCP_AUTH_TOKEN is
      // what Claude Code and mcp-remote pass as a header and is the simplest
      // thing that works; an OAuth access token is what the hosted Claude
      // surfaces obtain, because their connector UI cannot send a header. The
      // 401 MUST carry WWW-Authenticate or Claude has no metadata to follow and
      // reports "Couldn't reach the MCP server" — a failure that looks like a
      // network problem and is not one. The same gate fronts every transport:
      // an older client protocol must never mean a weaker door.
      const gate = (): Response | null => {
        if (!authToken && !oauthOn) return null;
        const header = req.headers.get("Authorization") ?? "";
        const bearer = header.startsWith("Bearer ") ? header.slice(7) : "";
        const staticOk = !!authToken && bearer === authToken;
        const oauthOk = oauthOn && !!bearer && validateAccessToken(bearer, base);
        if (staticOk || oauthOk) return null;
        const headers: Record<string, string> = { "Content-Type": "application/json" };
        if (oauthOn) headers["WWW-Authenticate"] = wwwAuthenticate(base, bearer ? "invalid_token" : undefined);
        return withCors(new Response(
          JSON.stringify({ error: "invalid_token", error_description: "Authentication required." }),
          { status: 401, headers }
        ));
      };

      // Authenticate every transport before any session lookup or MCP parser
      // runs. The streamable-HTTP branch below is the primary door; gating only
      // /sse and /messages leaves /mcp reachable without credentials.
      const denied = gate();
      if (denied) return denied;

      // ── Legacy SSE transport ────────────────────────────────────────────────
      // GET /sse opens the stream; POST /messages ingests one JSON-RPC message.
      // Same auth gate, same CORS, same idle eviction as /mcp.
      if (url.pathname === "/sse") {
        if (req.method !== "GET") {
          return withCors(new Response("Method Not Allowed", { status: 405, headers: { "Allow": "GET" } }));
        }
        if (sessions.size + sseSessions.size >= MAX_HTTP_SESSIONS) {
          return withCors(new Response(JSON.stringify({ error: "session_limit" }), {
            status: 503,
            headers: { "Content-Type": "application/json", "Retry-After": "60" },
          }));
        }
        const transport = new BunSseServerTransport("/messages");
        sseSessions.set(transport.sessionId, { transport, lastUsed: Date.now() });
        transport.onclose = () => sseSessions.delete(transport.sessionId);
        await createServer(base).connect(transport);
        return withCors(transport.streamResponse());
      }

      if (url.pathname === "/messages") {
        if (req.method !== "POST") {
          return withCors(new Response("Method Not Allowed", { status: 405, headers: { "Allow": "POST" } }));
        }
        const sid = url.searchParams.get("sessionId") ?? "";
        const entry = sseSessions.get(sid);
        if (!entry) {
          return withCors(new Response(JSON.stringify({ error: "Session not found" }), {
            status: 404,
            headers: { "Content-Type": "application/json" },
          }));
        }
        entry.lastUsed = Date.now();
        return withCors(await entry.transport.handlePost(req));
      }

      const sessionId = req.headers.get("mcp-session-id");

      // MCP spec: DELETE /mcp terminates the session explicitly.
      if (req.method === "DELETE") {
        if (sessionId && sessions.has(sessionId)) {
          const entry = sessions.get(sessionId)!;
          sessions.delete(sessionId);
          await entry.transport.close().catch(() => {});
          return withCors(new Response(null, { status: 204 }));
        }
        return withCors(new Response(JSON.stringify({ error: "Session not found" }), {
          status: 404,
          headers: { "Content-Type": "application/json" },
        }));
      }

      if (sessionId && sessions.has(sessionId)) {
        const entry = sessions.get(sessionId)!;
        entry.lastUsed = Date.now();
        return withCors(await entry.transport.handleRequest(req));
      }

      if (!sessionId) {
        if (sessions.size + sseSessions.size >= MAX_HTTP_SESSIONS) {
          return withCors(new Response(JSON.stringify({ error: "session_limit" }), {
            status: 503,
            headers: { "Content-Type": "application/json", "Retry-After": "60" },
          }));
        }
        // Initialization request — create a fresh session
        const transport = new WebStandardStreamableHTTPServerTransport({
          maxRequestBodySize: 50 * 1024 * 1024,
          sessionIdGenerator: () => crypto.randomUUID(),
          onsessioninitialized: (id) => { sessions.set(id, { transport, lastUsed: Date.now() }); },
          onsessionclosed:      (id) => { sessions.delete(id); },
        });

        await createServer(base).connect(transport);
        return withCors(await transport.handleRequest(req));
      }

      return withCors(new Response(JSON.stringify({ error: "Session not found" }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      }));
    },
  });

  console.error(`[brainllm] HTTP connector listening on :${port}`);
} else {
  // ── stdio mode — local Claude Code / desktop ──────────────────────────────
  const transport = new StdioServerTransport();
  await createServer().connect(transport);
}
