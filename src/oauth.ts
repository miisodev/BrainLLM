// ─────────────────────────────────────────────────────────────────────────────
// BrainLLM — OAuth 2.1 authorization server (V10)
//
// BrainLLM is both the MCP resource server and its own authorization server.
// The alternative — delegating to an external IdP — would mean every forker
// signs up for a third-party service before their brain works, which defeats
// the point of a self-hosted memory.
//
// The mechanism is Client ID Metadata Documents (CIMD): the client_id IS an
// HTTPS URL that dereferences to the client's own OAuth registration metadata.
// No client database, no POST /register. MCP's 2026-07-28 revision deprecates
// Dynamic Client Registration in favour of exactly this, and Claude only
// selects CIMD when the authorization-server metadata advertises BOTH
// `client_id_metadata_document_supported: true` AND `"none"` in
// `token_endpoint_auth_methods_supported` — the second because Claude's CIMD
// client authenticates as a public client, so the token endpoint must accept
// PKCE-only requests with no client secret. Miss either and Claude silently
// falls back to hunting for a registration_endpoint and the connection fails.
//
// Everything here sits ABOVE the MCP transport: it gates the HTTP request
// before the JSON-RPC body reaches the SDK, because the refusal has to be a
// transport-level 401. A 200 wrapping an error is an application-level tool
// failure and produces no auth prompt at all.
// ─────────────────────────────────────────────────────────────────────────────

import { createHmac, randomBytes, createHash, timingSafeEqual } from "crypto";
import { existsSync, readFileSync, writeFileSync } from "fs";
import { configFilePath } from "./config.js";

// ── Constants ─────────────────────────────────────────────────────────────────

/** The single scope. A brain is not meaningfully divisible into read/write
 *  halves — a session that can recall but not remember is not the product —
 *  so scope minimisation here means one scope, not a taxonomy nobody reads. */
export const SCOPE = "brain";

const AUTH_CODE_TTL_MS = 10 * 60 * 1000;        // 10 min — codes are single-use
const ACCESS_TOKEN_TTL_S = 60 * 60;             // 1 hour
const REFRESH_TOKEN_TTL_MS = 90 * 24 * 60 * 60 * 1000;
/** Claude allows 10s for discovery/authorize/token. Fetching the client's CIMD
 *  happens inside that budget, so it gets a fraction of it. */
const CIMD_FETCH_TIMEOUT_MS = 5000;

// ── base64url + JWT ───────────────────────────────────────────────────────────

const b64url = (buf: Buffer | string): string =>
  Buffer.from(buf as never).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

const b64urlDecode = (s: string): Buffer =>
  Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64");

interface AccessClaims {
  iss: string;
  aud: string;
  sub: string;
  scope: string;
  iat: number;
  exp: number;
}

/** Access tokens are signed JWTs so validation is stateless — no store read on
 *  the hot path of every MCP request. Refresh tokens are opaque and stored,
 *  because rotation requires invalidating the old one. */
function signJwt(claims: AccessClaims, secret: string): string {
  const header = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const payload = b64url(JSON.stringify(claims));
  const sig = b64url(createHmac("sha256", secret).update(`${header}.${payload}`).digest());
  return `${header}.${payload}.${sig}`;
}

export function verifyJwt(token: string, secret: string): AccessClaims | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [header, payload, sig] = parts;
  const expected = b64url(createHmac("sha256", secret).update(`${header}.${payload}`).digest());
  // Constant-time compare — a fast-fail string === leaks signature bytes.
  if (sig.length !== expected.length) return null;
  if (!timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  try {
    const claims = JSON.parse(b64urlDecode(payload).toString("utf8")) as AccessClaims;
    if (typeof claims.exp !== "number" || claims.exp * 1000 < Date.now()) return null;
    return claims;
  } catch {
    return null;
  }
}

// ── Durable store ─────────────────────────────────────────────────────────────
// On the volume, beside brainllm.json. Process memory is not an option: Railway
// redeploys constantly, and a signing secret that changes on restart invalidates
// every token a user holds. This is the same lesson the pre-close gate taught.

interface AuthCode {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  resource: string;
  scope: string;
  expiresAt: number;
}

interface RefreshRecord {
  clientId: string;
  resource: string;
  scope: string;
  expiresAt: number;
}

interface OAuthStore {
  secret: string;
  codes: Record<string, AuthCode>;
  refresh: Record<string, RefreshRecord>;
}

function storePath(): string {
  return configFilePath().replace(/\.json$/, "") + ".oauth.json";
}

let cache: OAuthStore | null = null;

function loadStore(): OAuthStore {
  if (cache) return cache;
  const path = storePath();
  if (existsSync(path)) {
    try {
      const parsed = JSON.parse(readFileSync(path, "utf-8")) as Partial<OAuthStore>;
      if (typeof parsed.secret === "string" && parsed.secret) {
        cache = { secret: parsed.secret, codes: parsed.codes ?? {}, refresh: parsed.refresh ?? {} };
        return cache;
      }
    } catch { /* fall through to a fresh store */ }
  }
  cache = { secret: randomBytes(32).toString("hex"), codes: {}, refresh: {} };
  saveStore();
  return cache;
}

function saveStore(): void {
  if (!cache) return;
  // Prune on every write — expired codes and refresh tokens are the only thing
  // that grows here, and this keeps the file from accumulating forever.
  const now = Date.now();
  for (const [k, v] of Object.entries(cache.codes)) if (v.expiresAt < now) delete cache.codes[k];
  for (const [k, v] of Object.entries(cache.refresh)) if (v.expiresAt < now) delete cache.refresh[k];
  try {
    writeFileSync(storePath(), JSON.stringify(cache), { mode: 0o600 });
  } catch { /* non-fatal: tokens still work until restart */ }
}

/** The HMAC secret used to sign access tokens. Persisted so a redeploy doesn't
 *  invalidate every issued token. */
export function signingSecret(): string {
  return loadStore().secret;
}

// ── Configuration ─────────────────────────────────────────────────────────────

/** OAuth is enabled only when an owner password exists. Without one there is no
 *  way to prove who owns the brain, and an authorization server that authorises
 *  anyone who finds the URL is worse than no authorization server. When
 *  disabled, discovery 404s and the static MCP_AUTH_TOKEN path is unaffected. */
export function oauthEnabled(): boolean {
  return !!process.env.BRAINLLM_OWNER_PASSWORD;
}

/** Our own public origin. Derived from the request so a forker doesn't have to
 *  configure it, because RFC 9728 requires the advertised `resource` to match
 *  the URL the user actually typed — including the path. BRAINLLM_PUBLIC_URL
 *  overrides for deployments behind a proxy that rewrites Host. */
export function baseUrl(req: Request): string {
  const override = process.env.BRAINLLM_PUBLIC_URL;
  if (override) return override.replace(/\/+$/, "");
  const url = new URL(req.url);
  const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host") ?? url.host;
  const proto = req.headers.get("x-forwarded-proto") ?? (host.startsWith("localhost") ? "http" : "https");
  return `${proto}://${host}`;
}

const resourceUri = (base: string): string => `${base}/mcp`;

function ownerPasswordMatches(supplied: string): boolean {
  const expected = process.env.BRAINLLM_OWNER_PASSWORD ?? "";
  const a = Buffer.from(supplied);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

// ── Discovery documents ───────────────────────────────────────────────────────

export function protectedResourceMetadata(base: string) {
  return {
    resource: resourceUri(base),
    authorization_servers: [base],
    bearer_methods_supported: ["header"],
    scopes_supported: [SCOPE],
  };
}

export function authorizationServerMetadata(base: string) {
  return {
    issuer: base,
    authorization_endpoint: `${base}/authorize`,
    token_endpoint: `${base}/token`,
    scopes_supported: [SCOPE],
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    // Both of the next two are load-bearing for CIMD selection — see the file
    // header. Removing either sends Claude looking for a registration_endpoint.
    token_endpoint_auth_methods_supported: ["none"],
    client_id_metadata_document_supported: true,
    code_challenge_methods_supported: ["S256"],
    authorization_response_iss_parameter_supported: true,
  };
}

/** The challenge that starts the whole flow. Without the resource_metadata
 *  pointer Claude has nothing to follow and reports "Couldn't reach the MCP
 *  server" — the failure looks like a network problem and isn't one. */
export function wwwAuthenticate(base: string, error?: string): string {
  const parts = [
    error ? `Bearer error="${error}"` : "Bearer",
    `resource_metadata="${base}/.well-known/oauth-protected-resource/mcp"`,
    `scope="${SCOPE}"`,
  ];
  return parts.join(", ");
}

// ── CIMD client resolution ────────────────────────────────────────────────────

interface ClientMetadata {
  client_id: string;
  client_name?: string;
  redirect_uris: string[];
}

/** Loopback redirects bind an ephemeral port at runtime, so RFC 8252 §7.3
 *  requires comparing them with the port ignored. Claude Code declares
 *  http://localhost/callback and http://127.0.0.1/callback and binds a random
 *  port, so the same port-agnostic match has to apply to `localhost` too. */
function isLoopback(u: URL): boolean {
  return u.hostname === "127.0.0.1" || u.hostname === "::1" || u.hostname === "localhost";
}

function redirectUriAllowed(requested: string, allowed: string[]): boolean {
  let want: URL;
  try { want = new URL(requested); } catch { return false; }
  return allowed.some((entry) => {
    let have: URL;
    try { have = new URL(entry); } catch { return false; }
    if (isLoopback(want) && isLoopback(have)) {
      return want.protocol === have.protocol && want.hostname === have.hostname && want.pathname === have.pathname;
    }
    return want.href === have.href;
  });
}

/** Fetch and validate a Client ID Metadata Document.
 *
 *  The document is SELF-ASSERTED — anyone can host one claiming any name — so
 *  two checks carry all the security weight: it must be self-referential (its
 *  client_id equals the URL it was served from), and its redirect_uris must be
 *  same-origin with that URL. Without the second, an attacker could host a
 *  document at their own domain pointing redirects anywhere they like. */
/** The pure half of CIMD validation — everything that doesn't need the network.
 *  Split out from the fetch so the two checks that carry the security weight
 *  can be tested directly against hostile documents, rather than inferred from
 *  a happy-path integration test. */
export function validateClientDocument(
  clientIdUrl: string,
  doc: unknown
): { client: ClientMetadata } | { error: string } {
  let url: URL;
  try { url = new URL(clientIdUrl); } catch { return { error: "client_id must be an absolute HTTPS URL" }; }

  const d = doc as ClientMetadata | null;
  if (!d || typeof d !== "object") return { error: "client_id document is not a JSON object" };

  // Self-referential: the document must claim the exact URL it was served from.
  // Without this, anyone can host a document claiming someone else's client_id.
  if (d.client_id !== url.href) return { error: "client_id document is not self-referential" };

  if (!Array.isArray(d.redirect_uris) || d.redirect_uris.length === 0) {
    return { error: "client_id document declares no redirect_uris" };
  }
  for (const entry of d.redirect_uris) {
    let r: URL;
    try { r = new URL(entry); } catch { return { error: `invalid redirect_uri: ${entry}` }; }
    if (isLoopback(r)) continue; // native clients — matched port-agnostically later
    // Same-origin: otherwise an attacker hosts a valid self-referential
    // document and points the redirect at a host they control, harvesting the
    // authorization code.
    if (r.origin !== url.origin) return { error: "redirect_uris must be same-origin with client_id" };
  }
  return { client: d };
}

export async function resolveClient(clientId: string): Promise<{ client: ClientMetadata } | { error: string }> {
  let url: URL;
  try { url = new URL(clientId); } catch { return { error: "client_id must be an absolute HTTPS URL" }; }
  if (url.protocol !== "https:") return { error: "client_id must use https" };

  let doc: unknown;
  try {
    const res = await fetch(url.href, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(CIMD_FETCH_TIMEOUT_MS),
    });
    if (!res.ok) return { error: `client_id document returned ${res.status}` };
    doc = await res.json();
  } catch (e) {
    return { error: `could not fetch client_id document: ${e instanceof Error ? e.message : e}` };
  }
  return validateClientDocument(url.href, doc);
}

/** Exposed for tests — the loopback port-agnostic redirect match. */
export { redirectUriAllowed };

// ── Consent screen ────────────────────────────────────────────────────────────

const esc = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** The consent screen names the HOST OF THE client_id URL, never client_name.
 *  client_name is self-asserted text in a document the requester controls —
 *  displaying it would let anyone render a consent screen that says
 *  "Anthropic". The host is the one part of the identity that DNS and TLS
 *  vouch for. */
/** The landing site's design tokens, and the shell every served page uses.
 *
 *  Deliberately NOT the site's font <link>: docs/ pulls Space Grotesk and Inter
 *  from Google Fonts, and this page must not. It is a consent screen, so a
 *  third-party request here would tell fonts.googleapis.com that someone is
 *  authorizing access to their memory, add a dependency the authorization flow
 *  cannot function without, and hand the page a blocking request on exactly the
 *  networks most likely to be restricted. The stacks below name the same fonts
 *  first — a machine that has them renders identically — and fall back to
 *  system faces rather than fetching anything.
 *
 *  Dark-only, like the site. The brand commits to one scheme; a consent screen
 *  that renders light while the product renders dark reads as a different
 *  application, which is the exact doubt a consent screen must not create. */
const PAGE_CSS = `
  :root {
    --bg:#0a0a0f; --bg-raised:#12121a; --bg-pill:#1a1a24;
    --text:#fafafa; --text-muted:#a1a1aa; --text-soft:#d4d4d8;
    --accent:#f59e0b; --accent-glow:rgba(245,158,11,.3);
    --border:rgba(255,255,255,.08); --border-strong:rgba(255,255,255,.15);
    --font-display:"Space Grotesk","Inter",system-ui,sans-serif;
    --font-body:"Inter",system-ui,-apple-system,sans-serif;
    --font-mono:"JetBrains Mono",ui-monospace,SFMono-Regular,Menlo,monospace;
    color-scheme: dark;
  }
  *,*::before,*::after { box-sizing:border-box; }
  body {
    margin:0; min-height:100dvh; display:grid; place-items:center; padding:24px;
    background:var(--bg); color:var(--text);
    font-family:var(--font-body); font-size:16px; line-height:1.6;
    -webkit-font-smoothing:antialiased;
    background-image:radial-gradient(circle at 50% 0%, rgba(245,158,11,.07) 0%, rgba(0,0,0,0) 60%);
  }
  .card {
    width:min(430px,100%); background:var(--bg-raised);
    border:1px solid var(--border); border-radius:16px; padding:32px;
  }
  .brand { display:flex; align-items:center; gap:10px; margin-bottom:26px; }
  .brand-mark { display:grid; grid-template-columns:repeat(3,4px); gap:3px; }
  .brand-mark i { width:4px; height:4px; border-radius:50%; background:var(--accent); display:block; }
  .brand-mark i.off { background:#3f3f46; }
  .brand-name { font-family:var(--font-display); font-size:19px; font-weight:700; letter-spacing:-.475px; }
  h1 { font-family:var(--font-display); font-size:24px; font-weight:700; letter-spacing:-.02em; line-height:1.2; margin:0 0 8px; }
  p { margin:0 0 20px; color:var(--text-muted); font-size:14.5px; }
  .host {
    font-family:var(--font-mono); font-size:13px; color:var(--text);
    background:var(--bg-pill); border:1px solid var(--border-strong);
    border-radius:6px; padding:2px 7px;
  }
  .scope {
    display:flex; gap:11px; align-items:flex-start; padding:14px 16px; font-size:14px;
    background:var(--bg-pill); border:1px solid var(--border); border-radius:11px;
    margin-bottom:22px; color:var(--text-soft);
  }
  .scope .dot { width:6px; height:6px; border-radius:50%; background:var(--accent); box-shadow:0 0 8px rgba(245,158,11,.8); flex:none; margin-top:7px; }
  label { display:block; font-size:13px; font-weight:600; margin-bottom:7px; color:var(--text-soft); }
  input[type=password] {
    width:100%; padding:12px 14px; font-size:15px; font-family:inherit;
    background:var(--bg); color:var(--text);
    border:1px solid var(--border-strong); border-radius:9px; margin-bottom:20px;
  }
  input[type=password]:focus { outline:none; border-color:var(--accent); box-shadow:0 0 0 3px rgba(245,158,11,.15); }
  .row { display:flex; gap:10px; }
  button {
    flex:1; padding:13px; font-size:15px; font-weight:600; font-family:inherit;
    border-radius:11px; border:1px solid transparent; cursor:pointer;
    transition:transform .12s, box-shadow .2s, background .2s;
  }
  .approve { background:var(--accent); color:#0a0a0f; box-shadow:0 0 40px var(--accent-glow); }
  .approve:hover { transform:translateY(-1px); box-shadow:0 0 56px rgba(245,158,11,.42); }
  .deny { background:transparent; color:var(--text); border-color:var(--border-strong); font-weight:500; }
  .deny:hover { background:rgba(255,255,255,.04); }
  .err {
    background:rgba(239,68,68,.1); border:1px solid rgba(239,68,68,.3); color:#fca5a5;
    padding:11px 14px; border-radius:9px; font-size:14px; margin-bottom:18px;
  }
  .foot { margin:22px 0 0; font-size:12.5px; color:var(--text-dim,#52525b); text-align:center; }
  @media (prefers-reduced-motion: reduce) { button { transition:none; } .approve:hover { transform:none; } }
`;

/** The 3×3 node grid the site uses as its mark — six lit, three dark. Pure CSS,
 *  so it costs no request and cannot go stale against a rasterised copy. */
const BRAND_MARK =
  `<span class="brand-mark"><i></i><i class="off"></i><i></i><i></i><i></i><i class="off"></i><i class="off"></i><i></i><i></i></span>`;

const shell = (title: string, body: string): string => `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="theme-color" content="#0a0a0f">
<meta name="robots" content="noindex,nofollow">
<title>${esc(title)}</title>
<style>${PAGE_CSS}</style></head>
<body>${body}</body></html>`;

export function consentPage(params: Record<string, string>, clientHost: string, error?: string): string {
  const hidden = Object.entries(params)
    .map(([k, v]) => `<input type="hidden" name="${esc(k)}" value="${esc(v)}">`)
    .join("");
  return shell(
    "Authorize access to your brain",
    `<form class="card" method="POST" action="/authorize">
  <div class="brand">${BRAND_MARK}<span class="brand-name">BrainLLM</span></div>
  <h1>Authorize access</h1>
  <p><span class="host">${esc(clientHost)}</span> is requesting access to your brain.</p>
  ${error ? `<div class="err">${esc(error)}</div>` : ""}
  <div class="scope"><span class="dot"></span><span>Read and write everything in your brain — memories, threads, knowledge and your diary.</span></div>
  <label for="pw">Owner password</label>
  <input id="pw" type="password" name="password" autocomplete="current-password" autofocus required>
  ${hidden}
  <div class="row">
    <button class="deny" type="submit" name="decision" value="deny">Deny</button>
    <button class="approve" type="submit" name="decision" value="approve">Authorize</button>
  </div>
  <p class="foot">Only the host above is shown, and it is the one DNS and TLS vouch for.</p>
</form>`
  );
}

// ── /authorize ────────────────────────────────────────────────────────────────

const redirectWith = (uri: string, params: Record<string, string>): Response => {
  const u = new URL(uri);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  return new Response(null, { status: 302, headers: { Location: u.href } });
};

/** The error page shares the consent screen's shell.
 *
 *  It used to be inline styles on a bare body — which meant the two pages a user
 *  can reach in this flow looked like they came from different products, and the
 *  one they hit when something has gone wrong was the unbranded one. That is
 *  backwards: an authorization error is exactly when someone should be sure what
 *  they are looking at. */
const htmlError = (message: string, status = 400): Response =>
  new Response(
    shell(
      "Authorization error",
      `<div class="card">
  <div class="brand">${BRAND_MARK}<span class="brand-name">BrainLLM</span></div>
  <h1>Authorization error</h1>
  <div class="err">${esc(message)}</div>
  <p class="foot">Nothing was authorized. Close this window and start again from your client.</p>
</div>`
    ),
    { status, headers: { "Content-Type": "text/html; charset=utf-8" } }
  );

export async function handleAuthorize(req: Request, base: string): Promise<Response> {
  const url = new URL(req.url);
  const form: { get(name: string): unknown } | null = req.method === "POST" ? await req.formData() : null;
  const get = (k: string): string =>
    (form ? (form.get(k) as string | null) : url.searchParams.get(k)) ?? "";

  const clientId = get("client_id");
  const redirectUri = get("redirect_uri");
  const responseType = get("response_type");
  const codeChallenge = get("code_challenge");
  const challengeMethod = get("code_challenge_method");
  const state = get("state");
  const resource = get("resource");
  const scope = get("scope") || SCOPE;

  if (!clientId || !redirectUri) return htmlError("Missing client_id or redirect_uri.");

  const resolved = await resolveClient(clientId);
  if ("error" in resolved) return htmlError(resolved.error);
  if (!redirectUriAllowed(redirectUri, resolved.client.redirect_uris)) {
    // Never redirect to an unvalidated URI — that is the open-redirect hole.
    return htmlError("redirect_uri is not listed in the client's metadata document.");
  }

  // From here the redirect_uri is trusted, so protocol errors go back to the
  // client as OAuth errors rather than being rendered as a dead-end page.
  const fail = (error: string, description: string): Response =>
    redirectWith(redirectUri, { error, error_description: description, iss: base, ...(state ? { state } : {}) });

  if (responseType !== "code") return fail("unsupported_response_type", "Only response_type=code is supported.");
  if (!codeChallenge || challengeMethod !== "S256") {
    return fail("invalid_request", "PKCE with code_challenge_method=S256 is required.");
  }
  if (resource && resource.replace(/\/+$/, "") !== resourceUri(base).replace(/\/+$/, "")) {
    return fail("invalid_target", `This server only issues tokens for ${resourceUri(base)}.`);
  }

  const clientHost = new URL(clientId).host;
  const carried: Record<string, string> = {
    client_id: clientId, redirect_uri: redirectUri, response_type: responseType,
    code_challenge: codeChallenge, code_challenge_method: challengeMethod, scope,
    ...(state ? { state } : {}), ...(resource ? { resource } : {}),
  };

  // GET → show the form. POST → the user answered it.
  if (!form) {
    return new Response(consentPage(carried, clientHost), {
      headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
    });
  }

  if (get("decision") !== "approve") {
    return fail("access_denied", "The owner denied the request.");
  }
  if (!ownerPasswordMatches(get("password"))) {
    return new Response(consentPage(carried, clientHost, "Incorrect password."), {
      status: 401,
      headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
    });
  }

  const store = loadStore();
  const code = randomBytes(32).toString("base64url");
  store.codes[code] = {
    clientId, redirectUri, codeChallenge, scope,
    resource: resource || resourceUri(base),
    expiresAt: Date.now() + AUTH_CODE_TTL_MS,
  };
  saveStore();

  // RFC 9207: the iss parameter lets the client detect a mix-up attack.
  return redirectWith(redirectUri, { code, iss: base, ...(state ? { state } : {}) });
}

// ── /token ────────────────────────────────────────────────────────────────────

const tokenError = (error: string, description: string, status = 400): Response =>
  new Response(JSON.stringify({ error, error_description: description }), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });

function issueTokens(base: string, clientId: string, resource: string, scope: string) {
  const store = loadStore();
  const now = Math.floor(Date.now() / 1000);
  const accessToken = signJwt(
    { iss: base, aud: resource, sub: "owner", scope, iat: now, exp: now + ACCESS_TOKEN_TTL_S },
    store.secret
  );
  const refreshToken = randomBytes(32).toString("base64url");
  store.refresh[refreshToken] = { clientId, resource, scope, expiresAt: Date.now() + REFRESH_TOKEN_TTL_MS };
  saveStore();
  return {
    access_token: accessToken,
    token_type: "Bearer",
    expires_in: ACCESS_TOKEN_TTL_S,
    refresh_token: refreshToken,
    scope,
  };
}

export async function handleToken(req: Request, base: string): Promise<Response> {
  if (req.method !== "POST") return tokenError("invalid_request", "POST required.", 405);

  // RFC 6749 §4.1.3 mandates form-urlencoded here. A JSON-only body parser
  // returning 415 is the single most common implementation bug in this flow.
  let form: { get(name: string): unknown };
  try {
    form = await req.formData();
  } catch {
    return tokenError("invalid_request", "Body must be application/x-www-form-urlencoded.");
  }
  const get = (k: string): string => ((form.get(k) as string | null) ?? "");
  const grantType = get("grant_type");
  const store = loadStore();

  if (grantType === "authorization_code") {
    const code = get("code");
    const verifier = get("code_verifier");
    const redirectUri = get("redirect_uri");
    const record = store.codes[code];

    // invalid_grant, not a custom code — clients key their retry logic on it.
    if (!record) return tokenError("invalid_grant", "Unknown or already-used authorization code.");
    delete store.codes[code]; // single use, consumed even on failure below
    saveStore();
    if (record.expiresAt < Date.now()) return tokenError("invalid_grant", "Authorization code expired.");
    if (record.redirectUri !== redirectUri) return tokenError("invalid_grant", "redirect_uri mismatch.");
    if (!verifier) return tokenError("invalid_request", "code_verifier is required.");

    const computed = createHash("sha256").update(verifier).digest("base64url");
    if (computed !== record.codeChallenge) return tokenError("invalid_grant", "PKCE verification failed.");

    return new Response(JSON.stringify(issueTokens(base, record.clientId, record.resource, record.scope)), {
      headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
    });
  }

  if (grantType === "refresh_token") {
    const supplied = get("refresh_token");
    const record = store.refresh[supplied];
    if (!record) return tokenError("invalid_grant", "Unknown or already-rotated refresh token.");
    // OAuth 2.1 requires rotation for public clients, and CIMD registers Claude
    // as one: the old token dies in the same response that issues its successor.
    delete store.refresh[supplied];
    saveStore();
    if (record.expiresAt < Date.now()) return tokenError("invalid_grant", "Refresh token expired.");

    return new Response(JSON.stringify(issueTokens(base, record.clientId, record.resource, record.scope)), {
      headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
    });
  }

  return tokenError("unsupported_grant_type", `grant_type "${grantType}" is not supported.`);
}

// ── Resource-server token validation ──────────────────────────────────────────

/** Validate a bearer presented to /mcp. Audience binding is the point: a token
 *  minted for another resource must not work here, per RFC 8707. */
export function validateAccessToken(token: string, base: string): boolean {
  const claims = verifyJwt(token, signingSecret());
  if (!claims) return false;
  if (claims.iss !== base) return false;
  const want = resourceUri(base).replace(/\/+$/, "");
  return claims.aud.replace(/\/+$/, "") === want;
}
