# Full Mode — Raw ETAPI Reference

`BRAINLLM_MODE=full` adds 33 raw ETAPI tools alongside the core surface. They map one-to-one onto Trilium's ETAPI and are **brain-agnostic** — no placement, format, dedup, or lifecycle.

**Ground rule:** use the core surface (`start`, `session`, `close`, `remember`, `recall`, the `<surface>` reads, `revise`, `resolve`, `withdraw`, `connect`, `explore`, `label`, `inspect`, `attach`, `detach`, `forget`) for all routine work. `label()` covers direct label fixes, `inspect(noteId, content?)` covers full attribute/relation/attachment reads plus the raw body, and `attach()`/`detach()` cover attachment writes — reach for full-mode only when the high-level path genuinely cannot do the job; these bypass every server guarantee, so correctness is on you.

---

## Using full mode natively (against the BrainLLM structure)

Full-mode writes bypass core placement, sanitising, deduplication and revision snapshots, so you take on those guarantees yourself. Two explicit exceptions remain: `delete_note` checks backlinks and blast radius, and `undelete_note` attempts to restore BrainLLM labels from placement. Three things keep raw edits from silently corrupting the brain:

- **A note is only a "memory" once it carries `#noteType`.** `recall` and every `<surface>` read filter out untyped notes, so a note you `create_note` without labelling is invisible to them. For a new memory, use core `remember` — it places the note, writes `#noteType` + `#created`/`#updated`, and dedups by title. Reach for `create_note` only for shapes core can't make (a `code` / `canvas` / `mermaid` note, a deliberate placement), then replicate the labels yourself: `add_label noteType <kind>`.
- **Overwrites don't snapshot; labels don't dedup.** `update_note_content` replaces the body with no revision — `create_revision` first when the content matters. Binary writes use standard base64 with `encoding="base64"`; the client decodes and sends raw bytes. `add_label` always adds (it can leave you with two `#status` labels); change an existing one with `update_attribute`. `delete_note` refuses backlinks, children and multiple parents, and blocks when its backlink check fails; prefer core `forget` for recoverable archival. Raw `delete_branch` can still delete a note when its last placement is removed.
- **Find structure by its marker, not a hardcoded id.** There is no `get_brain_config`. To locate a container, `search_notes("#brainLlmRoot")` for the root, then `get_note` and walk `children` to the area / book you need; or lift a `parents` id from any note a surface read already returned.

### Raw artifacts (code, images, files)

BrainLLM memories are typed text notes; `code` / `file` / `image` notes aren't a `#noteType` kind. Keep raw artifacts *attached to* or *embedded in* a typed note rather than free-floating:
- **Code / structured text** → embed it as a fenced block in an `information` note via core `remember` (fully conformant and full-text searchable), or
- **Binary (image, PDF, file)** → core `attach()` it onto the relevant typed note (`role=image` / `file`) — pass standard base64 with `encoding="base64"`; read back with `attach(noteId, title)`, which returns the base64 envelope and MIME.

Create a standalone `type=code` / `file` note only when you specifically need Trilium's native handling of that type. If you do: label it (`add_label noteType <closest kind>`) so `recall` can see it, give it the same `domain` / `topic` labels as its anchor, and `connect` it to a typed note — otherwise it's an untyped orphan, exactly what `maintain(deep=true)` flags.

### Use-case → tool

| You need to… | Reach for |
|---|---|
| A query core `recall` can't express (date ranges, exact labels, custom ordering) | `search_notes` |
| Exact attributes / parent-child ids / attachments / raw body of a note | core `inspect(noteId, content?)` — reach for raw `get_note`/`get_note_content` only for what `inspect` doesn't return |
| Attach, update, or read an artifact on a note | core `attach(noteId, title, content?)` — upsert by title; omit content to read. Remove with core `detach()` |
| Store a code snippet, canvas, or mermaid diagram as a note | `create_note` (`type=code` / …) + label it |
| Recover content clobbered by a bad write | `get_revisions` → `get_revision_content` |
| Recover a Trilium-hard-deleted note | `note_history` (find the deleted note id) → `undelete_note`; the feed does not report restore eligibility, so backend refusal remains possible |
| Fix or remove a stray label | core `label(noteId, name, value?, remove?)` — guarded, validates `status`, slugs `domain`/`topic`, refuses on containers |
| Retarget an existing relation | Delete and re-add it; relation targets are immutable through `update_attribute` |
| Place one note under a second parent | `clone_note` (shared content, not a copy) |
| A Trilium journal day / week / month / year note | `get_day_note` / `get_week_note` / … |

---

## Notes

| Tool | Signature |
|---|---|
| `search_notes` | `(query, ancestorNoteId?, limit?, orderBy?, orderDirection?, fastSearch?, includeArchived?, debug?)` — raw Trilium query language; unscoped unless `ancestorNoteId` given |
| `get_note` | `(noteId)` — metadata + attributes + parent/child ids + dates |
| `get_note_content` | `(noteId)` — raw content; binary returns `{encoding:"base64", mime, content}` |
| `create_note` | `(parentNoteId, title, content, type?, mime?, encoding?)` — `encoding` ∈ auto·text·base64; binary creation is an empty create followed by a raw PUT |
| `update_note_content` | `(noteId, content, mime?, encoding?)` — full replace; binary uses standard base64 and raw bytes |
| `patch_note` | `(noteId, title?, type?, mime?)` — metadata only |
| `delete_note` | `(noteId)` — hard-delete a single note; refuses backlinks, children or multiple parents |
| `undelete_note` | `(noteId)` — recover a Trilium-deleted note from Trilium's trash and attempt to restore its BrainLLM labels from placement; read `ok`, `labelsFailed` and `warning` on the receipt. The recent feed does not expose restore eligibility. Distinct from core `recover()` which restores BrainLLM-archived notes. |
| `note_history` | `(ancestorNoteId?)` — recent changes feed (`id`, `title`, `deleted`, `date`); no restore-eligibility field |

## Attributes

| Tool | Signature |
|---|---|
| `get_attribute` | `(attributeId)` |
| `add_label` | `(noteId, name, value?, isInheritable?)` — adds a `#label` (no dedup) |
| `add_relation` | `(fromNoteId, relationName, toNoteId, isInheritable?)` — any name (`connect` enforces the closed vocab) |
| `update_attribute` | `(attributeId, value?, position?)` — label value/position only; relation targets are immutable, and relation-position compatibility errors are explicit |
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
| `get_revision_content` | `(revisionId)` — text or base64 envelope for binary snapshots |

## Attachments

| Tool | Signature |
|---|---|
| `get_attachments` | `(noteId)` |
| `get_attachment_content` | `(attachmentId)` — text or base64 envelope for binary attachments |
| `create_attachment` | `(ownerId, title, mime, content, role?, encoding?)` — `role` ∈ file·image; binary uses base64/raw bytes |
| `update_attachment` | `(attachmentId, title?, mime?, content?, encoding?)` — metadata first, then raw content; binary uses base64 |
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
| `create_backup` | `(name?, date?)` — named DB backup request; ETAPI reports logical completion, not the resulting filename (`.db`/`.tnbackup` is deployment-dependent) |
