# BrainLLM Blueprint

**Version:** 7.0.0 · **License:** MIT · **Author:** Kevin Miiso \<miisodev@gmail.com\>
**Document date:** 2026-07-09
**Sources analyzed:** the full `BrainLLM` repository (`src/`, `skills/`, `scripts/`, `Dockerfile`, `manifest.json`, `README.md`, `CLAUDE.md`) and the sibling `Trilium` repository (TriliumNext — the backend BrainLLM drives via ETAPI).

---

## Table of Contents

1. [Executive Overview](#1-executive-overview)
2. [Workspace & Repository Layout](#2-workspace--repository-layout)
3. [Runtime Architecture](#3-runtime-architecture)
4. [The Brain Structure](#4-the-brain-structure)
5. [Vocabularies & Taxonomy](#5-vocabularies--taxonomy)
6. [Configuration](#6-configuration)
7. [Core Tool Surface (32 tools)](#7-core-tool-surface-32-tools)
8. [Full-Mode Tool Surface (33 raw ETAPI tools)](#8-full-mode-tool-surface-33-raw-etapi-tools)
9. [Internal Modules & Utilities](#9-internal-modules--utilities)
10. [Lifecycle & Maintenance Engine](#10-lifecycle--maintenance-engine)
11. [Content Pipeline & Write Safety](#11-content-pipeline--write-safety)
12. [Session Protocol & the Pre-Close Gate](#12-session-protocol--the-pre-close-gate)
13. [Deployment](#13-deployment)
14. [The Operational Skill Package](#14-the-operational-skill-package)
15. [Scripts & Developer Tooling](#15-scripts--developer-tooling)
16. [Testing](#16-testing)
17. [Appendix A — Tool Inventory Summary](#appendix-a--tool-inventory-summary)
18. [Appendix B — Known Documentation Discrepancies](#appendix-b--known-documentation-discrepancies)

---

## 1. Executive Overview

**BrainLLM** is an MCP (Model Context Protocol) server that turns a running [TriliumNext Notes](https://github.com/TriliumNext/Notes) instance into a **persistent, graph-structured second brain** for Claude and other LLM clients. It is a single Bun/TypeScript service (~4,600 lines of source) with two dependencies: the MCP SDK and Zod.

### The core design principle

> **The model supplies content. The server owns form.**

Placement, naming, labels, deduplication, relation bookkeeping, lifecycle aging, archival, date stamping, HTML sanitization, and backups are all **server policy** — implemented deterministically in code, never delegated to the LLM. The model never chooses a parent note, never sets a `#noteType` label, never checks for duplicates, never stamps a date. This division is what makes the memory reliable: every guarantee the system provides is enforced at the tool layer, not requested via prompt.

### What V7 adds (over V6)

| Capability | Description |
|---|---|
| **Relation snippets everywhere** | Every core read/write/search tool returns an outbound `relations` array for free (attributes are already loaded from the same fetch). |
| **The standing "BrainLLM" meta-thread** | A `status=eternal` self-analysis thread, exempt from lifecycle aging and structurally protected, logged every session via `remarks()`. |
| **Enforced pre-close gate** | `close()` refuses until `diary()`, `session()`, `remarks()`, `addendum()`, and `maintain()` have each *actually been called* this session. |
| **`label()` / `inspect()`** | Guarded label surgery and full raw note reads in core mode — full mode becomes a true edge-case fallback. |

### Positioning of the two repos in this workspace

| Repo | Role |
|---|---|
| `BrainLLM` | The MCP server — this blueprint's subject. |
| `Trilium` | TriliumNext Notes (pnpm monorepo: `apps/`, `packages/`) — the open-source knowledge base whose **ETAPI** (External Token API) BrainLLM consumes. BrainLLM never touches Trilium's internals; the boundary is exclusively `/etapi/*` HTTP endpoints authenticated with a bearer token. |

---

## 2. Workspace & Repository Layout

```
C:\Users\miiso\Projects\OSS\
├── BrainLLM\                      ← the MCP server
│   ├── src\                       ← all runtime source (TypeScript, Bun target)
│   │   ├── index.ts               entry point: env, config resolution, transport selection
│   │   ├── config.ts              brainllm.json schema, load/save, auto-discovery
│   │   ├── types.ts               canonical vocabularies (areas, kinds, statuses, relations, policy)
│   │   ├── router.ts              placement policy: kind → parent, label plans, domain resolution
│   │   ├── trilium.ts             ETAPI client + graph traversal + attribute helpers
│   │   ├── normalize.ts           titles, slugs, markdown→HTML, sanitization, section surgery
│   │   ├── templates.ts           enforced note-content skeletons per kind
│   │   ├── lifecycle.ts           structural protection, resolution surgery, sweep, start digest
│   │   ├── journal.ts             daily Insights/Logs generation
│   │   ├── time.ts                timezone-correct "now"/"today" (BRAINLLM_TZ)
│   │   ├── bootstrap.ts           five-area tree builder (shared by tool + CLI)
│   │   ├── init.ts                one-shot CLI bootstrapper (bun run init)
│   │   ├── tools.ts               the 22 universal-verb core tools + registration hub
│   │   ├── tools-surface.ts       shared helpers for surface reads (skim/readFull/preview)
│   │   ├── tools-master.ts        master / master_recall
│   │   ├── tools-llm.ts           llm / llm_recall
│   │   ├── tools-memory.ts        memory / memory_recall
│   │   ├── tools-knowledge.ts     knowledge / knowledge_recall
│   │   ├── tools-insights.ts      insights / insights_recall
│   │   ├── tools-advanced.ts      the 33 raw ETAPI full-mode tools
│   │   └── *.test.ts, test.ts     unit + integration tests
│   ├── skills\brainllm\           the operational skill (SKILL.md + references/)
│   ├── scripts\                   sweep.ts, digest-smoke.ts, start-trilium.ps1, entrypoint.sh
│   ├── dist\                      built bundle (index.js) + brainllm.json (runtime config)
│   ├── public\                    BrainLLM.svg / BrainLLM.png (MCP handshake branding)
│   ├── Dockerfile                 HTTP-connector container build (Railway-ready)
│   ├── manifest.json              DXT (Desktop Extension) manifest for one-click install
│   ├── .env.example               documented environment variables
│   ├── CLAUDE.md                  dev workflow conventions (build → docs → commit → push)
│   └── README.md                  user-facing feature summary & setup
└── Trilium\                       TriliumNext Notes monorepo (backend; consumed via ETAPI only)
```

**Build & scripts** (`package.json`):

| Script | Command | Purpose |
|---|---|---|
| `dev` | `bun run --watch src/index.ts` | Hot-reload dev server |
| `build` | `bun build src/index.ts --outfile dist/index.js --target bun` | Single-file bundle |
| `start` | `bun run dist/index.js` | Run the built server |
| `test` | `bun run src/test.ts` | Integration tests (needs live Trilium) |
| `init` | `bun run src/init.ts` | CLI bootstrap of a fresh brain |

---

## 3. Runtime Architecture

### 3.1 Startup sequence (`src/index.ts`)

1. **Validate env** — `TRILIUM_BASE_URL` and `TRILIUM_ETAPI_TOKEN` are mandatory; exit(1) if absent.
2. **Construct `TriliumClient`** against the base URL.
3. **Resolve brain config** with a three-step priority chain:
   `brainllm.json` file → **auto-discovery** from Trilium (search `#brainLlmRoot`, walk children) → `EMPTY_BRAINLLM` (bootstrap required).
   A successful discovery is persisted back to disk.
4. **Wrap config in `brainRef`** — a mutable `{ config }` container so `bootstrap()` can swap IDs mid-session without a restart.
5. **Select mode** — `BRAINLLM_MODE=full` additionally registers the raw ETAPI surface; default is `core`.
6. **Select transport** by the presence of `PORT`.

### 3.2 Transport modes

| Mode | Trigger | Mechanics |
|---|---|---|
| **stdio** | `PORT` unset (default) | `StdioServerTransport`; the client (Claude Desktop / Claude Code) spawns BrainLLM as a child process. |
| **HTTP connector** | `PORT` set (Railway injects it) | `Bun.serve` + `WebStandardStreamableHTTPServerTransport`. Endpoints: `POST/GET /mcp` (one MCP session per `mcp-session-id` header, UUID-generated), `DELETE /mcp` (explicit session termination per MCP spec), `GET /health`. Optional `MCP_AUTH_TOKEN` enforces `Authorization: Bearer <token>` on `/mcp`. Sessions idle >1 h are evicted every 15 min. Request bodies capped at 50 MB. |

Each HTTP session gets its **own `McpServer` instance** (fresh tool registration), all sharing the single `TriliumClient` and `brainRef`.

### 3.3 Branding

The MCP handshake advertises `serverInfo.icons` (SVG `sizes:["any"]` + PNG fallback), served raw from the public GitHub repo, so clients render the BrainLLM logo in connector lists and beside tool calls.

### 3.4 Module dependency flow

```
index.ts ─→ tools.ts ─┬→ trilium.ts (ETAPI I/O, graph traversal)
                      ├→ router.ts (placement policy) ─→ templates.ts, normalize.ts
                      ├→ lifecycle.ts (sweep, digest, protection) ─→ templates.ts, normalize.ts, time.ts
                      ├→ journal.ts (daily logs)
                      ├→ bootstrap.ts (tree builder)
                      ├→ normalize.ts (all content shaping)
                      ├→ config.ts (brainllm.json persistence)
                      └→ tools-{master,llm,memory,knowledge,insights}.ts ─→ tools-surface.ts
index.ts ─→ tools-advanced.ts (full mode only) ─→ trilium.ts
```

---

## 4. The Brain Structure

### 4.1 The five-area tree

Built by `bootstrap()` / `bun run init` on a fresh Trilium instance. The root carries `#brainLlmRoot` (the auto-discovery marker) and `#iconClass=bx bx-brain`. Every structural note is **engraved with its purpose** — a one-line italic statement written into its body at creation.

```
BrainLLM  (#brainLlmRoot, book)
├── 👤 Master      (book)   The master/user — fundamental, durable identity
│   ├── Biography            singleton (text, #noteType=biography)
│   ├── Goals                singleton (text, #noteType=goals)
│   └── Preferences          singleton (text, #noteType=preferences)
├── 🤖 LLM         (book)   The assistant's self-model
│   ├── Responsibilities     singleton (text, #noteType=responsibilities)
│   ├── Protocols            singleton (text, #noteType=protocols)
│   └── Diary/       (book)  one [yyyy-mm-dd] note per day (#noteType=diary)
├── 🗂️ Memory      (book)   The primary/operational memory system
│   ├── Sessions/    (book)  one [yyyy-mm-dd] note per day (#noteType=session)
│   └── Threads/     (book)  titled multi-session work (#noteType=thread)
│       └── "BrainLLM"       the standing meta-thread (#status=eternal)
├── 📚 Knowledge   (book)   Learned info beyond/contradicting training
│   ├── Master/      (book)  user facts beyond bio/goals/prefs (#noteType=knowledge)
│   └── Domains/     (book)  auto-created domain books (#noteType=domain, #domain=<slug>)
│       └── <Domain>/        one Sources note (#noteType=sources) + N information notes
└── 💡 Insights    (book)   The brain's record of itself
    └── Logs/        (book)  one auto-generated [yyyy-mm-dd] change log per day (#noteType=log)
```

### 4.2 Area purposes (as engraved at bootstrap)

| Area | Engraved purpose |
|---|---|
| **Master** | The master/user. Fundamental, durable information about who they are — biography, goals, preferences. |
| **LLM** | The assistant. Its self-model — responsibilities, operating protocols, and diary (its raw, unfiltered record). |
| **Memory** | The primary memory system the brain operates on — daily sessions and multi-session threads. |
| **Knowledge** | The secondary memory system — learned knowledge adding to or conflicting with training data. |
| **Insights** | The insights system — the brain's record of itself, starting with per-day content change logs. |

### 4.3 Note classes

| Class | Kinds | Behavior |
|---|---|---|
| **Singletons** | `biography`, `goals`, `preferences`, `responsibilities`, `protocols` (+ the per-domain `sources` note) | Exactly one maintained note; writes upsert into it. Seeded with an enforced section skeleton at bootstrap. Hold *current-state truth*, edited in place. |
| **Dated records** | `diary`, `session`, `log` | One per calendar day, titled `[yyyy-mm-dd]`; same-day writes append timestamped addendums. Chronological history is the point. |
| **Collections** | `thread`, `knowledge`, `information`, `domain` | Titled notes, deduplicated by normalized title within their scope (information notes dedup *within* their domain). |

### 4.4 The BrainLLM meta-thread

A single standing note titled "BrainLLM" under Memory → Threads:

- `#status=eternal` — exempt from the active → dormant → archived timeline.
- Structurally protected: `resolve()`, `reopen()`, and `forget()` all refuse it with specific explanations; `revise()` still works, but `remarks()` is the intended write path.
- No Resolution anchor — it is never meant to close.
- Body = a chronological stack of dated addendum blocks (one per session via `remarks()`), tracking BrainLLM's own capabilities, bugs, usability, efficiency, and roadmap over time.
- Lazily created/discovered by `ensureMetaThread()` — the cached config ID is **verified live** on every use; if the note was deleted directly in Trilium, it is re-discovered (by `#noteType=thread #status=eternal` inside Threads) or re-created.

---

## 5. Vocabularies & Taxonomy

All vocabularies are defined once in `src/types.ts` — tool schemas, the router, the structure builder, and placement all derive from these constants; there is no second copy anywhere.

### 5.1 Kinds (`#noteType`) — 13 values

| Kind | Area | Class | Home |
|---|---|---|---|
| `biography` | master | singleton | Master → Biography |
| `goals` | master | singleton | Master → Goals |
| `preferences` | master | singleton | Master → Preferences |
| `responsibilities` | llm | singleton | LLM → Responsibilities |
| `protocols` | llm | singleton | LLM → Protocols |
| `diary` | llm | dated | LLM → Diary |
| `session` | memory | dated | Memory → Sessions |
| `thread` | memory | collection | Memory → Threads |
| `knowledge` | knowledge | collection | Knowledge → Master |
| `domain` | knowledge | container | Knowledge → Domains (auto-created book) |
| `information` | knowledge | collection | Knowledge → Domains → \<Domain\> |
| `sources` | knowledge | per-domain singleton | Knowledge → Domains → \<Domain\> → Sources |
| `log` | insights | dated (auto) | Insights → Logs |

### 5.2 Statuses (`#status`) — 5 values

| Status | Meaning |
|---|---|
| `active` | Live work (default for threads) |
| `dormant` | Untouched past `dormantAfterDays` — review queue |
| `resolved` | Terminal — closed with a substantive outcome, archived in place |
| `superseded` | Terminal — replaced by another note, archived in place |
| `eternal` | The one standing BrainLLM meta-thread — exempt from aging, structurally protected |

### 5.3 Relations — closed vocabulary of 15

`connect()` rejects anything not on this list. `worksWith` is symmetric (auto-wired both ways).

| Relation | Direction | Semantics |
|---|---|---|
| `relatesTo` | A → B | Generic association — **last resort** |
| `extends` | A → B | Builds upon / elaborates |
| `contradicts` | A → B | Conflicts with |
| `supports` | A → B | Provides evidence or justification |
| `causes` | A → B | Produces / leads to |
| `references` | A → B | Cites as source (auto-wired session ↔ log by `close()`) |
| `partOf` | A → B | Semantically belongs to |
| `worksWith` | A ↔ B | Collaboration — symmetric |
| `mentors` | A → B | Teaches / shapes |
| `instanceOf` | A → B | Concrete example of |
| `supersedes` | A → B | Replaces entirely (auto-wired via `supersedes=` on `remember()`; the old note is archived) |
| `implements` | A → B | Concrete realisation of |
| `inspiredBy` | A → B | Conceptually influenced by |
| `sourceOf` | A → B | Origin / provenance of |
| `derivedFrom` | A → B | Synthesised from |

### 5.4 Label conventions (server-owned)

| Label | Values | Set by |
|---|---|---|
| `#noteType` | one of the 13 kinds | Creation only — never editable afterward (even `label()` refuses it) |
| `#status` | the 5 statuses | `remember`/`resolve`/`reopen`/`recover`/sweep; `label()` validates against the vocabulary |
| `#created` | ISO date | Creation (user-local day) |
| `#updated` | ISO date | Every write |
| `#closed` | ISO date | `resolve()` / `forget()` / archive transition |
| `#topic` | slug, repeatable | `remember(topics=[…])`; slugged server-side |
| `#domain` | slug | Domain routing; book auto-created on first use |
| `#archived` | flag | Excludes from default `recall()`; content preserved in place |
| `#brainLlmRoot` | flag | Root marker for auto-discovery |
| `#iconClass` | `bx …` | Display icons on structural notes |

---

## 6. Configuration

### 6.1 Environment variables

| Variable | Required | Purpose |
|---|---|---|
| `TRILIUM_BASE_URL` | ✅ | URL of the TriliumNext instance (e.g. `http://localhost:8080`, or an HTTPS reverse-proxy/tunnel URL for remote). |
| `TRILIUM_ETAPI_TOKEN` | ✅ | ETAPI bearer token (Trilium: Options → ETAPI → Create token). |
| `BRAINLLM_MODE` | — | `core` (default) or `full` (adds the raw ETAPI surface). |
| `BRAINLLM_TZ` | — | IANA timezone (e.g. `Africa/Johannesburg`) for correct date stamping on hosted deploys. Unset = host clock (correct locally). |
| `PORT` | — | Presence switches to HTTP-connector mode. Railway injects it; never set for local stdio use. |
| `MCP_AUTH_TOKEN` | — | Bearer token required on `/mcp` in HTTP mode. |
| `BRAINLLM_CONFIG` | — | Absolute file path for `brainllm.json` (persistent-volume deploys). Unset = next to the bundle (`dist/brainllm.json`). Must be a **file** path, never Trilium's data directory. |

### 6.2 `brainllm.json` — the runtime config (schema version 5)

Written by `bootstrap()` / auto-discovery; never hand-edited (except `policy`). Only `version: 5` configs load; anything older falls through to discovery/bootstrap (a deliberate clean break).

```json
{
  "version": 5,
  "root": "<noteId>",
  "master":    { "root": "…", "biography": "…", "goals": "…", "preferences": "…" },
  "llm":       { "root": "…", "responsibilities": "…", "protocols": "…", "diary": "…" },
  "memory":    { "root": "…", "sessions": "…", "threads": "…", "metaThread": "…" },
  "knowledge": { "root": "…", "master": "…", "domains": "…" },
  "insights":  { "root": "…", "logs": "…" },
  "policy":    { "dormantAfterDays": 21, "archiveDormantAfterDays": 45, "staleAfterDays": 7 }
}
```

- `memory.metaThread` may be `""` on older configs — `ensureMetaThread()` fills it lazily and persists.
- **Auto-discovery** (`discoverBrainLLM`): search `#brainLlmRoot` → walk root's children by title (Master/LLM/Memory/Knowledge/Insights) → map grandchildren by title → find the meta-thread by `#noteType=thread #status=eternal` inside Threads. Fails (returns null) if any required area root is missing.

### 6.3 Lifecycle policy

| Field | Default | Meaning |
|---|---|---|
| `dormantAfterDays` | 21 | Active thread untouched this long → `dormant` |
| `archiveDormantAfterDays` | 45 | Dormant this much longer → archived in place |
| `staleAfterDays` | 7 | Deep sweep flags non-record content untouched this long for review |

---

## 7. Core Tool Surface (32 tools)

The default (`BRAINLLM_MODE=core`) surface: **22 universal verbs** (registered in `tools.ts`) + **10 dual-mode surface reads** (5 per-area modules). All returns are JSON serialized into a single MCP text block via the shared `txt()` helper. User-input mistakes return **informational errors** `{error, detail, hint}` instead of throwing; only system failures (unbootstrapped structure, network) throw.

A cross-cutting V7 behavior: **every core read, write, and search tool includes a `relations` snippet** — outbound `{relation, toNoteId}` edges (capped at 8, `~template` excluded, omitted when empty) — at zero extra fetch cost.

### 7.1 Session lifecycle

#### `start()` — parameters: none

Boot the brain; call once at session start, before responding to anything.

**Does:** runs the lite maintenance sweep → builds the orientation digest → creates today's diary stub and session stub if absent (titled `[yyyy-mm-dd]`, labeled `#noteType` + `#created`) → ensures the meta-thread exists → computes `changesSinceLastSession` from Trilium's note history (deduped by noteId, deletion flags preserved, capped at 25).

**Returns:**

| Field | Content |
|---|---|
| `status` | `"ready"` or `"uninitialized"` (→ run `bootstrap`) |
| `today`, `weekday` | User-local date + weekday name |
| `master` | Biography / goals / preferences — each **in full** (`{slot, summary}`) |
| `llm` | Responsibilities / protocols in full, plus today's diary as `{slot:"diary", id, preview}` |
| `session` | Today's session stub `{id, preview}` |
| `metaThread` | `{id, title:"BrainLLM", preview}` |
| `activeThreads` | Live threads with `idleDays` and relation snippets (sorted freshest first) |
| `dormantThreads` | Review queue with a guidance note (empty array when none) |
| `lastSession` | `{id, title, date, summary}` of the previous session |
| `changesSinceLastSession` | `{id, title, changed, deleted?}` entries |
| `hygiene` | Sweep summary `{scanned, fixed, transitions, flagged}` |

#### `session(date?)` — the mandatory pre-close step

Marks the `session` gate step. Fetches the five singletons (biography, goals, preferences, responsibilities, protocols) each **in full** as `{id, lastModified, content, relations?}`, today's diary entry `{id, content}`, and runs the lite sweep. Returns a `next[]` protocol array driving: update master singletons → update LLM singletons → `diary()` → `addendum()` → `maintain()` → `remarks()` → `close()`. Idempotent (all reads; sweep is non-destructive).

#### `remarks(capabilities?, issuesAndBugs?, usability?, memoryEfficiency?, tokenEfficiency?, performance?, hygieneAndMaintenance?, roadmap?, date?)`

The default write tool for the BrainLLM meta-thread; the last gate step before `close()`. Dual-mode by parameter presence:

- **Cue mode** (no params): returns the meta-thread `{id, preview, relations?}` plus the 8 cue questions. Does **not** satisfy the gate.
- **Write mode** (any param): writes all provided answers as **one dated addendum block** (`<h2>Addendum — yyyy-mm-dd</h2>` with an `<h3>` per answered section), duplicate-append-guarded, revision-snapshotted, bumps `#updated`, and marks the `remarks` gate step. Returns `{action:"logged", noteId, date, sections[], next[]}` (or `already_written`).

#### `close(summary, title?, learned?, date?, backup?, force?)`

Commit the session log — once, last.

- **Gate:** refuses with `{error:"preclose_incomplete", detail, hint}` unless `diary`, `session`, `remarks`, `addendum`, `maintain` all ran this session. `force=true` bypasses; bypassed steps are reported back as `bypassed`.
- **Write:** idempotent per date — searches `#noteType=session #created='<d>'`; if today's note already has content, appends a time-stamped addendum; if it's an empty stub, fills it. `title` renders as an `<h2>` above Summary; `learned[]` renders as a Learned list.
- **Side effects:** generates the daily Insights log (`generateDailyLog`), wires session ↔ log with mutual `~references` relations, triggers a DB backup (`brainllm-<date>.db`, unless `backup=false`), and **clears the gate**.
- **Returns:** `{action: "created"|"appended", noteId, date, backup, log: "<action> (Nc/Nu/Nd)", bypassed?, sanitized?}`.

#### `backup(name?)`

On-demand named Trilium DB snapshot (default `brainllm-{today}`); for milestone snapshots before large restructures (`close()` already backs up). Returns `{ok, backup: "<name>.db", date}`.

### 7.2 Writing

#### `diary(body, date?)`

The dedicated path for the daily diary. Idempotent per date: first call of the day fills/creates `[yyyy-mm-dd]`; later calls append `<h2>Addendum — HH:mm</h2>` blocks. Retry guard: identical normalized content within 5 minutes of the last addendum returns `action:"already_written"`. Marks the `diary` gate step. Returns `{action, noteId, date, location?, sanitized?}`.

#### `remember(kind, title?, body?, domain?, topics?, supersedes?, connect?, date?)`

The universal write verb — the server owns placement, naming, labels and dedup. Routing by kind:

| Route | Kinds | Behavior |
|---|---|---|
| **Global singleton** | biography, goals, preferences, responsibilities, protocols | Upsert (dated addendum append) into the one maintained note; duplicate-append-guarded → `action: "maintained"` / `"already_written"`. |
| **Per-domain singleton** | `sources` (requires `domain=`) | Resolve/auto-create the domain book, find-or-create its Sources note, upsert. |
| **Domain collection** | `information` (requires `domain=` + `title=`) | Dedup by normalized title *within* the domain; append to existing (`"updated"`) or create with the information template (`"created"`, `createdDomain` flagged when the book was new). |
| **Generic collection** | `thread`, `knowledge` | Dedup by title across the area scope; existing → addendum inserted **before the Resolution anchor** (threads); new → created from template with the full label plan. |
| **Rejected** | `diary`, `session`, `log`, `domain` | `{error:"rejected_kind"}` with a redirect hint — each has a dedicated path (`diary()`, `close()`, auto-generation, `information` respectively). |

`supersedes=<noteId>`: wires `new ~supersedes→ old`, sets the old note's status to `superseded` + `#closed`, archives it, and reports `wired[]`. `connect=[{relation, toNoteId}]`: wires relations from the note in the same call (connect() semantics — idempotent, `worksWith` bidirectional), reported as `connected[]`; a freshly-created connectable note with no relations returns an orphan-prevention `hint` instead. `topics[]` are slugged and added as `#topic` labels (deduped). Every create runs the `labelPlan` (`#noteType`, `#created`, `#status` for threads, `#domain`, `#topic`s).

### 7.3 Reading & search

#### `recall(query, kinds?, domain?, includeArchived?, limit?, orderBy?, orderDirection?, fastSearch?)`

Brain-wide ranked search. Two paths:

- **Ranked (default):** three parallel strategies scored and merged — label match (`#topic=<slug> OR #domain=<slug>`, weight 3), title tokens (`note.title *=* '<token>' AND …`, weight 2), full text (weight 1) — tie-broken by recency.
- **Ordered:** `orderBy` (`dateModified` | `dateCreated` | `title`) switches to a single Trilium-ordered query, preserving the sort.

Filters: `kinds[]`, `domain` slug, `includeArchived` (default false — `#archived` notes excluded). Top 3 results include a 280-char content `snippet`; all include `{id, title, kind, status, updated, archived?, relations?}`. `fastSearch=true` restricts to title/label scans. Empty result includes a hint to `remember()` the content if the user supplies it.

#### `domain(name, includeArchived?)`

The complete picture for a named domain/topic/project. Looks up the Knowledge domain book (`knowledgeDomain`, null if none) and gathers **all content across every area** carrying a matching `#domain` or `#topic` slug, deduped and grouped by kind: `{domain, slug, knowledgeDomain, total, groups: {kind: [{id, title, status, created, modified, archived?, relations?}]}}`.

#### `brain(includeArchived?)`

The full content tree: every `#noteType`-labeled note across all five areas, grouped by area and sub-container (Master; LLM.singletons/diary; Memory.sessions/threads; Knowledge.master/domains; Insights), newest first, capped at 300 per container. Rows: `{id, title, kind, status, created, modified, archived?, relations?}` plus a `total`.

#### Surface reads — dual-mode, read-only (10 tools)

Writes always go through the universal verbs; these are pure reads built on the shared `skim`/`readFull` helpers (see §9.8).

| Tool | Parameters | Returns |
|---|---|---|
| `master(which)` | `which ∈ biography\|goals\|preferences` | The singleton in full: `{which, id, content, relations?}` |
| `master_recall()` | — | All three singletons as `{id, preview(200), relations?}` |
| `llm(which, id?)` | `which ∈ responsibilities\|protocols\|diary` (+`id` for diary) | The note in full `{id, title, kind, content, relations?}` |
| `llm_recall(limit?)` | — | Responsibilities + protocols previews (with ids/relations) + recent diary stubs (default 7) |
| `memory(id)` | note id | A thread or session in full |
| `memory_recall(query?, limit?)` | title filter for threads | `{threads: […20], sessions: […7]}` stubs with previews and statuses |
| `knowledge(id)` | note id | A knowledge / information / sources note in full |
| `knowledge_recall(query?, domain?)` | — | With `domain`: that domain's contents (50); without: user-knowledge stubs (30) + the domain list |
| `insights(date?)` | `YYYY-MM-DD` (default today) | That day's change log in full, or a "no log" note |
| `insights_recall(limit?)` | — | Recent log stubs (default 14) |

### 7.4 Updating & lifecycle verbs

#### `revise(noteId, body?, title?, section?, mode?, date?)`

Update an existing note. Refused on containers (`{error:"protected_note"}`); the maintained singletons and the meta-thread are editable. A revision snapshot is always taken before content writes. Three content modes:

| Mode | Behavior |
|---|---|
| default (append) | Dated addendum, inserted **before the Resolution anchor** if present; duplicate-append-guarded |
| `mode=replace` | Full body rewrite |
| `section="<heading>"` | In-place section surgery via `setSection` — matches h2 → h3 → h4 in order, tolerant of tag attributes/case/whitespace; appends a new h2 if not found |

Section calls return `matched` (false = heading not found, content appended as a new h2) and `headingCount` (>1 = ambiguous match, only the first touched) plus a plain-language `hint`. Also: normalizes a new `title`, bumps `#updated`, and **reactivates a dormant note to `active`** on any touch. `body` omitted → metadata-only.

#### `resolve(noteId, outcome, status?, supersededBy?, date?)`

Complete a thread: sanitizes the outcome, applies **resolution surgery** (replaces everything from the `<h2>Resolution</h2>` anchor down with the outcome + `Closed <date>`; appends the section if absent), sets terminal status (`resolved` default | `superseded`), stamps `#closed`, adds `#archived`. `supersededBy` wires `replacement ~supersedes→ this`. Refuses the meta-thread and structural notes. Returns `{ok, noteId, kind, status, archivedInPlace: true, followUps?, relations?, sanitized?}`.

#### `reopen(noteId, reason?, date?)`

Re-activate an archived/resolved **thread only** (`{error:"wrong_kind"}` otherwise → use `recover()`). Removes `#archived` and `#closed`, resets `#status=active`, appends a `<h2>Reopened — date</h2>` addendum (duplicate-guarded). Refuses the meta-thread (already permanently open).

#### `recover(noteId, reason?, date?)`

The canonical undo for `forget()` and the restore path for any non-thread kind: removes `#archived`, clears `#closed`, resets `#status=active`, appends `<h2>Recovered — date</h2>`. Does **not** restore content (use `revise()` or full-mode revisions); Trilium-hard-deleted notes need full-mode `undelete_note`.

#### `label(noteId, name, value?, remove?)`

Guarded direct label surgery — the core path that replaces raw attribute tools for fixing stray/drifted labels. Guards: refused on containers; `noteType` untouchable; `status` validated against the closed vocabulary; `domain`/`topic` values auto-slugged. Bumps `#updated` unless setting `updated` itself. Returns `{ok, noteId, name, value?, action: "set"|"removed"|"not_found"}`.

#### `forget(noteId, reason?, hard?)`

Archive (default) or hard-delete. Archive: optional reason appended to the body, `#closed` stamped, `#archived` added — content stays in place, hidden from default recall. Hard delete is **blocked while backlinks exist** (returns `{blocked, why, backlinks[]}` so you can re-wire first). Refuses the meta-thread and structural notes.

### 7.5 Graph verbs

#### `connect(fromNoteId, relation, toNoteId, remove?)`

Wire a typed edge from the closed 15-relation vocabulary (Zod-enforced). Idempotent — existing edges are detected (`action: "already-existed"`). `worksWith` is wired both directions automatically. `remove=true` deletes the edge (both directions when symmetric).

#### `explore(noteId, mode, toNoteId?, depth?, relation?)`

Graph traversal, four modes:

| Mode | Returns |
|---|---|
| `links` | Outbound one hop: `{id, title, via}` per relation (`~template` excluded; optional `relation` filter) |
| `backlinks` | Inbound one hop: `{noteId, title, relationName}` — computed by OR-ing a `~name.noteId = "<id>"` clause per known relation name (Trilium has no generic reverse predicate) |
| `neighborhood` | BFS within `depth` hops (default 2) walking **both directions**; inbound edges show `via: "←relationName"` |
| `path` | Shortest relation route between `noteId` and `toNoteId` (BFS, default max 6 hops): `{found, hops, path: [{noteId, title, via?}]}` |

#### `inspect(noteId)`

The full raw read of one note — every label (`{name, value, inheritable?}`), outbound relations (capped at 50), type/mime, status/archived, dates, parent and child note IDs. Read-only, safe on any note including containers. The core-mode replacement for reaching into full-mode `get_note`.

### 7.6 Maintenance & system verbs

#### `addendum()` — parameters: none

Marks the `addendum` gate step. Searches Master, the LLM singletons (diary excluded — it's a record), and Knowledge for notes containing pending addendum blocks that should be **folded into the main content** (these surfaces must be clean, merged documents). Detection requires the structural marker — an h2–h4 heading starting with "Addendum —" — so prose mentions of the word don't false-positive. Returns `{found, notes: [{id, title, kind, snippet, relations?}], hint}` guiding `revise(section=…, mode=replace)` merges.

#### `maintain(deep?, dryRun?)`

Marks the `maintain` gate step. Runs the sweep (§10): lite = thread aging + unlabeled-node check; `deep=true` adds stale-review, orphan/sink report, and duplicate-title detection. `dryRun=true` previews without writing. Returns the full `SweepReport` including the active `policy` thresholds.

#### `bootstrap()` — parameters: none

Initialize or repair. If a root is configured, verifies it live: alive → returns `already_initialized` with the children listing, re-ensures the meta-thread, and re-saves config; confirmed 404 (root deleted) → falls through to a fresh build; **any other error is re-thrown** rather than silently creating a duplicate tree (a v5.2 fix). Fresh build: creates the five-area tree via `createBrainLLMStructure`, writes `brainllm.json`, and swaps `brainRef.config` in place — active immediately, no restart.

---

## 8. Full-Mode Tool Surface (33 raw ETAPI tools)

Enabled by `BRAINLLM_MODE=full` (`tools-advanced.ts`). These map one-to-one onto Trilium ETAPI primitives and are **brain-agnostic** — no placement, labeling, dedup, sanitization, snapshots, or lifecycle. The skill's ground rules: a note is only a *memory* once it carries `#noteType`; overwrites don't snapshot (`create_revision` first); find structure by the `#brainLlmRoot` marker, not hardcoded IDs.

### 8.1 Notes (9)

| Tool | Parameters | Returns / purpose |
|---|---|---|
| `search_notes` | `query, ancestorNoteId?, limit?, orderBy?, orderDirection?, fastSearch?, includeArchived?, debug?` | Raw Trilium query language (`#label=value`, `note.title =* "x"`, date comparisons, AND/OR). Returns note stubs `{id, title, type?}` (+ `debugInfo`). |
| `get_note` | `noteId` | Full metadata: attributes (id/type/name/value), parents, children, dates. |
| `get_note_content` | `noteId` | Raw body (HTML/text/code). |
| `create_note` | `parentNoteId, title, content, type?, mime?` | Create at an explicit parent; `type ∈ text·code·book·canvas·mermaid·relationMap·render·search·file·image`. Returns `{noteId, branchId, title}`. |
| `update_note_content` | `noteId, content` | Full replace — **no snapshot**. |
| `patch_note` | `noteId, title?, type?, mime?` | Metadata-only mutation. |
| `delete_note` | `noteId` | Hard-delete (subtree if last branch). Irreversible. |
| `undelete_note` | `noteId` | Recover from Trilium's trash (`canBeUndeleted` per `note_history`). Distinct from core `recover()`. |
| `note_history` | `ancestorNoteId?` | Recent changes feed `{id, title, deleted, date}`, newest first. |

### 8.2 Attributes (5)

| Tool | Parameters | Purpose |
|---|---|---|
| `get_attribute` | `attributeId` | Fetch one attribute. |
| `add_label` | `noteId, name, value?, isInheritable?` | Add a `#label` (empty value = flag). **No dedup** — can produce doubled labels. |
| `add_relation` | `fromNoteId, relationName, toNoteId, isInheritable?` | Any relation name (core `connect()` enforces the closed vocabulary). |
| `update_attribute` | `attributeId, value?, position?` | In-place value/position patch — the way to retarget an existing relation. |
| `delete_attribute` | `attributeId` | Delete any label or relation. |

### 8.3 Branches / placement (4)

| Tool | Parameters | Purpose |
|---|---|---|
| `get_branch` | `branchId` | One placement record. |
| `clone_note` | `noteId, parentNoteId, prefix?` | Multi-parent placement (shared content, not a copy). |
| `move_note` | `noteId, fromParentNoteId, toParentNoteId` | Composite: clone to new parent, then delete the old branch. |
| `delete_branch` | `branchId` | Remove one placement (deletes the note if last). |

### 8.4 Revisions (3)

| Tool | Parameters | Purpose |
|---|---|---|
| `create_revision` | `noteId` | Snapshot current content. |
| `get_revisions` | `noteId` | List `{id, title, date, size}`, newest first. |
| `get_revision_content` | `revisionId` | Historical content — the clobbered-write recovery path. |

### 8.5 Attachments (5)

| Tool | Parameters | Purpose |
|---|---|---|
| `get_attachments` | `noteId` | List `{id, title, mime, size}`. |
| `get_attachment_content` | `attachmentId` | Read text/code attachment content. |
| `create_attachment` | `ownerId, title, mime, content, role?` | Attach a file/text blob (`role ∈ file·image`; base64 for binary). |
| `update_attachment` | `attachmentId, title?, mime?, content?` | Replace content in place and/or patch metadata. |
| `delete_attachment` | `attachmentId` | Permanent delete. |

### 8.6 Calendar — Trilium journal (5)

| Tool | Parameters | Purpose |
|---|---|---|
| `get_day_note` | `date?` (`YYYY-MM-DD`, default today) | Get/auto-create the journal day note. |
| `get_week_note` | `week` (`YYYY-Www`) | Week note. |
| `get_month_note` | `month` (`YYYY-MM`) | Month note. |
| `get_year_note` | `year` (`YYYY`) | Year note. |
| `get_inbox_note` | `date?` | The inbox note for a date (fixed `#inbox` note or the day note). |

### 8.7 System (2)

| Tool | Parameters | Purpose |
|---|---|---|
| `get_app_info` | — | Trilium app version, DB version, runtime metadata. |
| `create_backup` | `name?, date?` | Named DB backup (`<name>.db`, default `brainllm-{date}`). |

---

## 9. Internal Modules & Utilities

### 9.1 `trilium.ts` — the ETAPI client (831 lines)

`TriliumClient` wraps every ETAPI endpoint BrainLLM uses. Key characteristics:

- **Every request carries `trilium-local-now-datetime`** (from `time.ts`) so Trilium stamps dates in the user's timezone, not the server's.
- **Client-generated attribute IDs** — 12-char alphanumeric `newEntityId()`, so `POST /attributes` succeeds on forks that mark the ID mandatory.
- Content endpoints (`get/updateNoteContent`, revision/attachment content, backup) use raw `fetch` (text bodies), everything else goes through a JSON `request<T>()` helper that throws `Trilium API error <status>` on non-2xx.

**Method inventory:**

| Group | Methods |
|---|---|
| App | `getAppInfo` |
| Notes | `searchNotes(query, opts)`, `getNote`, `createNote`, `patchNote`, `deleteNote`, `undeleteNote`, `getNoteContent`, `updateNoteContent` (empty body coerced to `" "`), `getNoteHistory` |
| Revisions | `getNoteRevisions`, `getRevision`, `getRevisionContent`, `createRevision` |
| Attributes | `getAttribute`, `addLabel`, `addRelation`, `updateAttribute`, `deleteAttribute`, `updateLabelValue` (PATCH-in-place preserving inheritable/position, **dedupes surplus same-name labels**, falls back to add), `removeRelation` |
| Branches | `getBranch`, `cloneNote`, `deleteBranch` |
| Attachments | `getNoteAttachments`, `getAttachment`, `getAttachmentContent`, `createAttachment`, `updateAttachmentContent`, `updateAttachment`, `deleteAttachment` |
| Calendar | `getDayNote`, `getWeekNote`, `getMonthNote`, `getYearNote`, `getInboxNote` |
| Backup | `createBackup(nameOrDate)` — bare `YYYY-MM-DD` auto-prefixed to `brainllm-` |
| Graph | `getLinkedNotes`, `getBacklinks(noteId, relationNames?)`, `findNeuralPath(from, to, maxDepth=6)` (BFS shortest path), `getNeighborhood(noteId, depth=2, relationType?)` (bidirectional BFS; inbound `via` prefixed `←`), `traverseConnectome(startId, {maxDepth, relationType, direction, maxNodes})`, `listRelationTypes(ancestor?)` |
| Convenience | `getNotesByLabel(name, value?)` |

**Pure exported helpers:**

| Helper | Purpose |
|---|---|
| `ownedLabel(note, name)` | Label value from the note's **own** (non-inherited) attributes — kind logic must not be fooled by inheritable labels propagating down. |
| `relationSnippet(note, max=8)` | The V7 free relation teaser: outbound edges minus `~template`, capped, `undefined` when empty. |
| `buildBacklinkQuery(targetId, names)` | OR-joined `~name.noteId = "<id>"` clauses — the workaround for Trilium's missing generic reverse-relation predicate (the old `note.ownedAttributes.value` approach returned HTTP 400). |
| `backlinkRelationNames(discovered)` | Canonical vocabulary ∪ discovered relation names, minus `template`. |

### 9.2 `normalize.ts` — the normalization layer (444 lines)

Everything the model emits passes through here before storage. See §11 for the write-safety pipeline. Inventory:

| Function | Purpose |
|---|---|
| `decodeEntities(s)` | Named + numeric HTML entity decoding, iterated up to 3× so double-escapes collapse. |
| `escapeHtml(s)` | Standard `& < > "` escaping. |
| `normalizeTitle(raw)` | Strips tags/entities/whitespace; strips baked-in status suffixes ("Foo — RESOLVED") and returns the `impliedStatus`; truncates at 120 chars on a word boundary with `…`. |
| `titleKey(title)` / `sameTitle(a, b)` | Canonical dedup key (lowercase, diacritics stripped, punctuation → space); `sameTitle` also matches word-boundary prefixes ≥ 8 chars (catches "Foo" vs "Foo — RESOLVED" leftovers). |
| `slugify(raw)` | Label-value slugs: lowercase, diacritics stripped, `&`→"and", non-alphanumerics → `-`, ≤ 60 chars. Prevents taxonomy forking ("Machine Learning" ≡ "machine_learning"). |
| `titleCaseSlug(slug)` | Display form of a domain folder ("machine-learning" → "Machine Learning"). |
| `looksLikeHtml(body)` / `toHtml(body)` | Deterministic minimal markdown → Trilium HTML: paragraphs, `#`–`####` → h2–h4, ul/ol lists, fenced code blocks, GFM tables, bold/italic/inline-code/links. HTML passes through untouched. |
| `toText(html, maxLength=300)` | HTML → readable plain text with ` · ` separators — powers every preview/snippet/digest. |
| `escapeQueryValue(s)` / `queryTokens(query, max=4)` | Search-string escaping; stop-word-filtered significant tokens for title search. |
| `closeDangling(html)` | Stack-based pass closing unclosed block tags at end of content. |
| `sanitizeHtml(html)` | The CKEditor 5 compatibility gate (see §11.2). Returns `{html, warnings[]}`. |
| `safeAppend(current, ...blocks)` | Closes dangling tags in `current` before appending, so new sections are never swallowed inside an unclosed element. |
| `setSection(html, heading, content, mode)` | Heading-section surgery: h2→h3→h4 first-match, attribute/case/whitespace-tolerant regex; append-as-new-h2 fallback. Returns `{html, matched, headingCount}`. |

### 9.3 `router.ts` — placement policy (183 lines)

The single source of truth for *where* a note lives and *which* labels it carries, derived from its kind.

| Export | Purpose |
|---|---|
| `isSingleton(kind)` | True for the five global maintained notes. |
| `kindHome(cfg, kind)` | The singleton note ID or the collection container ID; `""` for domain-resolved kinds (`information`/`sources`). |
| `dedupScope(cfg, kind)` | The area root searched when deduplicating/recalling a kind. |
| `labelPlan(kind, opts, date)` | The labels a new note gets: `#noteType`, `#created`, `#status=active` (threads), `#domain=<slug>`, `#topic=<slug>`s — deduped by name+value. |
| `resolveDomain(trilium, cfg, name)` | Find-or-create a domain book under Knowledge/Domains (search `#noteType=domain #domain=<slug>`; create with `#noteType`, `#domain`, folder icon). Returns `{domainId, domainTitle, createdDomain}`. |
| `resolveParent(trilium, cfg, kind, opts)` | Parent resolution; `information` routes into its domain; `sources` deliberately throws (callers must use `resolveDomain`). |
| `locationLabel(kind, domainTitle?)` | Human-readable receipts, e.g. `"Knowledge → Domains → Technology"`. |

### 9.4 `templates.ts` — enforced content skeletons (107 lines)

`contentFor(kind, {date, body, domain})` produces the enforced structure per kind — the model supplies content, this owns the shape:

| Kind | Skeleton |
|---|---|
| `thread` | meta line → `<h2>Context</h2>` → `<h2>Log</h2>` (dated h3 "Thread opened.") → `<h2>Resolution</h2> — open —` |
| `biography` | Overview / Background / Present |
| `goals` | Near-term / Long-term |
| `preferences` | Communication / Working style / Tools and stack |
| `responsibilities` | Core / Current priorities |
| `protocols` | Operating / Self-correction |
| `sources` | meta line → ❇️/✅ legend → body (`<ul>`) |
| `diary` | meta line (`diary · date`) → body |
| `log` | meta line → Created / Updated / Deleted |
| `domain` | `domainContent(name)` — the book's descriptive line |
| default | meta line (kind · domain · date) → body (+ Resolution anchor when resolvable) |

Also exports: `RESOLUTION_ANCHOR` (`<h2>Resolution</h2>`) / `OPEN_RESOLUTION`, `STRUCTURED_SINGLETONS` (the five skeleton-seeded kinds), `metaThreadContent(date)` (the meta-thread seed — no Resolution anchor by design), `domainContent(name)`, and `purposeContent(purpose)` (the italic engraving written into structural notes at bootstrap).

### 9.5 `lifecycle.ts` — protection, resolution, sweep, digest (375 lines)

Detailed in §10. Exports: `structuralIds(cfg)` / `isStructural(cfg, id)` (every container + singleton + the meta-thread — never relabelled/retitled/forgotten by tools), `isContainer(cfg, id)` (structural **minus** the editable singletons and meta-thread — locked against content edits), `applyResolution(html, outcome, date)` (pure resolution surgery), `sweep(trilium, cfg, {deep, dryRun})` → `SweepReport`, and `buildDigest(trilium, cfg)` → `SessionDigest` (the `start()` orientation payload).

### 9.6 `journal.ts` — daily Insights log generation (88 lines)

`generateDailyLog(trilium, cfg, date)` — sourced entirely from Trilium's own note dates and change history (no parallel bookkeeping):

1. Search content notes with `dateModified` inside the day (archived included, logs and structural notes excluded); split into **Created** (dateCreated starts with the day) vs **Updated**.
2. Pull **Deleted** from `getNoteHistory` entries flagged `current_isDeleted` on the day.
3. Render Created/Updated/Deleted `<ul>` sections with note IDs, and upsert the `[yyyy-mm-dd]` note in Insights/Logs: identical content → `unchanged`; different → append an addendum; missing → create with `#noteType=log` + `#created`.

Returns `{date, noteId, created, updated, deleted, action: created|updated|unchanged|skipped}`.

### 9.7 `time.ts` — timezone-correct dates (56 lines)

Trilium records dates from the client-supplied `trilium-local-now-datetime` header. BrainLLM sends its local now (in Trilium's `YYYY-MM-DD HH:mm:ss.SSS±HHMM` format) on **every** write and derives "today" from the same clock:

- `localNowDateTime()` — host clock by default; when `BRAINLLM_TZ` (IANA) is set, computes the wall time and UTC offset in that zone via `Intl.DateTimeFormat`.
- `localToday()` — `YYYY-MM-DD` in the same zone.
- `localNowTime()` — `HH:mm` in the same zone; used for intra-day addendum headers in `diary()` and `close()`.

This keeps `dateCreated`/`dateModified`, the calendar, sessions, and logs in the **user's** timezone even when the server runs elsewhere (Railway, VPS).

### 9.8 `tools-surface.ts` — surface-read helpers (80 lines)

Shared by the five per-area read modules:

| Helper | Purpose |
|---|---|
| `skim(trilium, ancestorId, {query?, kind?, limit?, includeArchived?})` | Subtree → compact stubs `{id, title, kind, status, updated, preview(160), relations?}`, newest-modified first. |
| `readFull(trilium, id)` | `{id, title, kind, content, relations?}` — the "read in full" primitive. |
| `preview(trilium, id, len=200)` / `previewWithRelations(...)` | Short text previews, with or without the relation snippet. |

### 9.9 `tools.ts` — private helpers of the core surface

| Helper | Purpose |
|---|---|
| `txt(obj)` | Serialize any return into the MCP text-content shape. |
| `err(code, detail, hint?)` | The informational-error convention `{error, detail, hint}`. |
| `labelOf` / `hasLabel` | Attribute lookups on a fetched note. |
| `insertBeforeResolution(html, section)` | Keeps thread addendums above the Resolution anchor. |
| `ensureArchivedFlag(trilium, note)` | Idempotent `#archived` add. |
| `isDuplicateAppend(current, incomingHtml)` | Retry safety: compares the normalized text of the **last** Addendum/Reopened/Recovered block against the incoming content. |
| `parseAddendums(html)` | Splits a body into main-section headings vs accumulated addendum blocks. |
| `findExisting(kind, title)` | Title-based dedup lookup within the kind's area scope (via `sameTitle`). |
| `ensureMetaThread()` | Lazy discover/create/verify of the eternal meta-thread; caches into config and persists. |
| `preCloseSteps` / `REQUIRED_PRECLOSE_STEPS` | The in-memory pre-close gate (§12). |

---

## 10. Lifecycle & Maintenance Engine

### 10.1 Thread aging timeline

```
active ────────────────▶ resolved | superseded    (terminal — archived in place)
  │ untouched dormantAfterDays (21)
  ▼
dormant ───────────────▶ archived in place (#archived + #closed)
  │ untouched archiveDormantAfterDays (45) more
  ▼
```

- Degradation **demotes, never deletes** — archived notes keep their content and are retrievable with `includeArchived=true`.
- Any `revise()` touch reactivates a dormant note to `active`.
- Singletons are maintained (never age); sessions/diary/logs are records (one per day, never aged); the `eternal` meta-thread is exempt from the entire timeline.

### 10.2 The sweep (`sweep()` in `lifecycle.ts`)

**Lite** (runs automatically inside `start()`, `session()`, and via `maintain()`):

1. **Aging** — `active` threads with `dateModified < dormant cutoff` → `dormant`; `dormant` threads past the archive cutoff → `#closed` + `#archived`.
2. **Unlabeled-node check** — for each typed container (Threads, Sessions, Diary, Logs): diff direct children against a `#noteType=<kind>` search; flag children missing their expected label (created via raw `create_note` or past bugs). Archived children skipped.

**Deep** (`maintain(deep=true)`) adds:

3. **Stale-review** — non-record, non-structural content untouched past `staleAfterDays`, flagged (max 15).
4. **Orphan/sink report** — candidates scoped to Memory/Threads + Knowledge (the connectable areas); **inbound detection is brain-wide** so a note referenced from another area is never misflagged. *Orphan* = no outbound and no inbound (max 10 flags); *sink* = inbound but no outbound (max 5). Domain/sources containers and structural notes exempt.
5. **Duplicate-title detection** — grouped by normalized title across the six flat containers (Sessions, Diary, Logs, Threads, Knowledge/Master, Knowledge/Domains), archived included; `information`/`sources` grouped per-domain (`domain-slug::title`) so cross-domain title reuse is intentional and unflagged.

**Report shape:** `{scanned, fixed[], transitions[], deleted[], flagged[], dryRun, policy}` — flags are conversation starters (`connect()` orphans, `revise()`/`resolve()` stale items, `forget()` duplicate extras), never auto-fixes.

### 10.3 Structural protection model

| Tier | Notes | `revise` | `resolve`/`reopen`/`forget` | `label` |
|---|---|---|---|---|
| Containers (root, area roots, Sessions/Threads/Diary/Domains/Logs books) | locked | ❌ | ❌ | ❌ |
| Editable singletons (5 maintained notes + meta-thread) | structural but editable | ✅ | ❌ | ✅ |
| Content notes | everything else | ✅ | ✅ | ✅ (guarded) |

---

## 11. Content Pipeline & Write Safety

### 11.1 The write path (every write tool)

```
model body (text | markdown | HTML)
  → toHtml()          markdown/plain converted; HTML passes through
  → sanitizeHtml()    CKEditor 5 compatibility gate (mutations reported)
  → duplicate guard   isDuplicateAppend() — retry-safe appends
  → createRevision()  snapshot before content mutation (core tools only)
  → safeAppend() / setSection() / insertBeforeResolution() / applyResolution()
  → updateNoteContent()
  → updateLabelValue("updated", today)
```

### 11.2 Sanitization rules (in order, each mutation reported in `sanitized[]`)

1. Strip forbidden element blocks — `script/style/noscript/iframe/form/object/applet/select/textarea/button`.
2. Strip forbidden lone tags — `input/embed`.
3. Strip `style=` attributes.
4. Strip `on*` event attributes.
5. Demote `<h1>` → `<h2>` (h1 is the Trilium note title).
6. Demote `<h5>`/`<h6>` → `<h4>` (CKEditor 5 supports h2–h4 only).
7. Replace `<div>` → `<p>`.
8. Normalize `<br>` — runs become paragraph separators, lone `<br>` becomes a space.
9. Close dangling block tags at end of content.

### 11.3 Idempotency & retry-safety matrix

| Tool | Mechanism |
|---|---|
| `remember` (all routes) | Title dedup (`sameTitle`) + `isDuplicateAppend` → `already_written` |
| `diary` | Same normalized content in **any** of today's addendum blocks → `already_written` |
| `revise` (append) | `isDuplicateAppend` |
| `remarks` (write) | `isDuplicateAppend` |
| `reopen` / `recover` | `isDuplicateAppend` on the Reopened/Recovered block |
| `close` | One session note per date; second call appends an addendum |
| `connect` | Edge-existence check → `already-existed`; symmetric handled both ways |
| `resolve` | Resolution surgery replaces from the anchor — re-running rewrites the same section |
| `bootstrap` | Live-verifies the existing root; only a confirmed 404 triggers a fresh tree |
| `generateDailyLog` | Content-identical regeneration → `unchanged` |

---

## 12. Session Protocol & the Pre-Close Gate

### 12.1 The protocol

```
SESSION START   start()                          once, before responding
DURING          remember / diary / recall / domain / revise / resolve /
                connect / explore / label / inspect / backup …          as things happen
SESSION END     session()                        fetch singletons + diary + sweep; follow next[]
                revise() master & LLM singletons with session observations
                diary(body)                      today's record (even one line)
                addendum()                       find & merge pending addendum blocks
                maintain()                       hygiene audit
                remarks() → remarks(answers)     cue mode, then write mode → meta-thread
                close(summary, title?)           commit log + backup + daily log — once, last
```

### 12.2 Gate mechanics (enforced, not documented)

- An in-memory `Set<string>` per server process/connection tracks which of `["diary", "session", "remarks", "addendum", "maintain"]` have actually run — **by tool invocation, not narration**.
- `remarks` counts only in write mode (content provided); the bare cue call does not.
- `close()` without all five → `{error: "preclose_incomplete", detail, hint}` naming the missing steps. `force=true` bypasses; the response reports `bypassed: [...]` so skips are visible, never silent.
- A successful `close()` clears the set, re-arming the gate for the next session. The gate is never persisted — it resets with the connection.

---

## 13. Deployment

### 13.1 Local (stdio) — the default

Claude Desktop / Claude Code spawns `bun run dist/index.js` with `TRILIUM_BASE_URL` + `TRILIUM_ETAPI_TOKEN` in env. `brainllm.json` sits next to the bundle in `dist/`.

### 13.2 Docker / Railway (HTTP connector)

- **Dockerfile:** two-stage build on `oven/bun:1-alpine` **pinned by digest** for reproducibility (re-pin when bumping `bun.lock`). Builder runs `bun install --frozen-lockfile` + `bun build`; the runtime stage adds `su-exec`, copies the bundle and `entrypoint.sh`, and chowns `/app` to `bun`.
- **entrypoint.sh:** runs as root only to `chown` the Railway volume, then execs the command as the unprivileged `bun` user.
- **Railway recipe:** `PORT` auto-injected; set `MCP_AUTH_TOKEN`, `TRILIUM_BASE_URL`, `TRILIUM_ETAPI_TOKEN`, `BRAINLLM_TZ` as service variables; point the client at `https://<app>.up.railway.app/mcp` with the bearer token. For config persistence, mount a volume on the **BrainLLM service** (not the Trilium service) and set `BRAINLLM_CONFIG=/vol/brainllm.json`; otherwise auto-discovery re-runs on each cold start (~1 s).

### 13.3 DXT desktop extension (`manifest.json`)

A `dxt_version: 0.1` manifest enabling one-click install: binary server (`bun run ${__dirname}/dist/index.js`), user-config prompts for base URL, ETAPI token (marked `sensitive`), mode (core/full), and timezone; platforms darwin/win32/linux; requires bun ≥ 1.0.0.

---

## 14. The Operational Skill Package

`skills/brainllm/` — the Claude skill that teaches the model to *operate* BrainLLM natively (also zipped as `skills/brainllm.zip` and installed to `~/.claude/skills/brainllm`).

| File | Content |
|---|---|
| `SKILL.md` (v7.0) | The full operational protocol: the division of labor, session start/end sequence, knowledge routing decision tree, the three domain-knowledge lifecycle protocols (create / extend / maintain, with the ❇️/✅ sources gate and `Last updated:` lines), reading and writing conventions, the merge rule (singletons/knowledge are clean documents; only sessions/diary/logs accumulate addendums), interconnection discipline, lifecycle behavior, the core tool reference table, full-mode ground rules, and quick-fix table. |
| `references/taxonomy.md` | The relation vocabulary with per-relation usage guidance, and the label conventions table (server-owned labels; `label()` as the one sanctioned direct edit). |
| `references/full-mode.md` | Full-mode ground rules (typed-note requirement, no-snapshot warning, marker-based structure discovery), the raw-artifact policy (embed in typed notes or attach; standalone code/file notes must be labeled and connected), a use-case → tool map, and complete signatures for all raw tools. |
| `references/troubleshooting.md` | Edge cases & failure modes (uninitialized, dedup surprises, contradicted facts, blocked hard-deletes, dormant reactivation, direct-Trilium edits) and symptom→fix troubleshooting (Trilium not running → `start-trilium.ps1`, stale config → `bootstrap`, duplicate-tree recovery, `BRAINLLM_CONFIG` ENOENT). |

The skill is the **human/model-facing contract**; `CLAUDE.md`'s dev workflow requires it (and README) to be updated whenever observable behavior changes.

---

## 15. Scripts & Developer Tooling

| Script | Purpose |
|---|---|
| `scripts/sweep.ts` | Headless maintenance sweep without an MCP client: `bun run scripts/sweep.ts [--deep] [--dry-run]`. Reads config from `dist/brainllm.json` or `BRAIN_CONFIG_PATH`; prints Scanned/Fixed/Transitions/Deleted/Flagged. |
| `scripts/digest-smoke.ts` | Prints the `start()` orientation digest against the live brain — read-only verification helper. |
| `scripts/start-trilium.ps1` | Windows convenience: starts the Trilium desktop exe if not running (idempotent, exit 0 either way). Hard-codes the author's install path and port 37840 — a documented seam to repoint on other machines. |
| `scripts/entrypoint.sh` | Container entrypoint (volume chown → drop privileges → exec). |

**Dev workflow (`CLAUDE.md`):** fix → `bun run build` (must pass clean) → update `SKILL.md`/`README.md` if observable behavior changed → conventional commit (`fix:`/`feat:`/`docs:`/`refactor:`, one logical change per commit) → push to `origin/main`.

---

## 16. Testing

| File | Scope |
|---|---|
| `src/normalize.test.ts` | Unit tests for the normalization layer (titles, slugs, markdown conversion, sanitization, section surgery). |
| `src/lifecycle.test.ts` | Unit tests for lifecycle logic (protection, resolution surgery, sweep behavior). |
| `src/trilium.test.ts` | Client-level tests (backlink query building, attribute helpers). |
| `src/test.ts` | Integration test runner (`bun run test`) — requires a live Trilium instance. |

---

## Appendix A — Tool Inventory Summary

| Surface | Count | Tools |
|---|---|---|
| **Core — universal verbs** | 22 | `start` · `session` · `remarks` · `close` · `backup` · `diary` · `remember` · `recall` · `domain` · `revise` · `resolve` · `reopen` · `recover` · `label` · `connect` · `explore` · `inspect` · `addendum` · `maintain` · `forget` · `brain` · `bootstrap` |
| **Core — surface reads** | 10 | `master`/`master_recall` · `llm`/`llm_recall` · `memory`/`memory_recall` · `knowledge`/`knowledge_recall` · `insights`/`insights_recall` |
| **Full mode — raw ETAPI** | 33 | 9 notes · 5 attributes · 4 branches · 3 revisions · 5 attachments · 5 calendar · 2 system |
| **Total (full mode on)** | **65** | |

## Appendix B — Known Documentation Discrepancies

Findings from this analysis worth reconciling in a future docs pass:

1. **Raw tool count** — `README.md` and `references/full-mode.md` say "32 raw ETAPI tools"; `tools-advanced.ts` actually registers **33** (`update_attachment` appears to be the uncounted addition).
2. **`create_backup` signature drift** — `full-mode.md` documents it as `(date?)`, but the tool accepts `(name?, date?)` with milestone-name support.
3. **`config.ts` version-comment nuance** — the config schema is labeled "version 5" while carrying V7 additions (`memory.metaThread`); intentional (V5 files load without migration) but worth a clarifying line for future readers.

---

*This blueprint is generated from source analysis and reflects the repository state as of 2026-07-09 (BrainLLM v7.0.0). The authoritative operational guide for models using BrainLLM remains `skills/brainllm/SKILL.md`; the authoritative user-facing summary remains `README.md`.*
