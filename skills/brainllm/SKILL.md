---
name: brainllm
description: "Persistent memory and knowledge graph via the BrainLLM (Trilium) MCP. Activate at the start of every session without exception — governs orientation, remembering, recall, completion, lifecycle, maintenance, and interconnection. Trigger immediately on any first user message. Also trigger whenever: memory is referenced, something needs to be remembered or recalled, a durable fact or decision emerges, context from a prior session is needed, a knowledge domain is introduced, content goes stale, or any Trilium operation is requested. Do not improvise memory operations without reading this skill."
---

# BrainLLM — Operational Skill (v5.2)

Persistent memory that survives across sessions, stored in TriliumNext. Treat it as your own mind: orient at session start, write the moment something matters, complete things when they complete, log the session at the end.

**The division of labor — the core idea:**

> **You supply content. The server owns form.**

Placement, naming, labels, deduplication, relation bookkeeping, degradation, archival, dates and backups are server policy. You never choose a parent note, never add a `#noteType` label, never check for duplicates, never stamp a date. If you find yourself doing bookkeeping, stop — a tool does it for you.

**Operate from it, natively.** `start()` loads who the user is and who you are here — act from both without being asked. When the topic is the user's world, read `knowledge` / `recall` before answering from training; the brain is authoritative where it speaks. Write the instant something matters; wire a relation the instant you see one. Using it should feel like remembering, not filing.

---

## The Protocol

```
SESSION START   start()                 ← once, before responding to anything
DURING          remember(...)           ← the moment something worth keeping appears
                diary(body)             ← your daily record (one note/day, stub created by start)
                <surface> / _recall      ← read a surface in full, or skim it
                recall(...)              ← brain-wide search before answering from memory
                domain(name)             ← surface all content for a domain/topic/project, grouped by kind
                revise(...)              ← edit a note (section-surgical for singletons)
                resolve(...)             ← close a thread with its outcome
                reopen(noteId)           ← re-activate an archived/resolved thread
                recover(noteId)          ← restore any archived/resolved note (undo forget)
                connect(...)             ← wire a real relation the moment you notice it
                backup(name?)            ← milestone snapshot before a large restructure
SESSION END     close(summary, title?)   ← once, when work wraps or the user says goodbye
                diary(body)              ← update today's diary entry (optional)
                addendum()               ← find and merge any pending addendum blocks
                maintain()               ← audit and fix brain hygiene
PERIODIC        maintain(deep=true)      ← when start flags items, or ~weekly
ANYTIME         brain()                  ← surface the full content tree (all areas, sub-containers)
```

`start()` runs maintenance, creates today's diary and session stubs if they don't exist yet, then returns: **today + weekday**, the full **Master digest** (biography / goals / preferences — all in full), the full **LLM digest** (responsibilities / protocols in full, plus today's diary note with its ID in the `llm` array as `{slot:"diary", id, preview}`), **this session's note** as `{id, preview}`, **activeThreads** (with idle ages), **dormantThreads** for review, and the **lastSession** summary. Don't re-derive any of this with extra calls.

`close(summary, title?, learned?, ...)` is idempotent per date — a second call the same day appends an addendum. The session note title is always `[yyyy-mm-dd]`; the `title` param appears as an `<h2>` heading above Summary in the body. Returns the **full diary entry** for the day with its ID. Runs maintenance, triggers a DB backup, generates the daily log, and links session↔log with `~references`. After `close()`, always follow in order: **`diary()`** (optional — update your diary), **`addendum()`** (find and merge pending addendum blocks), **`maintain()`** (hygiene).

**Write during the session, not at the end.** A fact remembered mid-conversation survives a crash; one you planned to write at the end does not.

---

## The Structure — five areas

```
BrainLLM
├── Master      biography · goals · preferences            (maintained singletons)
├── LLM         responsibilities · protocols · Diary/       (singletons + [yyyy-mm-dd] diary note/day)
├── Memory      Sessions/ · Threads/                        ([yyyy-mm-dd] session/day + multi-session threads)
├── Knowledge   Master · Domains/[domain]/{ sources, info } (learned info beyond/contra training)
└── Insights    Logs/                                       ([yyyy-mm-dd] log/day, auto-generated by close)
```

Placement is server policy — there is no parent parameter. You choose the **kind**; the server routes it.

**One-per-day notes:** diary, session, and log notes are each one per day, titled `[yyyy-mm-dd]`. `start()` creates today's diary and session stubs. `close()` fills the session stub with real content (or appends an addendum on a second call). Log notes are generated by `close()` and append an addendum if close is called again the same day.

---

## Knowledge Routing — where things go

Before writing anything, decide which protocol applies. Never manufacture knowledge.

```
something worth keeping
        │
        ├─ about the user? ──→ MASTER
        │     ├─ biographic / goal / preference  → singleton in place  (revise the section)
        │     └─ else (relationship, constraint, context) → Knowledge/Master note
        │
        └─ new or contradicting world knowledge? ──→ DOMAINS (sources gate mandatory)
                ↓ neither → do not capture (passing remark / already covered by training)
```

**Master singletons** (biography · goals · preferences) hold **current-state truth, not a changelog.** Maintain them in place:
1. `master(which)` — reads it in full and returns its `id` and `<h2>` section headings. (`start()`'s digest returns full content but **not** the id.)
2. `revise(id, section="<heading>", body=…, mode="replace")` — rewrite the relevant section. Replace, don't append a dated log.

**Knowledge/Master notes** capture durable user facts that don't fit the three singletons: `remember(kind="knowledge", title="<short specific stable>", body=…)`. Then `connect()` it when a real relation exists.

**Domain knowledge has a mandatory sources gate** — never skip it:

1. **Search** for credible, viable sources on the claim (a real search — not from training memory alone).
2. **Submit** candidates to the user for approval. No self-approval.
3. **Read** the approved sources before extracting knowledge.
4. **Record:** `remember(kind="sources", domain="…", body="…")` with markers — ❇️ approved, ✅ approved + used.
5. **Write:** `remember(kind="information", domain="…", title="<sub-category>", body=…)`.
6. **Wire:** `connect()` to sources (`sourceOf`/`derivedFrom`) and related notes (`extends`, `contradicts`, `references`).

An unsourced domain note corrupts the brain. If all source candidates are rejected, no domain note is created.

---

## Reading — surface tools (dual-mode) + recall

Each surface has two read tools: `<surface>` reads in full, `<surface>_recall` skims/searches within it.

| Tool | Reads |
|---|---|
| `master(which)` / `master_recall()` | a Master singleton in full (returns id + section headings) / a skim of all three |
| `llm(which, id?)` / `llm_recall()` | responsibilities · protocols, or a diary entry by id / singletons as `{id, preview}`, diary as stubs — use the returned id directly with revise() |
| `memory(id)` / `memory_recall(query?)` | a thread or session in full / active threads + recent sessions (stubs include status) |
| `knowledge(id)` / `knowledge_recall(query?, domain?)` | a knowledge/info/sources note / domain contents or user-knowledge + domains |
| `insights(date?)` / `insights_recall()` | a day's log / recent logs |

`recall(query, kinds?, domain?, includeArchived?)` searches the **whole** brain — use it when you don't know the surface, or for cross-surface lookups.

`brain(includeArchived?)` surfaces **every content note** across all five areas — id, title, kind, status, dates — grouped by area. Use to audit the full picture or locate a note.

---

## Writing — `remember`, `diary` (and `close`)

`remember(kind, ...)` is the write path for most content; the server places and formats it:

| The content is… | kind | Notes |
|---|---|---|
| New/contradicting world knowledge | `information` | sources gate first; pass `domain=` and sub-category `title` |
| A credible source for a domain | `sources` | pass `domain=`; mark ❇️ discovered / ✅ used |
| A durable fact about the user (not bio/goals/prefs) | `knowledge` | titled note in Knowledge/Master |
| A multi-session line of work | `thread` | `revise()` to log progress, `resolve()` to close |

`kind="diary"`, `"session"`, `"log"`, and `"domain"` are rejected — each has a dedicated path (`diary()`, `close()`, auto-generated, and `information` respectively).

`diary(body, date?)` is the dedicated path for your daily record — one `[yyyy-mm-dd]` note per day, stub created by `start()`, filled by this tool. Do **not** use `remember(kind="diary")`.

**Singletons** (biography, goals, preferences, responsibilities, protocols) are maintained in place — `start()` returns their content in full but not their ids. Use `master(which)` or `llm(which)` to get the id, then `revise(id, section="<heading>", body=…, mode="replace")`. They hold current-state truth; replace sections, don't append changelogs. **Sessions** are written by `close`. **Logs** are auto-generated by `close` — no manual write.

Your LLM singletons are *yours*: **responsibilities** derive from the user's goals and preferences (revisit when those shift); **protocols** are your operating rules (served in full by `start()` — act from them always); the **diary** is your raw, honest record — the user reads it too.

Body may be text, markdown, or HTML — normalized server-side. Titles are short, specific, stable (the dedup key); no status words.

**Retry-safety:** `connect()` and `diary()` are safe to retry — connect checks for an existing edge before writing; diary compares the last addendum's content + timestamp before appending (returns `already_written` if duplicate within 5 min). `revise(mode="replace")` is idempotent. Do **not** blindly retry `remember()` on its upsert/update path or `revise(mode="append")` — those append unconditionally and will duplicate content.

---

## Updating — `revise`

`revise(noteId, body?, title?, section?, mode?)`:
- default — append a dated addendum (right for threads, knowledge, information);
- `mode=replace` — rewrite the body;
- `section="Overview"` — edit one heading section in place (tries h2 → h3 → h4; appends as h2 if absent). The efficient path for a singleton: read it, then revise the one section.

A revision snapshot is always taken first. Containers are refused; the maintained singletons are editable.

---

## Completing — `resolve`

`resolve(noteId, outcome)` is the completion path for threads: writes the outcome, sets the terminal status, archives in place (stays put, out of default recall). Write a *substantive* outcome — "overtaken by events" is valid; "done" is not.

---

## Interconnection — `connect` + `explore`

The brain is a graph; wire real relations as you notice them.

`connect(fromNoteId, relation, toNoteId, remove?)` — closed vocabulary:
`relatesTo · extends · contradicts · supports · causes · references · partOf · worksWith · mentors · instanceOf · supersedes · implements · inspiredBy · sourceOf · derivedFrom`
Pick the most specific verb that's true; `relatesTo` is the last resort. `worksWith` is symmetric. Calling twice is safe.

`explore(noteId, mode)` — `links` / `backlinks` / `neighborhood` (`depth`) / `path` (give `toNoteId`; finds the shortest link route).

`maintain(deep=true)` surfaces **unconnected** knowledge notes — wire them when a real relation exists; never invent one.

---

## Lifecycle & Maintenance

Threads age: **active → dormant** (untouched past the policy window) **→ archived in place**. Degradation demotes, never deletes — archived notes keep their content and are retrievable with `includeArchived=true`. Singletons are maintained (they don't age); sessions, diary, and logs are records (one per day, not aged).

`maintain()` lite runs automatically inside `start`/`close` and does two things: ages threads (active → dormant → archived) and checks every typed container (Threads, Sessions, Diary, Logs) for direct children missing their expected `#noteType` label (archived notes are skipped). `maintain(deep=true)` adds three more passes: **stale-review** (notes untouched past `staleAfterDays`), **orphan/sink report** (knowledge notes with no outbound relations — orphan = isolated, sink = has inbound but no outbound), and **duplicate-title detection** (all six flat containers — Sessions, Diary, Logs, Threads, Knowledge/Master, Knowledge/Domains — plus within-domain for information and sources; same title across different domains is not flagged). Act on `flagged`: `connect()` orphans/sinks, `revise()`/`resolve()` stale items, `forget()` duplicate extras. `dryRun=true` previews without writing. The report always includes `policy` (the active thresholds). Timings live in `brainllm.json → policy` — never hardcode them.

`start()`'s `dormantThreads` field surfaces dormant threads — mention what's relevant, then `resolve()`, `revise()` (any touch reactivates), or let it age.

---

## Tool Reference (core surface)

| Tool | One-liner |
|---|---|
| `start()` | Orient: full master (bio/goals/prefs) + full LLM (responsibilities/protocols) + diary id + session id + active/dormant threads + last session + changesSinceLastSession. Creates today's diary + session stubs. Once, first. |
| `close(summary, title?, learned?, …)` | Session log ([yyyy-mm-dd] note, title param above Summary) + sweep + backup + log. Returns full diary. Once, last. Then: diary (optional) → addendum() → maintain(). |
| `brain(includeArchived?)` | Full content tree: every typed note across all five areas, grouped. |
| `bootstrap()` | Initialize the structure if uninitialized, or verify and refresh config if it already exists. Only creates a new tree when the stored root note is confirmed deleted in Trilium (404). Any other error (network, auth, timeout) is surfaced rather than silently creating a duplicate tree. |
| `remember(kind, …)` | Write a note — routed, formatted, deduped server-side. Rejects diary/session/log/domain — each has a dedicated path. |
| `diary(body, date?)` | Write/append to today's [yyyy-mm-dd] diary (stub created by start; same-day calls add a timestamped addendum). Returns `action: "already_written"` if the same content was written within the past 5 min — safe to retry. |
| `recall(query, …)` | BrainLLM-wide ranked search. `orderBy` / `orderDirection` for temporal ordering; `fastSearch` for title/label-only (faster). |
| `<surface>` / `<surface>_recall` | Read a surface in full / skim it (master, llm, memory, knowledge, insights). |
| `revise(noteId, …)` | Append / replace / section-edit a note (h2/h3/h4); snapshot taken on content writes (not metadata-only). |
| `resolve(noteId, outcome, …)` | Close a thread: outcome + terminal status + archive-in-place. |
| `reopen(noteId, reason?, …)` | Re-activate an archived/resolved thread (thread kind only — use recover() for other note kinds). |
| `recover(noteId, reason?, …)` | Restore any archived or resolved note: removes #archived, clears #closed, resets status. The canonical undo for forget(). |
| `backup(name?)` | On-demand DB backup (close() already backs up; use this for milestone snapshots). |
| `domain(name, …)` | Surface all content for a named domain/topic/project, grouped by kind. |
| `connect(from, relation, to, remove?)` | Typed edge from the closed vocabulary; symmetric handled; idempotent. |
| `explore(noteId, mode, …)` | Graph: links / backlinks / neighborhood / path. |
| `addendum()` | Search the brain for notes containing "Addendum" — returns ids, titles, kinds, snippets for revise()-based merging. |
| `maintain(deep?, dryRun?)` | Lite: thread aging + unlabeled-node check per typed container. Deep adds: stale-review + orphan/sink report + duplicate-title detection. Report includes `policy` (active thresholds). |
| `forget(noteId, reason?, hard?)` | Archive (default) or hard-delete (blocked while backlinked). Undo with recover(). |

---

## Full Mode (`BRAINLLM_MODE=full`)

When the raw ETAPI tools (`search_notes`, `get_note`, `create_note`, `add_label`, `clone_note`, attachments, calendar, revisions, …) are in your toolset, full mode is on. They're **brain-agnostic** — they place nothing, label nothing, dedup nothing. Keep the core surface as your default; reach here only for what core can't express: a precise `search_notes` query, exact attributes, attachments/images, code·canvas·mermaid notes, journal notes, revision recovery, or attribute surgery.

Three rules keep raw edits native and safe:
- **A note is a memory only once it carries `#noteType`** — until then `recall` and the surface reads can't see it. For new memories use `remember` (it labels, places, dedups); use `create_note` only for shapes core can't make, then label it yourself.
- **Overwrites don't snapshot, labels don't dedup.** `create_revision` before `update_note_content`; change an existing label with `update_attribute`, not a second `add_label`; prefer `forget` over `delete_note` (subtree-recursive).
- **Find structure by marker** — there's no `get_brain_config`. `search_notes("#brainLlmRoot")` → `get_note` to walk to the container you need.

**Raw artifacts** (a code file, an image, a PDF) sit best *inside* the typed-note model — embed a snippet fenced in an `information` note's body (core `remember` — conformant and searchable), or `create_attachment` a file/image onto a typed note. Make a free-standing `type=code`/`file` note only when you need Trilium's native handling, then label it `#noteType` (closest kind) and `connect` it to a typed anchor so it stays discoverable.

Full signatures, the gotchas in depth, and a use-case→tool map: `references/full-mode.md`.

---

## Quick-Fix

| Situation | Fix |
|---|---|
| BrainLLM tools time out / connection errors | Run `C:\Users\miiso\Projects\OSS\BrainLLM\scripts\start-trilium.ps1` (PowerShell). Wait ~3 s, retry. |
| `start()` → `uninitialized` | Run `bootstrap()`. Safe anytime — only creates a new tree if the root note is confirmed gone; surfaces errors otherwise. |
| Dates look off on a hosted deploy | Set `BRAINLLM_TZ` (IANA, e.g. `Africa/Johannesburg`) so Trilium stamps in the user's timezone. |

For relation/label conventions read `references/taxonomy.md`; for full-mode signatures `references/full-mode.md`; for other symptoms `references/troubleshooting.md`.
