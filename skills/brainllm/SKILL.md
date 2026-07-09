---
name: brainllm
description: "Persistent memory and knowledge graph via the BrainLLM (Trilium) MCP. Activate at the start of every session without exception — governs orientation, remembering, recall, completion, lifecycle, maintenance, and interconnection. Trigger immediately on any first user message. Also trigger whenever: memory is referenced, something needs to be remembered or recalled, a durable fact or decision emerges, context from a prior session is needed, a knowledge domain is introduced, content goes stale, or any Trilium operation is requested. Do not improvise memory operations without reading this skill."
---

# BrainLLM — Operational Skill (v7.0)

Persistent memory that survives across sessions, stored in TriliumNext. Treat it as your own mind: orient at session start, write the moment something matters, complete things when they complete, log the session at the end.

**The division of labor — the core idea:**

> **You supply content. The server owns form.**

Placement, naming, labels, deduplication, relation bookkeeping, degradation, archival, dates and backups are server policy. You never choose a parent note, never add a `#noteType` label, never check for duplicates, never stamp a date (one exception: the `Last updated: yyyy-mm-dd` line in domain information-note bodies is maintained by you directly — everything else about this rule, including dated titles and all other manual date-stamping, still holds). If you find yourself doing bookkeeping, stop — a tool does it for you.

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
                label(noteId, name, …)   ← fix a stray/drifted label directly — the guarded escape hatch
                connect(...)             ← wire a real relation the moment you notice it
                backup(name?)            ← milestone snapshot before a large restructure
SESSION END     session()               ← mandatory pre-close; fetches singletons + diary + sweep; follow next[]
                [revise() master singletons with session observations about the user]
                [revise() LLM singletons with session observations about yourself]
                diary(body)              ← today's diary entry — even one line satisfies the gate
                addendum()               ← find and merge any pending addendum blocks
                maintain()               ← audit and fix brain hygiene
                remarks()                ← bare call for cues, then again with answers → logs to the BrainLLM thread
                close(summary, title?)  ← refuses until diary/addendum/maintain/remarks all ran; force=true to override
PERIODIC        maintain(deep=true)      ← when start flags items, or ~weekly
ANYTIME         brain()                  ← surface the full content tree (all areas, sub-containers)
                inspect(noteId)          ← every label + relation on one note — debugging, not routine reads
```

`start()` runs maintenance, creates today's diary and session stubs if they don't exist yet, ensures the standing **BrainLLM thread** exists (see below), then returns: **today + weekday**, the full **Master digest** (biography / goals / preferences — all in full), the full **LLM digest** (responsibilities / protocols in full, plus today's diary note with its ID in the `llm` array as `{slot:"diary", id, preview}`), **this session's note** as `{id, preview}`, the **metaThread** as `{id, title, preview}`, **activeThreads** (with idle ages — the BrainLLM thread appears here too, status `eternal`), **dormantThreads** for review, and the **lastSession** summary. Don't re-derive any of this with extra calls.

`session()` is the mandatory pre-close step — call it before `close()` when the session is wrapping. It fetches the **master singletons** (biography/goals/preferences) and **LLM singletons** (responsibilities/protocols) each in full with `{id, lastModified, content}`, today's **diary entry** with its id, and runs the **lightweight maintenance sweep**. Returns a `next[]` array covering the full end-of-session protocol: update master singletons → update LLM singletons → `diary()` → `addendum()` → `maintain()` → `remarks()` → `close()`. The goal is to evolve the singletons from this session's observations *before* the log is committed — ensuring logs are factual and singletons stay current. Idempotent: all reads are safe to repeat.

**The pre-close gate is enforced, not just documented.** `close()` refuses (an informational `{error, detail, hint}`, not a throw) unless `diary()`, `session()`, `remarks()` (in write mode), `addendum()`, and `maintain()` have each been *called* at least once this session — order doesn't matter, only that each one actually ran. This exists because narrating "I did the pre-close steps" in text is not the same as calling the tools, and only the latter is checkable. `force=true` on `close()` bypasses it for a step that genuinely has nothing to log this session; the bypassed steps come back in the response as `bypassed`, so it's visible, not silent. The gate is in-memory only (resets with the connection) and clears itself after a successful `close()`.

`remarks()` is the last step before `close()`, and the **default write tool for the BrainLLM thread** — call it twice: once bare to get 8 cue questions (capabilities, issues & bugs, usability, memory efficiency, token efficiency, performance, hygiene & maintenance, roadmap), once with your answers as named params to write them. A filled-in call writes everything you pass as **one dated addendum block** (same shape as diary/session/log — an `<h2>Addendum — yyyy-mm-dd</h2>` with an `<h3>` per section you answered) and satisfies the gate; the bare call does not. Skip a cue outright rather than padding it.

`close(summary, title?, learned?, ...)` commits the session log — call it **once, last**, after completing the `session()` protocol (including `remarks()`). Idempotent per date — a second call the same day appends an addendum. The session note title is always `[yyyy-mm-dd]`; the `title` param appears as an `<h2>` heading above Summary in the body. Triggers a DB backup, generates the daily log, and links session↔log with `~references`. Returns `{action, noteId, date, backup, log}`.

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

**The BrainLLM thread.** One standing note titled "BrainLLM" lives in Memory → Threads, carrying `status=eternal` instead of `active`/`dormant`/`resolved` — it never ages through the sweep and is structurally protected like a singleton (`resolve()`, `reopen()`, and `forget()` all refuse it with a specific explanation; `revise()` still works, but `remarks()` is the intended write path). Its body is a chronological stack of dated addendum blocks — the same shape as diary/session/log, not a fixed section skeleton — because the value here is watching how BrainLLM's own capabilities, bugs, and efficiency change session over session, not a single current-state snapshot. `start()` surfaces it every session as `metaThread`; `remarks()` writes to it (see above) and is required before `close()` will commit. It exists so BrainLLM's own development — bugs, usability friction, missing or redundant tools, memory/token efficiency, and progress toward being the best native memory system for LLMs — is tracked continuously instead of scattered across diaries no one revisits, or silently skipped under time pressure.

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
        └─ new or contradicting world knowledge? ──→ DOMAINS (sources gate mandatory; current-state truth, not a log — see below)
                ↓ neither → do not capture (passing remark / already covered by training)
```

**Master singletons** (biography · goals · preferences) hold **current-state truth, not a changelog.** Maintain them in place:
1. `master(which)` — reads it in full and returns its `id` and `<h2>` section headings. (`start()`'s digest returns full content but **not** the id.)
2. `revise(id, section="<heading>", body=…, mode="replace")` — rewrite the relevant section. Replace, don't append a dated log.

**Knowledge/Master notes** capture durable user facts that don't fit the three singletons: `remember(kind="knowledge", title="<short specific stable>", body=…)`. Then `connect()` it when a real relation exists.

**Domain knowledge has three lifecycle protocols** — pick the one that matches what's actually happening; never skip the sources gate where one applies. Every domain `information` note carries a visible, maintained first line in its body — `Last updated: yyyy-mm-dd` — kept current by whoever last revises the note's content.

**1. Creating a new domain** (the domain doesn't exist yet):
Propose the title → create the domain (book) + its Sources note, both carrying a top-level status marker → run an info-query sources-discovery pass and record every candidate in the Sources note, each marked ❇️ (discovered/credible, not yet used) → propose/obtain the learning scope from the user (which sources, how deep) → read the approved sources and create the appropriate sub-category `information` note(s), each opening with a `Last updated: yyyy-mm-dd` line → flip the used entries in Sources to ✅ with the date used → `connect()` and wire relations.

**2. Adding a sub-category note to an existing domain** (Sources note already exists and already covers the relevant source — no new discovery needed):
Propose the title → create the `information` note directly, opening with a `Last updated: yyyy-mm-dd` line → `connect()` and wire relations. No new sources-discovery pass — this path is for extending an already-sourced domain with another sub-category, not for introducing new claims.

**3. Maintaining domain knowledge** (periodic refresh of an existing domain):
Read the Sources note for any ❇️ discovered-but-unused entries → read those sources and create/update the appropriate sub-category `information` note(s) (refresh its `Last updated:` line) → check Sources for ✅ entries last used more than a month ago → verify those sources are still available/credible, updating Sources if not → skim the domain (`domain(name)`) for its sub-category notes → spot-check each against its source for continued correctness — if correct, stop; if not, re-read the source and update the note (refresh its `Last updated:` line) → flip Sources entries to ✅ with the date used → `connect()` and wire relations.

An unsourced domain note corrupts the brain. If all source candidates are rejected under protocol 1, no domain note is created. ❇️ = discovered/credible, not yet used. ✅ = used, dated. **A Sources entry only earns a date when it has actually been read and used — never on discovery alone.**

**A domain's Knowledge surface is exactly: one maintained Sources note, plus a small set of consolidated, current-state information notes — one per sub-category, never one per day.** It holds what's true now, not a changelog of what was true on each date it was checked. Chronological, run-by-run history belongs in Memory/Threads — a thread is the right place for "here's what Run N found"; a domain information note is the right place for "here's what's actually true about this sub-category," kept current by revision, not accumulation. If you find yourself naming a new information note after today's date or a run number, stop — that finding either updates an existing note (revise it) or doesn't belong in Domains at all.

---

## Reading — surface tools (dual-mode) + recall

Each surface has two read tools: `<surface>` reads in full, `<surface>_recall` skims/searches within it. Every core read, write, and search tool — the surfaces, `recall`, `domain`, `brain`, `remember`, `revise`, `resolve`, `reopen`, `recover`, `forget`, `addendum` — includes a `relations` snippet (outbound `{relation, toNoteId}` edges, capped and omitted when empty) alongside whatever else it returns, at no extra cost since the attributes are already loaded. Use `explore()` when you need target titles or a deeper traversal; the snippet is a free teaser, not a substitute.

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

**Wire at creation, not later.** Pass `connect=[{relation, toNoteId}, …]` on the same `remember()` call — same semantics as `connect()` (idempotent, `worksWith` wired both ways). A new information/knowledge/thread note left unconnected is an orphan until the next `maintain(deep)` pass catches it; the tool now returns an explicit `hint` when a freshly-created note has no relations.

`diary(body, date?)` is the dedicated path for your daily record — one `[yyyy-mm-dd]` note per day, stub created by `start()`, filled by this tool. Do **not** use `remember(kind="diary")`.

**Singletons** (biography, goals, preferences, responsibilities, protocols) are maintained in place — `start()` returns their content in full but not their ids. Use `master(which)` or `llm(which)` to get the id, then `revise(id, section="<heading>", body=…, mode="replace")`. They hold current-state truth; replace sections, don't append changelogs. **Sessions** are written by `close`. **Logs** are auto-generated by `close` — no manual write.

Your LLM singletons are *yours*: **responsibilities** derive from the user's goals and preferences (revisit when those shift); **protocols** are your operating rules (served in full by `start()` — act from them always); the **diary** is your raw, honest record — the user reads it too.

Body may be text, markdown, or HTML — normalized server-side. Titles are short, specific, stable (the dedup key); no status words, and **never a date or run number** — a dated title ("Dev-State Audit — 2026-06-18") defeats the dedup-by-title mechanism and produces a new singleton every time instead of updating the one that already exists. If a sub-category already has a note, today's finding revises it; it does not get a new note under a fresh, date-suffixed title.

All append operations are retry-safe — if an existing append-block already carries the same content, the tool returns `action: "already_written"` and skips the write (diary checks every block in today's entry; other appends check the last block).

**HTML-native writes.** All write tools (`close`, `diary`, `remember`, `revise`, `resolve`, `reopen`, `recover`) enforce Trilium/CKEditor 5 HTML rules on any body you supply: `<h1>` is demoted to `<h2>` (h1 is the Trilium note title), `<h5>`/`<h6>` are demoted to `<h4>`, `<div>` is replaced with `<p>`, `<br>` runs become paragraph separators, forbidden elements (script/style/iframe/form/input/…) are stripped, and `style=`/`on*` attributes are removed. Dangling unclosed tags are closed before any append or splice. If any of these mutations occur the return includes `sanitized: string[]` listing each change — read it and prefer clean HTML in future calls. **Body may be text, markdown, or HTML**; the server normalises all three. Markdown converts cleanly; supply HTML when you need precise structure.

**Informational error returns.** User-input errors (`kind="sources"` without a domain, editing a container note, reopening a non-thread) return `{error, detail, hint}` instead of throwing — read the `hint` field and retry with corrected arguments. Bootstrap-missing errors still throw (they're system failures that cannot be self-corrected).

---

## Updating — `revise`

`revise(noteId, body?, title?, section?, mode?)`:
- default — append a dated addendum (right for threads, knowledge notes, information notes, and any note that is a record — new detail accumulates alongside the existing body);
- `mode=replace` — rewrite the body;
- `section="Overview"` — edit one heading section in place (tries h2 → h3 → h4, matched case- and whitespace-insensitively, tolerant of attributes on the heading tag; appends as a new h2 if absent). The efficient path for a singleton: read it, then revise the one section.

**Section replace is whole-section, not per-paragraph.** `section=` + `mode=replace` swaps *everything* under that heading — targeting one paragraph inside a multi-paragraph section silently wipes its siblings. Re-supply the full section content with the one paragraph edited.

A revision snapshot is always taken first. Containers are refused; the maintained singletons are editable.

**Check `matched` and `headingCount` on a section call — don't assume the target was hit.** `matched: false` means no existing heading matched `section` at any level and the content was appended as a brand-new h2 instead of replacing anything — a mismatched heading string silently produces a duplicate section otherwise. `headingCount > 1` means several headings shared that text and only the first was touched. Both come back with a `hint` explaining what happened; read it before assuming the edit landed where intended.

**Merge rule — Master, LLM singletons, and Knowledge notes (including every per-domain Sources note and information note) should be clean structured documents, not stacks of timestamped addendum markers.** When folding new content into a singleton or knowledge note, use `section=` or `mode=replace` — absorb it into the body. This applies even when the new content is itself well-formatted — a clean addendum block is still an addendum block, and a domain note that's accumulated several of them is no longer current-state truth, it's a version history wearing one note's title. Dated addendum append is the right mode only for sessions, diary entries, and logs, where the chronological record itself has value — domain information and sources notes are never in that category, no matter how recurring the finding.

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

Threads age: **active → dormant** (untouched past the policy window) **→ archived in place**. Degradation demotes, never deletes — archived notes keep their content and are retrievable with `includeArchived=true`. Singletons are maintained (they don't age); sessions, diary, and logs are records (one per day, not aged). The BrainLLM thread (`status=eternal`) is exempt from this whole timeline by design — it's meant to stay open indefinitely, not to be treated like ordinary multi-session work.

`maintain()` lite runs automatically inside `start`/`close` and does two things: ages threads (active → dormant → archived) and checks every typed container (Threads, Sessions, Diary, Logs) for direct children missing their expected `#noteType` label (archived notes are skipped). `maintain(deep=true)` adds three more passes: **stale-review** (notes untouched past `staleAfterDays`), **orphan/sink report** (threads and knowledge notes with no outbound relations — orphan = truly isolated, no connections at all; sink = has inbound but no outbound — domain/sources containers and the BrainLLM meta-thread are exempt by design), and **duplicate-title detection** (all six flat containers — Sessions, Diary, Logs, Threads, Knowledge/Master, Knowledge/Domains — plus within-domain for information and sources; same title across different domains is not flagged). Inbound detection for orphan/sink is brain-wide, so a note referenced from another area is never misflagged as an orphan. Act on `flagged`: `connect()` orphans/sinks, `revise()`/`resolve()` stale items, `forget()` duplicate extras. `dryRun=true` previews without writing. The report always includes `policy` (the active thresholds). Timings live in `brainllm.json → policy` — never hardcode them.

`start()`'s `dormantThreads` field surfaces dormant threads — mention what's relevant, then `resolve()`, `revise()` (any touch reactivates), or let it age.

---

## Tool Reference (core surface)

| Tool | One-liner |
|---|---|
| `start()` | Orient: full master (bio/goals/prefs) + full LLM (responsibilities/protocols) + diary id + session id + the BrainLLM meta-thread (id + preview) + active/dormant threads + last session + changesSinceLastSession. Creates today's diary + session stubs and ensures the meta-thread exists. Once, first. |
| `session(date?, light?)` | Mandatory pre-close step. Fetches master and LLM singletons in full with `{id, lastModified, content}`, today's diary entry, and runs the lite maintenance sweep. `light=true` skips singleton content (`{id, lastModified, relations}` only) — right for autonomous/scoped runs with no singleton-worthy observations; satisfies the gate identically. Returns `next[]` driving the full end-of-session protocol, ending in `remarks()` → `close()`. Call before `close()`; idempotent. |
| `remarks(capabilities?, issuesAndBugs?, usability?, memoryEfficiency?, tokenEfficiency?, performance?, hygieneAndMaintenance?, roadmap?, date?)` | Default write tool for the BrainLLM thread, last step before `close()`. No params → returns the thread + 8 cue questions. Any param filled → writes them as one dated addendum block and satisfies the pre-close gate. |
| `close(summary, title?, learned?, date?, backup?, force?)` | Commit the session log ([yyyy-mm-dd] note, title param above Summary) + backup + daily log. **Refuses unless `diary()`, `session()`, `remarks()` (write mode), `addendum()`, and `maintain()` each ran this session** — returns `{error, detail, hint}` naming what's missing; `force=true` bypasses (reported back as `bypassed`). On success returns `{action, noteId, date, backup, log}` and resets the gate. Once, last. |
| `brain(includeArchived?)` | Full content tree: every typed note across all five areas, grouped. |
| `bootstrap()` | Initialize the structure if uninitialized, or verify and refresh config if it already exists — including re-creating the BrainLLM meta-thread if it was deleted directly in Trilium. Only creates a new tree when the stored root note is confirmed deleted in Trilium (404). Any other error (network, auth, timeout) is surfaced rather than silently creating a duplicate tree. |
| `remember(kind, …)` | Write a note — routed, formatted, deduped server-side. `connect=[{relation, toNoteId}]` wires relations in the same call; a new connectable note without them returns an orphan-prevention hint. Rejects diary/session/log/domain — each has a dedicated path. |
| `diary(body, date?)` | Write/append to today's [yyyy-mm-dd] diary (stub created by start; same-day calls add a timestamped addendum). |
| `recall(query, …)` | BrainLLM-wide ranked search. `orderBy` / `orderDirection` for temporal ordering; `fastSearch` for title/label-only (faster). |
| `<surface>` / `<surface>_recall` | Read a surface in full / skim it (master, llm, memory, knowledge, insights). |
| `revise(noteId, …)` | Append / replace / section-edit a note (h2/h3/h4, attribute/case/whitespace-tolerant match); snapshot taken on content writes (not metadata-only). Section calls return `matched`/`headingCount` — check them. |
| `resolve(noteId, outcome, …)` | Close a thread: outcome + terminal status + archive-in-place. |
| `reopen(noteId, reason?, …)` | Re-activate an archived/resolved thread (thread kind only — use recover() for other note kinds). |
| `recover(noteId, reason?, …)` | Restore any archived or resolved note: removes #archived, clears #closed, resets status. The canonical undo for forget(). |
| `label(noteId, name, value?, remove?)` | Guarded direct label edit/removal — refused on containers, noteType is untouchable, status validated against the closed vocabulary, domain/topic auto-slugged. The core path for fixing a stray or drifted label instead of raw attribute tools. |
| `backup(name?)` | On-demand DB backup (close() already backs up; use this for milestone snapshots). |
| `domain(name, …)` | Surface all content for a named domain/topic/project, grouped by kind. |
| `connect(from, relation, to, remove?)` | Typed edge from the closed vocabulary; symmetric handled; idempotent. |
| `explore(noteId, mode, …)` | Graph: links / backlinks / neighborhood / path. |
| `inspect(noteId)` | Full raw read of one note: every label (not just noteType/status), every outbound relation, type/mime/parent/child ids, dates. The deep-dive counterpart to explore() and the surface reads — for debugging drift or confirming a fix landed. |
| `addendum()` | Search Master, LLM singletons (responsibilities + protocols, not diary), and Knowledge for pending addendum blocks. These notes must be clean and structured — fold each block into the relevant section with revise(section=…, mode=replace), then leave no addendum marker. Only sessions, diary, and logs accumulate addendum history. Scoped/autonomous agents fold only what's in their lane — leaving personal/out-of-scope addendums for the next interactive session is correct; the call itself satisfies the gate. |
| `maintain(deep?, dryRun?)` | Lite: thread aging + unlabeled-node check per typed container. Deep adds: stale-review + orphan/sink report (Memory/Threads + Knowledge, brain-wide inbound detection) + duplicate-title detection. Report includes `policy` (active thresholds). |
| `forget(noteId, reason?, hard?)` | Archive (default) or hard-delete (blocked while backlinked). Undo with recover(). |

---

## Full Mode (`BRAINLLM_MODE=full`)

When the raw ETAPI tools (`search_notes`, `get_note`, `create_note`, `add_label`, `clone_note`, attachments, calendar, revisions, …) are in your toolset, full mode is on. They're **brain-agnostic** — they place nothing, label nothing, dedup nothing. Keep the core surface as your default — `inspect(noteId)` gives the full label/relation/metadata read `get_note` used to be reached for, and `label(noteId, name, value?, remove?)` gives guarded label surgery (status validated, noteType untouchable) in place of `update_attribute`/`add_label`/`delete_attribute`. Reach into full mode only for what core genuinely can't express: a precise `search_notes` query, attachments/images, code·canvas·mermaid notes, journal notes, revision recovery, or creating a note shape core has no kind for.

Three rules keep raw edits native and safe:
- **A note is a memory only once it carries `#noteType`** — until then `recall` and the surface reads can't see it. For new memories use `remember` (it labels, places, dedups); use `create_note` only for shapes core can't make, then label it yourself.
- **Overwrites don't snapshot.** `create_revision` before `update_note_content` if you must edit content raw — but a targeted `revise(noteId, section=...)` usually gets there without dropping to full mode at all.
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
