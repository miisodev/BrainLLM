// ─────────────────────────────────────────────────────────────────────────────
// BrainLLM — OAuth 2.1 authorization server (V10)
//
// BrainLLM is both the MCP resource server and its own authorization server.
// The alternative — delegating to an external IdP — would mean every forker
// signs up for a third-party service before their brain works, which defeats
// the point of a self-hosted memory.
//
// Two client mechanisms are served, deliberately:
//
// 1. Client ID Metadata Documents (CIMD): the client_id IS an HTTPS URL that
//    dereferences to the client's own OAuth registration metadata. No client
//    database. MCP's 2026-07-28 revision deprecates Dynamic Client Registration
//    in favour of exactly this, and Claude only selects CIMD when the
//    authorization-server metadata advertises BOTH
//    `client_id_metadata_document_supported: true` AND `"none"` in
//    `token_endpoint_auth_methods_supported` — the second because Claude's CIMD
//    client authenticates as a public client, so the token endpoint must accept
//    PKCE-only requests with no client secret. Miss either and Claude silently
//    falls back to hunting for a registration_endpoint and the connection fails.
//
// 2. RFC 7591 Dynamic Client Registration at /register — for clients that never
//    grew CIMD support. opencode (MCP TS SDK ≤1.29) is the forcing case: its
//    auth flow reads registration_endpoint, POSTs its client metadata, and on a
//    missing endpoint reports "does not support dynamic client registration"
//    and refuses pre-flight. A registered client is stored server-side as a
//    first-class record; /authorize resolves it by id BEFORE attempting a CIMD
//    fetch, since an opaque reg_ id is not dereferenceable. Open registration is
//    safe here for the same reason it is anywhere: registration grants nothing —
//    the owner password on the consent screen is still what authorizes access,
//    and redirect_uris are validated with the same rules CIMD applies.
//
// Everything here sits ABOVE the MCP transport: it gates the HTTP request
// before the JSON-RPC body reaches the SDK, because the refusal has to be a
// transport-level 401. A 200 wrapping an error is an application-level tool
// failure and produces no auth prompt at all.
// ─────────────────────────────────────────────────────────────────────────────

import { createHmac, randomBytes, createHash, timingSafeEqual } from "crypto";
import { existsSync, readFileSync, statSync, writeFileSync } from "fs";
import { configFilePath } from "./config.js";
import { fetchPublicJson } from "./network-security.js";

// ── Constants ─────────────────────────────────────────────────────────────────

/** The single scope. A brain is not meaningfully divisible into read/write
 *  halves — a session that can recall but not remember is not the product —
 *  so scope minimisation here means one scope, not a taxonomy nobody reads. */
export const SCOPE = "brain";

const AUTH_CODE_TTL_MS = 10 * 60 * 1000;        // 10 min — codes are single-use
const ACCESS_TOKEN_TTL_S = 60 * 60;             // 1 hour
const REFRESH_TOKEN_TTL_MS = 90 * 24 * 60 * 60 * 1000;
/** The consent page and its password form are one short browser transaction.
 *  Five minutes is enough to read the screen, enter the password, and retry a
 *  typo without turning a public, client-supplied redirect URI into a durable
 *  bearer credential. */
const CONSENT_TRANSACTION_TTL_S = 5 * 60;
/** Claude allows 10s for discovery/authorize/token. Fetching the client's CIMD
 *  happens inside that budget, so it gets a fraction of it. */
const CIMD_FETCH_TIMEOUT_MS = 5000;
/** OAuth metadata and forms are small by definition. Keep anonymous endpoints
 *  from consuming the 50 MB MCP request budget just by posting a giant body. */
export const MAX_OAUTH_BODY_BYTES = 64 * 1024;
const MAX_CIMD_DOCUMENT_BYTES = 64 * 1024;
const MAX_REDIRECT_URIS = 5;
const MAX_REDIRECT_URI_LENGTH = 2048;
const MAX_CLIENT_NAME_LENGTH = 200;
const MAX_OAUTH_STORE_BYTES = 4 * 1024 * 1024;

class BodyTooLargeError extends Error {
  constructor() { super("request body exceeds the OAuth size limit"); }
}

async function readLimitedBody(body: ReadableStream<Uint8Array> | null, maxBytes: number): Promise<Uint8Array> {
  if (!body) return new Uint8Array(0);
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      total += part.value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        throw new BodyTooLargeError();
      }
      chunks.push(part.value);
    }
  } finally {
    reader.releaseLock();
  }
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.byteLength; }
  return result;
}

async function readFormBody(req: Request): Promise<URLSearchParams> {
  return new URLSearchParams(new TextDecoder().decode(await readLimitedBody(req.body, MAX_OAUTH_BODY_BYTES)));
}

const bodyLimitResponse = (format: "json" | "html" = "json"): Response => {
  if (format === "html") return htmlError("The request body is too large.", 413);
  return new Response(JSON.stringify({ error: "request_too_large", error_description: "Request body exceeds 64 KiB." }), {
    status: 413,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
};

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
function signSignedClaims(claims: object & { exp: number }, secret: string): string {
  const header = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const payload = b64url(JSON.stringify(claims));
  const sig = b64url(createHmac("sha256", secret).update(`${header}.${payload}`).digest());
  return `${header}.${payload}.${sig}`;
}

function signJwt(claims: AccessClaims, secret: string): string {
  return signSignedClaims(claims, secret);
}

function verifySignedClaims(token: string, secret: string): Record<string, unknown> | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [header, payload, sig] = parts;
  const expected = b64url(createHmac("sha256", secret).update(`${header}.${payload}`).digest());
  // Constant-time compare — a fast-fail string === leaks signature bytes.
  if (sig.length !== expected.length) return null;
  if (!timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  try {
    const claims = JSON.parse(b64urlDecode(payload).toString("utf8")) as Record<string, unknown>;
    if (typeof claims.exp !== "number" || claims.exp * 1000 < Date.now()) return null;
    return claims;
  } catch {
    return null;
  }
}

export function verifyJwt(token: string, secret: string): AccessClaims | null {
  const claims = verifySignedClaims(token, secret);
  if (!claims ||
      typeof claims.iss !== "string" ||
      typeof claims.aud !== "string" ||
      typeof claims.sub !== "string" ||
      typeof claims.scope !== "string" ||
      typeof claims.iat !== "number") return null;
  return claims as unknown as AccessClaims;
}

interface AuthorizationRequest {
  clientId: string;
  clientName?: string;
  redirectUri: string;
  responseType: string;
  codeChallenge: string;
  challengeMethod: string;
  state: string;
  resource: string;
  scope: string;
}

interface AuthorizationTransaction extends AuthorizationRequest {
  kind: "authorization-consent";
  iss: string;
  iat: number;
  exp: number;
}

/** Bind the already-validated OAuth request to this issuer for the life of the
 *  consent form. The browser gets one opaque signed value instead of editable
 *  copies of client_id, redirect_uri, PKCE, resource, scope and state. POST can
 *  therefore trust the transaction without fetching the client's metadata a
 *  second time — a remote WAF or outage cannot strand a form the owner already
 *  reviewed, and a tampered hidden redirect can never become a Location header. */
function issueConsentTransaction(request: AuthorizationRequest, base: string): string {
  const now = Math.floor(Date.now() / 1000);
  const transaction: AuthorizationTransaction = {
    kind: "authorization-consent",
    iss: base,
    iat: now,
    exp: now + CONSENT_TRANSACTION_TTL_S,
    ...request,
  };
  return signSignedClaims(transaction, signingSecret());
}

function verifyConsentTransaction(ticket: string, base: string): AuthorizationRequest | null {
  const claims = verifySignedClaims(ticket, signingSecret());
  if (!claims ||
      claims.kind !== "authorization-consent" ||
      claims.iss !== base ||
      typeof claims.clientId !== "string" ||
      (claims.clientName !== undefined && typeof claims.clientName !== "string") ||
      typeof claims.redirectUri !== "string" ||
      typeof claims.responseType !== "string" ||
      typeof claims.codeChallenge !== "string" ||
      typeof claims.challengeMethod !== "string" ||
      typeof claims.state !== "string" ||
      typeof claims.resource !== "string" ||
      typeof claims.scope !== "string") return null;

  let redirect: URL;
  try { redirect = new URL(claims.redirectUri); } catch { return null; }
  if (redirect.protocol !== "http:" && redirect.protocol !== "https:") return null;
  if (claims.responseType !== "code" || claims.challengeMethod !== "S256" || !claims.codeChallenge) return null;
  if (claims.resource.replace(/\/+$/, "") !== resourceUri(base).replace(/\/+$/, "")) return null;

  return {
    clientId: claims.clientId,
    ...(typeof claims.clientName === "string" ? { clientName: claims.clientName } : {}),
    redirectUri: claims.redirectUri,
    responseType: claims.responseType,
    codeChallenge: claims.codeChallenge,
    challengeMethod: claims.challengeMethod,
    state: claims.state,
    resource: claims.resource,
    scope: claims.scope,
  };
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

/** A client registered through /register (RFC 7591). The redirect_uris are the
 *  whole security story — /authorize checks the incoming redirect_uri against
 *  exactly this list, so they carry the same weight as a CIMD document's. */
export interface RegisteredClient {
  redirectUris: string[];
  clientName?: string;
  issuedAt: number;
}

/** Registration is unauthenticated by design, so the store needs a ceiling —
 *  an anonymous loop could otherwise grow the file without bound. Oldest
 *  registration is evicted first; re-registering is free, so eviction costs a
 *  client one round-trip, never its authorization. */
const MAX_REGISTERED_CLIENTS = 200;

interface OAuthStore {
  secret: string;
  codes: Record<string, AuthCode>;
  refresh: Record<string, RefreshRecord>;
  clients?: Record<string, RegisteredClient>;
}

function storePath(): string {
  return configFilePath().replace(/\.json$/, "") + ".oauth.json";
}

let cache: OAuthStore | null = null;

function loadStore(): OAuthStore {
  if (cache) return cache;
  const path = storePath();
  try {
    if (existsSync(path) && statSync(path).size <= MAX_OAUTH_STORE_BYTES) {
      const parsed = JSON.parse(readFileSync(path, "utf-8")) as Partial<OAuthStore>;
      if (typeof parsed.secret === "string" && parsed.secret) {
        cache = { secret: parsed.secret, codes: parsed.codes ?? {}, refresh: parsed.refresh ?? {}, clients: parsed.clients ?? {} };
        return cache;
      }
    }
  } catch { /* fall through to a fresh store */ }
  cache = { secret: randomBytes(32).toString("hex"), codes: {}, refresh: {}, clients: {} };
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
  while (Object.keys(cache.codes).length > 1_000) {
    const oldest = Object.entries(cache.codes).sort((a, b) => a[1].expiresAt - b[1].expiresAt)[0]?.[0];
    if (!oldest) break;
    delete cache.codes[oldest];
  }
  while (Object.keys(cache.refresh).length > 1_000) {
    const oldest = Object.entries(cache.refresh).sort((a, b) => a[1].expiresAt - b[1].expiresAt)[0]?.[0];
    if (!oldest) break;
    delete cache.refresh[oldest];
  }
  // Enforce the registration ceiling — evict oldest first.
  const regs = Object.entries(cache.clients ?? {});
  if (regs.length > MAX_REGISTERED_CLIENTS) {
    regs.sort(([, a], [, b]) => a.issuedAt - b.issuedAt);
    for (const [k] of regs.slice(0, regs.length - MAX_REGISTERED_CLIENTS)) delete cache.clients![k];
  }
  let serialized = JSON.stringify(cache);
  if (Buffer.byteLength(serialized) > MAX_OAUTH_STORE_BYTES) {
    // A bounded registration request still leaves a hard ceiling for a corrupted
    // or manually edited store. Evict oldest clients before refusing to grow.
    for (const [key] of Object.entries(cache.clients ?? {}).sort((a, b) => a[1].issuedAt - b[1].issuedAt)) {
      delete cache.clients![key];
      serialized = JSON.stringify(cache);
      if (Buffer.byteLength(serialized) <= MAX_OAUTH_STORE_BYTES) break;
    }
  }
  if (Buffer.byteLength(serialized) > MAX_OAUTH_STORE_BYTES) return;
  try {
    writeFileSync(storePath(), serialized, { mode: 0o600 });
  } catch { /* non-fatal: tokens still work until restart */ }
}

/** The HMAC secret used to sign access tokens. Persisted so a redeploy doesn't
 *  invalidate every issued token. */
export function signingSecret(): string {
  const configured = process.env.BRAINLLM_OAUTH_SECRET?.trim();
  if (configured) {
    if (configured.length < 32) throw new Error("BRAINLLM_OAUTH_SECRET must be at least 32 characters");
    return configured;
  }
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
  const trustProxy = process.env.BRAINLLM_TRUST_PROXY === "true";
  const host = (trustProxy ? req.headers.get("x-forwarded-host") : null) ?? req.headers.get("host") ?? url.host;
  const proto = (trustProxy ? req.headers.get("x-forwarded-proto") : null) ?? (host.startsWith("localhost") ? "http" : "https");
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
    // Registration endpoint for clients without CIMD support (opencode, MCP TS
    // SDK ≤1.29). Its presence does not disturb Claude's CIMD selection — Claude
    // prefers CIMD when the two properties above are set, regardless.
    registration_endpoint: `${base}/register`,
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

/** Claude's hosted connector has a fixed client identifier and callback, but
 *  its metadata URL currently sits behind a browser-oriented WAF that returns
 *  403/404 to conforming server-side CIMD fetchers. Treating this one exact
 *  identifier as pre-registered is both narrower and more reliable than
 *  weakening SSRF protection or impersonating a browser. The owner password is
 *  still required, and the redirect remains the exact Anthropic callback. */
const PRE_REGISTERED_CLIENTS: Record<string, ClientMetadata> = {
  "https://claude.ai/oauth/client-metadata": {
    client_id: "https://claude.ai/oauth/client-metadata",
    redirect_uris: ["https://claude.ai/api/mcp/auth_callback"],
  },
};

/** Loopback redirects bind an ephemeral port at runtime, so RFC 8252 §7.3
 *  requires comparing them with the port ignored. Claude Code declares
 *  http://localhost/callback and http://127.0.0.1/callback and binds a random
 *  port, so the same port-agnostic match has to apply to `localhost` too. */
function isLoopback(u: URL): boolean {
  return (u.protocol === "http:" || u.protocol === "https:") &&
    (u.hostname === "127.0.0.1" || u.hostname === "::1" || u.hostname === "localhost");
}

function redirectUriAllowed(requested: string, allowed: string[]): boolean {
  let want: URL;
  try { want = new URL(requested); } catch { return false; }
  if (want.protocol !== "http:" && want.protocol !== "https:") return false;
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
  if (typeof d.client_name === "string" && d.client_name.length > MAX_CLIENT_NAME_LENGTH) {
    return { error: "client_name is too long" };
  }

  // Self-referential: the document must claim the exact URL it was served from.
  // Without this, anyone can host a document claiming someone else's client_id.
  if (d.client_id !== url.href) return { error: "client_id document is not self-referential" };

  if (!Array.isArray(d.redirect_uris) || d.redirect_uris.length === 0) {
    return { error: "client_id document declares no redirect_uris" };
  }
  if (d.redirect_uris.length > MAX_REDIRECT_URIS) {
    return { error: `client_id document may list at most ${MAX_REDIRECT_URIS} redirect_uris` };
  }
  for (const entry of d.redirect_uris) {
    if (typeof entry !== "string" || entry.length > MAX_REDIRECT_URI_LENGTH) {
      return { error: "client_id document contains an invalid redirect_uri length" };
    }
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
  // A /register-issued id resolves locally and is not a URL — check the
  // registry before the CIMD fetch, which would reject it as non-HTTPS.
  const registered = loadStore().clients?.[clientId];
  if (registered) {
    return {
      client: {
        client_id: clientId,
        client_name: registered.clientName,
        redirect_uris: registered.redirectUris,
      },
    };
  }

  const preRegistered = PRE_REGISTERED_CLIENTS[clientId];
  if (preRegistered) {
    return { client: { ...preRegistered, redirect_uris: [...preRegistered.redirect_uris] } };
  }

  let url: URL;
  try { url = new URL(clientId); } catch { return { error: "client_id must be an absolute HTTPS URL" }; }
  if (url.protocol !== "https:") return { error: "client_id must use https" };

  let doc: unknown;
  try {
    // The client controls this URL, so it is an outbound request from the
    // authorization server. Resolve and reject non-public destinations, bound
    // the response, and re-check every redirect before following it.
    doc = await fetchPublicJson(url.href, MAX_CIMD_DOCUMENT_BYTES, CIMD_FETCH_TIMEOUT_MS);
  } catch (e) {
    return { error: `could not fetch client_id document: ${e instanceof Error ? e.message : e}` };
  }
  return validateClientDocument(url.href, doc);
}

/** Exposed for tests — the loopback port-agnostic redirect match. */
export { redirectUriAllowed };

// ── /register (RFC 7591) ──────────────────────────────────────────────────────

/** The pure half of registration validation. The rules mirror CIMD's: loopback
 *  http is allowed (native clients bind an ephemeral port at runtime), anything
 *  else must be https. There is no same-origin check here because there is no
 *  self-hosted document to be same-origin WITH — the consent screen's owner
 *  password carries that weight instead. */
export function validateRegistration(body: unknown): { redirectUris: string[]; clientName?: string } | { error: string } {
  if (!body || typeof body !== "object") return { error: "registration request is not a JSON object" };
  const b = body as Record<string, unknown>;

  const rawUris = b.redirect_uris;
  if (!Array.isArray(rawUris) || rawUris.length === 0) {
    return { error: "redirect_uris must be a non-empty array" };
  }
  if (rawUris.length > MAX_REDIRECT_URIS) {
    return { error: `redirect_uris may list at most ${MAX_REDIRECT_URIS} entries` };
  }
  for (const entry of rawUris) {
    if (typeof entry !== "string" || entry.length > MAX_REDIRECT_URI_LENGTH) {
      return { error: "redirect_uris must contain short strings" };
    }
    let r: URL;
    try { r = new URL(entry); } catch { return { error: `invalid redirect_uri: ${entry}` }; }
    if (isLoopback(r)) continue;
    if (r.protocol !== "https:") return { error: "non-loopback redirect_uris must use https" };
  }

  const clientName = typeof b.client_name === "string" ? b.client_name : undefined;
  if (clientName && clientName.length > MAX_CLIENT_NAME_LENGTH) return { error: "client_name is too long" };
  return { redirectUris: rawUris.map((u) => String(u)), ...(clientName ? { clientName } : {}) };
}

export async function handleRegister(req: Request): Promise<Response> {
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "invalid_request", error_description: "POST required." }), {
      status: 405,
      headers: { "Content-Type": "application/json", "Allow": "POST", "Cache-Control": "no-store" },
    });
  }

  let body: unknown;
  try {
    const bytes = await readLimitedBody(req.body, MAX_OAUTH_BODY_BYTES);
    body = JSON.parse(new TextDecoder().decode(bytes));
  } catch (error) {
    if (error instanceof BodyTooLargeError) return bodyLimitResponse();
    return new Response(JSON.stringify({ error: "invalid_client_metadata", error_description: "Body must be JSON." }), {
      status: 400,
      headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
    });
  }

  const validated = validateRegistration(body);
  if ("error" in validated) {
    return new Response(JSON.stringify({ error: "invalid_redirect_uri", error_description: validated.error }), {
      status: 400,
      headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
    });
  }

  // Public clients only — this server has no client-secret store and the token
  // endpoint authenticates nobody but the PKCE proof.
  const clientId = `reg_${randomBytes(12).toString("hex")}`;
  const store = loadStore();
  store.clients = store.clients ?? {};
  store.clients[clientId] = {
    redirectUris: validated.redirectUris,
    ...(validated.clientName ? { clientName: validated.clientName } : {}),
    issuedAt: Date.now(),
  };
  saveStore();

  // OAuthClientInformationFull — the MCP TS SDK Zod-parses exactly this shape
  // and refuses anything without client_id + redirect_uris.
  return new Response(JSON.stringify({
    client_id: clientId,
    client_id_issued_at: Math.floor(Date.now() / 1000),
    client_name: validated.clientName,
    redirect_uris: validated.redirectUris,
    token_endpoint_auth_method: "none",
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    scope: SCOPE,
  }), {
    status: 201,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

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

/** The page a human (or a probing client) gets at the server root. A bare 404
 *  on / reads as "nothing is here"; this names what is here, the endpoint to
 *  point a client at, and what authentication expects — with the consent
 *  screen's no-external-request policy, for the same reasons. */
export function landingPage(base: string, oauthOn: boolean, sseOn: boolean): string {
  return shell(
    "BrainLLM — a persistent memory server",
    `<div class="card">
  <div class="brand">${BRAND_MARK}<span class="brand-name">BrainLLM</span></div>
  <h1>A brain is listening</h1>
  <p>This is a <strong>BrainLLM</strong> MCP memory server — a persistent, graph-structured second brain served over the Model Context Protocol.</p>
  <p>Point an MCP client at <span class="host">${esc(base)}/mcp</span>${sseOn ? ` — or, for clients that only speak the legacy SSE transport, <span class="host">${esc(base)}/sse</span>` : ""}.</p>
  <p>${oauthOn
    ? `Authentication: OAuth 2.1 with owner consent, or a static bearer token (<span class="host">MCP_AUTH_TOKEN</span>). Both work against the same brain.`
    : `Authentication: a static bearer token (<span class="host">MCP_AUTH_TOKEN</span>).`}</p>
  <p class="foot">Health: <span class="host">/health</span> · Everything else is MCP.</p>
</div>`
  );
}

const PAGE_SECURITY_DIRECTIVES = "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; img-src 'self' data:";

/** The consent page is unusual: the form posts to this origin, but the response
 *  redirects to the OAuth client's already-validated callback. Chrome and Safari
 *  enforce form-action across that redirect chain, so `form-action 'self'` alone
 *  blocks the callback and leaves the owner staring on a page whose server did
 *  return 302. Add only the exact validated callback origin, never a scheme-wide
 *  grant or a client-supplied string. */
function pageContentSecurityPolicy(redirectUri?: string): string {
  let formAction = "'self'";
  if (redirectUri) {
    const origin = new URL(redirectUri).origin;
    if (origin !== "null") formAction += ` ${origin}`;
  }
  return `${PAGE_SECURITY_DIRECTIVES}; form-action ${formAction}; style-src 'unsafe-inline'`;
}

function consentResponse(
  transaction: string,
  redirectUri: string,
  clientHost: string,
  verifiedHost: boolean,
  error?: string,
  status = 200
): Response {
  return new Response(consentPage({ transaction }, clientHost, error, verifiedHost), {
    status,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "Content-Security-Policy": pageContentSecurityPolicy(redirectUri),
    },
  });
}

export function consentPage(params: Record<string, string>, clientHost: string, error?: string, verifiedHost = true): string {
  const hidden = Object.entries(params)
    .map(([k, v]) => `<input type="hidden" name="${esc(k)}" value="${esc(v)}">`)
    .join("");
  // A CIMD client is identified by its URL host, which DNS and TLS vouch for.
  // A /register client has no URL — only a name it chose itself — so the footer
  // must say so rather than imply a verification that did not happen. The owner
  // password is the authorization either way; this line only says what the
  // label above can be trusted for.
  const foot = verifiedHost
    ? "Only the host above is shown, and it is the one DNS and TLS vouch for."
    : "The name above is self-reported by the application — your password is what authorizes access.";
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
  <p class="foot">${foot}</p>
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
    {
      status,
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Content-Security-Policy": pageContentSecurityPolicy(),
      },
    }
  );

export async function handleAuthorize(req: Request, base: string): Promise<Response> {
  const url = new URL(req.url);
  let form: URLSearchParams | null = null;
  if (req.method === "POST") {
    try {
      form = await readFormBody(req);
    } catch (error) {
      if (error instanceof BodyTooLargeError) return bodyLimitResponse("html");
      return htmlError("The authorization form could not be read.", 400);
    }
  }

  let request: AuthorizationRequest;
  let transaction: string;

  if (form) {
    // POST trusts only the server-signed transaction rendered by the GET. Never
    // read a redirect_uri or PKCE value from an editable hidden field here.
    transaction = form.get("transaction") ?? "";
    const verified = verifyConsentTransaction(transaction, base);
    if (!verified) {
      return htmlError("This authorization request expired or was altered. Start again from your client.");
    }
    request = verified;
  } else {
    const get = (k: string): string => url.searchParams.get(k) ?? "";
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

    request = {
      clientId,
      ...(resolved.client.client_name ? { clientName: resolved.client.client_name } : {}),
      redirectUri,
      responseType,
      codeChallenge,
      challengeMethod,
      state,
      resource: resource || resourceUri(base),
      scope,
    };
    transaction = issueConsentTransaction(request, base);
  }

  const { clientId, redirectUri, codeChallenge, state, resource, scope } = request;

  // From here the redirect_uri came from a validated client document on GET, or
  // from the HMAC-signed transaction on POST. Protocol errors can safely return
  // to that exact client callback.
  const fail = (error: string, description: string): Response =>
    redirectWith(redirectUri, { error, error_description: description, iss: base, ...(state ? { state } : {}) });

  // CIMD clients identify as a URL — its host is what the consent screen
  // shows, because DNS and TLS vouch for it. A /register client_id is an
  // opaque reg_ string, so parsing it as a URL throws; fall back to the
  // client's registered name and let the page label it as self-reported.
  let clientHost: string;
  let verifiedHost = true;
  try {
    clientHost = new URL(clientId).host;
  } catch {
    verifiedHost = false;
    clientHost = request.clientName ?? "a dynamically registered client";
  }

  // GET → issue the consent transaction and show the form. POST → consume it.
  if (!form) {
    return consentResponse(transaction, redirectUri, clientHost, verifiedHost);
  }

  if (form.get("decision") !== "approve") {
    return fail("access_denied", "The owner denied the request.");
  }
  if (!ownerPasswordMatches(form.get("password") ?? "")) {
    return consentResponse(transaction, redirectUri, clientHost, verifiedHost, "Incorrect password.", 401);
  }

  const store = loadStore();
  const code = randomBytes(32).toString("base64url");
  store.codes[code] = {
    clientId, redirectUri, codeChallenge, scope,
    resource,
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
  let form: URLSearchParams;
  try {
    form = await readFormBody(req);
  } catch (error) {
    if (error instanceof BodyTooLargeError) return bodyLimitResponse();
    return tokenError("invalid_request", "Body must be application/x-www-form-urlencoded.");
  }
  const get = (k: string): string => form.get(k) ?? "";
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
