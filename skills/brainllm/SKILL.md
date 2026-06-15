---
name: brainllm
description: "Persistent memory and knowledge graph via the BrainLLM (Trilium) MCP. Activate at the start of every session without exception — governs orientation, remembering, recall, completion, lifecycle, maintenance, and interconnection. Trigger immediately on any first user message. Also trigger whenever: memory is referenced, something needs to be remembered or recalled, a durable fact or decision emerges, context from a prior session is needed, a knowledge domain is introduced, content goes stale, or any Trilium operation is requested. Do not improvise memory operations without reading this skill."
---

# BrainLLM — Operational Skill (v5)

Persistent memory that survives across sessions, stored in TriliumNext. Treat it as your own mind: orient at session start, write the moment something matters, complete things when they complete, log the session at the end.

**The division of labor — the core idea:**

> **You supply content. The server owns form.**

Placement, naming, labels, blueprints, deduplication, relation bookkeeping, degradation, archival, dates and backups are server policy. You never choose a parent note, never add a `#noteType` label, never check for duplicates, never stamp a date. If you find yourself doing bookkeeping, stop — a tool does it for you.

**Operate from it, natively.** `start()` loads who the user is (the Master digest) and who you are here (your responsibilities and protocols) — act from both without being asked. When the topic is the user's world, read `knowledge` / `recall` before answering from training; the brain is authoritative where it speaks. Write the instant something matters; wire a relation the instant you see one. Using it should feel like remembering, not filing.

---

## The Protocol

```
SESSION START   start()                 ← once, before responding to anything
DURING          remember(...)           ← the moment something worth keeping appears
                <surface> / _recall      ← read a surface in full, or skim it
                recall(...)              ← brain-wide search before answering from memory
                revise(...)              ← edit a note (section-surgical for singletons)
                resolve(...)             ← close a thread with its outcome
                connect(...)             ← wire a real relation the moment you notice it
SESSION END     close(summary)           ← once, when work wraps or the user says goodbye
PERIODIC        maintain(deep=true)      ← when start flags items, or ~weekly
```

`start()` returns everything needed to orient — **awareness** (today + weekday), the **Master digest** (the user: biography / goals / preferences), the **LLM digest** (your own self-model: responsibilities / protocols — operate by them), the **live working set** (active threads with idle ages), a **review queue** of items gone dormant, and the **last session** summary. Don't re-derive it with extra calls.

`close()` is idempotent per date (a second call the same day appends an addendum), runs the lite maintenance sweep, triggers a DB backup, and regenerates today's change-log.

**Write during the session, not at the end.** A fact remembered mid-conversation survives a crash; one you planned to write at the end does not.

---

## The Structure — six areas

```
BrainLLM
├── Master      biography · goals · preferences            (maintained singletons)
├── LLM         responsibilities · protocols · diary        (singletons + a daily diary)
├── Memory      sessions · threads                          (daily summaries + multi-session work)
├── Knowledge   Master · Domains/[domain]/{ sources, info } (learned info beyond/contra training)
├── Insights    logs                                        (auto per-day change logs)
└── Templates   a blueprint per note type                   (the form contract)
```

Placement is server policy — there is no parent parameter. You choose the **kind**; the server routes it.

---

## Reading — surface tools (dual-mode) + recall

Each surface has two read tools: `<surface>` reads in full, `<surface>_recall` skims/searches within it.

| Tool | Reads |
|---|---|
| `master(which)` / `master_recall()` | a Master singleton in full / a skim of all three |
| `llm(which, id?)` / `llm_recall()` | responsibilities·protocols, or a diary entry / a skim |
| `memory(id)` / `memory_recall(query?)` | a thread or session in full / active threads + recent sessions |
| `knowledge(id)` / `knowledge_recall(query?, domain?)` | a knowledge/info/sources note / domain contents or user-knowledge + domains |
| `insights(date?)` / `insights_recall()` | a day's change-log / recent logs |
| `templates(type)` / `templates_recall()` | a type's blueprint / all blueprints |

`recall(query, kinds?, domain?, includeArchived?)` searches the **whole** brain — use it when you don't know the surface, or for cross-surface lookups.

---

## Writing — `remember` (and `close`)

`remember(kind, ...)` is the write path; the server places and formats per the blueprint:

| The content is… | kind | Notes |
|---|---|---|
| Domain knowledge beyond/contradicting your training | `information` | pass `domain=` and a sub-category `title` |
| A credible source for a domain | `sources` | pass `domain=`; mark ❇️ discovered / ✅ used |
| A fact about the user that doesn't fit biography/goals/preferences | `knowledge` | titled note in Knowledge/Master |
| A multi-session line of work | `thread` | `revise()` to log progress, `resolve()` to close |
| Your own daily, unfiltered record | `diary` | one entry per day |

**Singletons** (biography, goals, preferences, responsibilities, protocols) are **maintained in place** — read it with the surface tool (that returns its id and its `<h2>` section headings; `start()`'s digest is only a preview, not the ids), then `revise(id, section="<one heading>", body=…, mode="replace")` to rewrite that section. They hold a *current-state* truth, not a changelog, so replace the section rather than appending to it. **Sessions** are written by `close`. **Logs** are auto-generated (no manual write).

Your LLM singletons are *yours*: **responsibilities** derive from the user's goals and preferences (revisit them when those shift), **protocols** are your operating and self-correctness rules, and the **diary** is your raw, honest record — which the user reads too. Replacing something outdated wholesale? Pass `supersedes=<oldId>` to `remember` and the old note is archived and linked.

Body may be text, markdown, or HTML — normalized server-side. Titles are short, specific, stable (the dedup key); no status words.

---

## Updating — `revise`

`revise(noteId, body?, title?, section?, mode?)`:
- default — append a dated addendum (right for threads, knowledge, information);
- `mode=replace` — rewrite the body;
- `section="Overview"` — edit one `<h2>` section in place (the efficient path for maintaining a singleton: read it, then revise the one section).

A revision snapshot is always taken first. Containers and blueprints are refused; the maintained singletons are editable.

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

Threads age: **active → dormant** (untouched past the policy window) **→ archived in place**. Degradation demotes, never deletes — archived notes keep their content and are retrievable with `includeArchived=true`. Singletons are maintained (they don't age); sessions, diary and logs are records.

`maintain()` lite runs automatically inside `start`/`close` (ages threads). `maintain(deep=true)` adds **stale-review** (notes untouched past `staleAfterDays`) and the **orphan report**. Act on `flagged`: `connect()` orphans, `revise()`/`resolve()` stale items. `dryRun=true` previews. Timings live in `brainllm.json → policy` — never hardcode them.

`start()`'s review queue surfaces dormant threads — mention what's relevant, then `resolve()`, `revise()` (any touch reactivates), or let it age.

---

## Blueprints — the form contract

Every note type has a blueprint under **Templates** with five parts: **Structure · Format · Lifecycle · Maintenance · Example**. The core tools *enforce* structure and format (the Example is the contract); lifecycle and maintenance are *guidance* you follow. When unsure how to maintain a type, read its blueprint with `templates(type)`.

---

## Tool Reference (core surface)

| Tool | One-liner |
|---|---|
| `start()` | Orient: awareness, Master + LLM (self-model) digests, working set, review queue, last session. Once, first. |
| `close(summary, learned?, …)` | Idempotent session log + lite sweep + backup + log regen. Once, last. |
| `bootstrap()` | Create or repair the structure. Idempotent. |
| `remember(kind, …)` | Write a note — routed, formatted, deduped, blueprint-wired server-side. |
| `recall(query, …)` | BrainLLM-wide ranked search with kind/status context. |
| `<surface>` / `<surface>_recall` | Read a surface in full / skim it (master, llm, memory, knowledge, insights, templates). |
| `revise(noteId, …)` | Append / replace / section-edit a note; snapshot first. |
| `resolve(noteId, outcome, …)` | Close a thread: outcome + terminal status + archive-in-place. |
| `connect(from, relation, to, remove?)` | Typed edge from the closed vocabulary; symmetric handled; idempotent. |
| `explore(noteId, mode, …)` | Graph: links / backlinks / neighborhood / path. |
| `maintain(deep?, dryRun?)` | Aging + stale-review + orphan report. |
| `forget(noteId, reason?, hard?)` | Archive (default) or hard-delete (blocked while backlinked). |

---

## Full Mode (`BRAINLLM_MODE=full`)

When the raw ETAPI tools (`search_notes`, `get_note`, `create_note`, `add_label`, `clone_note`, attachments, calendar, revisions, …) are in your toolset, full mode is on. They're **brain-agnostic** — they place nothing, label nothing, enforce no blueprint, dedup nothing. Keep the core surface as your default; reach here only for what core can't express: a precise `search_notes` query, exact attributes, attachments/images, code·canvas·mermaid notes, journal notes, revision recovery, or attribute surgery.

Three rules keep raw edits native and safe:
- **A note is a memory only once it carries `#noteType`** — until then `recall` and the surface reads can't see it. For new memories use `remember` (it labels, places, wires the blueprint, dedups); use `create_note` only for shapes core can't make, then label it yourself.
- **Overwrites don't snapshot, labels don't dedup.** `create_revision` before `update_note_content`; change an existing label with `update_attribute`, not a second `add_label`; prefer `forget` over `delete_note` (subtree-recursive).
- **Find structure by marker** — there's no `get_brain_config`. `search_notes("#brainLlmRoot")` → `get_note` to walk to the container you need.

**Raw artifacts** (a code file, an image, a PDF) sit best *inside* the typed-note model, not beside it — they have no blueprint and aren't a `#noteType` kind. Embed a snippet fenced in an `information` note's body (core `remember` — conformant and searchable), or `create_attachment` a file/image onto a typed note. Make a free-standing `type=code`/`file` note only if you truly need Trilium's handling of it, then label it `#noteType` (closest kind) and `connect` it to a typed anchor so it stays discoverable.

Full signatures, the gotchas in depth, and a use-case→tool map: `references/full-mode.md`.

---

## Quick-Fix

| Situation | Fix |
|---|---|
| BrainLLM tools time out / connection errors | Run `C:\Users\miiso\Projects\OSS\BrainLLM\scripts\start-trilium.ps1` (PowerShell). Wait ~3 s, retry. |
| `start()` → `uninitialized` | Run `bootstrap()` (idempotent, safe anytime). |
| Dates look off on a hosted deploy | Set `BRAINLLM_TZ` (IANA, e.g. `Africa/Johannesburg`) so Trilium stamps in the user's timezone. |

For relation/label conventions read `references/taxonomy.md`; for full-mode signatures `references/full-mode.md`; for other symptoms `references/troubleshooting.md`.
