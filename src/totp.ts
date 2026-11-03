// ─────────────────────────────────────────────────────────────────────────────
// BrainLLM — RFC 6238 TOTP for the optional owner second factor
//
// The OAuth consent screen is the one place a password alone grants a durable
// refresh token. This module is the second factor for that screen: a six-digit
// code from any standard authenticator app, HMAC-SHA1, thirty-second steps,
// one step of clock tolerance either way.
//
// Nothing here touches HTTP, the OAuth store or the environment. Parsing the
// operator's base32 secret, generating a code and verifying one are pure, so
// the RFC vectors and every hostile input can be tested directly.
// ─────────────────────────────────────────────────────────────────────────────

import { createHash, createHmac, timingSafeEqual } from "node:crypto";

/** RFC 6238's default step. Authenticator apps universally default to it. */
export const TOTP_PERIOD_SECONDS = 30;
/** Six digits is what every authenticator app displays for a standard entry. */
export const TOTP_DIGITS = 6;
/** One step either side absorbs ordinary clock skew without widening the
 *  guessing window beyond three codes. */
export const TOTP_WINDOW_STEPS = 1;
/** RFC 4226 §4 requires at least 128 bits of shared secret. */
export const TOTP_MIN_KEY_BYTES = 16;

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export type TotpSecretError = "missing" | "invalid_base32" | "too_short";

export interface TotpSecret {
  key: Buffer;
  /** A SHA-256 fingerprint, persisted instead of the seed so the OAuth store
   *  never holds a second-factor credential. */
  secretId: string;
}

/** RFC 4648 base32, unpadded — the shape authenticator apps export. */
export function encodeBase32Secret(bytes: Buffer): string {
  let value = 0;
  let bits = 0;
  let out = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
    value &= (1 << bits) - 1;
  }
  if (bits > 0) out += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

/** Decode a base32 secret, tolerating the grouping humans copy around.
 *
 *  Lowercase, spaces and hyphens are accepted because an operator pasting a
 *  secret out of an authenticator's UI should not be defeated by formatting.
 *  The re-encode check makes the decoding canonical: a non-zero unused tail or
 *  a stray `=` in the middle is rejected rather than silently reinterpreted. */
export function decodeBase32Secret(secret: string): Buffer | null {
  const cleaned = secret.replace(/[\s-]/g, "").toUpperCase();
  if (!cleaned || !/^[A-Z2-7]+=*$/.test(cleaned)) return null;

  const unpadded = cleaned.replace(/=+$/, "");
  if (cleaned.length !== unpadded.length && cleaned.length % 8 !== 0) return null;

  const bytes: number[] = [];
  let value = 0;
  let bits = 0;
  for (const character of unpadded) {
    const index = BASE32_ALPHABET.indexOf(character);
    if (index < 0) return null;
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
      value &= (1 << bits) - 1;
    }
  }
  // Leftover bits are the encoding's padding inside the final character. They
  // must be zero; otherwise another string spells the same bytes.
  if (value !== 0) return null;

  const decoded = Buffer.from(bytes);
  return encodeBase32Secret(decoded) === unpadded ? decoded : null;
}

export function totpSecretId(key: Buffer): string {
  return createHash("sha256").update(key).digest("base64url");
}

/** Parse and validate an operator-provided secret.
 *
 *  Errors are codes, never the input: a misconfiguration must be diagnosable
 *  without putting the seed in a page, a log line or a test failure. */
export function parseTotpSecret(raw: string | undefined): TotpSecret | { error: TotpSecretError } {
  const trimmed = raw?.trim() ?? "";
  if (!trimmed) return { error: "missing" };
  const key = decodeBase32Secret(trimmed);
  if (!key) return { error: "invalid_base32" };
  if (key.length < TOTP_MIN_KEY_BYTES) return { error: "too_short" };
  return { key, secretId: totpSecretId(key) };
}

/** RFC 4226 HOTP over the SHA-1 counter, with RFC 6238's 30-second step. */
export function generateTotp(key: Buffer, timeMs: number, digits = TOTP_DIGITS): string {
  const step = Math.floor(timeMs / 1000 / TOTP_PERIOD_SECONDS);
  return generateHotp(key, step, digits);
}

function generateHotp(key: Buffer, counter: number, digits: number): string {
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));
  const digest = createHmac("sha1", key).update(message).digest();
  const offset = digest[digest.length - 1]! & 0x0f;
  const binary =
    ((digest[offset]! & 0x7f) << 24) |
    ((digest[offset + 1]! & 0xff) << 16) |
    ((digest[offset + 2]! & 0xff) << 8) |
    (digest[offset + 3]! & 0xff);
  return String((binary >>> 0) % 10 ** digits).padStart(digits, "0");
}

/** Verify a submitted code against the current step and its neighbours.
 *
 *  Comparison is constant-time. The caller gets the matched step so it can
 *  persist it and refuse the same code twice — checking only "valid" would let
 *  a code be replayed for the rest of its window. */
export function verifyTotpCode(
  key: Buffer,
  code: string,
  timeMs: number
): { step: number } | null {
  const normalized = code.replace(/\s+/g, "");
  if (!new RegExp(`^\\d{${TOTP_DIGITS}}$`).test(normalized)) return null;

  const supplied = Buffer.from(normalized, "utf8");
  const current = Math.floor(timeMs / 1000 / TOTP_PERIOD_SECONDS);
  let matched: number | null = null;
  for (let offset = -TOTP_WINDOW_STEPS; offset <= TOTP_WINDOW_STEPS; offset += 1) {
    const step = current + offset;
    if (step < 0) continue;
    const expected = Buffer.from(generateHotp(key, step, TOTP_DIGITS), "utf8");
    if (expected.length === supplied.length && timingSafeEqual(expected, supplied)) matched = step;
  }
  return matched === null ? null : { step: matched };
}

/** True when a verified step has not already been consumed. A code is reusable
 *  within its tolerance window unless the exact step is refused, so the caller
 *  must persist this decision before returning a grant. */
export function isTotpStepFresh(lastUsedStep: number | undefined, step: number): boolean {
  return lastUsedStep === undefined || step > lastUsedStep;
}
