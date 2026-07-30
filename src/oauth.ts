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
function consentPage(params: Record<string, string>, clientHost: string, error?: string): string {
  const hidden = Object.entries(params)
    .map(([k, v]) => `<input type="hidden" name="${esc(k)}" value="${esc(v)}">`)
    .join("");
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Authorize access to your brain</title>
<style>
  :root { color-scheme: light dark; }
  body { font: 16px/1.55 ui-sans-serif, system-ui, -apple-system, sans-serif; margin: 0;
         min-height: 100dvh; display: grid; place-items: center; padding: 24px;
         background: #faf9f7; color: #1a1a1a; }
  @media (prefers-color-scheme: dark) { body { background: #16151a; color: #ececf1; } }
  .card { width: min(420px, 100%); background: light-dark(#fff, #1f1e26); border-radius: 14px;
          padding: 28px; box-shadow: 0 1px 2px rgba(0,0,0,.06), 0 8px 24px rgba(0,0,0,.08); }
  h1 { font-size: 19px; margin: 0 0 6px; letter-spacing: -0.01em; }
  p { margin: 0 0 18px; color: light-dark(#5c5a66, #a5a3b0); font-size: 14.5px; }
  .host { font-weight: 600; color: light-dark(#1a1a1a, #ececf1); }
  .scope { display: flex; gap: 10px; align-items: flex-start; padding: 12px 14px; font-size: 14px;
           background: light-dark(#f4f3f0, #26252e); border-radius: 9px; margin-bottom: 18px; }
  label { display: block; font-size: 13px; font-weight: 600; margin-bottom: 6px; }
  input[type=password] { width: 100%; box-sizing: border-box; padding: 10px 12px; font-size: 15px;
    border: 1px solid light-dark(#dcdae2, #3a3945); border-radius: 8px; margin-bottom: 16px;
    background: light-dark(#fff, #16151a); color: inherit; }
  .row { display: flex; gap: 10px; }
  button { flex: 1; padding: 11px; font-size: 15px; font-weight: 600; border-radius: 8px;
           border: 1px solid transparent; cursor: pointer; font-family: inherit; }
  .approve { background: #6d28d9; color: #fff; }
  .deny { background: transparent; border-color: light-dark(#dcdae2, #3a3945); color: inherit; }
  .err { background: #fee2e2; color: #991b1b; padding: 10px 12px; border-radius: 8px;
         font-size: 14px; margin-bottom: 16px; }
  @media (prefers-color-scheme: dark) { .err { background: #45161a; color: #fca5a5; } }
</style></head>
<body><form class="card" method="POST" action="/authorize">
  <h1>Authorize access to your brain</h1>
  <p><span class="host">${esc(clientHost)}</span> is requesting access to your BrainLLM memory.</p>
  ${error ? `<div class="err">${esc(error)}</div>` : ""}
  <div class="scope"><span>🧠</span><span>Read and write everything in your brain — memories, threads, knowledge and your diary.</span></div>
  <label for="pw">Owner password</label>
  <input id="pw" type="password" name="password" autocomplete="current-password" autofocus required>
  ${hidden}
  <div class="row">
    <button class="deny" type="submit" name="decision" value="deny">Deny</button>
    <button class="approve" type="submit" name="decision" value="approve">Authorize</button>
  </div>
</form></body></html>`;
}

// ── /authorize ────────────────────────────────────────────────────────────────

const redirectWith = (uri: string, params: Record<string, string>): Response => {
  const u = new URL(uri);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  return new Response(null, { status: 302, headers: { Location: u.href } });
};

const htmlError = (message: string, status = 400): Response =>
  new Response(
    `<!doctype html><meta charset="utf-8"><title>Authorization error</title>` +
    `<body style="font:16px/1.6 ui-sans-serif,system-ui,sans-serif;max-width:34rem;margin:12vh auto;padding:0 24px">` +
    `<h1 style="font-size:19px">Authorization error</h1><p>${esc(message)}</p></body>`,
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
