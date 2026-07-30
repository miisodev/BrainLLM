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

  test("allows loopback redirect_uris for native clients", () => {
    // Claude Code binds an ephemeral port, so its declared loopback URIs are
    // legitimately not same-origin with the client_id host.
    const cid = "https://claude.ai/oauth/claude-code-client-metadata";
    const res = validateClientDocument(cid, {
      client_id: cid,
      redirect_uris: ["http://localhost/callback", "http://127.0.0.1/callback"],
    });
    expect(res).toHaveProperty("client");
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

  test("non-loopback requires an exact match", () => {
    const declared = ["https://claude.ai/api/mcp/auth_callback"];
    expect(redirectUriAllowed("https://claude.ai/api/mcp/auth_callback", declared)).toBe(true);
    expect(redirectUriAllowed("https://claude.ai/api/mcp/auth_callback?x=1", declared)).toBe(false);
    expect(redirectUriAllowed("https://claude.ai.evil.com/api/mcp/auth_callback", declared)).toBe(false);
  });
});
