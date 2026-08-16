<div align="center">

<img src="./public/BrainLLM.png" alt="BrainLLM logo" width="128" />

# BrainLLM

**Give Claude a memory that survives the session.**

A persistent, graph-structured second brain for Claude and any MCP client — built on [TriliumNext Notes](https://github.com/TriliumNext/Notes), served over the [Model Context Protocol](https://modelcontextprotocol.io).

[**brainllm site**](https://miisodev.github.io/BrainLLM/) · [How it works](https://miisodev.github.io/BrainLLM/how-it-works.html) · [Use cases](https://miisodev.github.io/BrainLLM/use-cases.html) · [Docs](https://miisodev.github.io/BrainLLM/docs.html)

[![Version](https://img.shields.io/badge/version-10.5.1-f59e0b?style=flat-square)](https://github.com/miisodev/BrainLLM/releases)
[![CI](https://img.shields.io/github/actions/workflow/status/miisodev/BrainLLM/ci.yml?branch=main&style=flat-square&label=CI&color=f59e0b)](https://github.com/miisodev/BrainLLM/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-a1a1aa?style=flat-square)](./LICENSE)
[![Runtime: Bun](https://img.shields.io/badge/runtime-Bun%20%E2%89%A5%201.0-a1a1aa?style=flat-square&logo=bun&logoColor=white)](https://bun.sh)
[![MCP](https://img.shields.io/badge/protocol-MCP-0a0a0f?style=flat-square)](https://modelcontextprotocol.io)
[![Sponsor](https://img.shields.io/badge/❤-Sponsor-f59e0b?style=flat-square&logo=githubsponsors&logoColor=white)](https://github.com/sponsors/miisodev)

</div>

---

## What is BrainLLM?

LLMs forget. Every session starts from zero: who you are, what you're working on, what was decided yesterday, what went wrong last week. BrainLLM fixes that.

**BrainLLM is an MCP server that gives an LLM a real, persistent memory** — stored in [TriliumNext Notes](https://github.com/TriliumNext/Notes), a mature open-source knowledge base you self-host and own. The model opens each session by loading who you are and what's live, writes durable facts the moment they surface, wires knowledge together as a typed graph, and closes each session with a log, a diary entry, and a database backup. The next session picks up exactly where the last one ended.

It's a single Bun/TypeScript service with two dependencies (the MCP SDK and Zod), speaking to Trilium exclusively through its public ETAPI. Your memory lives in *your* Trilium instance — inspectable, editable, and portable, never locked inside a vendor's black box.

### Who it's for

Anyone running an LLM as a long-running collaborator, not a one-shot Q&A tool — across coding, research, personal knowledge management, or day-to-day operational tracking — who wants that collaborator to actually remember: who you are, what's in flight, what was decided, without you re-explaining it every session. If you're comfortable self-hosting one small service and a Trilium instance, BrainLLM turns "the model forgot everything again" into a solved problem. It works with any MCP-capable client (Claude Desktop, Claude Code, or anything else speaking MCP), not just one product.

### From experiment to open source

BrainLLM began in February 2026 as a personal experiment: could an LLM operate a real, self-hosted second brain reliably enough to be trusted as its own memory — orienting, writing, connecting, and closing sessions without a human doing the filing? Through sustained daily, production use the answer held. The design has settled, the failure modes have been found and fixed, and the project has graduated from experiment to something **efficient and stable enough to share** — so it's now open source. It still runs the author's own sessions every day; what you're reading is the same code, not a demo. It also still carries the shape of one person's daily use — see [Adapting to your environment](#adapting-to-your-environment) for exactly what that means and what to change.

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

A session follows an enforced protocol: `start()` orients (who you are, live threads, what changed since last time) → the model works, writing durable facts *as they surface* → `session()` → `addendum()` → `maintain()` → `remarks()` → `diary()` → `close()` commits the log, regenerates the daily change log, and triggers a DB backup. The pre-close gate is **enforced in code**: `close()` refuses until every step actually ran, in order — narrating "I did the steps" doesn't count, only tool calls do. The gate is *durable*, written to the session note rather than held in memory, so it survives a restart mid-session and behaves the same on stdio and HTTP.

Orientation is deliberately cheap. `start()` returns your singletons as **section headings** — enough for the model to know what the brain holds — and it pulls the one section that matters. Serving the entire self-model on every session meant a one-line question cost the same as a day's work; `start(depth="full")` is still there for the sessions that genuinely need it.

Knowledge is a **typed graph**: a closed vocabulary of 16 relations (`extends`, `contradicts`, `supports`, `partOf`, `supersedes`, `corrects`, …), wired by `connect()` or at creation, traversed by `explore()` (links / backlinks / neighborhood / shortest path), rendered by `graph()`, and audited by `maintain(deep)`, which heals duplicate edges and flags what a note application would never think to look for: orphaned notes, stale content, duplicate titles, structural drift *inside* a note, bodies past the read ceiling, stubs that were labelled and never written, titles carrying a date (which defeats dedup-by-title), threads heavy enough to want consolidating, Sources notes whose verification table was never filled in, and bodies carrying doubly-escaped markup. Most of it is computed from note properties server-side rather than by reading bodies, so the report is complete rather than truncated. Findings can be acknowledged (`maintain(ack=[…])`) so a flag you have judged correct goes quiet until that note's content actually changes — a warning that reappears every run and is correctly ignored every run trains you to skim the list.

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

**Or skip this step.** Set `TRILIUM_PASSWORD` instead of `TRILIUM_ETAPI_TOKEN` and BrainLLM mints a token itself on first start, caching it beside `brainllm.json` so restarts reuse it rather than creating a new one each time. This is the easiest path for a container deploy, where there's no terminal to run a setup command in.

To do it explicitly instead, either let `init` mint one:

```bash
TRILIUM_BASE_URL=http://localhost:8080 TRILIUM_PASSWORD=your-trilium-password bun run init
```

It prints the token once to save as `TRILIUM_ETAPI_TOKEN`, and bootstraps the brain in the same run. Or create one by hand in Trilium: **Options → ETAPI → Create token**.

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

### Why the tools are named the way they are

**The naming is a readability feature for you, not a style choice.** Most MCP clients show you the name of each tool call as it happens. BrainLLM's tools are named as **plain-English verbs for what is happening to your memory** — `remember`, `recall`, `revise`, `resolve`, `forget`, `connect`, `maintain` — so that the call log reads as a description of what the model is doing in your brain, without you having to know the schema or open Trilium to find out.

The alternative, which most servers pick, is to name tools after the API underneath: `create_note`, `patch_note`, `update_attribute`. That tells you a row changed. It doesn't tell you the model recorded a decision, corrected something it previously believed, or closed a line of work — and those are the things you actually want to see scroll past.

Read this way, a session is legible at a glance:

| You see | What it means |
|---|---|
| `start` → `day` | Orienting: loading who you are, what's open, what changed since last time |
| `remember` · `diary` | Writing something down — a durable fact, or the model's own daily record |
| `recall` · `domain` · `outline` | Looking something up before answering, rather than answering from training |
| `revise` · `resolve` · `forget` | Changing, completing, or archiving something that already existed |
| `connect` · `graph` | Wiring a relationship between two things it noticed |
| `maintain` · `addendum` | Housekeeping — aging, structural drift, folding pending edits in |
| `remarks` → `close` | Wrapping up: reflecting, then committing the session log |

Three conventions keep that legible as the surface grows:

- **Verbs for actions, nouns for surfaces.** `remember` writes; `knowledge` reads. If a tool name is a noun, it only ever reads.
- **`<surface>` / `<surface>_recall` pairs.** The bare name reads a surface in full; the `_recall` suffix skims it. Seeing `memory_recall` rather than `memory` tells you the model chose the cheap read.
- **Destructive verbs say so.** `forget`, `detach`, `delete_*` are never spelled as something softer, so an irreversible call is never disguised as a routine one.

The **full mode** tools deliberately break this convention — they are named after the raw Trilium primitives (`create_note`, `patch_note`, `delete_attribute`) precisely so that a raw, guard-free operation is visibly different in the log from a brain-aware one.

### Tool permissions

Every tool declares whether it reads, writes, or destroys, so your client can group them and you can grant permission per group instead of per call. The current split is **31 read-only · 34 write · 6 destructive**, which lets reads run unattended while anything that touches your brain still asks.

The classification lives in one reviewable table ([`src/annotations.ts`](./src/annotations.ts)) rather than scattered across registrations, and its default is deliberately unsafe-side: a tool missing from the table is treated as a **write**, never a read, and says so at startup. Three are worth knowing because they look like reads and aren't — `start()` creates today's diary and session stubs, `session()` runs the maintenance sweep, and `graph()` writes the rendered graph note.

### Core — universal verbs (32)

| Group | Tools |
|---|---|
| Session lifecycle | `start` · `day` · `session` · `remarks` · `close` · `backup` |
| Writing | `remember` · `diary` · `revise` · `resolve` · `withdraw` · `recover` |
| Reading & search | `recall` · `domain` · `brain` · `assembly` · `outline` · `inspect` · `diff` · `template` · `consistency` |
| Graph | `connect` · `explore` · `graph` |
| Attachments & labels | `attach` · `detach` · `label` |
| Maintenance & system | `addendum` · `maintain` · `claim` · `forget` · `bootstrap` |

### Core — surface reads (10, dual-mode)

`master`/`master_recall` · `llm`/`llm_recall` · `memory`/`memory_recall` · `knowledge`/`knowledge_recall` · `insights`/`insights_recall` — each surface read in full, or skimmed as compact stubs.

### Full mode (`BRAINLLM_MODE=full`, +33)

The raw ETAPI, one tool per Trilium primitive — notes, attributes, branches, revisions, attachments, calendar, system. Brain-agnostic and guard-free: an edge-case fallback for what core can't express (precise raw queries, code/canvas/mermaid notes, branch surgery, revision recovery).

The complete operational reference is [`skills/brainllm/SKILL.md`](./skills/brainllm/SKILL.md); per-topic deep dives live in [`skills/brainllm/references/`](./skills/brainllm/references/). Beyond that, the **Blueprint** is a from-source architecture reference — every module, every tool's exact behavior and signature, the sweep internals, the full idempotency matrix — kept internally rather than published in this repo; see [Support the project](#support-the-project) for how to get a copy.

---

## Deployment

### Transport modes

| Mode | When | Selected by |
|------|------|-------------|
| **stdio** | Local — Claude Desktop / Claude Code spawns BrainLLM as a child process | `PORT` unset (default) |
| **HTTP connector** | Remote — clients reach BrainLLM over the network | `PORT` set (Railway injects it) |

The HTTP connector serves a streamable-HTTP MCP endpoint at `/mcp` (one session per `mcp-session-id`, DELETE terminates, CORS-enabled with `mcp-session-id` exposed for browser clients) plus `GET /health`. The server itself speaks plain HTTP — TLS is expected to terminate in front of it (Railway's edge does this automatically for you; on a bare VPS or your own Docker host, put it behind a reverse proxy such as Caddy, nginx, or a Cloudflare Tunnel). **Set `MCP_AUTH_TOKEN` on any deployment reachable outside a trusted network** — CORS defaults to `*`, so without a token any client that can reach the endpoint can call your Trilium brain. Idle sessions are evicted after 1 hour; request bodies are capped at 50 MB.

### Docker / Railway

The included [`Dockerfile`](./Dockerfile) builds and runs the HTTP connector (two-stage, digest-pinned `oven/bun`, drops privileges via `entrypoint.sh`). On **Railway**: `PORT` is auto-injected — set `MCP_AUTH_TOKEN`, `TRILIUM_BASE_URL`, `TRILIUM_ETAPI_TOKEN`, and `BRAINLLM_TZ` as service variables, deploy, and point your client at `https://<app>.up.railway.app/mcp` with the bearer token. Deploying elsewhere (a VPS, your own Docker host) works the same way — the container only needs those same env vars and a TLS-terminating proxy in front of it, per the transport note above.

### Branding

In HTTP mode BrainLLM serves its own icons — `/icon.png`, `/icon.svg`, sized variants, and `/favicon.ico` — and advertises them in the MCP handshake, so clients show the BrainLLM mark in your connector list and beside its tool calls.

Both halves of that are load-bearing. The spec tells clients to **verify icon URIs share the server's origin**, so icons hosted anywhere else are silently dropped. And a host that serves no favicon makes clients fall back to the *registrable domain's* — a BrainLLM at `brain.yourdomain.com` would show `yourdomain.com`'s site logo, which is worse than nothing because it looks intentional.

To use your own artwork, replace `public/BrainLLM.svg` and run `bun run icons` — it rasterises the vector at each size the server serves. Commit the results; the Docker image copies `public/` and has no image toolchain at runtime.

### Connecting claude.ai (OAuth)

Claude Code and `mcp-remote` send `MCP_AUTH_TOKEN` as a header and need nothing further. **The hosted Claude surfaces — claude.ai, Claude mobile, Cowork — cannot.** Their custom-connector UI offers OAuth or nothing; there is no field for a bearer token. So BrainLLM ships its own OAuth 2.1 authorization server, using [Client ID Metadata Documents](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization) — the registration-free mechanism MCP's `2026-07-28` revision adopted in place of Dynamic Client Registration.

Set one variable to turn it on:

```bash
BRAINLLM_OWNER_PASSWORD=<a strong password you choose>
```

That password is what you type on the consent screen. Without it the OAuth endpoints are disabled entirely and nothing else changes.

Then in Claude: **Settings → Connectors → Add custom connector**, enter `https://<your-host>/mcp`, and leave the OAuth client fields blank — CIMD needs no client ID or secret. Claude discovers everything from the `401`, you approve once on a consent screen, and it stays connected.

What that turns on:

| Endpoint | Purpose |
|---|---|
| `/.well-known/oauth-protected-resource` (+ `/mcp` variant) | RFC 9728 — names the authorization server |
| `/.well-known/oauth-authorization-server` | RFC 8414 — advertises CIMD support and PKCE S256 |
| `/authorize` | Validates the client's metadata document, shows the consent screen |
| `/token` | PKCE-verified code exchange, with rotating refresh tokens |

Both credentials work simultaneously — a static token from Claude Code and an OAuth token from claude.ai, against the same brain. Access tokens are signed JWTs bound to your server's resource URI, so a token minted for a different MCP server is rejected; the signing secret and refresh tokens persist beside `brainllm.json`, which on a container deploy means **putting `BRAINLLM_CONFIG` on a volume** — otherwise every redeploy invalidates every token.

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
| `TRILIUM_ETAPI_TOKEN` | ◐ | ETAPI bearer token. Required unless `TRILIUM_PASSWORD` is set |
| `TRILIUM_PASSWORD` | ◐ | Alternative to the token: BrainLLM mints one on first start and caches it beside `brainllm.json`, reusing it across restarts. Also used by `bun run init` |
| `BRAINLLM_MODE` | — | `core` (default) or `full` (adds the raw ETAPI surface) |
| `BRAINLLM_TZ` | — | IANA timezone (e.g. `Africa/Johannesburg`) so dates stamp in *your* day on hosted deploys; unset = host clock |
| `PORT` | — | Presence switches to HTTP-connector mode |
| `MCP_AUTH_TOKEN` | — | Static bearer token accepted on `/mcp` — what Claude Code and `mcp-remote` send |
| `BRAINLLM_OWNER_PASSWORD` | — | Enables the OAuth 2.1 / CIMD endpoints, required for claude.ai. The password you type on the consent screen |
| `BRAINLLM_PUBLIC_URL` | — | Override the derived public origin when a proxy rewrites `Host`. Must match the URL you enter in the client exactly |
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

Key properties: every write is sanitized for Trilium/CKEditor 5 compatibility (mutations reported back as `sanitized[]`); a revision snapshot precedes every content mutation; every request carries the user's local time so Trilium stamps dates in the right day; all writes are idempotent or duplicate-guarded (see the retry-safety matrix in the Blueprint).

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

### What we value

BrainLLM started as one person's daily-driver tool, so the code and docs still carry that person's assumptions in a few places (see [Adapting to your environment](#adapting-to-your-environment)). The contributions that matter most are the ones that generalize it beyond that:

| Value | What that looks like in a PR |
|---|---|
| **Generalization** | Replacing an assumption baked in for one workflow with something that holds for any brain's content and conventions |
| **Cross-user** | Nothing in `src/` should assume a specific person's ventures, schedule, or vocabulary — that belongs in *content* the model writes, never in the tool layer |
| **Cross-device** | Behaves the same on Windows/macOS/Linux, over local stdio and remote HTTP, on a laptop and in a Railway container |
| **Token efficiency** | Smaller responses, fewer round-trips, cheaper reads — e.g. `recall()`'s ranked snippets over `inspect(content=true)` for a plain yes/no check. This is a standing design bias, not a one-off optimization |
| **Latency** | Bounded, retrying I/O; parallel reads over sequential ones; nothing that makes session start or a tool call slower than it needs to be |

### How to contribute

1. **Open an issue first** for anything non-trivial — bugs with reproduction steps, or proposals with the use case spelled out.
2. **Fork and branch**, keep changes focused, and match the existing code style.
3. **`bun run build` must pass clean** and unit tests must stay green (`bun test src/*.test.ts` — CI runs the same two checks on every push and PR); add tests for new normalize/lifecycle logic.
4. **Use conventional commits** (`fix:`, `feat:`, `docs:`, `refactor:`).
5. **Update the docs that your change touches** — `README.md`, the skill package under `skills/brainllm/`, and `config.example.json`/`.env.example` where relevant. The skill is part of the product: a tool change without its skill update is half a change.

Not sure where to start? Issues labeled `good first issue`, doc gaps, and the troubleshooting reference are all friendly entry points.

## Support the project

BrainLLM is built and maintained by one person. If it's useful to you, sponsorship directly funds its continued development:

<div align="center">

[![Sponsor on GitHub](https://img.shields.io/badge/Sponsor%20on%20GitHub-%E2%9D%A4-ea4aaa?style=for-the-badge&logo=githubsponsors)](https://github.com/sponsors/miisodev)
[![Donate via PayPal](https://img.shields.io/badge/Donate-PayPal-009cde?style=for-the-badge&logo=paypal&logoColor=white)](https://paypal.me/miisodev?locale.x=en_US&country.x=ZA)

</div>

Sponsors can request a copy of the **Blueprint** — the complete internal architecture reference generated from full source analysis (every module, every tool's exact behavior and signatures, the sweep and idempotency internals) that isn't published in this repo. Message via GitHub Sponsors to ask for one.

Starring the repo, reporting bugs, and spreading the word help too.

## License

[MIT](./LICENSE) © [Kevin Miiso Novo](https://github.com/miisodev)

## Credits

- [TriliumNext Notes](https://github.com/TriliumNext/Notes) — the open-source, self-hosted knowledge base that powers this server's backend. BrainLLM would not exist without the TriliumNext team's work.
- [Model Context Protocol](https://modelcontextprotocol.io) — the open standard that lets one memory serve every MCP-capable client.
