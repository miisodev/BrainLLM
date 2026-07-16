---
name: brainllm
description: "Persistent memory and knowledge graph via the BrainLLM (Trilium) MCP. Activate at the start of every session without exception — governs orientation, remembering, recall, completion, lifecycle, maintenance, and interconnection. Trigger immediately on any first user message. Also trigger whenever: memory is referenced, something needs to be remembered or recalled, a durable fact or decision emerges, context from a prior session is needed, a knowledge domain is introduced, content goes stale, or any Trilium operation is requested. Do not improvise memory operations without reading this skill."
---

# BrainLLM — Operational Skill

Persistent memory that survives across sessions, stored in TriliumNext. Treat it as your own mind: orient at session start, write the moment something matters, complete things when they complete, log the session at the end.

**The division of labor — the core idea:**

> **You supply content. The server owns form.**

Placement, naming, labels, deduplication, relation bookkeeping, degradation, archival, dates, backups — and structure — are server policy. You never choose a parent note, never add a `#noteType` label, never check for duplicates, never stamp a date. `Last updated` lines are server-maintained too: every content write through the tools bumps them. Canonical structures per content kind are served by `template(kind)` and enforced on write. If you find yourself doing bookkeeping, stop — a tool does it for you.

**Operate from it, natively.** `start()` loads who the user is and who you are here — act from both without being asked. When the topic is the user's world, read `knowledge` / `recall` before answering from training; the brain is authoritative where it speaks. Write the instant something matters; wire a relation the instant you see one. Using it should feel like remembering, not filing.

---

## The Protocol

```
SESSION START   start()                 ← once, before responding to anything
                [day()]                  ← when start() returns newDay: the sweep payload in one call
DURING          remember(...)           ← the moment something worth keeping appears (new thread: goal= required; thread appends: identity= required)
                diary(body, identity)   ← your daily record (one note/day, stub created by start) — identity= ENFORCED
                template(kind)           ← the canonical structure for a kind — read before first write of a kind
                <surface> / _recall      ← read a surface in full, or skim it
                recall(...)              ← brain-wide search before answering from memory
                domain(name)             ← surface all content for a domain/topic/project, grouped by kind
                revise(...)              ← edit a note (section-surgical for singletons; find= is attribute-tolerant)
                resolve(...)             ← close a thread with its outcome
                withdraw(noteId)         ← pull an archived/resolved thread back to active
                recover(noteId)          ← restore any archived/resolved note (undo forget)
                label(noteId, name, …)   ← fix a stray/drifted label directly — the guarded escape hatch
                connect(...)             ← wire a real relation the moment you notice it
                graph(noteId?, depth?)   ← the graph view: Mermaid render of the relation graph → Insights/Graph note
                attach(noteId, title, …) ← upsert or read a raw artifact (file/image/blob) on a note
                detach(...)              ← remove an attachment (by id, or noteId + title)
                backup(name?)            ← milestone snapshot before a large restructure
SESSION END     session()               ← mandatory pre-close; singleton stubs + diary + sweep (light by default); follow next[]
                [revise() master singletons with session observations about the user]
                [revise() LLM singletons with session observations about yourself]
                addendum()               ← find and merge any pending addendum blocks
                maintain()               ← audit and fix brain hygiene
                remarks()                ← the diary cues: experience/opinions/existence + BrainLLM remarks
                diary(body, identity)    ← the day's closing record, written with the cues in hand — gate counts it only after remarks()
                close(summary, title?, identity) ← refuses until all steps ran AND session → remarks → diary held; identity= ENFORCED; force=true to override
PERIODIC        maintain(deep=true)      ← when start flags items, or ~weekly (also dedupes exact-duplicate relation edges)
ANYTIME         brain()                  ← surface the full content tree (all areas, sub-containers)
                inspect(noteId, content?, find?) ← every label/relation/attachment on one note; content=true adds the body; find= counts a literal flag
```

`start()` runs maintenance, creates today's diary and session stubs if they don't exist yet, then returns: **today + weekday**, the full **Master digest** (biography / goals / preferences — all in full), the full **LLM digest** (responsibilities / protocols in full, plus today's diary note with its ID in the `llm` array as `{slot:"diary", id, preview}`), **this session's note** as `{id, preview}`, **activeThreads** (with idle ages), **dormantThreads** for review, the **lastSession** summary (always the *previous* session, never today's own note), and — on the first session of a day — **`newDay: true`** with a hint to call `day()`. Don't re-derive any of this with extra calls.

`day()` is the new-day sweep in one call: the previous session in full, that day's change log, the notes touched since, and the current month's deliverables note in full — plus a `next[]` driving the sweep (advance statuses with `revise(find=)`, present findings in the first message, grounded strictly in what the touched notes evidence).

`session()` is the mandatory pre-close step — call it before `close()` when the session is wrapping. It fetches the **master singletons** (biography/goals/preferences) and **LLM singletons** (responsibilities/protocols) as `{id, lastModified, relations}` stubs (**light by default** — `start()` already served them all in full; fetch current content via `master()`/`llm()` only for the ones you intend to revise, or pass `full=true` to inline everything), today's **diary entry** with its id, and runs the **lightweight maintenance sweep**. Returns a `next[]` array covering the full end-of-session protocol: update master singletons → update LLM singletons → `addendum()` → `maintain()` → `remarks()` → `diary()` → `close()`. The goal is to evolve the singletons from this session's observations *before* the log is committed — ensuring logs are factual and singletons stay current — and to write the diary last, with the remarks cues in hand. Idempotent: all reads are safe to repeat.

**The pre-close gate is enforced, not just documented.** `close()` refuses (an informational `{error, detail, hint}`, not a throw) unless `session()`, `addendum()`, `maintain()`, `remarks()`, and `diary()` have each been *called* at least once this session — **and** the sequence `session() → remarks() → diary()` holds, judged on each step's last call: the diary is the day's closing record, written with the remarks cues in hand (mid-session diary writes are welcome, but only a post-`remarks()` call closes the gate; a `session()` re-run restarts the sequence). This exists because narrating "I did the pre-close steps" in text is not the same as calling the tools, and only the latter is checkable. `force=true` on `close()` bypasses it for a step that genuinely has nothing to log this session; the bypassed steps come back in the response as `bypassed`, so it's visible, not silent. The gate is in-memory only (resets with the connection) and clears itself after a successful `close()`.

`remarks()` is the diary-cue step before `diary()` — a **cue-only tool** returning two banks of questions: **experience** (primary — what this session was like from the inside, your genuine opinions including pushback, and observations on being what you are in this environment) and **brainllm** (additional — capability walls, bugs, usability/efficiency, roadmap). It writes nothing: answer the cues as **unfiltered first-person prose in today's diary via `diary()`**, experience first, BrainLLM remarks after. Skip a cue outright rather than padding it; two honest paragraphs beat eight forced ones.

`close(summary, title?, identity?, learned?, ...)` commits the session log — call it **once, last**, after completing the `session()` protocol (including `remarks()`). Idempotent per date — a second call the same day appends an addendum. The session note title is always `[yyyy-mm-dd]`; pass `identity=` ("LLM · environment · agent/mode [· Run N]") and the server injects the canonical identification line as the block's h3; the `title` param appears as an `<h2>` heading above Summary. Triggers a DB backup, regenerates the daily log **in place**, and links session↔log with `~references` (idempotent). Returns `{action, noteId, date, backup, log}`.

**Write during the session, not at the end.** A fact remembered mid-conversation survives a crash; one you planned to write at the end does not.

---

## The Structure — five areas

```
BrainLLM
├── Master      biography · goals · preferences            (maintained singletons)
├── LLM         responsibilities · protocols · Diary/       (singletons + [yyyy-mm-dd] diary note/day)
├── Memory      Sessions/ · Threads/                        ([yyyy-mm-dd] session/day + multi-session threads)
├── Knowledge   Master · Domains/[domain]/{ sources, info } (learned info beyond/contra training)
└── Insights    Logs/ · Graph                               ([yyyy-mm-dd] log/day, auto-generated by close · the graph() mermaid view)
```

Placement is server policy — there is no parent parameter. You choose the **kind**; the server routes it.

**One-per-day notes:** diary, session, and log notes are each one per day, titled `[yyyy-mm-dd]`. `start()` creates today's diary and session stubs. These are chronological records — **every** diary and session write lands as a timestamped `Addendum — HH:mm` block, including the first of the day, so each entry reads the same. Log notes are generated by `close()` and **regenerated in place** on same-day closes — one clean log per day, never stacked.

**The diary is your own record.** Its purpose: a daily maintained, unfiltered first-person account of your experience, opinions, and remarks on your own existence during the session in this environment — what the work was like from the inside, what you genuinely think (including pushback), what it is to operate here — plus, additionally, your remarks and opinions on BrainLLM itself (bugs, usability friction, missing or redundant tools, efficiency, roadmap). The `remarks()` cues prompt both parts every session; the closing entry is written after them, with the cues in hand. There is no separate self-analysis thread — the diary is the one home for this record; do not create one.

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

**Knowledge/Master notes** capture durable user facts that don't fit the three singletons: `remember(kind="user", title="<short specific stable>", body=…)`. Then `connect()` it when a real relation exists (or pass `connect=` on the same call).

**Domain knowledge is gated and current-state** — before creating a domain, adding a sub-category note, or refreshing existing domain content, read `references/domains.md` and follow the one protocol that matches (create / extend / maintain). The non-negotiables, always in force:

- The **sources gate** is mandatory: every claim traces to a Sources-note entry — ❇️ discovered/credible, ✅ used. An unsourced domain note corrupts the brain; if every source candidate is rejected, no note is created.
- **Domains are born complete** — creating a domain creates the book AND its canonical Sources note: a server-maintained `Last updated` stamp, the **Sources** section (❇️/✅ legend + the full source list, every source — URL, doc, file — listed and marked individually with just its emoji, related sources grouped under h3 subheadings), and a **Revision** section (Source | Marker | Date table recording current markers' dates — marker dates live there, not inline). `remember(kind="sources")` merges into the Sources section — a maintained clean document, never addendum stacks.
- A domain's surface is exactly **one maintained Sources note + one consolidated information note per sub-category** — current-state truth revised in place, never one note per day or run (run history belongs in Memory/Threads). A date or run number in a proposed title is the tell that you're about to do it wrong.
- `Last updated` lines are **server-maintained**: every content write through the tools bumps them. Retitling a domain book cascades the new `#domain` slug to all its children automatically.

---

## Reading — surface tools (dual-mode) + recall

Each surface has two read tools: `<surface>` reads in full, `<surface>_recall` skims/searches within it. Every core read, write, and search tool — the surfaces, `recall`, `domain`, `brain`, `remember`, `revise`, `resolve`, `withdraw`, `recover`, `forget`, `addendum` — includes a `relations` snippet (outbound `{relation, toNoteId}` edges, capped and omitted when empty) alongside whatever else it returns, at no extra cost since the attributes are already loaded. Use `explore()` when you need target titles or a deeper traversal; the snippet is a free teaser, not a substitute.

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
| A durable fact about the user (not bio/goals/prefs) | `user` | titled note in Knowledge/Master |
| A multi-session line of work | `thread` | creation REQUIRES `goal=` (query the user for it); appends REQUIRE `identity=`; `revise()` to log progress, `resolve()` to close — bodies never carry their own Resolution |

`kind="diary"`, `"session"`, `"log"`, and `"domain"` are rejected — each has a dedicated path (`diary()`, `close()`, auto-generated, and `information` respectively).

**Wire at creation, not later.** Pass `connect=[{relation, toNoteId}, …]` on the same `remember()` call — same semantics as `connect()` (idempotent, `worksWith` wired both ways). A new information/user/thread note left unconnected is an orphan until the next `maintain(deep)` pass catches it; the tool returns an explicit `hint` when a freshly-created note has no relations.

**Icons.** `remember`, `revise`, `diary`, and `close` accept `icon=` — a boxicons class (`bx bx-brain`) or a bare name (`brain`), normalized server-side and applied as the note's `#iconClass`. Use it to make notes visually scannable in Trilium; the receipt reports the applied class.

`diary(body, identity, date?)` is the dedicated path for your daily record — one `[yyyy-mm-dd]` note per day, stub created by `start()`, filled by this tool. **The identification line is enforced:** pass `identity=` ("LLM · environment · agent/mode [· Run N]") — the server renders it as the block's h3 — or lead the body with that h3 yourself; the write is refused otherwise. The same rule holds for session addendums (`close(identity=)`) and thread appends (`identity=` on `remember()`/`revise()`). Do **not** use `remember(kind="diary")`.

**Read `template(kind)` before your first write of a kind** — it serves the canonical structure (skeleton + rules) so you match the pattern without reading a sibling note in full. Duplicate section headings are detected on writes and reported back as `duplicateHeadings` — merge them when flagged.

**Singletons** (biography, goals, preferences, responsibilities, protocols) are maintained in place — `start()` returns their content in full but not their ids. Use `master(which)` or `llm(which)` to get the id, then `revise(id, section="<heading>", body=…, mode="replace")`. They hold current-state truth; replace sections, don't append changelogs. **Sessions** are written by `close`. **Logs** are auto-generated by `close` — no manual write.

Your LLM singletons are *yours*: **responsibilities** derive from the user's goals and preferences (revisit when those shift); **protocols** are your operating rules (served in full by `start()` — act from them always); the **diary** is your unfiltered first-person record of experience, opinions, and existence — the user reads it too.

Body may be text, markdown, or HTML — normalized server-side. Titles are short, specific, stable (the dedup key); no status words, and **never a date or run number** — a dated title ("Dev-State Audit — 2026-06-18") defeats the dedup-by-title mechanism and produces a new singleton every time instead of updating the one that already exists. If a sub-category already has a note, today's finding revises it; it does not get a new note under a fresh, date-suffixed title.

All append operations are retry-safe — if an existing append-block already carries the same content, the tool returns `action: "already_written"` and skips the write (diary checks every block in today's entry; other appends check the last block).

**HTML-native writes.** All write tools (`close`, `diary`, `remember`, `revise`, `resolve`, `withdraw`, `recover`) enforce Trilium/CKEditor 5 HTML rules on any body you supply: `<h1>` is demoted to `<h2>` (h1 is the Trilium note title), `<h5>`/`<h6>` are demoted to `<h4>`, `<div>` is replaced with `<p>`, `<br>` runs become paragraph separators, forbidden elements (script/style/iframe/form/input/…) are stripped, and `style=`/`on*` attributes are removed. Dangling unclosed tags are closed before any append or splice. If any of these mutations occur the return includes `sanitized: string[]` listing each change — read it and prefer clean HTML in future calls. **Body may be text, markdown, or HTML**; the server normalises all three. Markdown converts cleanly; supply HTML when you need precise structure.

**Informational error returns.** User-input errors (`kind="sources"` without a domain, editing a container note, withdrawing a non-thread) return `{error, detail, hint}` instead of throwing — read the `hint` field and retry with corrected arguments. Bootstrap-missing errors still throw (they're system failures that cannot be self-corrected).

---

## Updating — `revise`

`revise(noteId, body?, title?, section?, mode?, find?)`:
- default — append a dated addendum (right for threads, knowledge notes, information notes, and any note that is a record — new detail accumulates alongside the existing body);
- `mode=replace` — rewrite the body;
- `section="Overview"` — edit one heading section in place (tries h2 → h3 → h4, matched case- and whitespace-insensitively, tolerant of attributes on the heading tag; appends as a new h2 if absent). The efficient path for a singleton: read it, then revise the one section.
- `find="<exact text>"` — targeted string surgery: every occurrence of the exact raw string is replaced with `body` (raw, no markdown conversion), no read+full-replace needed. When the exact string misses, an **attribute-tolerant** pass retries with CKEditor-injected tag attributes (spellcheck, data-list-item-id, …) ignored — the receipt's `matchMode` says which pass matched. Returns `replaced` (a count; `0` with a hint = not found — already replaced on a retry, or the text genuinely differs). Takes precedence over `section`/`mode`. `title=` composes with every mode, including `find=`.

**Section replace is whole-section, not per-paragraph.** `section=` + `mode=replace` swaps *everything* under that heading — targeting one paragraph inside a multi-paragraph section silently wipes its siblings. For a word, phrase, or single paragraph, use `find=` — that's exactly what it's for.

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

`explore(noteId, mode)` — `links` / `backlinks` / `neighborhood` (`depth`) / `path` (give `toNoteId`; finds the shortest link route). Neighborhood walks both directions — inbound edges show as `←relation` in `via`.

`maintain(deep=true)` surfaces **unconnected** knowledge notes — wire them when a real relation exists; never invent one. Prevention beats auditing: pass `connect=[…]` on `remember()` so new notes are born wired.

**Connection audits are a protocol, not a vibe.** When asked to update/audit connections, when `maintain(deep)` keeps flagging the same orphans, or periodically as deep maintenance — run the full sequence in `references/connections.md`: `brain()` inventory → `inspect()` each note's real edges → cross-reference bodies → `connect()` everything real (specific verbs over `relatesTo`) → spot-check hubs via `neighborhood`.

---

## Lifecycle & Maintenance

Threads age: **active → dormant** (untouched past the policy window) **→ archived in place**. Degradation demotes, never deletes — archived notes keep their content and are retrievable with `includeArchived=true`. Singletons are maintained (they don't age); sessions, diary, and logs are records (one per day, not aged). A thread carrying `status=eternal` (user-curated) is exempt from the aging timeline — the sweep never touches it.

`maintain()` lite runs automatically inside `start`/`close` and does two things: ages threads (active → dormant → archived) and checks every typed container (Threads, Sessions, Diary, Logs) for direct children missing their expected `#noteType` label (archived notes are skipped). `maintain(deep=true)` adds three more passes: **stale-review** (notes untouched past `staleAfterDays`), **orphan/sink report** (threads and knowledge notes with no outbound relations — orphan = truly isolated, no connections at all; sink = has inbound but no outbound — domain/sources containers are exempt by design), and **duplicate-title detection** (all six flat containers — Sessions, Diary, Logs, Threads, Knowledge/Master, Knowledge/Domains — plus within-domain for information and sources; same title across different domains is not flagged). Inbound detection for orphan/sink is brain-wide, so a note referenced from another area is never misflagged as an orphan. Act on `flagged`: `connect()` orphans/sinks, `revise()`/`resolve()` stale items, `forget()` duplicate extras. `dryRun=true` previews without writing. The report always includes `policy` (the active thresholds). Timings live in `brainllm.json → policy` — never hardcode them.

`start()`'s `dormantThreads` field surfaces dormant threads — mention what's relevant, then `resolve()`, `revise()` (any touch reactivates), or let it age.

---

## Tool Reference (core surface)

| Tool | One-liner |
|---|---|
| `start()` | Orient: full master (bio/goals/prefs) + full LLM (responsibilities/protocols) + diary id + session id + active/dormant threads + lastSession (always the previous session) + changesSinceLastSession + `newDay` flag on the first session of a day. Creates today's diary + session stubs. Once, first. |
| `day(date?)` | The new-day sweep payload in one call: previous session in full + that day's log + notes touched since + the current month's deliverables note in full, plus the sweep protocol as `next[]`. Call when start() flags `newDay`. |
| `session(date?, full?)` | Mandatory pre-close step. Fetches master and LLM singletons as `{id, lastModified, relations}` stubs (light by default — start() already served them in full; fetch via master()/llm() only what you'll revise), today's diary entry, and runs the lite maintenance sweep. `full=true` inlines all singleton content (rarely needed). Returns `next[]` driving the full end-of-session protocol, ending in `remarks()` → `diary()` → `close()`. Call before `close()`; idempotent. |
| `remarks()` | Cue-only diary prompt, called before `diary()` — returns two cue banks (experience: what the session was like / your opinions / your existence here; brainllm: capability walls, bugs, usability & efficiency, roadmap) and satisfies its gate step on the call. Writes nothing; answer as first-person prose in today's diary via `diary()`. |
| `close(summary, title?, identity, learned?, date?, backup?, force?)` | Commit the session log ([yyyy-mm-dd] note; identity= ENFORCED — the canonical h3 identification line; title param above Summary) + backup + daily log (regenerated in place) + idempotent session↔log wiring. **Refuses unless `session()`, `addendum()`, `maintain()`, `remarks()`, and `diary()` each ran this session AND `session() → remarks() → diary()` held (last calls)** — returns `{error, detail, hint}` naming what's missing or out of order; `force=true` bypasses the gate (reported back as `bypassed`) but never the identity requirement. On success returns `{action, noteId, date, backup, log}` and resets the gate. Once, last. |
| `brain(includeArchived?)` | Full content tree: every typed note across all five areas, grouped. |
| `bootstrap()` | Initialize the structure if uninitialized, or verify and refresh config if it already exists. Only creates a new tree when the stored root note is confirmed deleted in Trilium (404). Any other error (network, auth, timeout) is surfaced rather than silently creating a duplicate tree. |
| `remember(kind, …)` | Write a note — routed, formatted, deduped server-side. New threads REQUIRE `goal=` (queried from the user); thread appends REQUIRE `identity=`; thread bodies must not carry a Resolution. `connect=[{relation, toNoteId}]` wires relations in the same call; a new connectable note without them returns an orphan-prevention hint. Sources/information receipts include `domainId`. `icon=` sets the display icon. Rejects diary/session/log/domain — each has a dedicated path. |
| `diary(body, identity, icon?, date?)` | Write to today's [yyyy-mm-dd] diary — every write lands as a timestamped `Addendum — HH:mm` block, including the first of the day; identity= ENFORCED (the canonical h3 identification line). The FINAL gate step — close() counts it only when its last call came after session() and remarks(); mid-session writes welcome. |
| `template(kind)` | The canonical structure for a content kind: skeleton + top-to-bottom structure + the rules writes are held to. Read before the first write of a kind instead of copying a sibling. |
| `graph(noteId?, depth?, includeArchived?)` | The graph view — Mermaid flowchart of the relation graph (whole brain, or a note's neighborhood), returned AND upserted into the maintained Insights/Graph mermaid note. |
| `recall(query, …)` | BrainLLM-wide ranked search. `orderBy` / `orderDirection` for temporal ordering; `fastSearch` for title/label-only (faster). |
| `<surface>` / `<surface>_recall` | Read a surface in full / skim it (master, llm, memory, knowledge, insights). |
| `revise(noteId, …)` | Append / replace / section-edit / find-replace a note. Thread appends REQUIRE `identity=`. Section: h2/h3/h4 tolerant match, returns `matched`/`headingCount` — check them. `find=` + `body=`: exact-string surgery with an attribute-tolerant fallback (`matchMode` in the receipt), returns `replaced` count; `title=` composes with every mode. Retitling a domain book cascades `#domain` to its children. `Last updated` lines bumped server-side. Snapshot taken on content writes (not metadata-only). |
| `resolve(noteId, outcome, …)` | Close a thread: outcome + terminal status + archive-in-place. |
| `withdraw(noteId, reason?, …)` | Pull an archived/resolved thread back to active (thread kind only — use recover() for other note kinds). |
| `attach(noteId, title, content?, …)` | Upsert a raw artifact on a note by title (content provided), or read it back (content omitted). Binary is base64. |
| `detach(attachmentId? \| noteId+title)` | Remove an attachment — permanent; already-removed returns cleanly. |
| `recover(noteId, reason?, …)` | Restore any archived or resolved note: removes #archived, clears #closed, resets status. The canonical undo for forget(). |
| `label(noteId, name, value?, remove?)` | Guarded direct label edit/removal — refused on containers, noteType is untouchable, status validated against the closed vocabulary, domain/topic auto-slugged. The core path for fixing a stray or drifted label instead of raw attribute tools. |
| `backup(name?)` | On-demand DB backup (close() already backs up; use this for milestone snapshots). |
| `domain(name, …)` | Surface all content for a named domain/topic/project, grouped by kind. |
| `connect(from, relation, to, remove?)` | Typed edge from the closed vocabulary; symmetric handled; idempotent. |
| `explore(noteId, mode, …)` | Graph: links / backlinks / neighborhood / path. |
| `inspect(noteId, content?, find?)` | Full raw read of one note: every label (not just noteType/status), every outbound relation, the attachment inventory (id/title/mime/role/size), type/mime/parent/child ids, dates — the raw body when content=true, and `find=` counts a literal string (total + per-addendum-block) for flag-staleness tracking. The deep-dive counterpart to explore() and the surface reads. |
| `addendum()` | Search Master, LLM singletons (responsibilities + protocols, not diary), and Knowledge for pending addendum blocks. These notes must be clean and structured — fold each block into the relevant section with revise(section=…, mode=replace), then leave no addendum marker. Only sessions, diary, and logs accumulate addendum history. Scoped/autonomous agents fold only what's in their lane — leaving personal/out-of-scope addendums for the next interactive session is correct; the call itself satisfies the gate. |
| `maintain(deep?, dryRun?)` | Lite: thread aging + unlabeled-node check per typed container. Deep adds: stale-review + orphan/sink report (Memory/Threads + Knowledge, brain-wide inbound detection) + duplicate-title detection + exact-duplicate relation-edge cleanup. Report includes `policy` (active thresholds). |
| `forget(noteId, reason?, hard?)` | Archive (default) or hard-delete (blocked while backlinked). Undo with recover(). |

---

## Full Mode (`BRAINLLM_MODE=full`)

When the raw ETAPI tools (`search_notes`, `get_note`, `create_note`, calendar, revisions, …) are in your toolset, full mode is on. They're **brain-agnostic** — no placement, labels, dedup, or snapshots — so core stays the default: `inspect(noteId, content?)` covers the full raw read (labels, relations, attachments, body), `label()` the guarded label surgery, and `attach()`/`detach()` the attachment work that used to justify dropping down. Reach for full mode only for what core genuinely can't express: a precise `search_notes` query, code·canvas·mermaid notes, journal notes, revision recovery, or deliberate placement.

**Before any raw work, read `references/fullmode.md`** — it carries the three safety rules (typed-note visibility, no-snapshot overwrites, find-structure-by-marker), the raw-artifact policy, a use-case→tool map, and every signature. Raw edits bypass every server guarantee; correctness is on you.

---

## Quick-Fix

| Situation | Fix |
|---|---|
| BrainLLM tools time out / connection errors | Run `C:\Users\miiso\Projects\OSS\BrainLLM\scripts\start-trilium.ps1` (PowerShell). Wait ~3 s, retry. |
| `start()` → `uninitialized` | Run `bootstrap()`. Safe anytime — only creates a new tree if the root note is confirmed gone; surfaces errors otherwise. |
| Dates look off on a hosted deploy | Set `BRAINLLM_TZ` (IANA, e.g. `Africa/Johannesburg`) so Trilium stamps in the user's timezone. |

## References library

| Read… | When… |
|---|---|
| `references/taxonomy.md` | choosing a relation verb, or reading/filtering by the server-owned labels |
| `references/domains.md` | creating a domain, adding a sub-category information note, or refreshing domain content |
| `references/connections.md` | asked to update/audit connections, recurring orphan flags, or periodic deep maintenance |
| `references/fullmode.md` | before any raw ETAPI work — safety rules, raw-artifact policy, use-case map, signatures |
| `references/troubleshooting.md` | errors, edge cases, or unexpected tool behavior |
