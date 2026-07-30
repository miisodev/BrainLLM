# Edge Cases & Failure Modes

| Situation | What happens / what to do |
|---|---|
| BrainLLM not initialized | `start` returns `status: "uninitialized"` → run `bootstrap` (idempotent, safe anytime) |
| Second `close` same day | Appends an addendum to today's session note — by design, not an error. Pass `continuing=true` so you don't re-run the whole pre-close protocol for a session whose brain writes are already done; it's verified against today's note, so it can't stand in for a first close |
| `remember()` says `action: "updated"` unexpectedly | A same-kind note with that title existed; content was appended there. If it was genuinely a different subject, `remember()` again with a distinguishing title |
| User contradicts a stored fact about themselves | `master(which)` to read it, then `revise(id, section=…)` with the correction — the Master singletons hold current-state truth, not history |
| A stored fact was wrong from the start | `revise(mode="replace")` — a revision snapshot is taken automatically, nothing is lost |
| User asks you to forget something | `forget(noteId, reason)` archives it. If they want it *gone* (privacy), `forget(noteId, hard=true)` |
| `forget(hard=true)` returns `blocked` | Other notes still link there. Remove the listed backlinks (`connect(..., remove=true)`) or archive instead |
| A relationship between notes changes | `connect(from, rel, oldTarget, remove=true)`, then `connect` the new target; note the change in the body via `revise()` |
| A thread's line of work concludes | `resolve(threadId, outcome)` — writes the outcome, sets the terminal status, archives in place |
| A dormant item becomes relevant again | Any `revise()` touch reactivates it to `active` automatically |
| Two notes turn out to be the same subject | `revise()` the better one with the other's content (append), then `forget(worseId, reason="merged into <id>")` |
| `resolve()` on a note with no Resolution section | Works — the section is appended |
| Structural note passed to revise/resolve/forget | Returns `{error, detail, hint}` — read `hint` and call again with a content noteId, not a container |
| Long conversation, no natural end | Call `close` when the work *topic* wraps, even if chat continues; a later wrap-up appends |
| User edited notes directly in Trilium | Fine — that's a feature. Run `maintain(deep=true)` next session to re-check the tree |
| Sweep flags a stray you can't classify | Tell the user what it is and where; flags are conversation starters, not auto-fixes |
| A task needs direct note surgery | Use the full-mode tools (`create_note`, `patch_note`, `delete_note`, `add_label`, …) — see `references/fullmode.md`. Prefer the high-level surface for routine memory. |

---

# Troubleshooting

| Symptom | Fix |
|---|---|
| BrainLLM tools time out or return connection errors | Run `C:\Users\miiso\Projects\OSS\BrainLLM\scripts\start-trilium.ps1` (PowerShell tool) — starts Trilium if it isn't running, no-ops if it is. Wait ~3 s then retry. |
| `start` → `uninitialized` | `bootstrap` |
| Deep maintenance flags the same items every session | Act on them — `connect()` orphans, `revise()`/`resolve()` stale notes — or `maintain(ack=[…])` the ones that are correct as they stand. Don't just keep ignoring them: a list you skim is a list where the item that *did* change gets missed |
| `revise(find=)` returns `replaced: 0` | Read the hint — it names the cause. Escaped search string (`&lt;h3&gt;` against stored real tags): pass the tag literally. Spans a block boundary (`</h3>` then `<ol>`): anchor inside one element, or use `section=` with `mode="before"/"after"`. Otherwise it was already replaced, or the text genuinely differs — check with `inspect(noteId, find="<shorter substring>")` |
| `revise(section=)` returns `matched: false` | No heading matched, so a NEW section was written — at the note's own level, with the note's real headings in `available[]`. Re-target from that list; `outline(noteId)` gives the same tree plus levels and occurrence indices before you write |
| Two sections legitimately share a heading | `revise(section=…, occurrence=2)`. Repeating a closing heading under every category is the consistency rule working, not drift — `occurrence=` is how you reach the second one without rewriting the whole section |
| Note body looks like literal `&lt;p&gt;` text in Trilium | It was written entity-encoded before the decode existed. New writes are fixed; repairing an existing note is a deliberate `revise(mode="replace")` with decoded content — nothing decodes it for you as a side effect |
| Unsure whether a note is still structurally sound after several edits | `outline(noteId)` — duplicate headings, unbalanced tags and size in one call, no body read. `maintain(deep=true)` runs the same check across the brain |
| `recall` returns odd results | It already filters untyped notes; if it persists, `maintain(deep=true)` then retry |
| Deep maintenance flags something you have never seen before | V10 added hygiene passes: `entity-corrupted`, `dated title`, `long title`, `stub`, `revision bloat`, `consolidate`, `unverified sources`. Each names its own fix in the flag text — read it rather than guessing. |
| A session was interrupted and you are resuming it | The pre-close gate is durable (a `#gate` label on today's session note), so steps you already ran still count. Re-run only what `close()` says is missing. |
| `start()` did not give you the singleton content you expected | By design — singletons arrive as section headings. Pull one with `master(which)`/`llm(which)`, or re-run `start(depth="full")` if the session genuinely needs the whole self-model. |
| A keyword search should have matched and did not | Try `recall(query, fuzzy=true)` for typo tolerance, or `recall(regex="…")` when the question is structural (a pattern in the stored HTML) rather than lexical. |
| Items going dormant too fast / too slow | User edits `policy` in `brainllm.json` (`dormantAfterDays` / `archiveDormantAfterDays` / `staleAfterDays`) |
| claude.ai says "Couldn't reach the MCP server" | OAuth discovery failed — it is almost never a network problem. Check BRAINLLM_OWNER_PASSWORD is set (no password, no OAuth endpoints), and that the `resource` in /.well-known/oauth-protected-resource matches the URL you typed EXACTLY, trailing slash included. |
| Connected once, then every call 401s after an hour | Access tokens live 1 hour and Claude refreshes on 401. If refresh fails, the signing secret changed — BRAINLLM_CONFIG must point at a persistent volume, or a redeploy invalidates every issued token. |
| Need raw Trilium access (attachments, calendar, custom queries) | Full-mode tools — see `references/fullmode.md` |
| Config IDs stale after restructuring in Trilium | `bootstrap` re-discovers and rewrites `brainllm.json` |
| `bootstrap` created a duplicate brain tree | Caused by a transient network/auth error during the existence check — the old catch-all fell through to fresh create. Fixed: only a confirmed 404 (root deleted) now triggers a new tree. To recover: identify the newer duplicate by `dateCreated`, then `forget(rootId, hard=true)` its entire subtree or delete it directly in Trilium. |
| Hosted deploy: `ENOENT` on startup / auto-discovery fails with a file-path error | `BRAINLLM_CONFIG` is set to a directory path instead of a file path (e.g. `/home/node/trilium-data` instead of `/vol/brainllm.json`). Mount a persistent volume on the BrainLLM MCP service (not the Trilium service) and set `BRAINLLM_CONFIG` to a file path inside it, or remove `BRAINLLM_CONFIG` entirely to rely on auto-discovery each startup. |
