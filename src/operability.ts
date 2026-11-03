// ─────────────────────────────────────────────────────────────────────────────
// BrainLLM — runtime operability
//
// The hosted connector needs three things the MCP SDK deliberately leaves to
// the application: a readiness answer that includes the one dependency this
// server cannot work without, a bounded drain on SIGTERM/SIGINT, and operator
// logs that can be read without risking the user's data. Everything here is
// process-local and dependency-free; the HTTP router and transport wiring stay
// in index.ts.
// ─────────────────────────────────────────────────────────────────────────────

import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { TOOL_ANNOTATIONS } from "./annotations.js";

// ── Safe structured logging ───────────────────────────────────────────────────

export type OperabilityEventName = "http_request" | "http_error" | "mcp_request" | "shutdown";

/** Every field is optional except the event name. Callers must never put
 *  request bodies, tool arguments, results, error messages, URLs or tokens in
 *  here — the logger only copies allowlisted scalar fields, so an accidental
 *  extra property is dropped rather than serialized. */
export interface OperabilityLogEvent {
  event: OperabilityEventName;
  method?: string;
  route?: string;
  tool?: string;
  status?: number | string;
  durationMs?: number;
  phase?: string;
  signal?: string;
  inFlight?: number;
}

export type OperabilityLogger = (event: OperabilityLogEvent) => void;

export interface OperabilityLoggerOptions {
  release: string;
  sink?: (line: string) => void;
  now?: () => Date;
}

const TOKEN_RE = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,63}$/;
const RELEASE_RE = /^[A-Za-z0-9][A-Za-z0-9.+-]{0,31}$/;
const EVENT_NAMES = new Set<OperabilityEventName>(["http_request", "http_error", "mcp_request", "shutdown"]);
const STATUS_NAMES = new Set(["ok", "error", "aborted", "send_error", "internal_error"]);

const HTTP_METHODS = new Set(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]);
// Request methods this server can legitimately receive. A client-supplied
// method is never logged verbatim, even when it looks like an identifier: the
// format is not the safety boundary, membership is.
const MCP_METHODS = new Set([
  "initialize",
  "ping",
  "tools/list",
  "tools/call",
  "resources/list",
  "resources/templates/list",
  "resources/read",
  "resources/subscribe",
  "resources/unsubscribe",
  "prompts/list",
  "prompts/get",
  "completion/complete",
  "logging/setLevel",
  "tasks/get",
  "tasks/result",
  "tasks/list",
  "tasks/cancel",
]);
// TOOL_ANNOTATIONS is the authoritative registry of BrainLLM tool names: a
// tool cannot be registered without an entry (annotations.test enforces it).
const TOOL_NAMES = new Set(Object.keys(TOOL_ANNOTATIONS));

function knownMethod(event: OperabilityEventName, value: unknown): string {
  if (typeof value !== "string") return "unknown";
  return (event === "mcp_request" ? MCP_METHODS : HTTP_METHODS).has(value) ? value : "unknown";
}

function knownTool(value: unknown): string {
  return typeof value === "string" && TOOL_NAMES.has(value) ? value : "unknown";
}

function safeToken(value: unknown, pattern: RegExp, fallback = "unknown"): string {
  return typeof value === "string" && pattern.test(value) ? value : fallback;
}

function safeNumber(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return undefined;
  return Math.min(Math.round(value), 86_400_000);
}

/** JSON-lines on stderr, the same stream the existing startup diagnostics use.
 *  The allowlist is the boundary: adding a field to a log call is not enough to
 *  put it in the output. */
export function createOperabilityLogger(options: OperabilityLoggerOptions): OperabilityLogger {
  const sink = options.sink ?? ((line: string) => console.error(line));
  const now = options.now ?? (() => new Date());
  const release = safeToken(options.release, RELEASE_RE);

  return (event) => {
    const record: Record<string, unknown> = {
      ts: now().toISOString(),
      event: EVENT_NAMES.has(event.event) ? event.event : "unknown",
      release,
    };
    if (event.method !== undefined) record.method = knownMethod(event.event, event.method);
    if (event.route !== undefined) record.route = safeToken(event.route, TOKEN_RE);
    if (event.tool !== undefined) record.tool = knownTool(event.tool);
    if (event.status !== undefined) {
      const numeric = typeof event.status === "number" ? safeNumber(event.status) : undefined;
      record.status = numeric ?? (typeof event.status === "string" && STATUS_NAMES.has(event.status) ? event.status : "unknown");
    }
    if (event.durationMs !== undefined) record.durationMs = safeNumber(event.durationMs);
    if (event.phase !== undefined) record.phase = safeToken(event.phase, TOKEN_RE);
    if (event.signal !== undefined) record.signal = safeToken(event.signal, TOKEN_RE);
    if (event.inFlight !== undefined) record.inFlight = safeNumber(event.inFlight);
    sink(`[brainllm] ${JSON.stringify(record)}`);
  };
}

// ── Readiness ─────────────────────────────────────────────────────────────────

export type ReadinessState = "ready" | "unavailable" | "draining";

export interface ReadinessProbeOptions {
  /** Resolve when the dependency is usable, reject when it is not. The result
   *  is never inspected or logged — only success or failure matters. */
  check: () => Promise<unknown>;
  successTtlMs?: number;
  failureTtlMs?: number;
  timeoutMs?: number;
  now?: () => number;
}

export const READINESS_DEFAULTS = {
  successTtlMs: 10_000,
  failureTtlMs: 5_000,
  timeoutMs: 3_000,
} as const;

/**
 * Caches and single-flights a bounded dependency check.
 *
 * `/ready` is unauthenticated, so an unguarded handler would let any caller
 * drive arbitrary load at Trilium. The cache is the first guard; the second is
 * that a check which outlives its deadline is not abandoned and immediately
 * re-issued — `outstanding` stays set until the original call settles, so a
 * hung backend sees one request, not one per probe. A late result still updates
 * the cache, which lets the next call recover without another backend request.
 */
export class ReadinessProbe {
  private readonly check: () => Promise<unknown>;
  private readonly successTtlMs: number;
  private readonly failureTtlMs: number;
  private readonly timeoutMs: number;
  private readonly now: () => number;
  private result: { ok: boolean; at: number } | null = null;
  private inFlight: Promise<ReadinessState> | null = null;
  private outstanding = 0;
  private generation = 0;
  private draining = false;

  constructor(options: ReadinessProbeOptions) {
    this.check = options.check;
    this.successTtlMs = options.successTtlMs ?? READINESS_DEFAULTS.successTtlMs;
    this.failureTtlMs = options.failureTtlMs ?? READINESS_DEFAULTS.failureTtlMs;
    this.timeoutMs = options.timeoutMs ?? READINESS_DEFAULTS.timeoutMs;
    this.now = options.now ?? Date.now;
  }

  get isDraining(): boolean {
    return this.draining;
  }

  beginDrain(): void {
    this.draining = true;
  }

  async status(): Promise<ReadinessState> {
    if (this.draining) return "draining";

    if (this.result) {
      const ttl = this.result.ok ? this.successTtlMs : this.failureTtlMs;
      if (this.now() - this.result.at < ttl) return this.result.ok ? "ready" : "unavailable";
    }

    if (this.inFlight) return this.inFlight;

    if (this.outstanding > 0) {
      // The previous check missed its deadline but is still running. Do not
      // stack another request on the dependency; report the last known state.
      return this.result?.ok ? "ready" : "unavailable";
    }

    const generation = ++this.generation;
    const running = this.probe(generation).finally(() => {
      if (this.inFlight === running) this.inFlight = null;
    });
    this.inFlight = running;
    return running;
  }

  private async probe(generation: number): Promise<ReadinessState> {
    this.outstanding += 1;
    let outcome: boolean | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const work = Promise.resolve()
      .then(this.check)
      .then(
        () => { outcome = true; },
        () => { outcome = false; },
      )
      .finally(() => { this.outstanding -= 1; });

    const deadline = new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => resolve("timeout"), Math.max(0, this.timeoutMs));
    });

    let raced: "done" | "timeout";
    try {
      raced = await Promise.race([work.then(() => "done" as const), deadline]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }

    const ok = raced === "done" && outcome === true;
    this.result = { ok, at: this.now() };

    if (raced === "timeout") {
      // Keep the original check's outcome without another backend call. If a
      // newer probe has started in the meantime its result wins.
      void work.then(() => {
        if (this.generation === generation) this.result = { ok: outcome === true, at: this.now() };
      });
    }

    return ok ? "ready" : "unavailable";
  }
}

/** The public readiness response. Only the state name leaves the process:
 *  never the Trilium URL, token, response body or error. */
export function readinessResponse(state: ReadinessState): Response {
  return new Response(JSON.stringify({ status: state }), {
    status: state === "ready" ? 200 : 503,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    },
  });
}

// ── Recent internal error ─────────────────────────────────────────────────────

export const INTERNAL_ERROR_TTL_MS = 30 * 60_000;

/** A timestamp, not a counter or message: one recent unexpected failure keeps
 *  /ready unavailable for the TTL. A restart starts a fresh signal. */
export class InternalErrorSignal {
  private markedAt: number | null = null;
  private readonly ttlMs: number;
  private readonly now: () => number;

  constructor(options: { ttlMs?: number; now?: () => number } = {}) {
    this.ttlMs = options.ttlMs ?? INTERNAL_ERROR_TTL_MS;
    this.now = options.now ?? Date.now;
  }

  mark(): void {
    this.markedAt = this.now();
  }

  get active(): boolean {
    return this.markedAt !== null && this.now() - this.markedAt < this.ttlMs;
  }
}

/** Draining is a deliberate lifecycle state and always wins; a dependency
 *  failure and a recent internal failure share the same safe 503 body. */
export function readinessStateWithInternalError(state: ReadinessState, signal: InternalErrorSignal): ReadinessState {
  return state === "ready" && signal.active ? "unavailable" : state;
}

// ── In-flight tracking ────────────────────────────────────────────────────────

/** Counts accepted work so shutdown can wait for it without knowing what the
 *  work is. HTTP handlers and individual MCP requests both use it. */
export class RequestTracker {
  private active = 0;
  private waiters = new Set<() => void>();

  get count(): number {
    return this.active;
  }

  begin(): void {
    this.active += 1;
  }

  end(): void {
    if (this.active === 0) return;
    this.active -= 1;
    if (this.active !== 0) return;
    const waiters = [...this.waiters];
    this.waiters.clear();
    for (const wake of waiters) wake();
  }

  waitForIdle(timeoutMs: number): Promise<boolean> {
    if (this.active === 0) return Promise.resolve(true);
    return new Promise((resolve) => {
      let settled = false;
      const finish = (idle: boolean) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.waiters.delete(check);
        resolve(idle);
      };
      const check = () => {
        if (this.active === 0) finish(true);
      };
      const timer = setTimeout(() => finish(false), Math.max(0, timeoutMs));
      this.waiters.add(check);
      check();
    });
  }
}

// ── Graceful shutdown ─────────────────────────────────────────────────────────

export interface GracefulShutdownOptions {
  tracker: RequestTracker;
  graceMs: number;
  markDraining: () => void;
  closeTransports: () => Promise<unknown> | unknown;
  closeServer: () => Promise<unknown> | unknown;
  log: OperabilityLogger;
  exit: (code: number) => void;
  now?: () => number;
}

/**
 * One shutdown per process. The listener keeps accepting sockets during the
 * drain window on purpose: the router answers new MCP work with 503 and
 * `/ready` with `draining`, which is what lets a load balancer take the
 * instance out before the listener finally stops. The grace is only as long as
 * in-flight work needs, bounded by `graceMs`.
 */
export function createGracefulShutdown(options: GracefulShutdownOptions): (signal: string) => Promise<void> {
  let started = false;
  const now = options.now ?? Date.now;

  return async (signal: string) => {
    if (started) return;
    started = true;

    const startedAt = now();
    const deadlineAt = startedAt + Math.max(0, options.graceMs);
    const remaining = () => Math.max(0, deadlineAt - now());
    options.markDraining();
    const inFlight = options.tracker.count;
    options.log({ event: "shutdown", phase: "started", signal, inFlight });

    // The grace bounds the whole sequence, not just the in-flight wait: a
    // transport whose close() never settles must not keep the process alive
    // past the platform's kill window. Each step gets whatever remains.
    const boundedClose = async (close: () => Promise<unknown> | unknown): Promise<boolean> => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const run = Promise.resolve().then(close).then(() => true, () => false);
      const expired = new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), remaining());
      });
      try {
        return await Promise.race([run, expired]);
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
    };

    const drained = await options.tracker.waitForIdle(remaining());
    const transportsClosed = await boundedClose(options.closeTransports);
    const serverClosed = await boundedClose(options.closeServer);
    const closeOk = transportsClosed && serverClosed;

    options.log({
      event: "shutdown",
      phase: !drained ? "grace_expired" : closeOk ? "drained" : "close_timeout",
      signal,
      inFlight,
      durationMs: now() - startedAt,
      status: closeOk ? "ok" : "error",
    });
    options.exit(0);
  };
}

// ── MCP transport observation ─────────────────────────────────────────────────

export interface TransportObservationOptions {
  tracker?: RequestTracker;
  log: OperabilityLogger;
  now?: () => number;
  onInternalError?: () => void;
}

function requestKey(id: unknown): string {
  if (typeof id === "string") return `s:${id}`;
  if (typeof id === "number") return `n:${id}`;
  return `o:${String(id)}`;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function toolNameFromParams(params: unknown): string {
  if (!isObject(params)) return "unknown";
  return knownTool(params.name);
}

function isFailedResult(result: unknown): boolean {
  return isObject(result) && result.isError === true;
}

function isInternalFailure(message: Record<string, unknown>): boolean {
  if (isFailedResult(message.result)) {
    // The SDK wraps input-validation / unknown-tool McpErrors in isError
    // results, rather than JSON-RPC errors. Classify its finite prefix without
    // logging any text. Output validation is a server fault and must alert.
    const result = message.result as Record<string, unknown>;
    const first = Array.isArray(result.content) ? result.content[0] : undefined;
    const text = isObject(first) && typeof first.text === "string" ? first.text : "";
    const expectedRejection = /^MCP error -(32601|32602): /.test(text) &&
      !text.startsWith("MCP error -32602: Output validation error:");
    return !expectedRejection;
  }
  return isObject(message.error) && message.error.code === -32603;
}

/**
 * Wraps the transport assigned by `McpServer.connect`, not the SDK internals.
 * The incoming message's method and the tools/call name are the only request
 * fields read; arguments, results and JSON-RPC error text never enter a log
 * line. Each request is also registered with the drain tracker, because a
 * streamable-HTTP POST can return its SSE response before a tool finishes —
 * waiting only on the HTTP handler would close the transport mid-write.
 */
export function instrumentTransport(transport: Transport, options: TransportObservationOptions): void {
  const now = options.now ?? Date.now;
  const pending = new Map<string, { method: string; tool?: string; started: number }>();
  const originalOnMessage = transport.onmessage;
  const originalSend = transport.send.bind(transport);
  const originalClose = transport.close.bind(transport);

  transport.onmessage = (message, extra) => {
    const raw = message as unknown as Record<string, unknown>;
    if (typeof raw.method === "string" && raw.id !== undefined && raw.id !== null) {
      const method = knownMethod("mcp_request", raw.method);
      const tool = method === "tools/call"
        ? toolNameFromParams(raw.params)
        : isObject(raw.params) && typeof raw.params.name === "string" ? "unknown" : undefined;
      pending.set(requestKey(raw.id), { method, tool, started: now() });
      options.tracker?.begin();
    }
    originalOnMessage?.(message, extra);
  };

  transport.send = async (message, sendOptions) => {
    const raw = message as unknown as Record<string, unknown>;
    const isResponse = typeof raw.method !== "string" && typeof raw.id !== "undefined" && ("result" in raw || "error" in raw);
    if (!isResponse) return originalSend(message, sendOptions);

    const key = requestKey(raw.id);
    const entry = pending.get(key);
    if (!entry) return originalSend(message, sendOptions);

    pending.delete(key);
    const internal = isInternalFailure(raw);
    if (internal) options.onInternalError?.();
    let status = internal ? "internal_error" : "error" in raw || isFailedResult(raw.result) ? "error" : "ok";
    try {
      await originalSend(message, sendOptions);
    } catch (error) {
      status = "send_error";
      throw error;
    } finally {
      options.tracker?.end();
      options.log({
        event: "mcp_request",
        method: entry.method,
        tool: entry.tool,
        status,
        durationMs: now() - entry.started,
      });
    }
  };

  transport.close = async () => {
    for (const entry of pending.values()) {
      options.tracker?.end();
      options.log({
        event: "mcp_request",
        method: entry.method,
        tool: entry.tool,
        status: "aborted",
        durationMs: now() - entry.started,
      });
    }
    pending.clear();
    await originalClose();
  };
}

// ── HTTP route labels ─────────────────────────────────────────────────────────

export type HttpRoute =
  | "health"
  | "ready"
  | "mcp"
  | "sse"
  | "messages"
  | "oauth"
  | "discovery"
  | "assets"
  | "root"
  | "unknown";

/** Fixed labels, never the raw path: a request path can carry a token or note
 *  id, and logs are not the place for either. */
export function classifyHttpRoute(pathname: string): HttpRoute {
  switch (pathname) {
    case "/health": return "health";
    case "/ready": return "ready";
    case "/mcp": return "mcp";
    case "/sse": return "sse";
    case "/messages": return "messages";
    case "/authorize":
    case "/token":
    case "/register": return "oauth";
    case "/": return "root";
    case "/favicon.ico":
    case "/favicon.png":
    case "/apple-touch-icon.png":
    case "/icon.png":
    case "/icon.svg":
    case "/icon-64.png":
    case "/icon-128.png":
    case "/icon-512.png": return "assets";
    default:
      return pathname.startsWith("/.well-known/") ? "discovery" : "unknown";
  }
}

export function shouldLogHttpRoute(route: HttpRoute): boolean {
  return route !== "health" && route !== "ready" && route !== "assets";
}
