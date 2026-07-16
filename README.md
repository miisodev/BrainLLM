<div align="center">

<img src="./public/BrainLLM.png" alt="BrainLLM logo" width="150" />

# BrainLLM

**A persistent, graph-structured second brain for Claude and other LLMs — built on [TriliumNext Notes](https://github.com/TriliumNext/Notes), served over the [Model Context Protocol](https://modelcontextprotocol.io).**

[![Version](https://img.shields.io/badge/version-9.0.0-6d28d9?style=flat-square)](https://github.com/miisodev/BrainLLM/releases)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue?style=flat-square)](./LICENSE)
[![Runtime: Bun](https://img.shields.io/badge/runtime-Bun%20%E2%89%A5%201.0-f9f1e1?style=flat-square&logo=bun&logoColor=black)](https://bun.sh)
[![MCP](https://img.shields.io/badge/protocol-MCP-000000?style=flat-square)](https://modelcontextprotocol.io)
[![Sponsor](https://img.shields.io/badge/❤-Sponsor-ea4aaa?style=flat-square&logo=githubsponsors)](https://github.com/sponsors/miisodev)

</div>

---

## What is BrainLLM?

LLMs forget. Every session starts from zero: who you are, what you're working on, what was decided yesterday, what went wrong last week. BrainLLM fixes that.

**BrainLLM is an MCP server that gives an LLM a real, persistent memory** — stored in [TriliumNext Notes](https://github.com/TriliumNext/Notes), a mature open-source knowledge base you self-host and own. The model opens each session by loading who you are and what's live, writes durable facts the moment they surface, wires knowledge together as a typed graph, and closes each session with a log, a diary entry, and a database backup. The next session picks up exactly where the last one ended.

It's a single Bun/TypeScript service with two dependencies (the MCP SDK and Zod), speaking to Trilium exclusively through its public ETAPI. Your memory lives in *your* Trilium instance — inspectable, editable, and portable, never locked inside a vendor's black box.

### From experiment to open source

BrainLLM began as a personal experiment: could an LLM operate a real, self-hosted second brain reliably enough to be trusted as its own memory — orienting, writing, connecting, and closing sessions without a human doing the filing? Through sustained daily, production use the answer held. The design has settled, the failure modes have been found and fixed, and the project has graduated from experiment to something **efficient and stable enough to share** — so it's now open source. It still runs the author's own sessions every day; what you're reading is the same code, not a demo.

### The core principle

> **The model supplies content. The server owns form.**

Placement, naming, labels, deduplication, relation bookkeeping, lifecycle aging, archival, date stamping, HTML sanitization, backups — and **structure itself** — are all deterministic server policy, never delegated to the LLM. The model never chooses a parent note, never sets a label, never checks for duplicates, never stamps a date. That division is what makes the memory *reliable*: every guarantee is enforced at the tool layer, not requested via prompt.

### Design highlights

- **Structure is enforced, not requested** — every content kind has a canonical structure, served by `template()` and held on write: a new thread requires its goal, thread/diary/session entries open with an identification line (which LLM, which environment, which session type), threads carry exactly one Resolution (owned by `resolve()`), duplicate section headings are detected, and `Last updated` stamps are server-maintained.
- **Domains born complete** — creating a knowledge domain creates its book *and* its canonical Sources note (marker legend, stamp, grouped source list, revision table), so every claim has a sourcing home from the first write.
- **A visible graph** — `graph()` renders the whole relation graph (or any note's neighborhood) as a Mermaid flowchart, maintained as a native Trilium note.
- **One-call day orientation** — `day()` serves the previous session, its change log, everything touched since, and the month's deliverables in a single call.
- **Resilient plumbing** — every backend call is timeout-bounded with retry on idempotent reads; all writes are idempotent or duplicate-guarded, so crashes and retries never double-write; content surgery survives the editor's own HTML rewriting; renaming a domain cascades to everything inside it; the maintenance sweep heals drift it finds.

---

## How it works

At bootstrap, BrainLLM builds a five-area tree in Trilium. Every note the tools create is typed, labeled, dated, and placed by server policy:

```
BrainLLM  (#brainLlmRoot)
├── 👤 Master       Biography · Goals · Preferences               (the user — maintained singletons)
├── 🤖 LLM          Responsibilities · Protocols · Diary/         (the assistant's self-model + daily diary)
├── 🗂️ Memory       Sessions/ · Threads/                          (daily session logs + multi-session work)
├── 📚 Knowledge    Master/ · Domains/<domain>/{ Sources, info }  (learned facts beyond/contra training)
└── 💡 Insights     Logs/ · Graph                                 (the brain's record of itself)
```

| Note class | Kinds | Behavior |
|---|---|---|
| **Singletons** | biography, goals, preferences, responsibilities, protocols (+ each domain's Sources note) | Exactly one maintained note; edited in place; hold *current-state truth* |
| **Dated records** | diary, session, log | One per calendar day; every write lands as a timestamped addendum block — chronology is the point |
| **Collections** | thread, user, information, domain | Titled notes, deduplicated by normalized title within their scope |

A session follows an enforced protocol: `start()` orients (full user digest, live threads, what changed since last time) → the model works, writing durable facts *as they surface* → `session()` → `addendum()` → `maintain()` → `remarks()` → `diary()` → `close()` commits the log, regenerates the daily change log, and triggers a DB backup. The pre-close gate is **enforced in code**: `close()` refuses until every step actually ran, in order — narrating "I did the steps" doesn't count, only tool calls do.

Knowledge is a **typed graph**: a closed vocabulary of 15 relations (`extends`, `contradicts`, `supports`, `partOf`, `supersedes`, …), wired by `connect()` or at creation, traversed by `explore()` (links / backlinks / neighborhood / shortest path), rendered by `graph()`, and audited by `maintain(deep)` — which flags orphaned notes, stale content, duplicate titles, and heals duplicate edges.

---

## Quick start

### Prerequisites

- [Bun](https://bun.sh) v1.0+
- A running [TriliumNext](https://github.com/TriliumNext/Notes) instance (desktop app or server)

### 1. Install and build

```bash
git clone https://github.com/miisodev/BrainLLM
cd BrainLLM
bun install
bun run build
```

### 2. Get an ETAPI token

In Trilium: **Options → ETAPI → Create token**.

### 3. Configure your MCP client

For **Claude Desktop**, add to `claude_desktop_config.json` (see `config.example.json` for a complete example including remote):

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

For **Claude Code**, the same server block works in `.mcp.json`. A DXT desktop-extension manifest (`manifest.json`) is also included for one-click installs.

### 4. Bootstrap the brain

Restart your client and ask Claude to run `bootstrap` — it builds the five-area tree (each area engraved with its purpose), writes `brainllm.json`, and is active immediately. Or from the CLI:

```bash
TRILIUM_BASE_URL=http://localhost:8080 TRILIUM_ETAPI_TOKEN=your-token bun run init
```

### 5. Teach the model to operate it

Install the **operational skill** — the document that teaches Claude to treat BrainLLM as its own mind rather than a filing cabinet:

```bash
# Claude Code / Cowork skills directory
cp -r skills/brainllm ~/.claude/skills/brainllm
```

Then start a session. The model calls `start()`, orients, and operates the brain natively from there.

---

## The tool surface

All tool returns are structured JSON. User-input mistakes return informational errors (`{error, detail, hint}`) the model can read and self-correct from; every read/write/search tool includes a free `relations` snippet; all writes are retry-safe.

### Core — universal verbs (27)

| Group | Tools |
|---|---|
| Session lifecycle | `start` · `day` · `session` · `remarks` · `close` · `backup` |
| Writing | `remember` · `diary` · `revise` · `resolve` · `withdraw` · `recover` |
| Reading & search | `recall` · `domain` · `brain` · `inspect` · `template` |
| Graph | `connect` · `explore` · `graph` |
| Attachments & labels | `attach` · `detach` · `label` |
| Maintenance & system | `addendum` · `maintain` · `forget` · `bootstrap` |

### Core — surface reads (10, dual-mode)

`master`/`master_recall` · `llm`/`llm_recall` · `memory`/`memory_recall` · `knowledge`/`knowledge_recall` · `insights`/`insights_recall` — each surface read in full, or skimmed as compact stubs.

### Full mode (`BRAINLLM_MODE=full`, +33)

The raw ETAPI, one tool per Trilium primitive — notes, attributes, branches, revisions, attachments, calendar, system. Brain-agnostic and guard-free: an edge-case fallback for what core can't express (precise raw queries, code/canvas/mermaid notes, branch surgery, revision recovery).

The complete operational reference is [`skills/brainllm/SKILL.md`](./skills/brainllm/SKILL.md); per-topic deep dives live in [`skills/brainllm/references/`](./skills/brainllm/references/).

---

## Deployment

### Transport modes

| Mode | When | Selected by |
|------|------|-------------|
| **stdio** | Local — Claude Desktop / Claude Code spawns BrainLLM as a child process | `PORT` unset (default) |
| **HTTP connector** | Remote — clients reach BrainLLM over the network | `PORT` set (Railway injects it) |

The HTTP connector serves a streamable-HTTP MCP endpoint at `/mcp` (one session per `mcp-session-id`, DELETE terminates, CORS-enabled with `mcp-session-id` exposed for browser clients) plus `GET /health`. Set `MCP_AUTH_TOKEN` to require a bearer token. Idle sessions are evicted after 1 hour; request bodies are capped at 50 MB.

### Docker / Railway

The included [`Dockerfile`](./Dockerfile) builds and runs the HTTP connector (two-stage, digest-pinned `oven/bun`, drops privileges via `entrypoint.sh`). On **Railway**: `PORT` is auto-injected — set `MCP_AUTH_TOKEN`, `TRILIUM_BASE_URL`, `TRILIUM_ETAPI_TOKEN`, and `BRAINLLM_TZ` as service variables, deploy, and point your client at `https://<app>.up.railway.app/mcp` with the bearer token.

For config persistence across redeploys, mount a volume on the **BrainLLM service** (not the Trilium service) and set `BRAINLLM_CONFIG` to a file path inside it:

```bash
railway volume -p <project-id> -s <brainllm-service-id> -e production add --mount-path /vol
railway variables set BRAINLLM_CONFIG=/vol/brainllm.json
```

Without a volume, leave `BRAINLLM_CONFIG` unset — auto-discovery re-finds the brain from Trilium's `#brainLlmRoot` marker on each cold start (~1 s).

### Configuration reference

| Variable | Required | Purpose |
|---|---|---|
| `TRILIUM_BASE_URL` | ✅ | URL of the TriliumNext instance (local, or an HTTPS reverse-proxy/tunnel URL) |
| `TRILIUM_ETAPI_TOKEN` | ✅ | ETAPI bearer token |
| `BRAINLLM_MODE` | — | `core` (default) or `full` (adds the raw ETAPI surface) |
| `BRAINLLM_TZ` | — | IANA timezone (e.g. `Africa/Johannesburg`) so dates stamp in *your* day on hosted deploys; unset = host clock |
| `PORT` | — | Presence switches to HTTP-connector mode |
| `MCP_AUTH_TOKEN` | — | Bearer token required on `/mcp` in HTTP mode |
| `BRAINLLM_CONFIG` | — | Absolute file path for `brainllm.json` on persistent-volume deploys |

Lifecycle timings live in `brainllm.json` and are yours to tune:

```json
"policy": { "dormantAfterDays": 21, "archiveDormantAfterDays": 45, "staleAfterDays": 7 }
```

Threads age `active → dormant → archived-in-place` on that timeline; nothing is ever deleted by aging, and `recover()` / `withdraw()` bring anything back.

---

## Adapting to your environment

A handful of values in this repo reflect the author's own machine. None are secrets, but if you clone or fork, review these and swap in your own:

| What | Where | Make it yours |
|---|---|---|
| **Timezone** | `BRAINLLM_TZ` in `.env` | Your IANA zone — or unset for the host clock |
| **Config path** | `BRAINLLM_CONFIG` env var | Only needed on persistent-volume deploys (see above) |
| **Monthly deliverables note** | the `day()` sweep | `day()` serves a Knowledge/Master note titled by the current month name (e.g. "July") as the month's deliverables tracker — the author's convention. Adopt it (one `user` note per month) or simply ignore the `deliverables` field; everything else `day()` returns is convention-free. |
| **Trilium launcher** | `scripts/start-trilium.ps1` | Windows convenience script — repoint the exe path and port, or ignore it |
| **"Trilium isn't running" hint** | `skills/brainllm/SKILL.md` + `references/troubleshooting.md` | Reference the author's script path — repoint or delete |
| **Bundle path** | your MCP client config | The real absolute path to `dist/index.js` on your machine |
| **Author · repo · funding** | `package.json`, `.github/FUNDING.yml`, the badges above | Your own details if you fork; the funding links support the original author |

---

## Architecture

```
index.ts ─→ tools.ts ─┬→ trilium.ts     ETAPI client: bounded/retrying I/O, graph traversal
                      ├→ router.ts      placement policy: kind → parent, label plans, domains
                      ├→ templates.ts   canonical structures per kind + the template-tool rules
                      ├→ normalize.ts   titles, slugs, markdown→HTML, sanitization, surgery
                      ├→ lifecycle.ts   protection, sweep, aging, the start digest
                      ├→ journal.ts     daily Insights log generation (regenerate-in-place)
                      ├→ time.ts        timezone-correct now/today (BRAINLLM_TZ)
                      ├→ bootstrap.ts   five-area tree builder
                      └→ tools-*.ts     per-area surface reads · full-mode raw ETAPI
```

Key properties: every write is sanitized for Trilium/CKEditor 5 compatibility (mutations reported back as `sanitized[]`); a revision snapshot precedes every content mutation; every request carries the user's local time so Trilium stamps dates in the right day; all writes are idempotent or duplicate-guarded (see the retry-safety matrix in the blueprint).

## Development

```bash
bun run dev    # hot-reload dev server
bun run build  # bundle to dist/index.js
bun test src/normalize.test.ts src/lifecycle.test.ts src/trilium.test.ts   # unit tests
bun run test   # integration tests (requires a live Trilium instance)
bun run init   # CLI bootstrap
```

Repo layout: runtime source in `src/`, the operational skill in `skills/brainllm/`, developer scripts in `scripts/`, DXT manifest in `manifest.json`, container build in `Dockerfile`.

## Contributing

Contributions are welcome — bug reports, fixes, docs, and ideas alike.

1. **Open an issue first** for anything non-trivial — bugs with reproduction steps, or proposals with the use case spelled out.
2. **Fork and branch**, keep changes focused, and match the existing code style.
3. **`bun run build` must pass clean** and unit tests must stay green (`bun test src/*.test.ts`); add tests for new normalize/lifecycle logic.
4. **Use conventional commits** (`fix:`, `feat:`, `docs:`, `refactor:`).
5. **Update the docs that your change touches** — `README.md`, the skill package under `skills/brainllm/`, and `config.example.json`/`.env.example` where relevant. The skill is part of the product: a tool change without its skill update is half a change.

Not sure where to start? Issues labeled `good first issue`, doc gaps, and the troubleshooting reference are all friendly entry points.

## Support the project

BrainLLM is built and maintained by one person. If it's useful to you, sponsorship directly funds its continued development:

<div align="center">

[![Sponsor on GitHub](https://img.shields.io/badge/Sponsor%20on%20GitHub-%E2%9D%A4-ea4aaa?style=for-the-badge&logo=githubsponsors)](https://github.com/sponsors/miisodev)
[![Donate via PayPal](https://img.shields.io/badge/Donate-PayPal-009cde?style=for-the-badge&logo=paypal&logoColor=white)](https://paypal.me/miisodev?locale.x=en_US&country.x=ZA)

</div>

Starring the repo, reporting bugs, and spreading the word help too.

## License

[MIT](./LICENSE) © [Kevin Miiso Novo](https://github.com/miisodev)

## Credits

- [TriliumNext Notes](https://github.com/TriliumNext/Notes) — the open-source, self-hosted knowledge base that powers this server's backend. BrainLLM would not exist without the TriliumNext team's work.
- [Model Context Protocol](https://modelcontextprotocol.io) — the open standard that lets one memory serve every MCP-capable client.
