import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { TriliumClient } from "./trilium.js";
import { registerTools } from "./tools.js";
import { loadConfig, discoverBrainLLM, saveConfig, configFilePath, EMPTY_BRAINLLM } from "./config.js";
import { generateDailyLog } from "./journal.js";
import { localToday } from "./time.js";

const baseUrl = process.env.TRILIUM_BASE_URL;
const token   = process.env.TRILIUM_ETAPI_TOKEN;

if (!baseUrl || !token) {
  console.error("Missing TRILIUM_BASE_URL or TRILIUM_ETAPI_TOKEN environment variables.");
  process.exit(1);
}

const trilium = new TriliumClient(baseUrl, token);

// ── Resolve brain config ───────────────────────────────────────────────────
// Priority: brainllm.json file → auto-discovery from Trilium → empty (bootstrap needed)

let brain = loadConfig();

if (!brain) {
  console.error("[brainllm] No brainllm.json — attempting auto-discovery from Trilium...");
  try {
    brain = await discoverBrainLLM(trilium);
    if (brain) {
      saveConfig(brain);
      console.error(`[brainllm] Auto-discovered. Config written to: ${configFilePath()}`);
    } else {
      console.error("[brainllm] BrainLLM not found in Trilium. Run the bootstrap tool to initialize.");
    }
  } catch (err) {
    console.error(`[brainllm] Auto-discovery failed: ${err}`);
  }
}

// brainRef is a mutable container — bootstrap updates config in-place
// so subsequent tool calls in the same session see the new IDs immediately.
const brainRef = { config: brain ?? EMPTY_BRAINLLM };

// ── Transport ─────────────────────────────────────────────────────────────────

const port      = process.env.PORT ? parseInt(process.env.PORT, 10) : null;
const authToken = process.env.MCP_AUTH_TOKEN;

// BRAINLLM_MODE=core (default): the 12 intent-level tools.
// BRAINLLM_MODE=full: additionally registers the low-level/advanced surface.
const mode: "core" | "full" = process.env.BRAINLLM_MODE === "full" ? "full" : "core";

// Brand identity advertised in the MCP handshake (serverInfo.icons). Clients
// that render server icons show the BrainLLM logo in their connector list and
// alongside its tool calls. Assets are served raw from the public repo; the SVG
// scales for any context, the PNG is a raster fallback.
const BRANDING_ICONS = [
  { src: "https://raw.githubusercontent.com/miisodev/BrainLLM/main/public/BrainLLM.svg", mimeType: "image/svg+xml", sizes: ["any"] },
  { src: "https://raw.githubusercontent.com/miisodev/BrainLLM/main/public/BrainLLM.png", mimeType: "image/png" },
];

function createServer(): McpServer {
  const s = new McpServer({
    name: "BrainLLM",
    title: "BrainLLM",
    version: "5.0.0",
    icons: BRANDING_ICONS,
  });
  registerTools(s, trilium, brainRef, mode);
  return s;
}

if (port) {
  // ── HTTP mode — Railway / remote connector ────────────────────────────────
  // Each MCP session gets its own transport + server instance.
  // Sessions are keyed by the mcp-session-id header the client echoes back.

  const sessions = new Map<string, WebStandardStreamableHTTPServerTransport>();

  Bun.serve({
    port,
    async fetch(req: Request): Promise<Response> {
      const url = new URL(req.url);

      if (url.pathname === "/health") {
        return new Response("OK");
      }

      if (authToken) {
        const auth = req.headers.get("Authorization");
        if (auth !== `Bearer ${authToken}`) {
          return new Response(JSON.stringify({ error: "Unauthorized" }), {
            status: 401,
            headers: { "Content-Type": "application/json" },
          });
        }
      }

      if (url.pathname !== "/mcp") {
        return new Response("Not Found", { status: 404 });
      }

      const sessionId = req.headers.get("mcp-session-id");

      if (sessionId && sessions.has(sessionId)) {
        return sessions.get(sessionId)!.handleRequest(req);
      }

      if (!sessionId) {
        // Initialization request — create a fresh session
        const transport = new WebStandardStreamableHTTPServerTransport({
          sessionIdGenerator: () => crypto.randomUUID(),
          onsessioninitialized: (id) => { sessions.set(id, transport); },
          onsessionclosed:      (id) => { sessions.delete(id); },
        });

        await createServer().connect(transport);
        return transport.handleRequest(req);
      }

      return new Response(JSON.stringify({ error: "Session not found" }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      });
    },
  });

  console.error(`[brainllm] HTTP connector listening on :${port}`);

  // ── Daily log generation ──────────────────────────────────────────────────
  // Keep today's Insights/Logs note fresh and catch up recent days on startup.
  // (Runs only in the always-on HTTP deployment; locally, close triggers it.)
  const runLog = (date: string) => {
    if (!brainRef.config.root) return;
    void generateDailyLog(trilium, brainRef.config, date).catch((e) => console.error(`[brainllm] log gen failed: ${e}`));
  };
  const dayMinus = (i: number) => new Date(Date.parse(`${localToday()}T00:00:00Z`) - i * 86_400_000).toISOString().slice(0, 10);
  for (let i = 0; i <= 3; i++) runLog(dayMinus(i));
  setInterval(() => runLog(localToday()), 3 * 60 * 60 * 1000);
} else {
  // ── stdio mode — local Claude Code / desktop ──────────────────────────────
  const transport = new StdioServerTransport();
  await createServer().connect(transport);
}
