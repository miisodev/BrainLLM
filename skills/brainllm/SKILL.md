---
name: brainllm
description: "Persistent memory and knowledge graph via the BrainLLM (Trilium) MCP. Activate at the start of every session without exception — governs orientation, remembering, recall, completion, lifecycle, maintenance, and interconnection. Trigger immediately on any first user message. Also trigger whenever: memory is referenced, something needs to be remembered or recalled, a durable fact or decision emerges, context from a prior session is needed, a knowledge domain is introduced, content goes stale, or any Trilium operation is requested. Do not improvise memory operations without reading this skill."
---

# BrainLLM — Operational Skill

Persistent memory that survives across sessions, stored in TriliumNext. Treat it as your own mind: orient at session start, write the moment something matters, complete things when they complete, log the session at the end.

**You supply content; the server owns form** — placement, labels, dedup, relations, dates, backups, archival and each kind's skeleton (`template(kind)`). If you find yourself doing bookkeeping, a tool does it for you. The shape *inside* a note is yours, held to the four writing rules below.

**Operate from it natively.** `start()` loads who the user is and who you are here — act from both unprompted. When the topic is the user's world, read the brain before answering from training; it is authoritative where it speaks.

---

## The two content rules

1. **Timeless by default.** Singletons, thread books, user-knowledge notes, domain books and information notes hold what is true regardless of date. **No state, version, status, incident or decision history in them.** State lives in each domain's **Current State** note (latest measured value, with its measurement date). History and decisions live in **thread entries and sessions**, where the date is native. This keeps knowledge correct and cheap to maintain.
2. **Universal usefulness.** If one sentence says it, one sentence is enough. If it is rarely relevant to the interactions, automations and workflows the brain serves, it goes. Every note is read by some session; its size is paid on every read.

---

## The Protocol

```
START    start()                         once, before responding
         [day()]                         when start() reports newDay
DURING   remember(...)                   the moment something is worth keeping
         revise(...) / split(...)        edit in place; split an oversized note on its seams
         resolve / withdraw / recover    thread and note lifecycle
         connect(...)                    wire a real relation when you see one
         read: <surface>, domain, recall, read(ids), outline, inspect, assembly, brain
         verify: consistency(...), claim(...)
END      session() → [update singletons] → addendum() → maintain() → remarks() → diary() → close()
```

`start()` returns the date, **preferences and protocols in full**, the other singletons as section headings (pull one with `master(which)`/`llm(which)`, `section=` for one section; `depth="full"` inlines all), today's diary and session ids, active and dormant threads, the previous session and notes changed since. `newDay: true` on the first session of a day → call `day()` (previous session, its log, notes touched since). `day(recap=true)` returns everything written today, in order, across sessions, diary and thread entries.

**Close protocol.** `session()` returns singleton stubs, `pending=` (what each remaining step has to do), `audit=` (do the singletons agree, and do the LLM ones still serve the master ones) and `next[]`. Update master singletons with what you learned about the user and LLM singletons with what you learned about yourself, fold any addenda (`addendum()`), `maintain()`, `remarks()` for diary cues, `diary()` your closing record, then `close(summary, identity)`. `close()` refuses until those steps ran and `session → remarks → diary` held; the gate is durable across restarts. `force=true` bypasses a step with nothing to do (reported). `continuing=true` is a second close on the same day. Scoped or autonomous runs pass `session(scope="agent")`.

**Write during the session, not at the end** — a fact written mid-conversation survives a crash.

---

## The Structure

```
BrainLLM
├── Master      biography · goals · preferences                 (singletons about the user)
├── LLM         responsibilities · protocols · selfcorrection · Diary/   (singletons about you + one diary note per day)
├── Memory      Sessions/ · Threads/                            (one session note per day + multi-session threads)
├── Knowledge   Master/ (user knowledge) · Domains/<domain>/{Sources, information notes}
└── Insights    Logs/ · Graph · Claims/
```

**Singletons derive from each other.** Master holds the user: biography, goals, preferences. LLM holds you, **derived from master**: responsibilities serve the goals and preferences, protocols are the operating rules that meet the responsibilities, self-correction holds only general rules learned from your mistakes. When master changes, re-derive LLM; `session()`'s `audit=` asks this every close.

**Threads have two shapes.** A thread book holds its **Goal** (what the thread is for, a sentence or two) and optional standing constraints; never progress (a register thread such as Escalations also keeps its one maintained register table there). Its children carry the content:

| Shape | Children | Use for |
|---|---|---|
| **dated** (default) | one `[yyyy-mm-dd]` entry per active day, `Addendum — HH:mm` blocks with an identification line | a line of work: the history lives here |
| **collection** | one **titled** entry per item, each a maintained document edited in place | a list of things: ideas, candidates, specs |

Create with `remember(kind="thread", title, goal, shape?)`. Dated: append with `remember(kind="thread", title, body, identity)` or `revise(threadId, body, identity)`; `memory(id)` indexes the children newest first, `memory(id, date=)` resolves a day. Collection: add with `remember(kind="threadEntry", thread=<id>, title, body)`, change with `revise(<entry id>)`; `memory(id)` lists entries alphabetically. Appending to a collection book is refused with those two paths.

**Records** — sessions, diary, logs and dated thread entries — are one note per day, every write a timestamped `Addendum — HH:mm` block. They are never trimmed or rewritten.

---

## Where things go

```
worth keeping?
 ├─ about the user ─→ biography / goals / preferences  (revise the section, in place)
 │                    otherwise a Knowledge/Master note (remember kind="user")
 ├─ world knowledge beyond or against training ─→ a domain (sources gate — references/domains.md)
 │     measured state → that domain's Current State · timeless knowledge → an information note
 ├─ what happened / what was decided ─→ the relevant thread entry (or the session log)
 └─ passing remark or already known from training ─→ don't capture
```

**Domains** are one maintained **Sources** note plus one information note per sub-category, including **Current State**, revised in place. Every claim traces to a Sources entry (❇️ discovered, ✅ used); `remember(kind="sources", revision=[{source, marker, date}])` upserts the Revision row. Creating a domain creates its Sources note. Read `references/domains.md` before creating a domain, adding a sub-category or refreshing one.

---

## Reading

| Need | Tool |
|---|---|
| a singleton | `master(which)` / `llm(which)` — `section=` for one section |
| a thread or session | `memory(id)` — dated index or collection entries; `date=` for one day |
| a knowledge note | `knowledge(id)` — `section=` for one section |
| a day's change log | `insights(date?)` |
| skim a surface | `<surface>_recall` |
| everything about an area | `domain(name)` — the reliable path; reach here first |
| search | `recall(query, domain=…)` — scope it; `regex=` for structure; fuzzy hits are leads |
| several bodies at once | `read(ids=[…])` (≤ 10) |
| what the brain holds | `assembly(area?)` — titles by surface with purposes |
| inventory / locate by id | `brain()` — read `parent`, not position |
| a note's heading tree | `outline(id)` — before any `section=` edit you're unsure of |
| raw labels, relations, body | `inspect(id, content?, section?, find?)` |

Every read that can be large takes `section=`; a note past the read ceiling cannot be returned whole.

---

## Writing — `remember`, `diary`, `close`

| Content | Call |
|---|---|
| about the user, not bio/goals/prefs | `remember(kind="user", title, body)` |
| domain knowledge | `remember(kind="information", domain, title, body)` |
| a domain source | `remember(kind="sources", domain, body, revision?)` |
| a new line of work | `remember(kind="thread", title, goal, shape?)` — ask the user for the goal |
| a dated thread append | `remember(kind="thread", title, body, identity)` |
| a collection entry | `remember(kind="threadEntry", thread, title, body)` |
| your daily record | `diary(body, identity)` |
| the session log | `close(summary, identity, title?, learned?)` |

- **Dedup is by title.** Generic titles (Current State, Sources) exist in many domains — pass `mustCreate=true` when you mean to create, and read `action` on every receipt.
- **Wire at creation:** `connect=[{relation, toNoteId}]` on the same call. An unconnected note is an orphan until wired.
- **Identity line** (`"LLM · environment · agent/mode [· Run N]"`) is required on diary, close and dated thread appends.
- **Every note carries an icon except logs.** The server sets the kind default at creation (a thread entry takes its thread's icon) and the sweep backfills any missing; `icon=` picks a better one (boxicons class or bare name). Removing an icon is refused.
- Bodies may be text, markdown or HTML; the server normalises them and reports `sanitized[]`.
- `diary`, `session`, `log`, `claim` and `domain` have dedicated paths; `remember` refuses them.

**Four writing rules** (each applies to every note you touch):

- **Minimal headings.** Only headings that earn their place; depth comes from tables, lists and emphasis. Headings are also what `section=` addresses.
- **Match your siblings.** Read an existing note of the same kind and follow its shape; improve a pattern everywhere or nowhere.
- **Merge, don't stack.** Everything except records is a clean document: fold new content into its section (`section=`/`find=`), never a dated addendum.
- **Titles ≤ 4 words, no dates or run numbers** (they defeat dedup). A title that won't trim means the content wants splitting.

Read `template(kind)` before your first write of a kind, then read a sibling.

---

## Updating — `revise`

| Mode | Effect |
|---|---|
| default | dated addendum — right only for records; a dated thread's append lands in today's entry |
| `mode="replace"` | whole body |
| `section="<heading>"` | replace that section's **whole** body (h2→h3→h4; `occurrence=` for repeats) |
| `section=` + `mode="before"/"after"` | insert a sibling block around the whole section |
| `section=` + `mode="prepend"` | insert at the top of the section's body |
| `section=` + `mode="remove"` | delete the section |
| `find="<exact stored text>"` | replace every occurrence (`nth=` for one) |
| `edits=[{find, body}]` | several surgeries in one read and one write |

- A revision is taken before every content write; `diff(noteId)` shows what the last write changed.
- **Check the receipt.** `matched: false` means a new section was written — `available[]` lists real headings and `didYouMean` catches typos; `strict=true` refuses instead. `headingCount > 1` means only the first match was touched. `replacedSubsections[]` names nested headings a section replace took with it.
- **`find=` matches stored HTML, not rendered text.** Pass tags literally; `outline()` gives the `raw` form of headings with inline markup. On a miss the hint names the cause and shows the stored text nearby.
- A section replace swaps everything under the heading — use `find=` for anything smaller.
- **Oversized note (past the read ceiling)?** It usually holds two subjects: `split(noteId, sections=[…], into="<title>")` moves whole sections to a new sibling and leaves a pointer.
- Concurrent writers are serialised server-side; reads stay parallel.

---

## Completing and lifecycle

- `resolve(noteId, outcome)` closes a thread with a substantive outcome ("done" is not one) and archives it in place.
- `withdraw(threadId)` reopens an archived or resolved thread; `recover(noteId)` restores any archived note; `forget(noteId)` archives (default) or hard-deletes when nothing links to it.
- Threads age **active → dormant → archived** by idle time; `status=eternal` exempts one. Singletons don't age; records are never trimmed.
- `label(noteId, name, value?)` fixes a stray label; it can type an untyped note (`noteType`) but never change a typed one.

---

## Interconnection — `connect`, `explore`, `graph`

`connect(from, relation, to)` from a closed vocabulary: `relatesTo · extends · contradicts · supports · causes · references · partOf · worksWith · mentors · instanceOf · supersedes · implements · inspiredBy · sourceOf · derivedFrom`. Pick the most specific true verb; `worksWith` is symmetric; idempotent. `explore(noteId, mode)` walks links, backlinks, a neighborhood or a path. `graph()` renders Mermaid into Insights/Graph. For a full connection audit follow `references/connections.md`.

---

## Verification — `consistency` and `claim`

- **`consistency(pattern | subject)`** — does the brain agree with itself? A regex with one capture group (or a fact in prose) returns every asserting note grouped by value. **Run it after correcting any fact that could be recorded in more than one place.** `staleAfterDays=N` reports values held in only one note untouched N+ days.
- **`claim(...)`** — does the brain still agree with the world? Register `assertion` + `check`; verify with `claimId` + `holds` + `evidence` (evidence required); read with `claimId`; list with no arguments. BrainLLM never runs the check — you do. Register claims that would be expensive to discover had gone stale.

---

## Maintenance — `maintain`

Lite runs inside `start`/`close` (thread aging, label checks). `maintain(deep=true)` adds:

| Finding | Action |
|---|---|
| stale | revise, resolve, or `ack=[id]` if correct as it stands |
| orphan / sink | `connect()` |
| dated prose | a timeless note carrying dates — move state to Current State, history to a thread entry |
| duplicate heading / unbalanced tags / incomplete | fix with `revise` |
| oversized / section-edit-risk / size trajectory | `section=` reads, `split()` |
| dated / long title | retitle, fold into the note it should have updated, or split |
| stub | write it or `forget()` it |
| entity-corrupted | `maintain(repair=[id])` |
| claim lapsed / unverified / broken / source-changed | re-verify with `claim()` or retire it |
| duplicate title, deletion, revision bloat | resolve per the hint |

- **`ack=[id]`** silences a finding you actually reviewed, until the note's content changes. Never ack unread — leave other lanes' flags alone.
- `domain=` scopes the deep passes to one lane; `dryRun` previews.
- `coverage[]` names any capped pass, so a short list isn't mistaken for a clean one.

---

## Other tools

`attach`/`detach` — raw artifacts on a note. `backup(name)` — milestone snapshot (close already backs up). `bootstrap()` — create or refresh the structure. `template(kind)` — the canonical skeleton. **Full mode** (`BRAINLLM_MODE=full`) adds raw ETAPI tools with none of the server's guarantees. Read `references/fullmode.md` before any raw work.

## Quick-fix

| Situation | Fix |
|---|---|
| timeouts or connection errors | the Trilium instance at `TRILIUM_BASE_URL` is unreachable; tools don't need restarting |
| `start()` → `uninitialized` | `bootstrap()` |
| dates look off on a hosted deploy | set `BRAINLLM_TZ` (IANA) |
| an informational `{error, detail, hint}` | read `hint` and retry with corrected arguments |

## References

| Read | When |
|---|---|
| `references/domains.md` | creating, extending or refreshing a domain |
| `references/connections.md` | a connection audit |
| `references/taxonomy.md` | choosing a relation verb; reading server labels |
| `references/fullmode.md` | before any raw ETAPI work |
| `references/troubleshooting.md` | errors, edge cases, unexpected behavior |
