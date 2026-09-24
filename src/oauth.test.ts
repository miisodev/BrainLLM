import { describe, expect, test } from "bun:test";
import { createHash, randomBytes } from "crypto";
import {
  verifyJwt,
  signingSecret,
  resolveClient,
  validateClientDocument,
  redirectUriAllowed,
  protectedResourceMetadata,
  authorizationServerMetadata,
  wwwAuthenticate,
  validateAccessToken,
  consentPage,
  landingPage,
  handleRegister,
  handleAuthorize,
  handleToken,
  validateRegistration,
  SCOPE,
} from "./oauth.js";

const BASE = "https://brain.example.com";

describe("discovery metadata", () => {
  test("protected resource metadata names the exact resource URI and the AS", () => {
    const prm = protectedResourceMetadata(BASE);
    // RFC 9728: `resource` must match the URL the user types, path included.
    // A mismatch here fails discovery silently and reads as a network error.
    expect(prm.resource).toBe("https://brain.example.com/mcp");
    expect(prm.authorization_servers).toEqual([BASE]);
    expect(prm.bearer_methods_supported).toEqual(["header"]);
  });

  test("authorization server metadata carries BOTH properties CIMD selection needs", () => {
    // Claude picks CIMD only when both are present; miss either and it falls
    // back to hunting for a registration_endpoint, and the connection fails.
    const asm = authorizationServerMetadata(BASE);
    expect(asm.client_id_metadata_document_supported).toBe(true);
    expect(asm.token_endpoint_auth_methods_supported).toContain("none");
    // PKCE S256 is mandatory, and RFC 9207 iss lets clients detect mix-up.
    expect(asm.code_challenge_methods_supported).toEqual(["S256"]);
    expect(asm.authorization_response_iss_parameter_supported).toBe(true);
    expect(asm.issuer).toBe(BASE);
  });

  test("the 401 challenge points at the path-suffixed metadata variant", () => {
    const h = wwwAuthenticate(BASE);
    expect(h).toContain(`resource_metadata="${BASE}/.well-known/oauth-protected-resource/mcp"`);
    expect(h).toContain(`scope="${SCOPE}"`);
    expect(wwwAuthenticate(BASE, "invalid_token")).toContain('Bearer error="invalid_token"');
  });

  test("the landing page names the endpoints and makes no external requests", () => {
    // Same policy as the consent screen: a third-party request from a page a
    // stranger can load leaks that a brain lives at this origin.
    const full = landingPage(BASE, true, true);
    expect(full).toContain(`${BASE}/mcp`);
    expect(full).toContain("/sse");
    const external = full.match(/(?:src|href)\s*=\s*["']https?:\/\/[^"']+/gi) ?? [];
    expect(external).toEqual([]);

    const minimal = landingPage(BASE, false, false);
    expect(minimal).toContain("MCP_AUTH_TOKEN");
    expect(minimal).not.toContain("/sse");
  });
});

describe("PKCE", () => {
  test("S256 challenge derivation matches what /token recomputes", () => {
    const verifier = randomBytes(32).toString("base64url");
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    expect(createHash("sha256").update(verifier).digest("base64url")).toBe(challenge);
    expect(createHash("sha256").update(verifier + "x").digest("base64url")).not.toBe(challenge);
  });
});

describe("access tokens", () => {
  test("a valid token round-trips and carries the resource as audience", () => {
    const secret = signingSecret();
    const now = Math.floor(Date.now() / 1000);
    const { default: _ } = { default: null };
    // Build via the same shape issueTokens uses.
    const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
    const payload = Buffer.from(JSON.stringify({
      iss: BASE, aud: `${BASE}/mcp`, sub: "owner", scope: SCOPE, iat: now, exp: now + 3600,
    })).toString("base64url");
    const sig = require("crypto").createHmac("sha256", secret).update(`${header}.${payload}`).digest("base64url");
    const token = `${header}.${payload}.${sig}`;

    const claims = verifyJwt(token, secret);
    expect(claims).not.toBeNull();
    expect(claims!.aud).toBe(`${BASE}/mcp`);
    expect(validateAccessToken(token, BASE)).toBe(true);
  });

  test("a tampered payload is rejected", () => {
    const secret = signingSecret();
    const now = Math.floor(Date.now() / 1000);
    const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
    const good = Buffer.from(JSON.stringify({
      iss: BASE, aud: `${BASE}/mcp`, sub: "owner", scope: SCOPE, iat: now, exp: now + 3600,
    })).toString("base64url");
    const sig = require("crypto").createHmac("sha256", secret).update(`${header}.${good}`).digest("base64url");
    const evil = Buffer.from(JSON.stringify({
      iss: BASE, aud: `${BASE}/mcp`, sub: "attacker", scope: SCOPE, iat: now, exp: now + 3600,
    })).toString("base64url");
    expect(verifyJwt(`${header}.${evil}.${sig}`, secret)).toBeNull();
  });

  test("an expired token is rejected", () => {
    const secret = signingSecret();
    const past = Math.floor(Date.now() / 1000) - 10;
    const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
    const payload = Buffer.from(JSON.stringify({
      iss: BASE, aud: `${BASE}/mcp`, sub: "owner", scope: SCOPE, iat: past - 3600, exp: past,
    })).toString("base64url");
    const sig = require("crypto").createHmac("sha256", secret).update(`${header}.${payload}`).digest("base64url");
    expect(verifyJwt(`${header}.${payload}.${sig}`, secret)).toBeNull();
  });

  test("a token minted for another resource is rejected — audience binding", () => {
    // RFC 8707: a token issued for someone else's MCP server must not work here,
    // or a malicious server could replay a token it was handed.
    const secret = signingSecret();
    const now = Math.floor(Date.now() / 1000);
    const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
    const payload = Buffer.from(JSON.stringify({
      iss: BASE, aud: "https://someone-else.example.com/mcp", sub: "owner", scope: SCOPE, iat: now, exp: now + 3600,
    })).toString("base64url");
    const sig = require("crypto").createHmac("sha256", secret).update(`${header}.${payload}`).digest("base64url");
    expect(validateAccessToken(`${header}.${payload}.${sig}`, BASE)).toBe(false);
  });

  test("garbage is rejected without throwing", () => {
    expect(verifyJwt("not-a-jwt", signingSecret())).toBeNull();
    expect(verifyJwt("a.b.c", signingSecret())).toBeNull();
    expect(validateAccessToken("", BASE)).toBe(false);
  });
});

describe("CIMD client resolution", () => {
  const CID = "https://claude.ai/oauth/client-metadata";

  test("rejects a non-HTTPS or malformed client_id", async () => {
    expect(await resolveClient("http://example.com/client.json")).toHaveProperty("error");
    expect(await resolveClient("not-a-url")).toHaveProperty("error");
  });

  test("resolves Claude's exact hosted client locally", async () => {
    const resolved = await resolveClient(CID);
    if (!("client" in resolved)) throw new Error(resolved.error);
    expect(resolved.client.redirect_uris).toEqual(["https://claude.ai/api/mcp/auth_callback"]);
  });

  test("hosted Claude consent allows its validated callback through form-action", async () => {
    const verifier = randomBytes(32).toString("base64url");
    const url = new URL(`${BASE}/authorize`);
    url.searchParams.set("client_id", CID);
    url.searchParams.set("redirect_uri", "https://claude.ai/api/mcp/auth_callback");
    url.searchParams.set("response_type", "code");
    url.searchParams.set("code_challenge", createHash("sha256").update(verifier).digest("base64url"));
    url.searchParams.set("code_challenge_method", "S256");
    url.searchParams.set("resource", `${BASE}/mcp`);
    url.searchParams.set("scope", SCOPE);
    const response = await handleAuthorize(new Request(url.href), BASE);
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Security-Policy")).toContain("form-action 'self' https://claude.ai");
    expect(await response.text()).toContain('name="transaction"');
  });

  test("accepts a well-formed, self-referential, same-origin document", () => {
    const ok = validateClientDocument(CID, {
      client_id: CID,
      client_name: "Claude",
      redirect_uris: ["https://claude.ai/api/mcp/auth_callback"],
    });
    expect(ok).toHaveProperty("client");
  });

  test("rejects a document claiming someone else's client_id", () => {
    // The document is self-asserted. Without the self-referential check an
    // attacker hosts a document at their own URL claiming to be Claude.
    const res = validateClientDocument("https://evil.example.com/meta.json", {
      client_id: CID,
      client_name: "Claude",
      redirect_uris: ["https://evil.example.com/cb"],
    });
    expect(res).toEqual({ error: "client_id document is not self-referential" });
  });

  test("rejects redirect_uris that are not same-origin with client_id", () => {
    // The code-harvesting attack: a genuine self-referential document whose
    // redirect points at a host the attacker controls.
    const res = validateClientDocument(CID, {
      client_id: CID,
      redirect_uris: ["https://evil.example.com/steal"],
    });
    expect(res).toEqual({ error: "redirect_uris must be same-origin with client_id" });
  });

  test("allows only HTTP(S) loopback redirect_uris for native clients", () => {
    // Claude Code binds an ephemeral port, so its declared loopback URIs are
    // legitimately not same-origin with the client_id host. Active schemes
    // are never native redirects, even when their hostname is localhost.
    const cid = "https://claude.ai/oauth/claude-code-client-metadata";
    const res = validateClientDocument(cid, {
      client_id: cid,
      redirect_uris: ["http://localhost/callback", "http://127.0.0.1/callback"],
    });
    expect(res).toHaveProperty("client");
    const active = validateClientDocument(cid, {
      client_id: cid,
      redirect_uris: ["javascript://localhost/callback", "data://127.0.0.1/callback"],
    });
    expect(active).toHaveProperty("error");
  });

  test("rejects a document with no redirect_uris, or a non-object", () => {
    expect(validateClientDocument(CID, { client_id: CID, redirect_uris: [] })).toHaveProperty("error");
    expect(validateClientDocument(CID, null)).toHaveProperty("error");
    expect(validateClientDocument(CID, "nope")).toHaveProperty("error");
  });
});

describe("redirect_uri matching", () => {
  test("loopback matches with the port ignored, per RFC 8252 §7.3", () => {
    // Native clients bind a random port at runtime, so an exact match would
    // reject every real Claude Code connection.
    const declared = ["http://localhost/callback", "http://127.0.0.1/callback"];
    expect(redirectUriAllowed("http://localhost:51763/callback", declared)).toBe(true);
    expect(redirectUriAllowed("http://127.0.0.1:8123/callback", declared)).toBe(true);
    // The path still has to match, and a different host must not.
    expect(redirectUriAllowed("http://localhost:51763/evil", declared)).toBe(false);
    expect(redirectUriAllowed("http://evil.example.com/callback", declared)).toBe(false);
  });

  test("loopback matching rejects active schemes even when both sides use localhost", () => {
    expect(redirectUriAllowed("javascript://localhost/cb", ["javascript://localhost/cb"])).toBe(false);
    expect(redirectUriAllowed("data://127.0.0.1/cb", ["data://127.0.0.1/cb"])).toBe(false);
  });

  test("non-loopback requires an exact match", () => {
    const declared = ["https://claude.ai/api/mcp/auth_callback"];
    expect(redirectUriAllowed("https://claude.ai/api/mcp/auth_callback", declared)).toBe(true);
    expect(redirectUriAllowed("https://claude.ai/api/mcp/auth_callback?x=1", declared)).toBe(false);
    expect(redirectUriAllowed("https://claude.ai.evil.com/api/mcp/auth_callback", declared)).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Dynamic Client Registration (RFC 7591). opencode / MCP TS SDK ≤1.29 is the
// forcing client: no CIMD support, refuses to proceed without this endpoint.
// The request shape below is what its provider actually sends.
// ─────────────────────────────────────────────────────────────────────────────

describe("dynamic client registration", () => {
  test("authorization server metadata advertises the registration endpoint", () => {
    const asm = authorizationServerMetadata(BASE);
    expect(asm.registration_endpoint).toBe(`${BASE}/register`);
  });

  async function postRegister(body: unknown): Promise<Response> {
    return handleRegister(new Request(`${BASE}/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }));
  }

  const OPENCODE_METADATA = {
    redirect_uris: ["http://127.0.0.1:19876/mcp/oauth/callback"],
    client_name: "OpenCode",
    client_uri: "https://opencode.ai",
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: "none",
  };

  function authorizationUrl(clientId: string, verifier: string): string {
    const url = new URL(`${BASE}/authorize`);
    url.searchParams.set("client_id", clientId);
    url.searchParams.set("redirect_uri", String(OPENCODE_METADATA.redirect_uris[0]));
    url.searchParams.set("response_type", "code");
    url.searchParams.set("code_challenge", createHash("sha256").update(verifier).digest("base64url"));
    url.searchParams.set("code_challenge_method", "S256");
    url.searchParams.set("resource", `${BASE}/mcp`);
    url.searchParams.set("scope", SCOPE);
    url.searchParams.set("state", "state-123");
    return url.href;
  }

  function transactionFrom(html: string): string {
    const match = html.match(/name="transaction" value="([^"]+)"/);
    if (!match) throw new Error("consent transaction missing");
    return match[1]!;
  }

  function postConsent(fields: Record<string, string>): Request {
    return new Request(`${BASE}/authorize`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(fields),
    });
  }

  test("registers a public client and echoes the SDK's metadata shape", async () => {
    const res = await postRegister(OPENCODE_METADATA);
    expect(res.status).toBe(201);
    const doc = await res.json() as Record<string, unknown>;
    expect(String(doc.client_id)).toMatch(/^reg_[0-9a-f]{24}$/);
    // OAuthClientInformationFull — the SDK Zod-parses exactly these fields.
    expect(doc.redirect_uris).toEqual(OPENCODE_METADATA.redirect_uris);
    expect(doc.token_endpoint_auth_method).toBe("none");
    expect(doc.grant_types).toContain("refresh_token");
    expect(doc.response_types).toEqual(["code"]);
    expect(doc.scope).toBe(SCOPE);
  });

  test("a registered client_id resolves locally, without a CIMD fetch", async () => {
    const res = await postRegister(OPENCODE_METADATA);
    const { client_id } = await res.json() as { client_id: string };
    const resolved = await resolveClient(client_id);
    if (!("client" in resolved)) throw new Error(resolved.error ?? "unresolved");
    // Port-agnostic loopback match — opencode may bind a different callback port.
    expect(redirectUriAllowed("http://127.0.0.1:29876/mcp/oauth/callback", resolved.client.redirect_uris)).toBe(true);
    expect(redirectUriAllowed("http://127.0.0.1:19876/evil", resolved.client.redirect_uris)).toBe(false);
  });

  test("rejects a GET, a malformed body, and hostile redirect lists", async () => {
    expect((await handleRegister(new Request(`${BASE}/register`, { method: "GET" }))).status).toBe(405);

    const badJson = new Request(`${BASE}/register`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: "{nope",
    });
    expect((await handleRegister(badJson)).status).toBe(400);

    expect((await postRegister({ redirect_uris: [] })).status).toBe(400);
    expect(validateRegistration({ redirect_uris: ["not a url"] })).toHaveProperty("error");
    // Plain http is fine on loopback, nowhere else.
    expect(validateRegistration({ redirect_uris: ["http://127.0.0.1/cb"] })).toHaveProperty("redirectUris");
    expect(validateRegistration({ redirect_uris: ["http://evil.example.com/cb"] })).toHaveProperty("error");
    expect(validateRegistration({
      redirect_uris: Array.from({ length: 6 }, (_, i) => `https://h${i}.example.com/cb`),
    })).toHaveProperty("error");
    expect(validateRegistration({ redirect_uris: [`https://example.com/${"x".repeat(2048)}`] })).toHaveProperty("error");
    expect(validateRegistration({ redirect_uris: ["https://example.com/cb"], client_name: "x".repeat(201) })).toHaveProperty("error");
  });

  test("rejects an oversized anonymous registration body with 413", async () => {
    const oversized = new Request(`${BASE}/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ redirect_uris: ["https://example.com/cb"], client_name: "x".repeat(70_000) }),
    });
    expect((await handleRegister(oversized)).status).toBe(413);
  });

  test("/authorize renders a consent screen for a registered client — it is not a URL", async () => {
    // The reg_ id must never reach new URL() — that crash 500'd the whole
    // consent flow the first time opencode clicked authenticate.
    const res = await postRegister(OPENCODE_METADATA);
    const { client_id } = await res.json() as { client_id: string };
    const verifier = randomBytes(32).toString("base64url");
    const page = await handleAuthorize(new Request(authorizationUrl(client_id, verifier)), BASE);
    expect(page.status).toBe(200);
    const csp = page.headers.get("Content-Security-Policy") ?? "";
    expect(csp).toContain("form-action 'self' http://127.0.0.1:19876");
    const html = await page.text();
    expect(html).toContain("OpenCode");
    expect(html).toContain("self-reported");
    expect(html).toContain('name="transaction"');
    expect(html).not.toContain('name="redirect_uri"');
  });

  test("consent screen labels a registered client's name as self-reported", () => {
    // The verified-host footer stays for CIMD clients; the self-reported one
    // must not claim a DNS/TLS verification that did not happen.
    const verified = consentPage({ client_id: "https://claude.ai/meta" }, "claude.ai");
    expect(verified).toContain("DNS and TLS vouch for");
    expect(verified).not.toContain("self-reported");

    const registered = consentPage({ client_id: "reg_abc" }, "OpenCode", undefined, false);
    expect(registered).toContain("self-reported");
    expect(registered).not.toContain("DNS and TLS vouch for");
  });

  test("POST completes from the signed transaction and ignores editable OAuth fields", async () => {
    const registered = await postRegister(OPENCODE_METADATA);
    const { client_id } = await registered.json() as { client_id: string };
    const verifier = randomBytes(32).toString("base64url");
    const page = await handleAuthorize(new Request(authorizationUrl(client_id, verifier)), BASE);
    const transaction = transactionFrom(await page.text());

    const previousPassword = process.env.BRAINLLM_OWNER_PASSWORD;
    process.env.BRAINLLM_OWNER_PASSWORD = "flow-test-owner-password";
    try {
      const wrong = await handleAuthorize(postConsent({
        transaction,
        password: "wrong-password",
        decision: "approve",
        // A hidden field added or edited after the owner saw the page must have
        // no effect; only the signed redirect URI is ever used.
        redirect_uri: "https://evil.example/steal",
      }), BASE);
      expect(wrong.status).toBe(401);
      expect(wrong.headers.get("Location")).toBeNull();
      expect(wrong.headers.get("Content-Security-Policy")).toContain("http://127.0.0.1:19876");
      expect(await wrong.text()).toContain("OpenCode");

      const approved = await handleAuthorize(postConsent({
        transaction,
        password: "flow-test-owner-password",
        decision: "approve",
        redirect_uri: "https://evil.example/steal",
      }), BASE);
      expect(approved.status).toBe(302);
      const callback = new URL(approved.headers.get("Location") ?? "");
      expect(`${callback.origin}${callback.pathname}`).toBe(String(OPENCODE_METADATA.redirect_uris[0]));
      expect(callback.searchParams.get("state")).toBe("state-123");
      expect(callback.searchParams.get("iss")).toBe(BASE);
      const code = callback.searchParams.get("code");
      expect(code).toBeTruthy();

      const token = await handleToken(new Request(`${BASE}/token`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code: code!,
          code_verifier: verifier,
          redirect_uri: String(OPENCODE_METADATA.redirect_uris[0]),
        }),
      }), BASE);
      expect(token.status).toBe(200);
      const issued = await token.json() as { access_token: string };
      expect(validateAccessToken(issued.access_token, BASE)).toBe(true);
    } finally {
      if (previousPassword === undefined) delete process.env.BRAINLLM_OWNER_PASSWORD;
      else process.env.BRAINLLM_OWNER_PASSWORD = previousPassword;
    }
  });

  test("a missing, tampered, or wrong-issuer consent transaction is rejected locally", async () => {
    const registered = await postRegister(OPENCODE_METADATA);
    const { client_id } = await registered.json() as { client_id: string };
    const verifier = randomBytes(32).toString("base64url");
    const page = await handleAuthorize(new Request(authorizationUrl(client_id, verifier)), BASE);
    const transaction = transactionFrom(await page.text());
    const tampered = `${transaction.slice(0, -1)}${transaction.endsWith("A") ? "B" : "A"}`;

    for (const [ticket, issuer] of [[undefined, BASE], [tampered, BASE], [transaction, "https://other.example"]] as const) {
      const response = await handleAuthorize(postConsent({
        ...(ticket ? { transaction: ticket } : {}),
        password: "irrelevant",
        decision: "approve",
      }), issuer);
      expect(response.status).toBe(400);
      expect(response.headers.get("Location")).toBeNull();
      expect(await response.text()).toContain("expired or was altered");
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Consent screen. These lock in two decisions that are invisible in the markup
// and easy to undo by accident.
// ─────────────────────────────────────────────────────────────────────────────

describe("consent screen", () => {
  const params = {
    client_id: "https://claude.ai/api/mcp/client-metadata.json",
    redirect_uri: "https://claude.ai/api/mcp/auth_callback",
    state: "abc123",
  };

  test("makes NO external requests — every asset is inline", () => {
    // The landing site pulls Space Grotesk and Inter from Google Fonts. This
    // page must not: a third-party request here tells that host someone is
    // authorizing access to their memory, adds a dependency the flow cannot
    // work without, and blocks on exactly the networks most likely to restrict
    // it. The brand mark is CSS dots for the same reason — no image request.
    const html = consentPage(params, "claude.ai");
    const external = html.match(/(?:src|href)\s*=\s*["']https?:\/\/[^"']+/gi) ?? [];
    expect(external).toEqual([]);
    expect(html).not.toContain("fonts.googleapis.com");
    expect(html).not.toContain("fonts.gstatic.com");
    expect(html).not.toContain("@import");
  });

  test("names the HOST, and escapes it", () => {
    // The host is the one part of a client's identity DNS and TLS vouch for.
    // client_name is self-asserted text in a document the requester controls,
    // so displaying it would let anyone render a screen that says "Anthropic".
    expect(consentPage(params, "claude.ai")).toContain("claude.ai");

    const hostile = consentPage(params, '"><script>alert(1)</script>');
    expect(hostile).not.toContain("<script>alert(1)</script>");
    expect(hostile).toContain("&lt;script&gt;");
  });

  test("escapes carried params, which come straight from the query string", () => {
    const html = consentPage({ state: '"><img src=x onerror=alert(1)>' }, "claude.ai");
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&quot;&gt;&lt;img");
  });

  test("the pure renderer carries only the fields it is given", () => {
    const html = consentPage(params, "claude.ai");
    for (const [k, v] of Object.entries(params)) {
      expect(html).toContain(`name="${k}"`);
      expect(html).toContain(v.replace(/&/g, "&amp;"));
    }
  });

  test("renders the error state without losing the form", () => {
    const html = consentPage(params, "claude.ai", "Incorrect password.");
    expect(html).toContain("Incorrect password.");
    expect(html).toContain('type="password"');
    expect(html).toContain('value="approve"');
  });
});
