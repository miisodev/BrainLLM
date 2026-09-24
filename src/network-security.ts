import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { request as httpsRequest } from "node:https";
import type { IncomingMessage } from "node:http";

/** RFC 1918/4193/loopback/link-local/documentation and other non-public space. */
export function isNonPublicAddress(address: string): boolean {
  const value = address.trim().toLowerCase().replace(/^\[|\]$/g, "").split("%")[0];
  const version = isIP(value);
  if (version === 4) return isNonPublicIpv4(value);
  if (version === 6) return isNonPublicIpv6(value);
  return true;
}

function isNonPublicIpv4(address: string): boolean {
  const parts = address.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return true;
  const [a, b, c] = parts;
  return a === 0 || a === 10 || a === 127 || a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0) || // RFC 6890 special-purpose block
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113);
}

function parseIpv6(address: string): number[] | null {
  let value = address;
  const lastColon = value.lastIndexOf(":");
  if (value.includes(".")) {
    const ipv4 = value.slice(lastColon + 1);
    if (!isIP(ipv4) || isIP(ipv4) !== 4) return null;
    const octets = ipv4.split(".").map(Number);
    const high = ((octets[0] << 8) | octets[1]).toString(16);
    const low = ((octets[2] << 8) | octets[3]).toString(16);
    value = `${value.slice(0, lastColon + 1)}${high}:${low}`;
  }
  const halves = value.split("::");
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const missing = 8 - left.length - right.length;
  if (halves.length === 1 ? missing !== 0 : missing < 1) return null;
  const groups = [...left, ...Array.from({ length: missing }, () => "0"), ...right];
  if (groups.length !== 8 || groups.some((group) => !/^[0-9a-f]{1,4}$/i.test(group))) return null;
  return groups.flatMap((group) => {
    const n = parseInt(group, 16);
    return [n >> 8, n & 0xff];
  });
}

function isNonPublicIpv6(address: string): boolean {
  const bytes = parseIpv6(address);
  if (!bytes) return true;
  const isZeroPrefix = bytes.slice(0, 10).every((byte) => byte === 0);
  const isIpv4Mapped = isZeroPrefix && bytes[10] === 0xff && bytes[11] === 0xff;
  const isIpv4Compatible = isZeroPrefix && bytes[10] === 0 && bytes[11] === 0;
  if (isIpv4Mapped || isIpv4Compatible) {
    return isNonPublicIpv4(bytes.slice(12).join("."));
  }
  if (bytes.every((byte) => byte === 0)) return true;
  if (bytes.slice(0, 15).every((byte) => byte === 0) && bytes[15] === 1) return true;
  if (bytes[0] === 0xfe && (bytes[1] & 0xc0) === 0x80) return true;
  if ((bytes[0] & 0xfe) === 0xfc) return true;
  if (bytes[0] === 0xff) return true;

  // Documentation, benchmarking, discard, ORCHID, and other special-use
  // ranges are not valid public CIMD destinations.
  if (bytes[0] === 0x20 && bytes[1] === 0x01 && bytes[2] === 0x0d && bytes[3] === 0xb8) return true;
  if (bytes[0] === 0x20 && bytes[1] === 0x01 && bytes[2] === 0x00 && bytes.slice(3, 8).every((b) => b === 0)) return true;
  if (bytes[0] === 0x20 && bytes[1] === 0x01 && bytes[2] === 0x02 && bytes.slice(3, 6).every((b) => b === 0)) return true;
  if (bytes[0] === 0x20 && bytes[1] === 0x01 && bytes[2] === 0x00 && bytes[3] >= 0x10 && bytes[3] <= 0x1f) return true;
  if (bytes[0] === 0x20 && bytes[1] === 0x01 && bytes[2] === 0x00 && bytes[3] === 0x20 && bytes.slice(4, 8).every((b) => b === 0)) return true;
  if (bytes[0] === 0x01 && bytes[1] === 0x00 && bytes.slice(2, 8).every((b) => b === 0)) return true;

  // NAT64 is not a public destination. 64:ff9b::/96 is the well-known prefix;
  // 64:ff9b:1::/48 is the local-use translation prefix. Both can otherwise
  // smuggle an IPv4 private address through an otherwise-public IPv6 literal.
  if (bytes[0] === 0x00 && bytes[1] === 0x64 && bytes[2] === 0xff && bytes[3] === 0x9b) return true;

  return false;
}

interface ResolvedPublicHttps {
  url: URL;
  address: string;
  family: 4 | 6;
}

/** Resolve a URL and reject private or otherwise non-public destinations. */
async function resolvePublicHttps(raw: string): Promise<ResolvedPublicHttps> {
  let url: URL;
  try { url = new URL(raw); } catch { throw new Error("URL is not absolute"); }
  if (url.protocol !== "https:") throw new Error("CIMD URLs must use https");
  if (url.username || url.password) throw new Error("CIMD URLs must not contain credentials");
  if (url.port && url.port !== "443") throw new Error("CIMD URLs must use the HTTPS port");
  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (!hostname || hostname === "localhost" || hostname.endsWith(".localhost") || hostname.endsWith(".local") || hostname.endsWith(".internal")) {
    throw new Error("CIMD host is not public");
  }

  let addresses: Array<{ address: string; family: number }>;
  const literalFamily = isIP(hostname);
  if (literalFamily) {
    addresses = [{ address: hostname, family: literalFamily }];
  } else {
    try {
      addresses = await lookup(hostname, { all: true, verbatim: true });
    } catch {
      throw new Error("CIMD host could not be resolved");
    }
  }
  if (addresses.length === 0 || addresses.some(({ address }) => isNonPublicAddress(address))) {
    throw new Error("CIMD host resolves to a non-public address");
  }

  // Prefer IPv4 when both families are public: it is the most widely available
  // route in hosted environments. The chosen address is pinned into the TLS
  // request below, so a second DNS answer cannot turn this check into SSRF.
  const selected = [...addresses].sort((a, b) => a.family - b.family)[0]!;
  return { url, address: selected.address, family: selected.family === 6 ? 6 : 4 };
}

export async function assertPublicHttpsUrl(raw: string): Promise<URL> {
  return (await resolvePublicHttps(raw)).url;
}

interface PinnedResponse {
  status: number;
  headers: Headers;
  body: Uint8Array;
}

function readIncomingBytes(response: IncomingMessage, maxBytes: number): Promise<Uint8Array> {
  const declared = Number(response.headers["content-length"] ?? 0);
  if (Number.isFinite(declared) && declared > maxBytes) {
    response.destroy();
    return Promise.reject(new Error("CIMD document is too large"));
  }
  return new Promise<Uint8Array>((resolve, reject) => {
    const chunks: Uint8Array[] = [];
    let total = 0;
    response.on("data", (chunk: Buffer | string) => {
      const bytes = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
      total += bytes.byteLength;
      if (total > maxBytes) {
        response.destroy(new Error("CIMD document is too large"));
        return;
      }
      chunks.push(new Uint8Array(bytes));
    });
    response.on("end", () => {
      const result = new Uint8Array(total);
      let offset = 0;
      for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.byteLength; }
      resolve(result);
    });
    response.on("error", reject);
  });
}

/** Fetch a small JSON document through a DNS-pinned HTTPS connection. */
async function fetchPinned(
  target: ResolvedPublicHttps,
  maxBytes: number,
  timeoutMs: number
): Promise<PinnedResponse> {
  return new Promise<PinnedResponse>((resolve, reject) => {
    const hostname = target.url.hostname.replace(/^\[|\]$/g, "");
    const request = httpsRequest(target.url, {
      method: "GET",
      headers: { Accept: "application/json", Host: target.url.host, Connection: "close" },
      agent: false,
      // The URL hostname remains the TLS SNI/certificate identity; lookup is
      // overridden so the socket can only connect to the address we checked.
      servername: isIP(hostname) ? undefined : hostname,
      lookup: ((_hostname: string, options: unknown, callback: (...args: any[]) => void) => {
        if (options && typeof options === "object" && (options as { all?: boolean }).all) {
          callback(null, [{ address: target.address, family: target.family }]);
        } else {
          callback(null, target.address, target.family);
        }
      }) as never,
      rejectUnauthorized: true,
    }, (response) => {
      void readIncomingBytes(response, maxBytes).then((body) => {
        response.destroy();
        request.destroy();
        resolve({ status: response.statusCode ?? 0, headers: new Headers(response.headers as Record<string, string>), body });
      }).catch((error) => {
        response.destroy();
        request.destroy();
        reject(error);
      });
    });
    request.setTimeout(timeoutMs, () => request.destroy(new Error("CIMD document request timed out")));
    request.on("error", reject);
    request.end();
  });
}

/** Fetch a small JSON document without following an unchecked redirect. */
export async function fetchPublicJson(
  raw: string,
  maxBytes: number,
  timeoutMs: number
): Promise<unknown> {
  let current = await resolvePublicHttps(raw);
  for (let redirect = 0; redirect <= 5; redirect += 1) {
    const response = await fetchPinned(current, maxBytes, timeoutMs);
    if (response.status >= 300 && response.status < 400) {
      if (redirect === 5) throw new Error("CIMD document redirected too many times");
      const location = response.headers.get("location");
      if (!location) throw new Error("CIMD redirect has no Location header");
      current = await resolvePublicHttps(new URL(location, current.url).href);
      continue;
    }
    if (response.status < 200 || response.status >= 300) throw new Error(`client_id document returned ${response.status}`);
    return JSON.parse(new TextDecoder().decode(response.body));
  }
  throw new Error("CIMD document could not be fetched");
}
