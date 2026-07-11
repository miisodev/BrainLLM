# Edge Cases & Failure Modes

| Situation | What happens / what to do |
|---|---|
| BrainLLM not initialized | `start` returns `status: "uninitialized"` → run `bootstrap` (idempotent, safe anytime) |
| Second `close` same day | Appends an addendum to today's session note — by design, not an error |
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
| Deep maintenance flags the same items every session | Act on them — `connect()` orphans, `revise()`/`resolve()` stale notes — or accept them and let them age |
| `recall` returns odd results | It already filters untyped notes; if it persists, `maintain(deep=true)` then retry |
| Items going dormant too fast / too slow | User edits `policy` in `brainllm.json` (`dormantAfterDays` / `archiveDormantAfterDays` / `staleAfterDays`) |
| Need raw Trilium access (attachments, calendar, custom queries) | Full-mode tools — see `references/fullmode.md` |
| Config IDs stale after restructuring in Trilium | `bootstrap` re-discovers and rewrites `brainllm.json` |
| `bootstrap` created a duplicate brain tree | Caused by a transient network/auth error during the existence check — the old catch-all fell through to fresh create. Fixed: only a confirmed 404 (root deleted) now triggers a new tree. To recover: identify the newer duplicate by `dateCreated`, then `forget(rootId, hard=true)` its entire subtree or delete it directly in Trilium. |
| Hosted deploy: `ENOENT` on startup / auto-discovery fails with a file-path error | `BRAINLLM_CONFIG` is set to a directory path instead of a file path (e.g. `/home/node/trilium-data` instead of `/vol/brainllm.json`). Mount a persistent volume on the BrainLLM MCP service (not the Trilium service) and set `BRAINLLM_CONFIG` to a file path inside it, or remove `BRAINLLM_CONFIG` entirely to rely on auto-discovery each startup. |
