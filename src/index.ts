import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { join, dirname } from "path";
import { TriliumClient } from "./trilium.js";
import { registerTools } from "./tools.js";
import { applyToolAnnotations } from "./annotations.js";
import { loadConfig, discoverBrainLLM, saveConfig, configFilePath, loadCachedToken, saveCachedToken, EMPTY_BRAINLLM } from "./config.js";
import {
  oauthEnabled, baseUrl as publicBaseUrl, protectedResourceMetadata, authorizationServerMetadata,
  handleAuthorize, handleToken, validateAccessToken, wwwAuthenticate,
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

// BRAINLLM_MODE=core (default): the 38 brain-aware tools (28 universal verbs + 10 surface reads).
// BRAINLLM_MODE=full: additionally registers the 33 raw ETAPI tools.
const mode: "core" | "full" = process.env.BRAINLLM_MODE === "full" ? "full" : "core";

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

function brandingIcons(origin: string | null) {
  const base = origin ?? REPO_RAW;
  const png = origin ? `${origin}/icon.png` : `${base}/BrainLLM.png`;
  const svg = origin ? `${origin}/icon.svg` : `${base}/BrainLLM.svg`;
  return [
    { src: png, mimeType: "image/png", sizes: ["500x500"] },
    { src: svg, mimeType: "image/svg+xml", sizes: ["any"] },
  ];
}

function createServer(origin: string | null = null): McpServer {
  const s = new McpServer({
    name: "BrainLLM",
    title: "BrainLLM",
    version: "10.0.0",
    icons: brandingIcons(origin),
  });
  registerTools(s, trilium, brainRef, mode);
  // Group the surface into read-only vs write/destructive for the client's
  // permission UI. Without it every tool is "Other", and the only choice on
  // offer is allow-all-71 or approve-every-call.
  const { unclassified } = applyToolAnnotations(s);
  if (unclassified.length) {
    console.error(`[brainllm] Unclassified tools, treated as writes: ${unclassified.join(", ")}`);
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
  const withCors = (res: Response): Response => {
    for (const [k, v] of Object.entries(CORS_HEADERS)) res.headers.set(k, v);
    return res;
  };

  // Evict sessions idle past 1 hour — clients that drop without sending DELETE
  // would otherwise accumulate forever in the map.
  const SESSION_TTL_MS = 60 * 60 * 1000;
  setInterval(() => {
    const cutoff = Date.now() - SESSION_TTL_MS;
    for (const [id, entry] of sessions) {
      if (entry.lastUsed < cutoff) sessions.delete(id);
    }
  }, 15 * 60 * 1000).unref();

  Bun.serve({
    port,
    // 50 MB cap — prevents runaway memory on large note writes in HTTP mode.
    maxRequestBodySize: 50 * 1024 * 1024,
    async fetch(req: Request): Promise<Response> {
      const url = new URL(req.url);

      if (req.method === "OPTIONS") {
        return new Response(null, { status: 204, headers: CORS_HEADERS });
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
      if (url.pathname === "/icon.png" || url.pathname === "/icon.svg" ||
          url.pathname === "/favicon.ico" || url.pathname === "/favicon.png" ||
          url.pathname === "/apple-touch-icon.png") {
        const svg = url.pathname.endsWith(".svg");
        const file = Bun.file(join(dirname(Bun.main), "..", "public", svg ? "BrainLLM.svg" : "BrainLLM.png"));
        if (!(await file.exists())) return withCors(new Response("Not Found", { status: 404 }));
        return withCors(new Response(file, {
          headers: {
            "Content-Type": svg ? "image/svg+xml" : "image/png",
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
        // resource URL has a path component, so both are served.
        if (url.pathname === "/.well-known/oauth-protected-resource" ||
            url.pathname === "/.well-known/oauth-protected-resource/mcp") {
          return json(protectedResourceMetadata(base));
        }
        if (url.pathname === "/.well-known/oauth-authorization-server" ||
            url.pathname === "/.well-known/openid-configuration") {
          return json(authorizationServerMetadata(base));
        }
        if (url.pathname === "/authorize") {
          return withCors(await handleAuthorize(req, base));
        }
        if (url.pathname === "/token") {
          return withCors(await handleToken(req, base));
        }
      }

      if (url.pathname !== "/mcp") {
        return withCors(new Response("Not Found", { status: 404 }));
      }

      // ── Authentication ──────────────────────────────────────────────────────
      // Two credentials are accepted, deliberately. A static MCP_AUTH_TOKEN is
      // what Claude Code and mcp-remote pass as a header and is the simplest
      // thing that works; an OAuth access token is what the hosted Claude
      // surfaces obtain, because their connector UI cannot send a header. The
      // 401 MUST carry WWW-Authenticate or Claude has no metadata to follow and
      // reports "Couldn't reach the MCP server" — a failure that looks like a
      // network problem and is not one.
      if (authToken || oauthOn) {
        const header = req.headers.get("Authorization") ?? "";
        const bearer = header.startsWith("Bearer ") ? header.slice(7) : "";
        const staticOk = !!authToken && bearer === authToken;
        const oauthOk = oauthOn && !!bearer && validateAccessToken(bearer, base);
        if (!staticOk && !oauthOk) {
          const headers: Record<string, string> = { "Content-Type": "application/json" };
          if (oauthOn) headers["WWW-Authenticate"] = wwwAuthenticate(base, bearer ? "invalid_token" : undefined);
          return withCors(new Response(
            JSON.stringify({ error: "invalid_token", error_description: "Authentication required." }),
            { status: 401, headers }
          ));
        }
      }

      const sessionId = req.headers.get("mcp-session-id");

      // MCP spec: DELETE /mcp terminates the session explicitly.
      if (req.method === "DELETE") {
        if (sessionId && sessions.has(sessionId)) {
          sessions.delete(sessionId);
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
        // Initialization request — create a fresh session
        const transport = new WebStandardStreamableHTTPServerTransport({
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
