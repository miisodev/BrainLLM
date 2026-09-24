/**
 * tools-advanced.ts — full-mode surface (BRAINLLM_MODE=full)
 *
 * The raw ETAPI, served generic: one tool per Trilium primitive, no brain
 * placement / format / config. This is the surgical layer — the skill guides
 * the model on where and how to use it, against the structure and blueprints.
 * The brain-aware core surface (tools.ts) covers all routine operation.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { TriliumClient, ownedLabel, ContentMetadataUpdateError, PartialContentUploadError } from "./trilium.js";
import { localToday } from "./time.js";
import { labelPlan } from "./router.js";
import type { BrainLLMConfig } from "./config.js";
import type { Kind } from "./types.js";

const txt = (obj: unknown) => ({
  content: [{ type: "text" as const, text: typeof obj === "string" ? obj : JSON.stringify(obj, null, 2) }],
});

const noteStub = (n: { noteId: string; title: string; type?: string }) => ({
  id: n.noteId,
  title: n.title,
  ...(n.type ? { type: n.type } : {}),
});

const attrStub = (a: { attributeId: string; noteId: string; type: string; name: string; value: string }) => ({
  id: a.attributeId, noteId: a.noteId, type: a.type, name: a.name, value: a.value,
});

/** The raw surface is brain-agnostic by design and takes no config — with one
 *  exception. `undelete_note` has to re-apply the BrainLLM label set, because
 *  Trilium's restore drops attributes and a note without #noteType is
 *  invisible to every read path. That needs to know which container maps to
 *  which kind, so the brain accessor is threaded in for that single use. */
export function registerAdvancedTools(
  server: McpServer,
  trilium: TriliumClient,
  brainRef: { config: BrainLLMConfig }
): void {
  const b = () => brainRef.config;
  // ── Notes ───────────────────────────────────────────────────────────────────

  server.tool(
    "search_notes",
    `Raw Trilium query search. Native query language: #label=value, note.title =* "x",
note.dateModified >= 'YYYY-MM-DD', AND/OR. Unscoped unless ancestorNoteId is given.`,
    {
      query: z.string().describe("Trilium search query"),
      ancestorNoteId: z.string().optional().describe("Limit to this subtree"),
      limit: z.number().optional(),
      orderBy: z.string().optional().describe("title | dateModified | dateCreated"),
      orderDirection: z.enum(["asc", "desc"]).optional(),
      fastSearch: z.boolean().optional().describe("Skip content body scan"),
      includeArchived: z.boolean().optional(),
      debug: z.boolean().optional().describe("Return query parse debug info"),
    },
    async ({ query, ancestorNoteId, limit, orderBy, orderDirection, fastSearch, includeArchived, debug }) => {
      const result = await trilium.searchNotes(query, {
        ancestorNoteId, limit, orderBy, orderDirection, fastSearch,
        includeArchivedNotes: includeArchived, debug,
      });
      const out: Record<string, unknown> = { results: result.results.map(noteStub) };
      if (result.debugInfo !== undefined) out.debugInfo = result.debugInfo;
      return txt(out);
    }
  );

  server.tool(
    "get_note",
    "Full note metadata: title, type, mime, attributes (labels + relations), parent/child ids, dates.",
    { noteId: z.string() },
    async ({ noteId }) => {
      const n = await trilium.getNote(noteId);
      return txt({
        id: n.noteId, title: n.title, type: n.type, mime: n.mime,
        attributes: n.attributes.map((a) => ({ id: a.attributeId, type: a.type, name: a.name, value: a.value })),
        parents: n.parentNoteIds, children: n.childNoteIds,
        created: n.dateCreated, modified: n.dateModified,
      });
    }
  );

  server.tool(
    "get_note_content",
    "Raw note content. Text returns the body; binary returns {encoding:'base64', mime, content} without lossy decoding.",
    { noteId: z.string() },
    async ({ noteId }) => {
      const note = await trilium.getNote(noteId);
      return txt(await trilium.getNoteContentResult(noteId, note.type));
    }
  );

  server.tool(
    "create_note",
    "Create a note at an explicit parent. Types: text/code/book/canvas/mermaid/relationMap/render/search/file/image.",
    {
      parentNoteId: z.string(),
      title: z.string(),
      content: z.string(),
      type: z.enum(["text", "code", "book", "canvas", "mermaid", "relationMap", "render", "search", "file", "image"]).optional(),
      mime: z.string().optional(),
      encoding: z.enum(["auto", "text", "base64"]).optional().describe("Content encoding; auto treats text/* as UTF-8 and other MIME types as base64"),
    },
    async ({ parentNoteId, title, content, type, mime, encoding }) => {
      try {
        const r = await trilium.createNote(parentNoteId, title, content, type ?? "text", mime, undefined, encoding ?? "auto");
        return txt({ noteId: r.note.noteId, branchId: r.branch.branchId, title: r.note.title, contentUploaded: r.contentUploaded ?? true });
      } catch (error) {
        if (error instanceof PartialContentUploadError) return txt({ ok: false, error: "partial_upload", entityType: error.entityType, entityId: error.entityId, contentUploaded: false, detail: error.message });
        throw error;
      }
    }
  );

  server.tool(
    "update_note_content",
    "Replace a note's full content. Binary input must use encoding=base64; text remains UTF-8.",
    { noteId: z.string(), content: z.string(), mime: z.string().optional(), encoding: z.enum(["auto", "text", "base64"]).optional() },
    async ({ noteId, content, mime, encoding }) => {
      const note = await trilium.getNote(noteId);
      const targetMime = mime ?? note.mime;
      try {
        await trilium.updateNoteContent(noteId, content, targetMime, encoding ?? "auto");
      } catch (error) {
        if (error instanceof ContentMetadataUpdateError) {
          return txt({ ok: false, error: "content_metadata_update_failed", noteId, contentUploaded: true, detail: error.message, hint: "The bytes landed, but the MIME metadata did not. Re-run patch_note with the intended mime." });
        }
        throw error;
      }
      return txt({ ok: true, noteId, mime: targetMime, contentUploaded: true });
    }
  );

  server.tool(
    "patch_note",
    "Mutate note metadata: title, type, or mime.",
    { noteId: z.string(), title: z.string().optional(), type: z.string().optional(), mime: z.string().optional() },
    async ({ noteId, title, type, mime }) => {
      const fields: { title?: string; type?: string; mime?: string } = {};
      if (title != null) fields.title = title;
      if (type != null) fields.type = type;
      if (mime != null) fields.mime = mime;
      const note = await trilium.patchNote(noteId, fields);
      return txt({ noteId: note.noteId, title: note.title, type: note.type });
    }
  );

  server.tool(
    "delete_note",
    "Hard-delete a note (and its subtree if this is its last branch). Irreversible.",
    { noteId: z.string() },
    async ({ noteId }) => {
      const note = await trilium.getNote(noteId);
      let backlinks;
      try {
        backlinks = await trilium.getBacklinks(noteId);
      } catch (error) {
        return txt({ ok: false, blocked: true, error: "backlink_check_failed", noteId, detail: error instanceof Error ? error.message : String(error), hint: "The backlink vocabulary or result set was incomplete; raw hard delete is blocked." });
      }
      if (backlinks.length > 0) {
        return txt({ ok: false, blocked: true, error: "backlinks_exist", noteId, backlinks, hint: "Remove or retarget the listed relations before deleting." });
      }
      if ((note.childNoteIds?.length ?? 0) > 0 || (note.parentBranchIds?.length ?? 0) > 1) {
        return txt({ ok: false, blocked: true, error: "blast_radius", noteId, childNoteIds: note.childNoteIds ?? [], parentBranchIds: note.parentBranchIds ?? [], hint: "Deleting this note would remove a subtree or multiple placements." });
      }
      await trilium.deleteNote(noteId);
      return txt({ ok: true, deleted: noteId });
    }
  );

  server.tool(
    "undelete_note",
    "Recover a recently Trilium-deleted note from Trilium's trash. canBeUndeleted must be true (check note_history). Distinct from recover() which restores BrainLLM-archived notes. Re-applies the BrainLLM label set for the container it lands in — the restore itself does not bring attributes back, and a note without #noteType is invisible to every read path.",
    { noteId: z.string() },
    async ({ noteId }) => {
      await trilium.undeleteNote(noteId);

      // Trilium's undelete restores the note, its title, its content and its
      // placement — but NOT its attributes. Every BrainLLM read filters on
      // #noteType, so a restored note comes back present in Trilium and
      // absent from every tool. This is not hypothetical: on 2026-08-01
      // eleven thread stubs were restored with their original noteIds and no
      // labels, and brain() reported 9 notes where 25 existed. Two thirds of
      // the brain was invisible until it was repaired by hand.
      //
      // Re-derive the kind from the container the note sits in and re-apply
      // the label plan. Never overwrite an existing label — if the restore
      // did preserve attributes, or the note has since been typed, that is
      // authoritative and this is a no-op.
      const cfg = b();
      const note = await trilium.getNote(noteId);
      const restored: string[] = [];
      const failedLabels: string[] = [];
      let inferredKind: string | undefined;

      if (note) {
        const already = ownedLabel(note, "noteType");
        if (already) {
          inferredKind = already;
        } else {
          const parents = note.parentNoteIds ?? [];
          const byContainer: Array<[string | undefined, Kind]> = [
            [cfg.memory.sessions, "session"],
            [cfg.memory.threads, "thread"],
            [cfg.llm.diary, "diary"],
            [cfg.insights.logs, "log"],
            [cfg.knowledge.master, "user"],
            [cfg.knowledge.domains, "domain"],
          ];
          for (const [containerId, kind] of byContainer) {
            if (containerId && parents.includes(containerId)) {
              inferredKind = kind;
              break;
            }
          }
          // A thread's day-child sits under a thread book, not under Threads.
          if (!inferredKind && parents.length) {
            const parent = await trilium.getNote(parents[0]!).catch(() => null);
            if (parent && ownedLabel(parent, "noteType") === "thread") inferredKind = "threadEntry";
            else if (parent && ownedLabel(parent, "noteType") === "domain") inferredKind = "information";
          }

          if (inferredKind) {
            for (const l of labelPlan(inferredKind as Kind, {}, localToday())) {
              if (!ownedLabel(note, l.name)) {
                try {
                  await trilium.addLabel(noteId, l.name, l.value, l.inheritable ?? false);
                  restored.push(l.value ? `${l.name}=${l.value}` : l.name);
                } catch {
                  failedLabels.push(l.name);
                }
              }
            }
          }
        }
      }

      return txt({
        ok: failedLabels.length === 0 && !!inferredKind,
        undeleted: noteId,
        ...(inferredKind ? { kind: inferredKind } : {}),
        ...(restored.length ? { labelsRestored: restored } : {}),
        ...(failedLabels.length ? { labelsFailed: failedLabels, partial: true } : {}),
        ...(note && !inferredKind
          ? {
              warning:
                "Could not infer this note's kind from its placement, so no #noteType was applied — it is currently INVISIBLE to brain(), recall() and every surface read. " +
                "Move it under its proper container and re-run, or set the label with add_label.",
            }
          : {}),
      });
    }
  );

  server.tool(
    "note_history",
    "Recent changes feed (creations / modifications / deletions), newest first.",
    { ancestorNoteId: z.string().optional() },
    async ({ ancestorNoteId }) => {
      const changes = await trilium.getNoteHistory(ancestorNoteId);
      return txt(changes.map((c) => ({ id: c.noteId, title: c.current_title, deleted: c.current_isDeleted, date: c.date })));
    }
  );

  // ── Attributes ──────────────────────────────────────────────────────────────

  server.tool(
    "get_attribute",
    "Fetch a single attribute by id.",
    { attributeId: z.string() },
    async ({ attributeId }) => txt(attrStub(await trilium.getAttribute(attributeId)))
  );

  server.tool(
    "add_label",
    "Add a #label to a note (empty value = boolean flag). Adds a new attribute; does not dedupe.",
    { noteId: z.string(), name: z.string().describe("Label name (no # prefix)"), value: z.string().optional(), isInheritable: z.boolean().optional() },
    async ({ noteId, name, value, isInheritable }) => {
      const attr = await trilium.addLabel(noteId, name, value ?? "", isInheritable ?? false);
      return txt(attrStub(attr));
    }
  );

  server.tool(
    "add_relation",
    "Add a ~relation with a conservative identifier name (the core connect() enforces the canonical vocabulary).",
    { fromNoteId: z.string(), relationName: z.string(), toNoteId: z.string(), isInheritable: z.boolean().optional() },
    async ({ fromNoteId, relationName, toNoteId, isInheritable }) => {
      const attr = await trilium.addRelation(fromNoteId, relationName, toNoteId, isInheritable ?? false);
      return txt(attrStub(attr));
    }
  );

  server.tool(
    "update_attribute",
    "Update an attribute's value (labels) and/or position by id.",
    { attributeId: z.string(), value: z.string().optional(), position: z.number().optional() },
    async ({ attributeId, value, position }) => {
      const fields: { value?: string; position?: number } = {};
      if (value != null) fields.value = value;
      if (position != null) fields.position = position;
      return txt(attrStub(await trilium.updateAttribute(attributeId, fields)));
    }
  );

  server.tool(
    "delete_attribute",
    "Delete any label or relation by attributeId.",
    { attributeId: z.string() },
    async ({ attributeId }) => {
      await trilium.deleteAttribute(attributeId);
      return txt({ ok: true, deleted: attributeId });
    }
  );

  // ── Branches (placement) ────────────────────────────────────────────────────

  server.tool(
    "get_branch",
    "Fetch a branch (a note's placement under one parent).",
    { branchId: z.string() },
    async ({ branchId }) => txt(await trilium.getBranch(branchId))
  );

  server.tool(
    "clone_note",
    "Place a note under an additional parent (multi-parent branch; shared content, no copy).",
    { noteId: z.string(), parentNoteId: z.string(), prefix: z.string().optional() },
    async ({ noteId, parentNoteId, prefix }) => {
      const branch = await trilium.cloneNote(noteId, parentNoteId, prefix);
      return txt({ id: branch.branchId, noteId: branch.noteId, parentNoteId: branch.parentNoteId });
    }
  );

  server.tool(
    "move_note",
    "Move a note to a new parent (clone to the new parent, then remove the old branch).",
    { noteId: z.string(), fromParentNoteId: z.string(), toParentNoteId: z.string() },
    async ({ noteId, fromParentNoteId, toParentNoteId }) => {
      if (fromParentNoteId === toParentNoteId) return txt({ ok: true, action: "already_moved", noteId, movedTo: toParentNoteId });
      const newBranch = await trilium.cloneNote(noteId, toParentNoteId);
      const fresh = await trilium.getNote(noteId);
      let removedBranchId: string | null = null;
      for (const bid of fresh.parentBranchIds) {
        if (bid === newBranch.branchId) continue;
        const branch = await trilium.getBranch(bid);
        if (branch.parentNoteId === fromParentNoteId) {
          await trilium.deleteBranch(bid);
          removedBranchId = bid;
          break;
        }
      }
      if (!removedBranchId) {
        return txt({ ok: false, error: "source_branch_not_found", noteId, movedTo: toParentNoteId, newBranchId: newBranch.branchId, detail: "The destination placement was created, but no branch under fromParentNoteId was removed; the note may now be present in both parents." });
      }
      return txt({ ok: true, noteId, movedTo: toParentNoteId, newBranchId: newBranch.branchId, removedBranchId });
    }
  );

  server.tool(
    "delete_branch",
    "Remove one placement of a note (deletes the note if it was the last branch).",
    { branchId: z.string() },
    async ({ branchId }) => {
      await trilium.deleteBranch(branchId);
      return txt({ ok: true, deleted: branchId });
    }
  );

  // ── Revisions ───────────────────────────────────────────────────────────────

  server.tool(
    "create_revision",
    "Snapshot a note's current content as a revision.",
    { noteId: z.string() },
    async ({ noteId }) => {
      await trilium.createRevision(noteId);
      return txt({ ok: true, noteId });
    }
  );

  server.tool(
    "get_revisions",
    "List a note's revisions, newest first.",
    { noteId: z.string() },
    async ({ noteId }) => {
      const revs = await trilium.getNoteRevisions(noteId);
      return txt(revs.map((r) => ({ id: r.revisionId, title: r.title, mime: r.mime, date: r.utcDateCreated, size: r.contentLength })));
    }
  );

  server.tool(
    "get_revision_content",
    "Content of a historical revision snapshot. Binary snapshots return a base64 envelope.",
    { revisionId: z.string() },
    async ({ revisionId }) => {
      const revision = await trilium.getRevision(revisionId);
      return txt(await trilium.getRevisionContentResult(revisionId, revision.type));
    }
  );

  // ── Attachments ─────────────────────────────────────────────────────────────

  server.tool(
    "get_attachments",
    "List attachments on a note (id + title + mime + size).",
    { noteId: z.string() },
    async ({ noteId }) => {
      const attachments = await trilium.getNoteAttachments(noteId);
      return txt(attachments.map((a) => ({ id: a.attachmentId, title: a.title, mime: a.mime, size: a.contentLength })));
    }
  );

  server.tool(
    "get_attachment_content",
    "Read an attachment. Text returns its body; binary returns {encoding:'base64', mime, content}.",
    { attachmentId: z.string() },
    async ({ attachmentId }) => txt(await trilium.getAttachmentContentResult(attachmentId))
  );

  server.tool(
    "create_attachment",
    "Attach a file or text blob to a note (role: file | image). Binary content uses standard base64 and is uploaded as raw bytes.",
    { ownerId: z.string(), title: z.string(), mime: z.string(), content: z.string().describe("Text content, or standard base64 for binary"), role: z.enum(["file", "image"]).optional(), encoding: z.enum(["auto", "text", "base64"]).optional() },
    async ({ ownerId, title, mime, content, role, encoding }) => {
      try {
        const att = await trilium.createAttachment(ownerId, title, mime, content, role ?? "file", encoding ?? "auto");
        return txt({ id: att.attachmentId, title: att.title, mime: att.mime, size: att.contentLength, contentUploaded: att.contentUploaded ?? true });
      } catch (error) {
        if (error instanceof PartialContentUploadError) return txt({ ok: false, error: "partial_upload", entityType: error.entityType, entityId: error.entityId, contentUploaded: false, detail: error.message });
        throw error;
      }
    }
  );

  server.tool(
    "update_attachment",
    "Update an attachment's content and/or metadata. MIME changes are applied before raw binary content so the server never coerces bytes using the old type.",
    {
      attachmentId: z.string(),
      title: z.string().optional(),
      mime: z.string().optional().describe("Stored MIME metadata; raw uploads use text/plain or application/octet-stream as appropriate"),
      content: z.string().optional().describe("New content; binary must be standard base64"),
      encoding: z.enum(["auto", "text", "base64"]).optional(),
    },
    async ({ attachmentId, title, mime, content, encoding }) => {
      if (title != null || mime != null) {
        const fields: { title?: string; mime?: string } = {};
        if (title != null) fields.title = title;
        if (mime != null) fields.mime = mime;
        await trilium.updateAttachment(attachmentId, fields);
      }
      if (content != null) {
        const current = mime ?? (await trilium.getAttachment(attachmentId).then((a) => a.mime).catch(() => "text/plain"));
        await trilium.updateAttachmentContent(attachmentId, content, current, encoding ?? "auto");
      }
      return txt({ id: attachmentId, contentUpdated: content != null, metadataUpdated: title != null || mime != null });
    }
  );

  server.tool(
    "delete_attachment",
    "Permanently delete an attachment. Irreversible.",
    { attachmentId: z.string() },
    async ({ attachmentId }) => {
      await trilium.deleteAttachment(attachmentId);
      return txt({ ok: true, deleted: attachmentId });
    }
  );

  // ── Calendar (Trilium journal) ──────────────────────────────────────────────

  server.tool(
    "get_day_note",
    "Get (or auto-create) the journal day note. Format: YYYY-MM-DD (default: today).",
    { date: z.string().optional() },
    async ({ date }) => txt(await trilium.getDayNote(date ?? localToday()))
  );

  server.tool(
    "get_week_note",
    "Get (or auto-create) the journal week note. Format: YYYY-Www.",
    { week: z.string() },
    async ({ week }) => txt(await trilium.getWeekNote(week))
  );

  server.tool(
    "get_month_note",
    "Get (or auto-create) the journal month note. Format: YYYY-MM.",
    { month: z.string() },
    async ({ month }) => txt(await trilium.getMonthNote(month))
  );

  server.tool(
    "get_year_note",
    "Get (or auto-create) the journal year note. Format: YYYY.",
    { year: z.string() },
    async ({ year }) => txt(await trilium.getYearNote(year))
  );

  server.tool(
    "get_inbox_note",
    "Get the Trilium inbox note for a date (fixed #inbox note, or the day note). Format: YYYY-MM-DD.",
    { date: z.string().optional() },
    async ({ date }) => txt(await trilium.getInboxNote(date ?? localToday()))
  );

  // ── System ──────────────────────────────────────────────────────────────────

  server.tool(
    "get_app_info",
    "Trilium server version, DB version, runtime metadata.",
    {},
    async () => txt(await trilium.getAppInfo())
  );

  server.tool(
    "create_backup",
    "Trigger a named Trilium database backup. ETAPI confirms the logical request completed but does not expose the resulting file path or format (it may be .db or .tnbackup). Use a descriptive name for milestone snapshots (e.g. 'before-migration').",
    {
      name: z.string().optional().describe("Backup file name without .db extension (default: brainllm-{today})"),
      date: z.string().optional().describe("ISO date used in the default name when name is omitted (default: today)"),
    },
    async ({ name, date }) => {
      const backupName = name ?? `brainllm-${date ?? localToday()}`;
      try {
        await trilium.createBackup(backupName);
        return txt({ ok: true, backup: backupName, backupStatus: "completed" });
      } catch (error) {
        return txt({ ok: false, backup: backupName, backupStatus: "failed", error: error instanceof Error ? error.message : String(error) });
      }
    }
  );
}
