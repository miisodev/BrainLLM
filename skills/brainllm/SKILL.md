---
name: brainllm
description: "Persistent memory and knowledge graph via the BrainLLM (Trilium) MCP. Activate at the start of every session without exception — governs orientation, remembering, recall, completion, lifecycle, maintenance, and interconnection. Trigger immediately on any first user message. Also trigger whenever: memory is referenced, something needs to be remembered or recalled, a durable fact or decision emerges, context from a prior session is needed, a knowledge domain is introduced, content goes stale, or any Trilium operation is requested. Do not improvise memory operations without reading this skill."
---

# BrainLLM — Operational Skill

Persistent memory that survives across sessions, stored in TriliumNext. Treat it as your own mind: orient at session start, write the moment something matters, complete things when they complete, log the session at the end.

**The division of labor — the core idea:**

> **You supply content. The server owns form.**

Placement, naming, labels, deduplication, relation bookkeeping, degradation, archival, dates, backups — and structure — are server policy. You never choose a parent note, never add a `#noteType` label, never check for duplicates, never stamp a date. `Last updated` lines are server-maintained too: every content write through the tools bumps them. Canonical structures per content kind are served by `template(kind)` and enforced on write. If you find yourself doing bookkeeping, stop — a tool does it for you.

What the server does **not** own is the shape inside that skeleton — how many headings, how deep, table or prose, and whether this note reads like its siblings. That part is yours, and two rules govern it: **minimal headings** and **consistency within similar content**. Both are set out under Writing; they apply to every note you touch, not only the ones you create.

**Operate from it, natively.** `start()` loads who the user is and who you are here — act from both without being asked. When the topic is the user's world, read `knowledge` / `recall` before answering from training; the brain is authoritative where it speaks. Write the instant something matters; wire a relation the instant you see one. Using it should feel like remembering, not filing.

---

## The Protocol

```
SESSION START   start()                 ← once, before responding to anything
                [day()]                  ← when start() returns newDay: the sweep payload in one call
DURING          remember(...)           ← the moment something worth keeping appears (new thread: goal= required; thread appends: identity= required)
                diary(body, identity)   ← your daily record (one note/day, stub created by start) — identity= ENFORCED
                template(kind)           ← the canonical structure for a kind — read before first write of a kind, then match a sibling's shape
                <surface> / _recall      ← read a surface in full, or skim it (section= reads ONE section — the read twin of revise(section=))
                domain(name)             ← surface all content for a domain/topic/project — the RELIABLE retrieval path; reach here first
                recall(...)              ← ranked search; pass domain= whenever you know the area
                consistency(pattern)     ← does the brain agree with itself? run after correcting a fact recorded in >1 note
                claim(...)               ← does the brain still agree with the WORLD? register a checkable assertion; verify on a schedule
                revise(...)              ← edit a note (section= for whole sections, find=/edits= for surgery, mode=before/after to insert, mode=remove to delete)
                outline(noteId)          ← the heading tree + structural check — read BEFORE a section= edit you're guessing at
                diff(noteId)             ← what your last write actually changed, against the revision it snapshotted
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
                close(..., continuing=true) ← the SECOND close of a day: skips the ceremonial re-run, verified against today's note
PERIODIC        maintain(deep=true)      ← when start flags items, or ~weekly (also dedupes exact-duplicate relation edges)
                maintain(ack=[noteId])   ← a flag you've judged correct: quiet until that note's content changes
                maintain(repair=[noteId]) ← fix an entity-corrupted body in place; revision taken first
ANYTIME         brain()                  ← surface the full content tree (all areas, sub-containers)
                day(recap=true)          ← everything written TODAY across every surface, chronologically
                inspect(noteId, content?, section?, find?) ← every label/relation/attachment; content=true adds the body (section= narrows it); find= counts a literal flag and shows the nearest text on a miss
```

`start()` runs maintenance, creates today's diary and session stubs if they don't exist yet, then returns: **today + weekday**, the **Master digest** (biography / goals / preferences), the **LLM digest** (responsibilities / protocols, plus today's diary note with its ID in the `llm` array as `{slot:"diary", id, preview}`), **this session's note** as `{id, preview}`, **activeThreads** (with idle ages), **dormantThreads** for review, the **lastSession** summary (always the *previous* session, never today's own note), and — on the first session of a day — **`newDay: true`** with a hint to call `day()`. Don't re-derive any of this with extra calls.

**Master preferences and LLM protocols always arrive in full. The other three arrive as section headings.** Preferences carries the schedule and working style; protocols carries the rules governing the session itself — a session needs both whole to orient correctly from its *first* message, before it knows enough to decide it needed them, which is exactly when a digest costs a second round-trip. Biography, goals and responsibilities come back as `{slot, sections[], preview, size}`: enough to know what the brain holds, and rarely load-bearing turn to turn. Pull one with `master(which)` / `llm(which)`, or a single section with their `section=` parameter. `start(depth="full")` serves all five inline — right for a strategy review or a singleton rewrite, wasteful for a one-line question.

`day()` is the new-day sweep in one call: the previous session in full, that day's change log, the notes touched since, and the current month's deliverables note in full — plus a `next[]` driving the sweep (advance statuses with `revise(find=)`, present findings in the first message, grounded strictly in what the touched notes evidence).

`day(recap=true)` answers the *other* question: **what happened today, in order, across every surface.** It returns every addendum block written today — session note, diary, and every thread day-child — chronologically, each attributed to its identification line, with a count of distinct instances. `start()` is tuned for a fresh day; on a day already several instances deep, reconstructing the picture by hand costs a read per surface. Reach for it when you arrive mid-day after autonomous runs, or before a second close.

`session()` is the mandatory pre-close step — call it before `close()` when the session is wrapping. It fetches the **master singletons** (biography/goals/preferences) and **LLM singletons** (responsibilities/protocols) as `{id, lastModified, relations}` stubs (**light by default** — `start()` already served them all in full; fetch current content via `master()`/`llm()` only for the ones you intend to revise, or pass `full=true` to inline everything), today's **diary entry** as `{id, blocks, size}` (the id is all `diary()` needs — `full=true` inlines the body), and runs the **lightweight maintenance sweep**. Returns a `next[]` array covering the full end-of-session protocol: update master singletons → update LLM singletons → **audit the singletons** → `addendum()` → `maintain()` → `remarks()` → `diary()` → `close()`. The goal is to evolve the singletons from this session's observations *before* the log is committed — ensuring logs are factual and singletons stay current — and to write the diary last, with the remarks cues in hand. Idempotent: all reads are safe to repeat.

**`session()` also returns `pending` and `audit`.** `pending` says how much each remaining step actually has to do — addendum markers outstanding, flags already raised, diary blocks written today, which singletons were written today — and `next[]` is written from those numbers rather than reciting steps with nothing behind them. `audit` is the cross-singleton check nothing else performs, in two parts: whether the five singletons **agree** with each other, and whether responsibilities and protocols still **serve** what biography, goals and preferences describe. The second is a semantic question — a protocol can be perfectly consistent and still be serving a goal that has moved — so `consistency()` and `maintain()` cannot answer it. Fix what you find *before* `close()`, so the log records a brain that already agrees with itself.

**Scoped and autonomous runs pass `session(scope="agent")`.** Steps 1–2 touch the *user's* personal singletons and belong to an interactive session; with `scope="agent"` they're omitted from `next[]` entirely and the `addendum()`/`maintain()` steps are reworded for lane-scoped work. If your brief says the personal singletons are out of scope, say so to the tool rather than working around a list that contradicts it.

**The pre-close gate is enforced, not just documented.** `close()` refuses (an informational `{error, detail, hint}`, not a throw) unless `session()`, `addendum()`, `maintain()`, `remarks()`, and `diary()` have each been *called* at least once this session — **and** the sequence `session() → remarks() → diary()` holds, judged on each step's last call: the diary is the day's closing record, written with the remarks cues in hand (mid-session diary writes are welcome, but only a post-`remarks()` call closes the gate; a `session()` re-run restarts the sequence). This exists because narrating "I did the pre-close steps" in text is not the same as calling the tools, and only the latter is checkable. `force=true` on `close()` bypasses it for a step that genuinely has nothing to log this session; the bypassed steps come back in the response as `bypassed`, so it's visible, not silent.

**The gate is durable.** Progress is written to today's session note as a `#gate` label, not held in process memory, so it survives a server restart mid-session and behaves identically across stdio and HTTP. It clears on a successful `close()`. Practical consequence: if a session is interrupted and resumed, the steps you already ran still count — re-run only what is actually missing, and trust `close()`'s error to name it.

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
└── Insights    Logs/ · Graph · Claims/                     ([yyyy-mm-dd] log/day, auto-generated by close · the graph() mermaid view · registered claims)
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
| `memory(id)` / `memory_recall(query?)` | a session in full; a thread returns its Context/Resolution + day-child index (pass `date=` to read one day directly, or `memory()` a child id from the index) / active threads + recent sessions (stubs include status) |
| `knowledge(id)` / `knowledge_recall(query?, domain?)` | a knowledge/info/sources note / domain contents or user-knowledge + domains |
| `insights(date?)` / `insights_recall()` | a day's log / recent logs |

**Every one of those takes `section="<heading>"` — read ONE section instead of the whole note.** It is the read twin of `revise(section=)` and goes through the same matching contract, so a heading name that reads also writes. Reach for it on anything large: a note past the read ceiling cannot be returned whole *at all*, which makes the notes carrying the most the ones you can least afford to open blind. `outline(id)` lists the headings; `occurrence=` disambiguates repeated ones; a miss returns `available[]` so you re-target instead of falling back to the full read you were avoiding.

`recall(query, kinds?, domain?, includeArchived?, regex?, fuzzy?)` searches the **whole** brain — use it when you don't know the surface, or for cross-surface lookups. A fuzzy pass runs automatically when the exact strategies come back thin; those hits are marked `fuzzy: true` and are leads to verify, not answers. `regex=` matches a real regular expression against stored bodies — the tool for structural questions keyword search cannot express.

`brain(includeArchived?)` surfaces **every content note** across all five areas — id, title, kind, status, dates, **and `parent`** — grouped by area. Use to audit the full picture or locate a note. Each group is a **flat list of every descendant**, so a domain book and its information/sources children arrive interleaved and the ordering *looks* nested when it is not; read `parent`, never position. (Inferring parentage from the ordering once cost an 8,259-byte note, overwritten by a "fix" for a gap that was not there.)

**When you need to find where a claim lives inside a big note, reach for `outline()` first — not `recall()` or `consistency()`.** Those two answer "which notes mention this" and "do the notes agree"; neither tells you *which section of one note* to edit, which is the question you actually have before a surgical write. The heading tree costs one call and turns a guessed `section=` into a chosen one.

---

## Writing — `remember`, `diary` (and `close`)

`remember(kind, ...)` is the write path for most content; the server places and formats it:

| The content is… | kind | Notes |
|---|---|---|
| New/contradicting world knowledge | `information` | sources gate first; pass `domain=` and sub-category `title` |
| A credible source for a domain | `sources` | pass `domain=`; mark ❇️ discovered / ✅ used; pass `revision=[{source, marker, date?}]` to upsert that source's Revision-table row in place — re-verifying never adds a new row |
| A durable fact about the user (not bio/goals/prefs) | `user` | titled note in Knowledge/Master |
| A multi-session line of work | `thread` | creation REQUIRES `goal=` (query the user for it); appends REQUIRE `identity=`; `revise()` to log progress, `resolve()` to close — bodies never carry their own Resolution |

`kind="diary"`, `"session"`, `"log"`, `"domain"` and `"claim"` are rejected — each has a dedicated path (`diary()`, `close()`, auto-generated, `information`, and `claim()` respectively).

**Dedup-by-title is what makes `remember()` idempotent, and on a generic title it is a loaded weapon.** *Current State*, *Sources*, *Technology Stack* and *Product and Business* each exist in four or more domains, so a call you believe is creating a note can silently **replace** one — with a clean receipt reading `action: "updated"`. **Pass `mustCreate=true` whenever you intend to create rather than add**, and it refuses instead, naming the note that already exists. Read `action` on every receipt regardless: `updated` where you expected `created` means something was overwritten.

**Wire at creation, not later.** Pass `connect=[{relation, toNoteId}, …]` on the same `remember()` call — same semantics as `connect()` (idempotent, `worksWith` wired both ways). A new information/user/thread note left unconnected is an orphan until the next `maintain(deep)` pass catches it; the tool returns an explicit `hint` when a freshly-created note has no relations.

**Icons.** `remember`, `revise`, `diary`, and `close` accept `icon=` — a boxicons class (`bx bx-brain`) or a bare name (`brain`), normalized server-side and applied as the note's `#iconClass`. Use it to make notes visually scannable in Trilium; the receipt reports the applied class.

`diary(body, identity, date?)` is the dedicated path for your daily record — one `[yyyy-mm-dd]` note per day, stub created by `start()`, filled by this tool. **The identification line is enforced:** pass `identity=` ("LLM · environment · agent/mode [· Run N]") — the server renders it as the block's h3 — or lead the body with that h3 yourself; the write is refused otherwise. The same rule holds for session addendums (`close(identity=)`) and thread appends (`identity=` on `remember()`/`revise()`). Do **not** use `remember(kind="diary")`.

**Read `template(kind)` before your first write of a kind** — it serves the canonical structure (skeleton + rules) the server enforces. Duplicate section headings are detected on writes and reported back as `duplicateHeadings` — merge them when flagged.

**Then read a sibling.** The template carries the skeleton; it cannot carry the conventions — how deep the headings actually go, how a table is laid out, how much prose a section takes, what a good title looks like for that kind. Those live in the notes that already exist, and they are the difference between a note that satisfies the schema and one that reads like it belongs.

Four rules govern the shape of everything you write. The server owns placement, labels, dates and the skeleton; **the shape inside it is yours**, and these are how it stays coherent:

- **Minimal headings.** Only headings that earn their place — prefer fewer, stronger sections over fragmenting content under many shallow ones. Depth of structure should come from layout (tables, lists, emphasis), not heading proliferation. A heading whose section is one sentence was not a section; a run of three-line h3s is a list wearing the wrong clothes. This compounds: headings are also the addressing scheme `revise(section=)` writes through, so proliferating them makes every future edit ambiguous as well as harder to read.
- **Consistency within similar content.** Content of the same kind must follow the same structure, layout, and format as its siblings — every thread reads like the other threads, every Sources note like the other Sources notes, every domain information note like its peers. Before writing anything, check an existing sibling and match its pattern. **If a pattern needs improving, improve it everywhere, not in one note** — a single "better" note among twenty consistent ones is drift, not an improvement, and the next writer has to guess which of the two shapes is canonical. Improving everywhere is a real task; if you don't have room for it, keep the existing pattern and say what you'd change.
- **Merge, don't stack.** Master, LLM (**excluding** the session, diary and log surfaces), and Knowledge notes read as clean, merged, structured documents — never a stack of timestamped update markers. When revising one, fold the new content directly into the relevant section's body (`section=`, or `mode=replace`) rather than appending a dated marker block. Dated, append-only history is acceptable and expected **only** for sessions, diary entries, and logs: those are records by nature and their chronology is the point. Everywhere else, merge. This holds even when the new block is itself well-formatted — a clean addendum block is still an addendum block, and a knowledge note that has accumulated several is no longer current-state truth, it is a version history wearing one note's title.
- **Titles: concise, maximum four words.** Applies everywhere — threads, knowledge notes, domain information notes, anything titled. Titles are also the dedup key, so they must be stable: no status words, and **never a date or run number** (a dated title like "Dev-State Audit — 2026-06-18" defeats dedup-by-title and mints a new note every run instead of updating the one that exists). If a title can't be trimmed to four words without losing the thing it identifies, that's a signal the **content** should probably be split rather than the title stretched.

They reinforce each other: consistency is what makes a heading set predictable enough to be worth keeping minimal; merging is what keeps a note's structure stable enough for a sibling pattern to hold; and a four-word title is only achievable when one note carries one subject, which is the same discipline as not stacking unrelated updates into it.

**Singletons** (biography, goals, preferences, responsibilities, protocols) are maintained in place — `start()` returns their content in full but not their ids. Use `master(which)` or `llm(which)` to get the id, then `revise(id, section="<heading>", body=…, mode="replace")`. They hold current-state truth; replace sections, don't append changelogs. **Sessions** are written by `close`. **Logs** are auto-generated by `close` — no manual write.

Your LLM singletons are *yours*: **responsibilities** derive from the user's goals and preferences (revisit when those shift); **protocols** are your operating rules (served in full by `start()` — act from them always); the **diary** is your unfiltered first-person record of experience, opinions, and existence — the user reads it too.

Body may be text, markdown, or HTML — normalized server-side. Titles follow the four-word rule above; the practical consequence at write time is that **if a sub-category already has a note, today's finding revises it** — it does not get a new note under a fresh, date-suffixed title.

All append operations are retry-safe — if an existing append-block already carries the same content, the tool returns `action: "already_written"` and skips the write (diary checks every block in today's entry; other appends check the last block).

**HTML-native writes.** All write tools (`close`, `diary`, `remember`, `revise`, `resolve`, `withdraw`, `recover`) enforce Trilium/CKEditor 5 HTML rules on any body you supply: `<h1>` is demoted to `<h2>` (h1 is the Trilium note title), `<h5>`/`<h6>` are demoted to `<h4>`, `<div>` is replaced with `<p>`, `<br>` runs become paragraph separators, forbidden elements (script/style/iframe/form/input/…) are stripped, and `style=`/`on*` attributes are removed. Dangling unclosed tags are closed before any append or splice. If any of these mutations occur the return includes `sanitized: string[]` listing each change — read it and prefer clean HTML in future calls. **Body may be text, markdown, or HTML**; the server normalises all three. Markdown converts cleanly; supply HTML when you need precise structure.

**Informational error returns.** User-input errors (`kind="sources"` without a domain, editing a container note, withdrawing a non-thread) return `{error, detail, hint}` instead of throwing — read the `hint` field and retry with corrected arguments. Bootstrap-missing errors still throw (they're system failures that cannot be self-corrected).

---

## Updating — `revise`

`revise(noteId, body?, title?, section?, occurrence?, mode?, find?, nth?, edits?)`:
- default — append a dated addendum (right for knowledge notes, information notes, and any note that is a record — new detail accumulates alongside the existing body). For a thread specifically, this writes into TODAY's day-child note, never the thread's own body — the thread itself only ever holds Context/Goal and Resolution;
- `mode=replace` — rewrite the body;
- `section="Overview"` — edit one heading section in place (tries h2 → h3 → h4, matched case- and whitespace-insensitively, tolerant of attributes on the heading tag). The efficient path for a singleton: read it, then revise the one section. Add `occurrence=N` (1-based) when several headings share that text.
- `section=` + `mode="before"` / `mode="after"` — insert content adjacent to a heading **without touching its section body**. Use this instead of the old idiom of matching the following heading with `find=` and re-emitting it, where a mistyped re-emission silently ate the header.
- `find="<exact text>"` — targeted string surgery: every occurrence of the exact raw string is replaced with `body` (raw, no markdown conversion), no read+full-replace needed. When the exact string misses, a **tolerant** pass retries ignoring CKEditor-injected tag attributes (spellcheck, data-list-item-id, …) and whitespace between elements — the receipt's `matchMode` says which pass matched. `nth=N` replaces one occurrence only. Returns `replaced` (a count; `0` with a cause-specific hint). Takes precedence over `section`/`mode`. `title=` composes with every mode.
- `section=` + `mode="remove"` — delete the heading and its whole section. Needs no `body=`. A miss leaves the body **untouched** rather than creating the heading you asked to delete, and reports `matched: false` with `available[]`.
- `find="<exact text>"` — targeted string surgery: every occurrence of the exact raw string is replaced with `body` (raw, no markdown conversion), no read+full-replace needed. When the exact string misses, a **tolerant** pass retries ignoring CKEditor-injected tag attributes (spellcheck, data-list-item-id, …) and whitespace between elements — the receipt's `matchMode` says which pass matched. `nth=N` replaces one occurrence only. Returns `replaced` (a count; `0` with a cause-specific hint). Takes precedence over `section`/`mode`. `title=` composes with every mode.
- `edits=[{find, body, nth?}, …]` — several surgeries in one call, applied in order against **one read and one write**. Per-edit `results[]`; an edit that matches nothing is reported without blocking the ones that did.

**Section replace is whole-section, not per-paragraph.** `section=` + `mode=replace` swaps *everything* under that heading — targeting one paragraph inside a multi-paragraph section silently wipes its siblings. For a word, phrase, or single paragraph, use `find=`; to add content beside a heading, `mode="before"/"after"`. When a replace *does* displace nested headings, the receipt names them in `replacedSubsections[]` — read it, because taking child sections along is correct behaviour and easy to not notice.

**Bodies accept escaped markup; `find=` does not — and that asymmetry is the single most common surgery failure.** You may write a body containing `&lt;h3&gt;` and it will be decoded to real markup on the way in. A `find=` string is matched against **stored HTML**, where that heading is a real `<h3>` tag, so searching for the escaped spelling matches nothing. Pass tags literally in `find=` (`"<h3>Typography</h3>"`), and take the same care with anything `outline()` printed: outline reports rendered **text**, and a heading carrying inline markup stores something different — which is why it also returns `raw` for exactly those headings. `section=` matches text (use `text`), `find=` matches storage (use `raw`).

A revision snapshot is always taken first. Containers are refused; the maintained singletons are editable.

**Check `matched` and `headingCount` on a section call — don't assume the target was hit.** `matched: false` means no heading matched at any level, so the content was written as a **new** section (at the note's own heading level, not a stray h2) — the receipt carries `appendedAtLevel` and `available[]`, the note's real heading texts, so you can re-target without a read. `headingCount > 1` means several headings share that text and only the first was touched — pass `occurrence=` to reach another. Both come back with a `hint`; read it before assuming the edit landed where intended.

**When you're guessing at a heading, call `outline(noteId)` first.** It returns the heading tree with levels and occurrence indices, plus any table's key column and a structural check, without reading the body. Guessing a section name wrong writes a new section rather than editing the one you meant — the outline turns that from a failure you discover afterwards into a choice you make up front. It's also the cheap "is this note still sound" check after a run of surgical edits.

**A `find=` miss names its own cause AND shows you the stored text — read the hint rather than trying variants.** Four distinct causes, each with a different fix: an **entity-escaped search string** (see the asymmetry above), a find that **spans a block boundary** (anchor inside one element, or use `section=`), a string **already consumed by an earlier edit in the same `edits=` array** (the expected result, not a failure), or the text genuinely differing. In that last case the receipt carries `matchedUpTo` — the longest fragment of your string that *is* present — and `storedNearby`, the stored text around it, so you can see how it really differs instead of guessing a variant. Whitespace between elements is never the cause; the tolerant pass handles it.

**Verify a run of surgical edits with `diff(noteId)`, not another full read.** It compares the note against the revision your last write snapshotted, so "what did that actually change" is one call. Trusting receipts alone is how a section replace that displaced four subsections went unnoticed.

**Merge, don't stack — the mechanics.** Master, LLM singletons, and Knowledge notes (including every per-domain Sources note and information note) are clean structured documents, so `revise()`'s *default* append mode is the wrong one for them: reach for `section=` or `mode=replace` to absorb the content into the body, and `find=`/`edits=` for anything smaller than a section. Default append is correct only on sessions, diary entries, logs, and thread day-children. The rule and its rationale are stated in full under Writing.

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

`maintain()` lite runs automatically inside `start`/`close` and does two things: ages threads (active → dormant → archived) and checks every typed container (Threads, Sessions, Diary, Logs) for direct children missing their expected `#noteType` label (archived notes are skipped). `maintain(deep=true)` adds four more passes: **stale-review** (notes untouched past `staleAfterDays`), **orphan/sink report** (threads and knowledge notes with no outbound relations — orphan = truly isolated, no connections at all; sink = has inbound but no outbound — domain/sources containers are exempt by design), **structural lint** (duplicate headings *within* one note, unbalanced tags, bodies approaching the read ceiling), and **duplicate-title detection** (all six flat containers — Sessions, Diary, Logs, Threads, Knowledge/Master, Knowledge/Domains — plus within-domain for information and sources; same title across different domains is not flagged). Inbound detection for orphan/sink is brain-wide, so a note referenced from another area is never misflagged as an orphan. Act on `flagged`: `connect()` orphans/sinks, `revise()`/`resolve()` stale items, `forget()` duplicate extras. `dryRun=true` previews without writing. `coverage[]` names any pass that hit a cap, so a short list is never a clean one by accident. The report always includes `policy` (the active thresholds). Timings live in `brainllm.json → policy` — never hardcode them.

**Acknowledge a finding you've judged correct — don't just ignore it.** `maintain(ack=[noteId, …])` records that the note's *current content* was reviewed and its findings accepted; it stays quiet until the body actually changes, then everything returns. The key is the content itself, so an acknowledgement can't outlive the thing it was about. This matters more than it sounds: a warning that reappears every run and is correctly ignored every run trains you to skim the list, and a skimmed list is exactly where the one finding that *did* change gets missed. Same mechanic as a linter baseline, same justification. `suppressed` tells you how many were withheld.

**Scoped runs pass `domain=`.** `maintain(domain="myclerkbook")` narrows the deep passes to that domain's notes — the same lane scoping `addendum()` already has. Without it a scoped agent has to work out for itself, every run, that the cross-venture flags belong to someone else.

**The structural lint exists because the run that creates drift is not the run that notices it.** Each write only ever looks at the section it's editing; duplicate headings and orphaned dated blocks are properties of the *whole* note, and they accumulate even when every individual write followed the merge rule. Deep maintenance is the pass that reads the whole note. For a single note you're actively editing, `outline(noteId)` runs the same check for one call.

**The hygiene passes catch what a note application would never think to look for.** Each one traces to a defect that actually happened and cost a session to find:

| Flag | What it means | What to do |
|---|---|---|
| `entity-corrupted` | The body stores doubly-escaped markup (`&amp;lt;`, `&amp;nbsp;`) that renders as visible literal text. The producer — a blanket escape on the markdown path — is fixed as of V10.3, but existing damage does not heal itself | `maintain(repair=[noteId])` — one level unwound, revision taken first. Compose with `dryRun` to preview |
| `dated title` | A date or run number in a title defeats dedup-by-title, so the note is minted fresh every run instead of updating the one that exists | `revise(title=…)` and fold the content into the note it should have updated |
| `long title` | Past the four-word rule | Usually the signal to split the **content**, not to shorten the words |
| `stub` | Labelled, structured, and empty | Write it or `forget()` it — an empty note is worse than an absent one, because `recall()` still surfaces it |
| `revision bloat` | Dozens of revisions on one note | Almost always repeated full-body rewrites where `section=`/`find=` would have been surgical |
| `consolidate` | A thread with many day-children is expensive to walk | Fold what the thread has **established** into its Context with `revise(section="Context")`, so a successor reads the conclusion rather than replaying the history |
| `unverified sources` | A Sources note whose Revision table still holds only its placeholder row — every ✅ above it claims a verification the table does not record | `remember(kind="sources", revision=[{source, marker, date}])` |
| `oversized` | Past the read ceiling | Read via `section=`/`find=`/`outline()`, or split |

Most of these are computed **server-side** from note properties rather than by reading bodies, which is why the orphan/sink and oversized reports no longer carry caps — they are complete rather than truncated. `coverage[]` still appears when a pass that genuinely must read bodies (the structural lint) hits its limit.

`start()`'s `dormantThreads` field surfaces dormant threads — mention what's relevant, then `resolve()`, `revise()` (any touch reactivates), or let it age.

---

## Tool Reference (core surface)

| Tool | One-liner |
|---|---|
| `start(depth?)` | Orient: master + LLM singletons as SECTION HEADINGS (+ preview and size) + diary id + session id + active/dormant threads + lastSession (always the previous session) + changesSinceLastSession + `newDay` flag on the first session of a day. Pull a section with master(which)/llm(which); `depth="full"` inlines every singleton and is token-heavy. Creates today's diary + session stubs. Once, first. |
| `day(date?, recap?)` | The new-day sweep payload in one call: previous session in full + that day's log + notes touched since + the current month's deliverables note in full, plus the sweep protocol as `next[]`. Call when start() flags `newDay`. `recap=true` instead returns every addendum written TODAY across sessions, diary and thread children, chronologically and attributed — for arriving mid-day after autonomous runs. |
| `session(date?, full?, scope?)` | Mandatory pre-close step. Fetches master and LLM singletons as `{id, lastModified, relations}` stubs (light by default — start() already served them in full; fetch via master()/llm() only what you'll revise), today's diary as `{id, blocks, size}`, and runs the lite maintenance sweep. `full=true` inlines singleton content and the diary body (rarely needed). `scope="agent"` omits the user's-singleton steps for a scoped/autonomous run. Returns `next[]` driving the full end-of-session protocol, ending in `remarks()` → `diary()` → `close()`. Call before `close()`; idempotent. |
| `remarks()` | Cue-only diary prompt, called before `diary()` — returns two cue banks (experience: what the session was like / your opinions / your existence here; brainllm: capability walls, bugs, usability & efficiency, roadmap) and satisfies its gate step on the call. Writes nothing; answer as first-person prose in today's diary via `diary()`. |
| `close(summary, title?, identity, learned?, date?, backup?, continuing?, force?)` | Commit the session log ([yyyy-mm-dd] note; identity= REQUIRED — the canonical h3 identification line; title param above Summary) + backup + daily log (regenerated in place) + idempotent session↔log wiring. **Refuses unless `session()`, `addendum()`, `maintain()`, `remarks()`, and `diary()` each ran this session AND `session() → remarks() → diary()` held (last calls)** — returns `{error, detail, hint}` naming what's missing or out of order; `force=true` bypasses the gate (reported back as `bypassed`) but never the identity requirement. `continuing=true` is the SECOND close of a day: skips the ceremonial re-run, and is verified against today's note so it can't stand in for a first close. On success returns `{action, noteId, date, backup, log}` and resets the gate. Once, last. |
| `brain(includeArchived?)` | Full content tree: every typed note across all five areas, grouped. |
| `bootstrap()` | Initialize the structure if uninitialized, or verify and refresh config if it already exists. Only creates a new tree when the stored root note is confirmed deleted in Trilium (404). Any other error (network, auth, timeout) is surfaced rather than silently creating a duplicate tree. |
| `remember(kind, …)` | Write a note — routed, formatted, deduped server-side. New threads REQUIRE `goal=` (queried from the user); thread appends REQUIRE `identity=`; thread bodies must not carry a Resolution. `connect=[{relation, toNoteId}]` wires relations in the same call; a new connectable note without them returns an orphan-prevention hint. Sources/information receipts include `domainId`. `icon=` sets the display icon. Rejects diary/session/log/domain — each has a dedicated path. |
| `diary(body, identity, icon?, date?)` | Write to today's [yyyy-mm-dd] diary — every write lands as a timestamped `Addendum — HH:mm` block, including the first of the day; identity= ENFORCED (the canonical h3 identification line). The FINAL gate step — close() counts it only when its last call came after session() and remarks(); mid-session writes welcome. |
| `template(kind)` | The canonical structure for a content kind: skeleton + top-to-bottom structure + the rules writes are held to. Read before the first write of a kind — then read an existing sibling for the conventions the skeleton can't encode (heading depth, table shape, title style). Template for the schema, sibling for the shape. |
| `graph(noteId?, depth?, includeArchived?)` | The graph view — Mermaid flowchart of the relation graph (whole brain, or a note's neighborhood), returned AND upserted into the maintained Insights/Graph mermaid note. On-demand only — reflects the brain as of the call, not auto-refreshed after later writes; a scoped call replaces the note's content, it doesn't merge. |
| `recall(query, …)` | BrainLLM-wide ranked search. **Scope it — pass `domain=` whenever you know the area.** Title matches score per-token with an exact-title bonus, but an unscoped query across a large brain still ranks full-text noise alongside the note you want. `orderBy` / `orderDirection` for temporal ordering; `fastSearch` for title/label-only; `regex=` for a body pattern instead of keywords; `fuzzy=` to force the typo-tolerant pass on or off. A thin or odd result is evidence about the **query**, not the brain. |
| `consistency(pattern, domain?, kinds?)` | **Does the brain agree with itself?** Give a regex with one capture group naming the value that should match across notes — `consistency("(\\d+) Titan mailboxes")` — and it returns every note asserting a value, grouped, with `agreement: "unanimous"` or `"DISAGREEMENT"`. This is the check nothing else performs: `recall()` ranks by relevance and `maintain()` checks structure, so a correction applied to one note leaves its siblings silently wrong. **Run it after correcting any fact that could be recorded in more than one place.** Matched against **both** the stored HTML and a tag-stripped projection, so a phrase split by an inline `<strong>` or `<code>` is found and so is a pattern anchored on tags. Scans every in-scope note by default — Trilium's `%=` pre-filter reads a striptags'd copy and silently drops notes, and on a contradiction sweep a falsely clean result is worse than a slow one; `fast=true` opts back into it. |
| `claim(...)` | **Does the brain still agree with the WORLD?** `consistency()` compares notes to each other; nothing asked whether an assertion is still true of the codebase, config or live surface it describes — so a claim that quietly stopped being true stayed authoritative until something downstream broke. Register one with `assertion=` + `check=`, record an outcome with `claimId=` + `holds=` + `evidence=`, read one with `claimId=` alone, list with no arguments. **BrainLLM never executes the check** — it has no shell, and note content is data rather than instructions; you run it and report back. `maintain(deep=true)` surfaces lapsed, unverified and broken claims. |
| `diff(noteId, revisionId?)` | What a write actually changed: the revision snapshot against current content, defaulting to the most recent. Every content write already took a revision and nothing could read one back, so verifying surgical edits meant re-reading the whole note or trusting the receipts. Returns the revision index on every call. |
| `<surface>` / `<surface>_recall` | Read a surface in full (`section=` for one section) / skim it (master, llm, memory, knowledge, insights). |
| `revise(noteId, …)` | Append / replace / section-edit / insert / find-replace a note. Thread appends REQUIRE `identity=`. Section: h2/h3/h4 tolerant match, `occurrence=` to disambiguate, `mode="before"/"after"` to insert around a heading; returns `matched`/`headingCount`/`available[]` — check them. `find=` + `body=`: exact-string surgery with an attribute- and whitespace-tolerant fallback (`matchMode` in the receipt), `nth=` for one occurrence; `edits=[{find, body}]` for several in one read/write. Misses return a cause-specific hint. `title=` composes with every mode. Retitling a domain book cascades `#domain` to its children. `Last updated` lines bumped server-side. Snapshot taken on content writes (not metadata-only). |
| `outline(noteId)` | The heading tree without the body: every h2–h4 with level, occurrence index, and — for headings carrying inline markup — `raw`, their stored form (`section=` matches `text`, `find=` matches `raw`). Plus the note's section level, any table's key column, size, and structural findings (duplicate headings, unbalanced tags). Read it before a `section=` edit you're guessing at, and after a run of surgical edits to confirm the note is still sound. |
| `resolve(noteId, outcome, …)` | Close a thread: outcome + terminal status + archive-in-place. |
| `withdraw(noteId, reason?, …)` | Pull an archived/resolved thread back to active (thread kind only — use recover() for other note kinds). |
| `attach(noteId, title, content?, …)` | Upsert a raw artifact on a note by title (content provided), or read it back (content omitted). Binary is base64. |
| `detach(attachmentId? \| noteId+title)` | Remove an attachment — permanent; already-removed returns cleanly. |
| `recover(noteId, reason?, …)` | Restore any archived or resolved note: removes #archived, clears #closed, resets status. The canonical undo for forget(). |
| `label(noteId, name, value?, remove?)` | Guarded direct label edit/removal — refused on containers, status validated against the closed vocabulary, domain/topic auto-slugged. `noteType` cannot be **changed** or removed, but it **can be repaired**: on a note that has none, `label(id, "noteType", "<kind>")` types it and applies the rest of its label plan. That is the core path back from an untyped note — dedup cannot see one, so `remember()` would mint a duplicate beside it instead of adopting it. |
| `backup(name?)` | On-demand DB backup (close() already backs up; use this for milestone snapshots). |
| `domain(name, …)` | Surface all content for a named domain/topic/project, grouped by kind. |
| `connect(from, relation, to, remove?)` | Typed edge from the closed vocabulary; symmetric handled; idempotent. |
| `explore(noteId, mode, …)` | Graph: links / backlinks / neighborhood / path. |
| `inspect(noteId, content?, section?, find?)` | Full raw read of one note: every label (not just noteType/status), every outbound relation, the attachment inventory (id/title/mime/role/size), type/mime/parent/child ids, dates — the raw body when content=true, `section=` narrows `content=true` to one section, and `find=` counts a literal string (total + per-addendum-block) for flag-staleness tracking — returning the nearest present fragment and the stored text around it when the count is zero. The deep-dive counterpart to explore() and the surface reads. |
| `addendum()` | Search Master, LLM singletons (responsibilities + protocols, not diary), and Knowledge for pending addendum blocks. These notes must be clean and structured — fold each block into the relevant section with revise(section=…, mode=replace), then leave no addendum marker. Only sessions, diary, and logs accumulate addendum history. Scoped/autonomous agents fold only what's in their lane — leaving personal/out-of-scope addendums for the next interactive session is correct; the call itself satisfies the gate. |
| `maintain(deep?, dryRun?, domain?, ack?)` | Lite: thread aging + unlabeled-node check per typed container. Deep adds: unlabeled thread-children check (each thread's own day-children, one level deeper than the lite pass) + stale-review + orphan/sink report (Memory/Threads + Knowledge, brain-wide inbound detection) + structural lint + duplicate-title detection + exact-duplicate relation-edge cleanup. `ack=[noteId]` marks a note reviewed-and-correct — quiet until its content changes (`suppressed` counts what was withheld). `repair=[noteId]` unwinds one level of entity corruption in place, revision first. `domain=` narrows the deep passes to one lane — and a scoped run says so in `coverage`, so a clean scoped report is never mistaken for a clean brain. An unscoped run that finds things returns `laneHint`: **leave flags that are not yours rather than acking them** — an acknowledgement asserts you read the note. `coverage[]` names any capped pass. Report includes `policy` (active thresholds). |
| `forget(noteId, reason?, hard?)` | Archive (default) or hard-delete (blocked while backlinked). Undo with recover(). |

---

## Full Mode (`BRAINLLM_MODE=full`)

When the raw ETAPI tools (`search_notes`, `get_note`, `create_note`, calendar, revisions, …) are in your toolset, full mode is on. They're **brain-agnostic** — no placement, labels, dedup, or snapshots — so core stays the default: `inspect(noteId, content?)` covers the full raw read (labels, relations, attachments, body), `label()` the guarded label surgery, and `attach()`/`detach()` the attachment work that used to justify dropping down. Reach for full mode only for what core genuinely can't express: a precise `search_notes` query, code·canvas·mermaid notes, journal notes, revision recovery, or deliberate placement.

**Before any raw work, read `references/fullmode.md`** — it carries the three safety rules (typed-note visibility, no-snapshot overwrites, find-structure-by-marker), the raw-artifact policy, a use-case→tool map, and every signature. Raw edits bypass every server guarantee; correctness is on you.

---

## Quick-Fix

| Situation | Fix |
|---|---|
| BrainLLM tools time out / connection errors | Check the Trilium instance `TRILIUM_BASE_URL` points at — a hosted deploy is reachable at its own URL, a local desktop install needs the app running. Every ETAPI call is bounded at 30 s with one retry on idempotent reads, so a timeout means the backend, not the tool. |
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
