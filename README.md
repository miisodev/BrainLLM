<div align="center">

<img src="./public/BrainLLM.png" alt="BrainLLM logo" width="150" />

# BrainLLM

An MCP (Model Context Protocol) server that turns [TriliumNext Notes](https://github.com/TriliumNext/Notes) into a persistent, graph-structured second brain for Claude and other LLM clients.

</div>

**v7.0: relation-aware, self-tracking, and self-repairing.** Every core read/write/search tool now surfaces a relation snippet for free, a standing "BrainLLM" thread tracks the project's own development every session under an enforced pre-close protocol, and `label()`/`inspect()` close the gap to raw mode for direct attribute work. Underneath, the brain is still organised into five purpose-built areas (Master, LLM, Memory, Knowledge, Insights), worked through a clean surface — per-area read tools, single-word universal verbs, and a raw ETAPI escape hatch now reserved for genuine edge cases. Placement, format, lifecycle, dates and backups are server policy — the model supplies content, the server owns form.

<div align="center">

### If BrainLLM is useful to you, consider supporting its development

[![Donate via PayPal](https://img.shields.io/badge/Donate-PayPal-009cde?style=for-the-badge&logo=paypal&logoColor=white)](https://paypal.me/miisodev?locale.x=en_US&country.x=ZA)

</div>

---

## Features

- **Five-area structure** — Master (the user), LLM (the assistant's self-model), Memory (sessions + threads), Knowledge (learned domains), Insights (per-session logs). Built and labelled at bootstrap.
- **Typed tool surface** — **surface reads** (`master`/`master_recall`, `memory`/`memory_recall`, …), **universal verbs** (`start`, `session`, `remarks`, `close`, `brain`, `bootstrap`, `remember`, `diary`, `recall`, `domain`, `addendum`, `revise`, `resolve`, `reopen`, `recover`, `label`, `connect`, `explore`, `inspect`, `maintain`, `forget`, `backup`), and **raw ETAPI** behind `BRAINLLM_MODE=full` — kept as a true edge-case fallback now that `label()`/`inspect()` cover direct attribute surgery natively.
- **Relation snippets everywhere** — every core read, write, and search tool returns a `relations` snippet (outbound `{relation, toNoteId}` edges) alongside its usual payload, for free — the attributes are already loaded from the same fetch. `explore()` remains the tool for target titles or deeper traversal.
- **A standing self-analysis thread** — the "BrainLLM" thread under Memory → Threads carries `status=eternal`: exempt from the active → dormant → archived timeline and structurally protected against `resolve()`/`reopen()`/`forget()`, so it stays open indefinitely. Its body is a chronological stack of dated addendum blocks, same shape as diary/session/log. `start()` surfaces it every session; `remarks()` is its default write tool — call bare for 8 cue questions (capabilities, issues/bugs, usability, memory/token efficiency, performance, hygiene/tool inventory, roadmap), call again with answers to log them as one dated block.
- **Enforced pre-close gate** — `close()` refuses (an informational error, not a throw) unless `diary()`, `session()`, `remarks()` (write mode), `addendum()`, and `maintain()` have each actually been called this session — narrating that you did them doesn't count, only the tool call does. `force=true` bypasses a step with genuinely nothing to log, reported back as `bypassed` rather than silently skipped. The gate is in-memory, resets each connection, and clears itself after a successful `close()`.
- **`label()` and `inspect()` close the gap to full mode** — `label(noteId, name, value?, remove?)` is the guarded core path for direct label surgery (fixing a stray or drifted value): refused on containers, `noteType` untouchable, `status` validated against the closed vocabulary, `domain`/`topic` auto-slugged. `inspect(noteId)` is the full raw read — every label, every outbound relation, type/mime/parent/child ids — for debugging drift or confirming a fix landed. Raw ETAPI attribute tools (`BRAINLLM_MODE=full`) are now a true edge-case fallback rather than something routine BrainLLM operation needs to reach for.
- **Full orientation on start** — `start()` returns the user's **goals in full**, **preferences in full**, and the model's **protocols in full**, plus today's diary note and a delta of notes changed since the last session. No separate reads needed to act from them.
- **Dedicated diary tool** — `diary(body)` writes to today's LLM diary entry (one note per day, created empty by `start()`; same-day calls append a timestamped addendum).
- **Retry-safe writes** — all append-mode write tools (`diary`, `remember`, `revise`, `reopen`, `recover`) detect duplicate content on retries and return `action: "already_written"` instead of double-writing. `connect()` and `resolve()` are idempotent by design.
- **Full brain tree** — `brain()` surfaces every typed note across all five content areas, grouped by area with id/title/kind/status/dates — audit the whole brain in one call.
- **One-per-day discipline** — diary, session, and log notes are each limited to one per day; subsequent writes on the same day append. Session and log notes are linked with `~references` after each `close()`.
- **Mandatory pre-close step** — `session()` runs before `close()`: fetches all master and LLM singletons in full with last-modified dates, today's diary entry, and the maintenance sweep — then returns a `next[]` protocol driving singleton updates → `diary()` → `addendum()` → `maintain()` → `remarks()` → `close()`. Ensures singletons are evolved from the session before the log is committed.
- **HTML-native writes** — all write tools enforce Trilium/CKEditor 5 rules: `<h1>` demoted to `<h2>`, `<h5>`/`<h6>` to `<h4>`, `<div>` replaced with `<p>`, forbidden elements stripped, dangling tags closed. Mutations are reported as `sanitized: string[]` in the tool return. Informational error returns (`{error, detail, hint}`) replace thrown exceptions for user-input mistakes.
- **Interconnection** — a closed relation vocabulary, `connect` to wire, `explore` to traverse (links / backlinks / neighborhood / path), and `maintain` to surface unconnected notes.
- **Graceful lifecycle** — threads degrade active → dormant → archived-in-place; nothing is deleted. The maintenance sweep (lite: thread aging + unlabeled-node check; deep: stale-review, orphan/sink report across Memory/Threads and Knowledge with brain-wide inbound detection, duplicate-title detection across all six typed containers plus per-domain information/sources) keeps the brain tidy. `recover()` undoes `forget()`.
- **Timezone-correct dates** — BrainLLM sends Trilium its local now, so every `dateCreated`/`dateModified`, the calendar, sessions and logs land in the user's timezone (set `BRAINLLM_TZ` on a hosted deploy).
- **Per-session change-logs** — `close()` generates a per-day Insights log (sourced from Trilium's own history); `start()` surfaces the delta since the last session so the model always knows what changed.
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

When `PORT` is set, BrainLLM serves a streamable-HTTP MCP server: `/mcp` (one session per `mcp-session-id`) and `GET /health`. Set `MCP_AUTH_TOKEN` to require `Authorization: Bearer <token>` on `/mcp`.

### Deploy with Docker / Railway

The included [`Dockerfile`](./Dockerfile) builds and runs the HTTP connector. On **Railway**, `PORT` is injected automatically — set `MCP_AUTH_TOKEN`, `TRILIUM_BASE_URL`, `TRILIUM_ETAPI_TOKEN` and `BRAINLLM_TZ` as service variables and deploy. Point your client at `https://<app>.up.railway.app/mcp` with the bearer token.

For config persistence across redeploys, add a volume to the **BrainLLM MCP service** (separate from the Trilium service's data volume) and set `BRAINLLM_CONFIG` to a file path inside it:

```bash
# Railway CLI — create and mount the volume, then set the config path
railway volume -p <project-id> -s <brainllm-service-id> -e production add --mount-path /vol
railway variables set BRAINLLM_CONFIG=/vol/brainllm.json
```

Without this, `BRAINLLM_CONFIG` should be left unset — the server auto-discovers from Trilium on each cold start via `#brainLlmRoot`, which is cheap but adds ~1 s to startup. Do **not** point `BRAINLLM_CONFIG` at Trilium's data directory; that path only exists on the Trilium service and will cause a startup ENOENT.

---

## First-time setup

On a fresh Trilium instance, ask Claude to run `bootstrap`. It builds the five-area tree (each area engraved with its purpose), writes `brainllm.json`, and activates config immediately — no restart, no manual ID copying. Or via CLI:

```bash
TRILIUM_BASE_URL=http://localhost:8080 TRILIUM_ETAPI_TOKEN=your-token bun run init
```

---

## Adapting to your environment

A handful of values in this repo reflect the author's own machine. None are secrets, but if you clone or fork, review these and swap in your own:

| What | Where | Make it yours |
|---|---|---|
| **Timezone** | `BRAINLLM_TZ` in `.env` (the example shows `Africa/Johannesburg`) | Your IANA zone (e.g. `America/New_York`) — or leave it unset to use the host clock, which is correct when BrainLLM runs on your own machine. |
| **Config path** | `BRAINLLM_CONFIG` env var (unset by default) | On Railway or any persistent-volume deploy, mount a volume on the **MCP service** (not the Trilium service) and set this to a file path inside it (e.g. `/vol/brainllm.json`) so config survives redeploys. Leave unset for local/stdio use — auto-discovery handles startup. Do not point it at Trilium's data directory. |
| **Trilium launcher** | `scripts/start-trilium.ps1` — hard-codes `C:\Users\…\trilium.exe` and assumes the desktop port `37840` | A Windows-only convenience script. Point the path at your Trilium install (and match `TRILIUM_BASE_URL` to its real port), or ignore it and start Trilium however you like. |
| **"Trilium isn't running" hint** | `skills/brainllm/SKILL.md` and `skills/brainllm/references/troubleshooting.md` | Both reference the author's absolute path to that script. Repoint them to your clone, or delete the line — it's only a fallback hint. |
| **Bundle path** | Claude Desktop config → `/absolute/path/to/BrainLLM/dist/index.js` | The real absolute path to `dist/index.js` on your machine. |
| **Author · repo · funding** | `package.json` (`author`, `repository`, `bugs`, `homepage`) and the PayPal badge near the top | Your own details if you fork; the funding link supports the original author. |

None of these change how the brain works — they're just the seams where one person's setup meets yours.

---

## Structure

```
BrainLLM  (#brainLlmRoot)
├── 👤 Master       biography · goals · preferences              (maintained singletons)
├── 🤖 LLM          responsibilities · protocols · Diary/        (singletons + daily diary)
├── 🗂️ Memory       Sessions/ · Threads/ (+ the standing "BrainLLM" thread)   (daily summaries + running work)
├── 📚 Knowledge    Master/ · Domains/[domain]/{ Sources, info } (learned, beyond/contra training)
└── 💡 Insights     Logs/                                        (per-session change logs)
```

The model never chooses placement — `remember(kind=…)` routes it. Domains are created on first use; each holds one maintained **Sources** note (❇️ discovered / ✅ used) plus sub-category **information** notes.

---

## Tools

### Core — universal verbs

`start` · `session` · `remarks` · `close` · `brain` · `bootstrap` · `remember` · `diary` · `recall` · `domain` · `addendum` · `revise` · `resolve` · `reopen` · `recover` · `label` · `connect` · `explore` · `inspect` · `maintain` · `forget` · `backup`

### Core — surface reads (dual-mode)

`master`/`master_recall` · `llm`/`llm_recall` · `memory`/`memory_recall` · `knowledge`/`knowledge_recall` · `insights`/`insights_recall`

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

Threads age on this timeline; singletons are maintained; sessions/diary/logs are records. The one exception is the standing **BrainLLM** thread (`status=eternal`) — it never ages and is structurally protected against `resolve()`/`reopen()`/`forget()`, so it stays open indefinitely for continuous self-analysis. Timings are configurable in `brainllm.json`:

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
