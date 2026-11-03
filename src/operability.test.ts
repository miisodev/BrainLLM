import { describe, expect, test } from "bun:test";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import {
  INTERNAL_ERROR_TTL_MS,
  InternalErrorSignal,
  ReadinessProbe,
  RequestTracker,
  classifyHttpRoute,
  createGracefulShutdown,
  createOperabilityLogger,
  instrumentTransport,
  readinessResponse,
  readinessStateWithInternalError,
  shouldLogHttpRoute,
  type OperabilityLogEvent,
} from "./operability.js";

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("ReadinessProbe", () => {
  test("caches a healthy dependency and rechecks only after the success TTL", async () => {
    let now = 0;
    let calls = 0;
    const probe = new ReadinessProbe({
      check: async () => { calls += 1; return {}; },
      successTtlMs: 1_000,
      failureTtlMs: 500,
      timeoutMs: 1_000,
      now: () => now,
    });

    expect(await probe.status()).toBe("ready");
    expect(calls).toBe(1);
    now = 999;
    expect(await probe.status()).toBe("ready");
    expect(calls).toBe(1);
    now = 1_001;
    expect(await probe.status()).toBe("ready");
    expect(calls).toBe(2);
  });

  test("caches a failed dependency for the failure TTL and recovers afterwards", async () => {
    let now = 0;
    let calls = 0;
    let fail = true;
    const probe = new ReadinessProbe({
      check: async () => {
        calls += 1;
        if (fail) throw new Error("SENTINEL_BACKEND_DETAIL");
        return {};
      },
      successTtlMs: 1_000,
      failureTtlMs: 100,
      timeoutMs: 1_000,
      now: () => now,
    });

    expect(await probe.status()).toBe("unavailable");
    expect(calls).toBe(1);
    now = 99;
    expect(await probe.status()).toBe("unavailable");
    expect(calls).toBe(1);
    fail = false;
    now = 100;
    expect(await probe.status()).toBe("ready");
    expect(calls).toBe(2);
  });

  test("coalesces concurrent checks into one backend request", async () => {
    let calls = 0;
    let resolveCheck!: (value: unknown) => void;
    const probe = new ReadinessProbe({
      check: () => {
        calls += 1;
        return new Promise((resolve) => { resolveCheck = resolve; });
      },
      successTtlMs: 1_000,
      failureTtlMs: 1_000,
      timeoutMs: 1_000,
      now: () => 0,
    });

    const first = probe.status();
    const second = probe.status();
    await tick();
    expect(calls).toBe(1);
    resolveCheck({});
    expect(await first).toBe("ready");
    expect(await second).toBe("ready");
  });

  test("bounds a hanging check, does not stack another while it is still running, and accepts its late result", async () => {
    let now = 0;
    let calls = 0;
    let resolveCheck!: (value: unknown) => void;
    const probe = new ReadinessProbe({
      check: () => {
        calls += 1;
        return new Promise((resolve) => { resolveCheck = resolve; });
      },
      successTtlMs: 1_000,
      failureTtlMs: 100,
      timeoutMs: 10,
      now: () => now,
    });

    expect(await probe.status()).toBe("unavailable");
    expect(calls).toBe(1);
    now = 1_000;
    expect(await probe.status()).toBe("unavailable");
    expect(calls).toBe(1);

    resolveCheck({});
    await tick();
    expect(await probe.status()).toBe("ready");
    expect(calls).toBe(1);
  });

  test("reports draining immediately without consulting the dependency", async () => {
    let calls = 0;
    const probe = new ReadinessProbe({
      check: async () => { calls += 1; return {}; },
      now: () => 0,
    });
    probe.beginDrain();
    expect(probe.isDraining).toBe(true);
    expect(await probe.status()).toBe("draining");
    expect(calls).toBe(0);
  });

  test("exposes only a safe status body and never the dependency error", async () => {
    const probe = new ReadinessProbe({
      check: async () => { throw new Error("SENTINEL_BACKEND_DETAIL"); },
      now: () => 0,
    });
    const response = readinessResponse(await probe.status());
    expect(response.status).toBe(503);
    expect(await response.text()).toBe('{"status":"unavailable"}');
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("content-type")).toContain("application/json");
  });
});

describe("recent internal error signal", () => {
  test("healthy dependency plus a recent internal failure reports unavailable without detail", async () => {
    let now = 0;
    const probe = new ReadinessProbe({
      check: async () => ({}),
      successTtlMs: 60_000,
      now: () => now,
    });
    const signal = new InternalErrorSignal({ now: () => now });

    expect(readinessStateWithInternalError(await probe.status(), signal)).toBe("ready");
    signal.mark();
    const state = readinessStateWithInternalError(await probe.status(), signal);
    expect(state).toBe("unavailable");
    expect(readinessStateWithInternalError(await probe.status(), signal)).toBe("unavailable");
    expect(await readinessResponse(state).text()).toBe('{"status":"unavailable"}');
  });

  test("expires after the 30 minute TTL and healthy probes do not clear it", () => {
    let now = 0;
    const signal = new InternalErrorSignal({ now: () => now });
    signal.mark();

    expect(readinessStateWithInternalError("ready", signal)).toBe("unavailable");
    now = INTERNAL_ERROR_TTL_MS - 1;
    expect(readinessStateWithInternalError("ready", signal)).toBe("unavailable");
    now = INTERNAL_ERROR_TTL_MS;
    expect(readinessStateWithInternalError("ready", signal)).toBe("ready");

    expect(new InternalErrorSignal({ now: () => 0 }).active).toBe(false);
  });

  test("draining takes precedence over a recent internal failure", () => {
    const signal = new InternalErrorSignal({ now: () => 0 });
    signal.mark();
    expect(readinessStateWithInternalError("draining", signal)).toBe("draining");
  });
});

describe("RequestTracker", () => {
  test("resolves waiters when the last request finishes", async () => {
    const tracker = new RequestTracker();
    tracker.begin();
    tracker.begin();
    expect(tracker.count).toBe(2);
    const idle = tracker.waitForIdle(1_000);
    tracker.end();
    expect(tracker.count).toBe(1);
    tracker.end();
    expect(await idle).toBe(true);
  });

  test("bounds the wait and reports a timeout", async () => {
    const tracker = new RequestTracker();
    tracker.begin();
    expect(await tracker.waitForIdle(10)).toBe(false);
    tracker.end();
    expect(tracker.count).toBe(0);
  });
});

describe("graceful shutdown", () => {
  const log = () => {
    const events: OperabilityLogEvent[] = [];
    const logger = createOperabilityLogger({
      release: "13.2.2",
      now: () => new Date("2026-01-01T00:00:00.000Z"),
      sink: (line) => events.push(JSON.parse(line.replace("[brainllm] ", "")) as OperabilityLogEvent),
    });
    return { events, logger };
  };

  test("marks draining, lets in-flight work finish, then closes transports, server and exits once", async () => {
    const tracker = new RequestTracker();
    const order: string[] = [];
    const { events, logger } = log();
    let exits = 0;
    const shutdown = createGracefulShutdown({
      tracker,
      graceMs: 500,
      markDraining: () => { order.push("drain"); },
      closeTransports: async () => { order.push("transports"); },
      closeServer: async () => { order.push("server"); },
      log: logger,
      exit: (code) => { exits += 1; order.push(`exit:${code}`); },
    });

    tracker.begin();
    const running = shutdown("SIGTERM");
    expect(order).toEqual(["drain"]);
    await tick();
    order.push("work-complete");
    tracker.end();
    await running;

    expect(order).toEqual(["drain", "work-complete", "transports", "server", "exit:0"]);
    expect(exits).toBe(1);
    expect(events.map((event) => event.phase)).toEqual(["started", "drained"]);
    expect(events[1].status).toBe("ok");

    await shutdown("SIGINT");
    expect(exits).toBe(1);
  });

  test("forces transport and server close after the grace expires", async () => {
    const tracker = new RequestTracker();
    const order: string[] = [];
    const { events, logger } = log();
    const shutdown = createGracefulShutdown({
      tracker,
      graceMs: 10,
      markDraining: () => { order.push("drain"); },
      closeTransports: async () => { order.push("transports"); },
      closeServer: async () => { order.push("server"); },
      log: logger,
      exit: () => { order.push("exit"); },
    });

    tracker.begin();
    await shutdown("SIGTERM");
    expect(order).toEqual(["drain", "transports", "server", "exit"]);
    expect(events.map((event) => event.phase)).toEqual(["started", "grace_expired"]);
    tracker.end();
  });

  test("bounds the whole shutdown when a transport close never settles", async () => {
    const tracker = new RequestTracker();
    const order: string[] = [];
    const { events, logger } = log();
    let exits = 0;
    const shutdown = createGracefulShutdown({
      tracker,
      graceMs: 25,
      markDraining: () => { order.push("drain"); },
      closeTransports: () => new Promise<void>(() => {}),
      closeServer: async () => { order.push("server"); },
      log: logger,
      exit: () => { exits += 1; order.push("exit"); },
    });

    const started = Date.now();
    await shutdown("SIGTERM");

    expect(Date.now() - started).toBeLessThan(1_000);
    expect(exits).toBe(1);
    expect(order).toContain("server");
    expect(order).toContain("exit");
    expect(events.at(-1)?.phase).toBe("close_timeout");
    expect(events.at(-1)?.status).toBe("error");
  }, 1_000);
});

describe("safe operation logging", () => {
  test("allowlists metadata and drops secret-bearing extras", () => {
    const lines: string[] = [];
    const logger = createOperabilityLogger({
      release: "13.2.2",
      now: () => new Date("2026-01-01T00:00:00.000Z"),
      sink: (line) => lines.push(line),
    });

    logger({
      event: "http_request",
      method: "POST",
      route: "mcp",
      status: 200,
      durationMs: 12.6,
      tool: "../../SENTINEL_SECRET",
      ...( { body: "SENTINEL_SECRET", authorization: "Bearer SENTINEL_SECRET" } as object),
    } as OperabilityLogEvent);

    const record = JSON.parse(lines[0].replace("[brainllm] ", "")) as Record<string, unknown>;
    expect(record.event).toBe("http_request");
    expect(record.method).toBe("POST");
    expect(record.route).toBe("mcp");
    expect(record.status).toBe(200);
    expect(record.durationMs).toBe(13);
    expect(record.release).toBe("13.2.2");
    expect(record.tool).toBe("unknown");
    expect(lines[0]).not.toContain("SENTINEL_SECRET");
  });

  test("drops identifier-shaped but unregistered MCP methods and tools", () => {
    const lines: string[] = [];
    const logger = createOperabilityLogger({
      release: "13.2.2",
      now: () => new Date("2026-01-01T00:00:00.000Z"),
      sink: (line) => lines.push(line),
    });

    logger({
      event: "mcp_request",
      method: "private_method_SENTINEL_9",
      tool: "private_tool_SENTINEL_9",
      status: "ok",
    });

    const record = JSON.parse(lines[0].replace("[brainllm] ", "")) as Record<string, unknown>;
    expect(record.method).toBe("unknown");
    expect(record.tool).toBe("unknown");
    expect(lines[0]).not.toContain("SENTINEL");
  });

  test("logs tool name, status and duration from the transport but never arguments, results or error text", async () => {
    const lines: string[] = [];
    const logger = createOperabilityLogger({
      release: "13.2.2",
      now: () => new Date("2026-01-01T00:00:00.000Z"),
      sink: (line) => lines.push(line),
    });
    const tracker = new RequestTracker();
    const transport: Transport = {
      start: async () => {},
      send: async () => {},
      close: async () => {},
      onmessage: undefined,
    };
    let internalFailures = 0;
    instrumentTransport(transport, {
      tracker,
      log: logger,
      onInternalError: () => { internalFailures += 1; },
    });

    transport.onmessage!({
      jsonrpc: "2.0",
      id: 7,
      method: "tools/call",
      params: { name: "remember", arguments: { content: "SENTINEL_SECRET" } },
    } as JSONRPCMessage);
    expect(tracker.count).toBe(1);

    await transport.send({
      jsonrpc: "2.0",
      id: 7,
      result: { content: [{ type: "text", text: "SENTINEL_SECRET" }], isError: true },
    } as JSONRPCMessage);
    expect(tracker.count).toBe(0);
    expect(internalFailures).toBe(1);

    const record = JSON.parse(lines[0].replace("[brainllm] ", "")) as Record<string, unknown>;
    expect(record.event).toBe("mcp_request");
    expect(record.method).toBe("tools/call");
    expect(record.tool).toBe("remember");
    expect(record.status).toBe("internal_error");
    expect(typeof record.durationMs).toBe("number");
    expect(record.release).toBe("13.2.2");
    expect(lines[0]).not.toContain("SENTINEL_SECRET");
    expect(lines[0]).not.toContain("arguments");
  });

  test("latches for server internal errors and tool failures, not client rejections", async () => {
    const lines: string[] = [];
    const logger = createOperabilityLogger({
      release: "13.2.2",
      now: () => new Date("2026-01-01T00:00:00.000Z"),
      sink: (line) => lines.push(line),
    });
    const transport: Transport = {
      start: async () => {},
      send: async () => {},
      close: async () => {},
      onmessage: undefined,
    };
    let internalFailures = 0;
    instrumentTransport(transport, {
      log: logger,
      onInternalError: () => { internalFailures += 1; },
    });

    const call = async (id: number, outcome: Record<string, unknown>) => {
      transport.onmessage!({
        jsonrpc: "2.0",
        id,
        method: "tools/call",
        params: { name: "remember", arguments: { content: "SENTINEL_ARGUMENT" } },
      } as JSONRPCMessage);
      await transport.send({ jsonrpc: "2.0", id, ...outcome } as JSONRPCMessage);
    };

    await call(11, { result: { content: [] } });
    expect(internalFailures).toBe(0);
    await call(12, { error: { code: -32602, message: "SENTINEL_INVALID_PARAMS" } });
    expect(internalFailures).toBe(0);
    await call(13, { error: { code: -32601, message: "SENTINEL_UNKNOWN_METHOD" } });
    expect(internalFailures).toBe(0);
    await call(131, { result: { content: [{ type: "text", text: "MCP error -32602: Input validation error: Invalid arguments for tool remember: SENTINEL_INVALID_PARAMS" }], isError: true } });
    expect(internalFailures).toBe(0);
    await call(14, { error: { code: -32603, message: "SENTINEL_INTERNAL" } });
    expect(internalFailures).toBe(1);
    await call(15, { result: { content: [{ type: "text", text: "SENTINEL_RESULT" }], isError: true } });
    expect(internalFailures).toBe(2);
    await call(16, { result: { content: [{ type: "text", text: "MCP error -32602: Output validation error: SENTINEL_INVALID_OUTPUT" }], isError: true } });
    expect(internalFailures).toBe(3);

    expect(lines.join("\n")).not.toContain("SENTINEL");
  });

  test("logs unknown for identifier-shaped but unregistered incoming methods and tool names", async () => {
    const lines: string[] = [];
    const logger = createOperabilityLogger({
      release: "13.2.2",
      now: () => new Date("2026-01-01T00:00:00.000Z"),
      sink: (line) => lines.push(line),
    });
    const tracker = new RequestTracker();
    const transport: Transport = {
      start: async () => {},
      send: async () => {},
      close: async () => {},
      onmessage: undefined,
    };
    instrumentTransport(transport, { tracker, log: logger });

    transport.onmessage!({
      jsonrpc: "2.0",
      id: 8,
      method: "private_method_SENTINEL_9",
      params: { name: "private_tool_SENTINEL_9", arguments: { query: "SENTINEL_SECRET" } },
    } as JSONRPCMessage);
    await transport.send({ jsonrpc: "2.0", id: 8, result: {} } as JSONRPCMessage);

    const record = JSON.parse(lines[0].replace("[brainllm] ", "")) as Record<string, unknown>;
    expect(record.method).toBe("unknown");
    expect(record.tool).toBe("unknown");
    expect(lines[0]).not.toContain("SENTINEL");
  });

  test("releases pending work and logs aborts when a transport closes", async () => {
    const lines: string[] = [];
    const logger = createOperabilityLogger({
      release: "13.2.2",
      now: () => new Date("2026-01-01T00:00:00.000Z"),
      sink: (line) => lines.push(line),
    });
    const tracker = new RequestTracker();
    const transport: Transport = {
      start: async () => {},
      send: async () => {},
      close: async () => {},
      onmessage: undefined,
    };
    instrumentTransport(transport, { tracker, log: logger });

    transport.onmessage!({
      jsonrpc: "2.0",
      id: "request-1",
      method: "tools/call",
      params: { name: "recall", arguments: { query: "SENTINEL_SECRET" } },
    } as JSONRPCMessage);
    expect(tracker.count).toBe(1);
    await transport.close();
    expect(tracker.count).toBe(0);

    const record = JSON.parse(lines[0].replace("[brainllm] ", "")) as Record<string, unknown>;
    expect(record.event).toBe("mcp_request");
    expect(record.tool).toBe("recall");
    expect(record.status).toBe("aborted");
    expect(lines[0]).not.toContain("SENTINEL_SECRET");
  });
});

describe("HTTP route classification", () => {
  test("maps known operations to fixed labels and keeps query strings out", () => {
    expect(classifyHttpRoute("/health")).toBe("health");
    expect(classifyHttpRoute("/ready")).toBe("ready");
    expect(classifyHttpRoute("/mcp")).toBe("mcp");
    expect(classifyHttpRoute("/sse")).toBe("sse");
    expect(classifyHttpRoute("/messages")).toBe("messages");
    expect(classifyHttpRoute("/authorize")).toBe("oauth");
    expect(classifyHttpRoute("/token")).toBe("oauth");
    expect(classifyHttpRoute("/register")).toBe("oauth");
    expect(classifyHttpRoute("/.well-known/oauth-protected-resource")).toBe("discovery");
    expect(classifyHttpRoute("/favicon.ico")).toBe("assets");
    expect(classifyHttpRoute("/icon-512.png")).toBe("assets");
    expect(classifyHttpRoute(new URL("http://example.test/mcp?token=SENTINEL").pathname)).toBe("mcp");
    expect(classifyHttpRoute("/unknown/SENTINEL")).toBe("unknown");
    expect(shouldLogHttpRoute("mcp")).toBe(true);
    expect(shouldLogHttpRoute("unknown")).toBe(true);
    expect(shouldLogHttpRoute("health")).toBe(false);
    expect(shouldLogHttpRoute("ready")).toBe(false);
    expect(shouldLogHttpRoute("assets")).toBe(false);
  });
});
