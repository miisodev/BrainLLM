# BrainLLM

An MCP (Model Context Protocol) server that turns [TriliumNext Notes](https://github.com/TriliumNext/Notes) into a persistent, graph-structured second brain for Claude and other LLM clients.

**v5: a six-area mind with a typed tool surface.** The brain is organised into six purpose-built areas (Master, LLM, Memory, Knowledge, Insights, Templates), each note type carries a **blueprint** that the tools enforce, and the model works through a clean surface: per-area read tools, single-word universal verbs, and a raw ETAPI escape hatch. Placement, format, lifecycle, dates and backups are server policy — the model supplies content, the server owns form.

<div align="center">

### If BrainLLM is useful to you, consider supporting its development

[![Donate via PayPal](https://img.shields.io/badge/Donate-PayPal-009cde?style=for-the-badge&logo=paypal&logoColor=white)](https://paypal.me/miisodev?locale.x=en_US&country.x=ZA)

</div>

---

## Features

- **Six-area structure** — Master (the user), LLM (the assistant's self-model), Memory (sessions + threads), Knowledge (learned domains), Insights (auto change-logs), Templates (the blueprints). Built and engraved at bootstrap.
- **Blueprints enforce form** — every note type has a blueprint (Structure / Format / Lifecycle / Maintenance / Example); the core tools produce exactly the blueprint's shape, so documentation and reality can't drift.
- **Typed tool surface** — **surface reads** (`master`/`master_recall`, `memory`/`memory_recall`, …), **universal verbs** (`start`, `close`, `bootstrap`, `remember`, `recall`, `revise`, `resolve`, `connect`, `explore`, `maintain`, `forget`), and **raw ETAPI** behind `BRAINLLM_MODE=full`.
- **Interconnection** — a closed relation vocabulary, `connect` to wire, `explore` to traverse (links / backlinks / neighborhood / path), and `maintain` to surface unconnected notes.
- **Graceful lifecycle** — threads degrade active → dormant → archived-in-place; nothing is deleted. The maintenance sweep ages work and surfaces stale or orphaned notes.
- **Timezone-correct dates** — BrainLLM sends Trilium its local now, so every `dateCreated`/`dateModified`, the calendar, sessions and logs land in the user's timezone (set `BRAINLLM_TZ` on a hosted deploy).
- **Auto change-logs + awareness** — a per-day Insights log of what changed (idempotent, sourced from Trilium's own history), and `start` opens with the date, weekday and continuity.
- **Zero ID pasting** — `bootstrap` builds the tree and writes `brainllm.json`; auto-discovery rebuilds config if the file is missing.

---

## Prerequisites

- [Bun](https://bun.sh) v1.0+
- A running [TriliumNext](https://github.com/TriliumNext/Notes) instance (desktop or server)

---

## Installation

```bash
git clone https://github.com/miisodev/BrainLLM
cd BrainLLM
bun install
bun run build
```

---

## Configuration

### 1. Get your ETAPI token

In Trilium: **Options → ETAPI → Create token**

### 2. Set environment variables

Copy `.env.example` to `.env` and fill in:

```env
TRILIUM_BASE_URL=http://localhost:8080
TRILIUM_ETAPI_TOKEN=your-token-here
# Optional: the user's timezone (IANA) for correct date stamping on a hosted server.
# Unset = the host's local clock (correct when BrainLLM runs on the user's own machine).
BRAINLLM_TZ=Africa/Johannesburg
# Optional: expose the raw ETAPI surface as well.
BRAINLLM_MODE=full
```

### 3. Configure Claude Desktop

| Platform | Path |
|----------|------|
| Windows  | `%APPDATA%\Claude\claude_desktop_config.json` |
| macOS    | `~/Library/Application Support/Claude/claude_desktop_config.json` |
| Linux    | `~/.config/Claude/claude_desktop_config.json` |

```json
{
  "mcpServers": {
    "BrainLLM": {
      "command": "bun",
      "args": ["run", "/absolute/path/to/BrainLLM/dist/index.js"],
      "env": {
        "TRILIUM_BASE_URL": "http://localhost:8080",
        "TRILIUM_ETAPI_TOKEN": "your-etapi-token-here"
      }
    }
  }
}
```

Restart Claude Desktop — the BrainLLM tools appear in the MCP tools list.

---

## Cloud / Remote setup

Use this when Trilium isn't on the same machine as the MCP server — e.g. Claude on the web, or Trilium on a VPS. Put Trilium behind HTTPS (Caddy/nginx reverse proxy, or a [Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/) for a zero-config endpoint), then point `TRILIUM_BASE_URL` at it.

### Transport modes: local (stdio) vs remote (HTTP)

BrainLLM runs in one of two transport modes, selected by `PORT`:

| Mode | When | Selected by |
|------|------|-------------|
| **stdio** | Local Claude Desktop / Claude Code spawns BrainLLM as a child process | `PORT` **unset** (default) |
| **HTTP connector** | Remote clients reach BrainLLM over the network | `PORT` **set** (Railway sets it for you) |

When `PORT` is set, BrainLLM serves a streamable-HTTP MCP server: `/mcp` (one session per `mcp-session-id`) and `GET /health`. Set `MCP_AUTH_TOKEN` to require `Authorization: Bearer <token>` on `/mcp`. The HTTP deployment also runs the daily change-log generation.

### Deploy with Docker / Railway

The included [`Dockerfile`](./Dockerfile) builds and runs the HTTP connector. On **Railway**, `PORT` is injected automatically — set `MCP_AUTH_TOKEN`, `TRILIUM_BASE_URL`, `TRILIUM_ETAPI_TOKEN` and `BRAINLLM_TZ` as service variables and deploy. Point your client at `https://<app>.up.railway.app/mcp` with the bearer token.

---

## First-time setup

On a fresh Trilium instance, ask Claude to run `bootstrap`. It builds the six-area tree (each note engraved with its purpose), creates the per-type blueprints, writes `brainllm.json`, and activates config immediately — no restart, no manual ID copying. Or via CLI:

```bash
TRILIUM_BASE_URL=http://localhost:8080 TRILIUM_ETAPI_TOKEN=your-token bun run init
```

---

## Structure

```
BrainLLM  (#brainLlmRoot)
├── 👤 Master       biography · goals · preferences              (maintained singletons)
├── 🤖 LLM          responsibilities · protocols · Diary/        (singletons + daily diary)
├── 🗂️ Memory       Sessions/ · Threads/                         (daily summaries + running work)
├── 📚 Knowledge    Master/ · Domains/[domain]/{ Sources, info } (learned, beyond/contra training)
├── 💡 Insights     Logs/                                        (auto per-day change logs)
└── 🧩 Templates    blueprints per note type                     (the form contract)
```

The model never chooses placement — `remember(kind=…)` routes it. Domains are created on first use; each holds one maintained **Sources** note (❇️ discovered / ✅ used) plus sub-category **information** notes.

---

## Tools

### Core — universal verbs

`start` · `close` · `bootstrap` · `remember` · `recall` · `revise` · `resolve` · `connect` · `explore` · `maintain` · `forget`

### Core — surface reads (dual-mode)

`master`/`master_recall` · `llm`/`llm_recall` · `memory`/`memory_recall` · `knowledge`/`knowledge_recall` · `insights`/`insights_recall` · `templates`/`templates_recall`

### Full mode (`BRAINLLM_MODE=full`)

32 raw ETAPI tools — notes, attributes, branches, revisions, attachments, calendar, and system — brain-agnostic, for surgery the core can't do.

See `skills/brainllm/SKILL.md` for the operational guide.

---

## Lifecycle

```
   active ───────────────▶ resolved | superseded   (terminal — archived in place)
     │ untouched dormantAfterDays
     ▼
   dormant ──────────────▶ archived in place (#archived; excluded from default recall)
     │ untouched archiveDormantAfterDays more
     ▼
```

Threads age on this timeline; singletons are maintained; sessions/diary/logs are records. Timings are configurable in `brainllm.json`:

```json
"policy": { "dormantAfterDays": 21, "archiveDormantAfterDays": 45, "staleAfterDays": 7 }
```

---

## Relations (closed vocabulary)

`relatesTo · extends · contradicts · supports · causes · references · partOf · worksWith · mentors · instanceOf · supersedes · implements · inspiredBy · sourceOf · derivedFrom`

`worksWith` is symmetric (wired both ways). `connect` is idempotent.

---

## Development

```bash
bun run dev    # hot-reload dev server
bun run build  # compile to dist/index.js
bun run test   # integration tests (requires a live Trilium instance)
bun run init   # CLI bootstrap
```

---

## Credits

- [TriliumNext Notes](https://github.com/TriliumNext/Notes) — the open-source, self-hosted knowledge base that powers this MCP server's backend. BrainLLM would not exist without the TriliumNext team's work.
