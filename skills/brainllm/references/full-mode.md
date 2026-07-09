# Full Mode — Raw ETAPI Reference (V7.0)

`BRAINLLM_MODE=full` adds 33 raw ETAPI tools alongside the core surface. They map one-to-one onto Trilium's ETAPI and are **brain-agnostic** — no placement, format, dedup, or lifecycle.

**Ground rule:** use the core surface (`start`, `session`, `close`, `remember`, `recall`, the `<surface>` reads, `revise`, `resolve`, `connect`, `explore`, `label`, `inspect`, `forget`) for all routine work. `label()` covers direct label fixes and `inspect()` covers full attribute/relation reads — reach for full-mode only when the high-level path genuinely cannot do the job — these bypass every server guarantee, so correctness is on you.

---

## Using full mode natively (against the BrainLLM structure)

Full-mode tools place nothing, label nothing — so when you reach past the core surface you take on what it normally guarantees. Three things keep raw edits from silently corrupting the brain:

- **A note is only a "memory" once it carries `#noteType`.** `recall` and every `<surface>` read filter out untyped notes, so a note you `create_note` without labelling is invisible to them. For a new memory, use core `remember` — it places the note, writes `#noteType` + `#created`/`#updated`, and dedups by title. Reach for `create_note` only for shapes core can't make (a `code` / `canvas` / `mermaid` note, a deliberate placement), then replicate the labels yourself: `add_label noteType <kind>`.
- **Overwrites don't snapshot; labels don't dedup.** `update_note_content` replaces the body with no revision — `create_revision` first when the content matters. `add_label` always adds (it can leave you with two `#status` labels); change an existing one with `update_attribute`. `delete_note` deletes the whole subtree when it's the last branch — prefer core `forget`, which archives and checks backlinks.
- **Find structure by its marker, not a hardcoded id.** There is no `get_brain_config` in V7. To locate a container, `search_notes("#brainLlmRoot")` for the root, then `get_note` and walk `children` to the area / book you need; or lift a `parents` id from any note a surface read already returned.

### Raw artifacts (code, images, files)

BrainLLM memories are typed text notes; `code` / `file` / `image` notes aren't a `#noteType` kind. Keep raw artifacts *attached to* or *embedded in* a typed note rather than free-floating:
- **Code / structured text** → embed it as a fenced block in an `information` note via core `remember` (fully conformant and full-text searchable), or
- **Binary (image, PDF, file)** → `create_attachment` it onto the relevant typed note (`role=image` / `file`).

Create a standalone `type=code` / `file` note only when you specifically need Trilium's native handling of that type. If you do: label it (`add_label noteType <closest kind>`) so `recall` can see it, give it the same `domain` / `topic` labels as its anchor, and `connect` it to a typed note — otherwise it's an orphan with a blueprint-less type, exactly what `maintain(deep=true)` flags.

### Use-case → tool

| You need to… | Reach for |
|---|---|
| A query core `recall` can't express (date ranges, exact labels, custom ordering) | `search_notes` |
| Exact attributes / parent-child ids of a note | core `inspect(noteId)` — reach for raw `get_note` only if you also need something `inspect` doesn't return |
| Attach an image or file to a note | `create_attachment` (`role=image` / `file`) |
| Update an existing attachment's content in place | `update_attachment` (pass `content=`) |
| Store a code snippet, canvas, or mermaid diagram as a note | `create_note` (`type=code` / …) + label it |
| Recover content clobbered by a bad write | `get_revisions` → `get_revision_content` |
| Recover a Trilium-hard-deleted note | `note_history` (check `canBeUndeleted`) → `undelete_note` |
| Fix or remove a stray label | core `label(noteId, name, value?, remove?)` — guarded, validates `status`, slugs `domain`/`topic`, refuses on containers |
| Retarget an existing relation's value in place (not remove-then-re-add) | `get_note` (read its `attributeId`) → `update_attribute` |
| Place one note under a second parent | `clone_note` (shared content, not a copy) |
| A Trilium journal day / week / month / year note | `get_day_note` / `get_week_note` / … |

---

## Notes

| Tool | Signature |
|---|---|
| `search_notes` | `(query, ancestorNoteId?, limit?, orderBy?, orderDirection?, fastSearch?, includeArchived?, debug?)` — raw Trilium query language; unscoped unless `ancestorNoteId` given |
| `get_note` | `(noteId)` — metadata + attributes + parent/child ids + dates |
| `get_note_content` | `(noteId)` — raw content |
| `create_note` | `(parentNoteId, title, content, type?, mime?)` — `type` ∈ text·code·book·canvas·mermaid·relationMap·render·search·file·image |
| `update_note_content` | `(noteId, content)` — full replace |
| `patch_note` | `(noteId, title?, type?, mime?)` — metadata only |
| `delete_note` | `(noteId)` — hard-delete (subtree if last branch) |
| `undelete_note` | `(noteId)` — recover a Trilium-deleted note from Trilium's trash (`canBeUndeleted` must be true per `note_history`). Distinct from core `recover()` which restores BrainLLM-archived notes. |
| `note_history` | `(ancestorNoteId?)` — recent changes feed (creations/modifications/deletions) |

## Attributes

| Tool | Signature |
|---|---|
| `get_attribute` | `(attributeId)` |
| `add_label` | `(noteId, name, value?, isInheritable?)` — adds a `#label` (no dedup) |
| `add_relation` | `(fromNoteId, relationName, toNoteId, isInheritable?)` — any name (`connect` enforces the closed vocab) |
| `update_attribute` | `(attributeId, value?, position?)` |
| `delete_attribute` | `(attributeId)` |

## Branches (placement)

| Tool | Signature |
|---|---|
| `get_branch` | `(branchId)` |
| `clone_note` | `(noteId, parentNoteId, prefix?)` — multi-parent branch (shared content) |
| `move_note` | `(noteId, fromParentNoteId, toParentNoteId)` — clone to new parent, remove old branch |
| `delete_branch` | `(branchId)` — removes one placement (deletes note if last) |

## Revisions

| Tool | Signature |
|---|---|
| `create_revision` | `(noteId)` |
| `get_revisions` | `(noteId)` — list, newest first |
| `get_revision_content` | `(revisionId)` |

## Attachments

| Tool | Signature |
|---|---|
| `get_attachments` | `(noteId)` |
| `get_attachment_content` | `(attachmentId)` |
| `create_attachment` | `(ownerId, title, mime, content, role?)` — `role` ∈ file·image |
| `update_attachment` | `(attachmentId, title?, mime?, content?)` — patch metadata and/or replace content in place |
| `delete_attachment` | `(attachmentId)` |

## Calendar (Trilium journal)

| Tool | Signature |
|---|---|
| `get_day_note` | `(date?)` — `YYYY-MM-DD`, default today |
| `get_week_note` | `(week)` — `YYYY-Www` |
| `get_month_note` | `(month)` — `YYYY-MM` |
| `get_year_note` | `(year)` — `YYYY` |
| `get_inbox_note` | `(date?)` — the inbox note for a date |

## System

| Tool | Signature |
|---|---|
| `get_app_info` | `()` — Trilium version, DB version, runtime metadata |
| `create_backup` | `(name?, date?)` — named DB backup (`<name>.db`, default `brainllm-{date}`); use a descriptive name for milestone snapshots |
