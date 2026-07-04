# Taxonomy Reference (V7.0)

## Relation Vocabulary

Closed — `connect()` rejects anything not on this list. Pick the most specific verb that's true; `relatesTo` is the last resort.

| Relation | Direction | Use when |
|---|---|---|
| `relatesTo` | A → B | Generic connection — last resort when nothing more specific fits |
| `extends` | A → B | A builds on, elaborates, or deepens B |
| `contradicts` | A → B | A conflicts with or argues against B |
| `supports` | A → B | A provides evidence or rationale for B |
| `causes` | A → B | A produces or leads to B |
| `references` | A → B | A cites B as a source or pointer |
| `partOf` | A → B | A semantically belongs to B |
| `worksWith` | A ↔ B | Collaboration — symmetric, wired both ways automatically |
| `mentors` | A → B | A teaches, guides, or coaches B |
| `instanceOf` | A → B | A is a concrete example of concept B |
| `supersedes` | A → B | A replaces B (auto-wired via `supersedes=`; B is archived) |
| `implements` | A → B | A is the realisation or execution of concept B |
| `inspiredBy` | A → B | A was conceptually influenced by B |
| `sourceOf` | A → B | A is the origin or provenance of B |
| `derivedFrom` | A → B | A was synthesised from B |

**Auto-wired — don't duplicate manually:**
- `new → old` via `supersedes=` on `remember()` → `supersedes`, old note archived.

---

## Label Conventions

Written by the server — you never set `#noteType`, `#status`, `#created`, `#updated`, `#closed`, `#archived` manually through the normal write path (`remember`/`revise`/`resolve`/`reopen`/`recover`). The one sanctioned exception is `label(noteId, name, value?, remove?)` — a guarded direct edit for fixing a stray or drifted value; `#noteType` is refused there too (it's never editable post-creation). Documented here so you can read and filter on them in `recall()` and `search_notes()`.

| Label | Values | Purpose |
|---|---|---|
| `#noteType` | `biography` `goals` `preferences` `responsibilities` `protocols` `diary` `session` `thread` `knowledge` `domain` `information` `sources` `log` | Kind — exactly one per note, set at creation, never edited after |
| `#status` | `active` `dormant` `resolved` `superseded` `eternal` | Lifecycle state — threads age; `resolve()` sets terminal. `eternal` marks the one standing BrainLLM thread — exempt from aging, structurally protected, set only at creation/repair |
| `#created` | ISO date | Set at creation (the user's local day) |
| `#updated` | ISO date | Updated on every write |
| `#closed` | ISO date | Set when `resolve()` or `forget()` archives a note |
| `#topic` | slugged, repeatable | Subject tags (`ai-tooling`, `infra`) — capitalization normalized server-side |
| `#domain` | slugged | Knowledge domain — book auto-created on first use |
| `#archived` | (flag) | Excludes the note from default `recall()`; content preserved in place |
| `#brainLlmRoot` | (flag) | Marks the brain root — used by auto-discovery |
| `#iconClass` | `bx …` | Display icon (structural notes) |

**Searching by label:** `recall()` accepts `kinds=[]`, `domain=`, `includeArchived=`. Raw queries via `search_notes()`: `#status=active`, `#noteType=thread`, `#topic=infra`, `#archived` (presence), `note.dateModified < 'YYYY-MM-DD'`. Combine with `AND`/`OR` (space = AND).
