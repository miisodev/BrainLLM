// ─────────────────────────────────────────────────────────────────────────────
// BrainLLM — legacy SSE server transport (V11)
//
// Streamable HTTP replaced SSE as the MCP transport in the 2025-03-26 spec
// revision, but a long tail of clients still speaks nothing else — older
// Cursor builds, Continue, and anyone pinned to a Python SDK that predates the
// streamable client. The SDK's own SSEServerTransport is Express-shaped (raw
// Node req/res), which Bun.serve does not offer, so this is a small native
// implementation of the same wire contract over the web-standard Request/
// Response pair the HTTP connector already uses:
//
//   GET  /sse                      → text/event-stream; first event names the
//                                    POST endpoint with the session id:
//                                    `event: endpoint\ndata: /messages?sessionId=…`
//   POST /messages?sessionId=…     → one JSON-RPC message per request → 202
//   server → client                → `event: message\ndata: {json}\n\n`
//
// It sits behind the same authentication gate, the same CORS policy and the
// same idle eviction as /mcp — an older transport must never mean a weaker
// door.
// ─────────────────────────────────────────────────────────────────────────────

import { randomUUID } from "crypto";
import type { Transport, TransportSendOptions } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";

/** Idle pings keep the stream open through proxies that time out silent
 *  connections — Railway's edge among them. An SSE comment line is the
 *  no-op frame the spec defines for exactly this. */
const KEEPALIVE_MS = 30_000;

export class BunSseServerTransport implements Transport {
  readonly sessionId = randomUUID();

  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;

  private controller: ReadableStreamDefaultController<Uint8Array> | null = null;
  private encoder = new TextEncoder();
  private keepalive: ReturnType<typeof setInterval> | null = null;
  private closed = false;

  constructor(private readonly endpointPath: string) {}

  /** The GET /sse response. The endpoint event is written as the stream opens,
   *  before anything else — a client that connects and never receives it has
   *  no address to POST to and hangs silently. */
  streamResponse(): Response {
    const self = this;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        self.controller = controller;
        // Resolve the endpoint against a dummy base — it is relative by
        // contract, so the stream works unchanged behind any host or proxy.
        const url = new URL(self.endpointPath, "http://placeholder.local");
        url.searchParams.set("sessionId", self.sessionId);
        self.write(`event: endpoint\ndata: ${url.pathname}${url.search}\n\n`);
        self.keepalive = setInterval(() => self.write(": ping\n\n"), KEEPALIVE_MS);
      },
      cancel() {
        self.terminate();
      },
    });
    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-store",
        Connection: "keep-alive",
      },
    });
  }

  /** Ingress for POST /messages. Session binding is checked here as well as at
   *  the router — a session id is a capability, and a mismatched one is a 404
   *  that reveals nothing. */
  async handlePost(req: Request): Promise<Response> {
    const url = new URL(req.url);
    if (url.searchParams.get("sessionId") !== this.sessionId) {
      return new Response(JSON.stringify({ error: "Session not found" }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      });
    }
    let message: JSONRPCMessage;
    try {
      message = (await req.json()) as JSONRPCMessage;
    } catch {
      return new Response(JSON.stringify({ error: "invalid_request", error_description: "Body must be JSON." }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }
    try {
      this.onmessage?.(message);
    } catch (e) {
      this.onerror?.(e instanceof Error ? e : new Error(String(e)));
    }
    return new Response(null, { status: 202 });
  }

  async start(): Promise<void> {
    // The stream opens in streamResponse(); nothing to negotiate here.
  }

  async send(message: JSONRPCMessage, _options?: TransportSendOptions): Promise<void> {
    if (this.closed) throw new Error("SSE transport is closed");
    this.write(`event: message\ndata: ${JSON.stringify(message)}\n\n`);
  }

  async close(): Promise<void> {
    this.terminate();
  }

  private write(chunk: string): void {
    if (this.closed || !this.controller) return;
    try {
      this.controller.enqueue(this.encoder.encode(chunk));
    } catch (e) {
      // A dead stream surfaces here as a write failure; close politely rather
      // than throwing into the server's send path.
      this.onerror?.(e instanceof Error ? e : new Error(String(e)));
      this.terminate();
    }
  }

  private terminate(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.keepalive) {
      clearInterval(this.keepalive);
      this.keepalive = null;
    }
    try {
      this.controller?.close();
    } catch {
      // Already closed by the platform when the client disconnected.
    }
    this.controller = null;
    this.onclose?.();
  }
}
