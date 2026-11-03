import { describe, expect, test } from "bun:test";
import {
  TOTP_DIGITS,
  TOTP_PERIOD_SECONDS,
  TOTP_WINDOW_STEPS,
  decodeBase32Secret,
  encodeBase32Secret,
  generateTotp,
  isTotpStepFresh,
  parseTotpSecret,
  totpSecretId,
  verifyTotpCode,
} from "./totp.js";

/** RFC 6238's SHA-1 key: the ASCII digits 1–0, twenty bytes. */
const RFC_KEY = Buffer.from("12345678901234567890", "ascii");
const RFC_KEY_BASE32 = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";
const RFC_TIME = 1_111_111_111;

describe("TOTP parameters", () => {
  test("uses the RFC 6238 defaults: SHA-1, 30 seconds, 6 digits, ±1 step", () => {
    expect(TOTP_PERIOD_SECONDS).toBe(30);
    expect(TOTP_DIGITS).toBe(6);
    expect(TOTP_WINDOW_STEPS).toBe(1);
  });
});

describe("base32 owner secrets", () => {
  test("decodes the RFC 4648 vector and round-trips it", () => {
    expect(decodeBase32Secret(RFC_KEY_BASE32)).toEqual(RFC_KEY);
    expect(encodeBase32Secret(RFC_KEY)).toBe(RFC_KEY_BASE32);
  });

  test("accepts lowercase, whitespace, hyphens and trailing padding", () => {
    expect(decodeBase32Secret(RFC_KEY_BASE32.toLowerCase())).toEqual(RFC_KEY);
    expect(decodeBase32Secret("gezd gnbv gy3t qojq gezd gnbv gy3t qojq")).toEqual(RFC_KEY);
    expect(decodeBase32Secret("GEZD-GNBV-GY3T-QOJQ-GEZD-GNBV-GY3T-QOJQ")).toEqual(RFC_KEY);
    expect(decodeBase32Secret("MZXW6===")).toEqual(Buffer.from("foo", "ascii"));
  });

  test("rejects invalid characters, misplaced padding and non-canonical encodings", () => {
    expect(decodeBase32Secret("not base32!")).toBeNull();
    expect(decodeBase32Secret("MZ=XW6")).toBeNull();
    expect(decodeBase32Secret("MZXW6=")).toBeNull();
    // The last five-bit group carries three unused bits; a non-zero remainder
    // is a different spelling of the same bytes, not a valid secret.
    expect(decodeBase32Secret("MZXW7")).toBeNull();
    expect(decodeBase32Secret("")).toBeNull();
  });

  test("parseTotpSecret requires at least 128 bits and never echoes the secret", () => {
    expect(parseTotpSecret(undefined)).toEqual({ error: "missing" });
    expect(parseTotpSecret("   ")).toEqual({ error: "missing" });
    expect(parseTotpSecret("not base32!")).toEqual({ error: "invalid_base32" });
    expect(parseTotpSecret(encodeBase32Secret(Buffer.alloc(15)))).toEqual({ error: "too_short" });

    const parsed = parseTotpSecret(RFC_KEY_BASE32);
    if ("error" in parsed) throw new Error(parsed.error);
    expect(parsed.key).toEqual(RFC_KEY);
    expect(parsed.secretId).toBe(totpSecretId(RFC_KEY));
    expect(parsed.secretId).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(parsed.secretId).not.toContain(RFC_KEY_BASE32);
  });
});

describe("RFC 6238 SHA-1 vectors", () => {
  // The RFC publishes eight digits; the low six are the same dynamic-truncation
  // value modulo 10^6, which is exactly what a six-digit authenticator shows.
  const vectors: Array<[number, string]> = [
    [59, "287082"],
    [1_111_111_109, "081804"],
    [1_111_111_111, "050471"],
    [1_234_567_890, "005924"],
    [2_000_000_000, "279037"],
    [20_000_000_000, "353130"],
  ];

  for (const [seconds, expected] of vectors) {
    test(`T=${seconds} -> ${expected}`, () => {
      expect(generateTotp(RFC_KEY, seconds * 1000)).toBe(expected);
    });
  }
});

describe("code verification", () => {
  const step = Math.floor(RFC_TIME / TOTP_PERIOD_SECONDS);

  test("accepts the current step, one step back and one step forward", () => {
    expect(verifyTotpCode(RFC_KEY, generateTotp(RFC_KEY, RFC_TIME * 1000), RFC_TIME * 1000)).toEqual({ step });
    expect(verifyTotpCode(RFC_KEY, generateTotp(RFC_KEY, (RFC_TIME - 30) * 1000), RFC_TIME * 1000))
      .toEqual({ step: step - 1 });
    expect(verifyTotpCode(RFC_KEY, generateTotp(RFC_KEY, (RFC_TIME + 30) * 1000), RFC_TIME * 1000))
      .toEqual({ step: step + 1 });
  });

  test("rejects codes outside the window", () => {
    expect(verifyTotpCode(RFC_KEY, generateTotp(RFC_KEY, (RFC_TIME - 60) * 1000), RFC_TIME * 1000)).toBeNull();
    expect(verifyTotpCode(RFC_KEY, generateTotp(RFC_KEY, (RFC_TIME + 60) * 1000), RFC_TIME * 1000)).toBeNull();
  });

  test("rejects a wrong, malformed or wrongly sized code without throwing", () => {
    const current = generateTotp(RFC_KEY, RFC_TIME * 1000);
    const wrong = String((Number(current) + 1) % 1_000_000).padStart(6, "0");
    expect(verifyTotpCode(RFC_KEY, wrong, RFC_TIME * 1000)).toBeNull();
    expect(verifyTotpCode(RFC_KEY, "12345", RFC_TIME * 1000)).toBeNull();
    expect(verifyTotpCode(RFC_KEY, "abcdef", RFC_TIME * 1000)).toBeNull();
    expect(verifyTotpCode(RFC_KEY, "", RFC_TIME * 1000)).toBeNull();
  });

  test("tolerates a space typed inside the code", () => {
    const current = generateTotp(RFC_KEY, RFC_TIME * 1000);
    expect(verifyTotpCode(RFC_KEY, `${current.slice(0, 3)} ${current.slice(3)}`, RFC_TIME * 1000))
      .toEqual({ step });
  });
});

describe("replay bookkeeping", () => {
  test("a step is fresh only when it is newer than the last consumed step", () => {
    expect(isTotpStepFresh(undefined, 10)).toBe(true);
    expect(isTotpStepFresh(10, 11)).toBe(true);
    expect(isTotpStepFresh(10, 10)).toBe(false);
    expect(isTotpStepFresh(10, 9)).toBe(false);
  });
});
