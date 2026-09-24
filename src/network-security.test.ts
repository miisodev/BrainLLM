import { describe, expect, test } from "bun:test";
import { assertPublicHttpsUrl, isNonPublicAddress } from "./network-security.js";

describe("CIMD network boundaries", () => {
  test("rejects private, loopback, link-local, documentation, and mapped addresses", () => {
    for (const address of [
      "127.0.0.1",
      "10.0.0.8",
      "192.168.1.10",
      "169.254.1.1",
      "::1",
      "fe80::1",
      "fc00::1",
      "::ffff:192.168.1.1",
      "2001:db8::1",
      "64:ff9b::c0a8:101",
      "64:ff9b:1::c0a8:101",
      "192.0.2.1",
    ]) expect(isNonPublicAddress(address)).toBe(true);
  });

  test("accepts ordinary public addresses", () => {
    for (const address of ["8.8.8.8", "1.1.1.1", "2606:4700:4700::1111"]) {
      expect(isNonPublicAddress(address)).toBe(false);
    }
  });

  test("requires HTTPS and rejects a private literal host", async () => {
    await expect(assertPublicHttpsUrl("http://example.com/client")).rejects.toThrow("https");
    await expect(assertPublicHttpsUrl("https://127.0.0.1/client")).rejects.toThrow("non-public");
    await expect(assertPublicHttpsUrl("https://localhost/client")).rejects.toThrow("not public");
  });
});
