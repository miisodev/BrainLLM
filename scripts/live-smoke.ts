// Post-deploy smoke test against a running BrainLLM, over real MCP.
//
// The session that ships a release cannot call its own new tools: its client
// cached the tool schemas when it connected, before the deploy. This connects
// fresh, so it sees exactly what a new session will see, and it is the release
// workflow's check that the deployed server is the one just tagged.
//
//   BRAINLLM_LIVE_TOKEN=<MCP_AUTH_TOKEN> bun run test:live [url]
//
// Read-only: it calls only tools annotated readOnlyHint, so it is safe against
// a production brain. Exits 1 on any failure.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import pkg from "../package.json" with { type: "json" };

const url = process.argv[2] ?? process.env.BRAINLLM_LIVE_URL ?? "https://brainllm.miiso.dev/mcp";
const token = process.env.BRAINLLM_LIVE_TOKEN ?? process.env.MCP_AUTH_TOKEN;
const expectVersion = process.env.BRAINLLM_EXPECT_VERSION ?? pkg.version;
if (!token) {
  console.error("Set BRAINLLM_LIVE_TOKEN (the server's MCP_AUTH_TOKEN) to run the live smoke test.");
  process.exit(1);
}

const failures: string[] = [];
const check = (ok: boolean, label: string, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` - ${detail}` : ""}`);
  if (!ok) failures.push(label);
};

const client = new Client({ name: "brainllm-live-smoke", version: pkg.version });
const transport = new StreamableHTTPClientTransport(new URL(url), {
  requestInit: { headers: { Authorization: `Bearer ${token}` } },
});

try {
  await client.connect(transport);
  const info = client.getServerVersion();
  check(info?.version === expectVersion, "deployed version", `${info?.version ?? "none"} (expected ${expectVersion})`);
  check(!!info?.icons?.length, "server icons advertised", `${info?.icons?.length ?? 0} icon(s)`);

  const { tools } = await client.listTools();
  check(tools.length > 0, "tools listed", `${tools.length} tools`);
  const untitled = tools.filter((t) => !t.title && !t.annotations?.title).map((t) => t.name);
  check(!untitled.length, "every tool has a title", untitled.join(", "));
  const unhinted = tools.filter((t) => t.annotations?.readOnlyHint === undefined).map((t) => t.name);
  check(!unhinted.length, "every tool has readOnlyHint", unhinted.join(", "));

  const readOnly = new Set(tools.filter((t) => t.annotations?.readOnlyHint === true).map((t) => t.name));
  const probes: Array<[string, Record<string, unknown>]> = [
    ["health", {}],
    ["template", { kind: "thread" }],
    ["recall", { query: "BrainLLM", limit: 1 }],
  ];
  for (const [name, args] of probes) {
    if (!readOnly.has(name)) {
      check(false, `${name} is read-only and present`);
      continue;
    }
    const started = performance.now();
    const result = await client.callTool({ name, arguments: args });
    const ms = Math.round(performance.now() - started);
    const text = (result.content as Array<{ type: string; text?: string }>)[0]?.text ?? "";
    const ok = !result.isError && !/"error":/.test(text.slice(0, 200));
    check(ok, `call ${name}`, `${ms} ms, ${text.length} chars`);
  }
} catch (error) {
  check(false, "connect and run", error instanceof Error ? error.message : String(error));
} finally {
  await client.close().catch(() => {});
}

if (failures.length) {
  console.error(`\n${failures.length} check(s) failed against ${url}.`);
  process.exit(1);
}
console.log(`\nLive smoke passed against ${url}.`);
