import { readFileSync } from "node:fs";
import { describe, expect, test } from "bun:test";

/**
 * `index.ts` starts a server as a module side effect, so it cannot be imported
 * into a unit test without changing the test's process into a live deployment.
 * This is a deliberately small structural tripwire for the route wiring that
 * caused the v12.3.0 security incident: the streamable-HTTP branch was reachable
 * before the authentication gate even though the legacy branches called it.
 * The behaviour itself is covered by the local HTTP smoke test in the release
 * run; this test keeps the single-gate invariant visible in ordinary CI.
 */
const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");

describe("HTTP transport authentication wiring", () => {
  test("one central gate precedes every protected transport", () => {
    const gateDeclaration = source.indexOf("const gate =");
    const gateCall = source.indexOf("const denied = gate();");
    const sseBranch = source.indexOf('if (url.pathname === "/sse")');
    const messagesBranch = source.indexOf('if (url.pathname === "/messages")');
    const streamableSession = source.indexOf("const sessionId = req.headers");

    expect(gateDeclaration).toBeGreaterThan(-1);
    expect(gateCall).toBeGreaterThan(gateDeclaration);
    expect(gateCall).toBeLessThan(sseBranch);
    expect(gateCall).toBeLessThan(messagesBranch);
    expect(gateCall).toBeLessThan(streamableSession);
    expect(source.match(/const denied = gate\(\);/g)?.length).toBe(1);
    expect(source).toContain("maxRequestBodySize: 50 * 1024 * 1024");
    expect(source).toContain("await entry.transport.close().catch(() => {})");
  });
});
