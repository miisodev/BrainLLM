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
import { TriliumClient } from "./trilium.js";
import { localToday } from "./time.js";

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

export function registerAdvancedTools(server: McpServer, trilium: TriliumClient): void {
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
    "Raw note content (HTML / text / code).",
    { noteId: z.string() },
    async ({ noteId }) => txt(await trilium.getNoteContent(noteId))
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
    },
    async ({ parentNoteId, title, content, type, mime }) => {
      const r = await trilium.createNote(parentNoteId, title, content, type ?? "text", mime);
      return txt({ noteId: r.note.noteId, branchId: r.branch.branchId, title: r.note.title });
    }
  );

  server.tool(
    "update_note_content",
    "Replace a note's full content.",
    { noteId: z.string(), content: z.string() },
    async ({ noteId, content }) => {
      await trilium.updateNoteContent(noteId, content);
      return txt({ ok: true, noteId });
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
      await trilium.deleteNote(noteId);
      return txt({ ok: true, deleted: noteId });
    }
  );

  server.tool(
    "undelete_note",
    "Recover a recently Trilium-deleted note from Trilium's trash. canBeUndeleted must be true (check note_history). Distinct from recover() which restores BrainLLM-archived notes.",
    { noteId: z.string() },
    async ({ noteId }) => {
      await trilium.undeleteNote(noteId);
      return txt({ ok: true, undeleted: noteId });
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
    "Add a ~relation with any name (the core connect() enforces the canonical vocabulary).",
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
      const newBranch = await trilium.cloneNote(noteId, toParentNoteId);
      const fresh = await trilium.getNote(noteId);
      for (const bid of fresh.parentBranchIds) {
        if (bid === newBranch.branchId) continue;
        const branch = await trilium.getBranch(bid);
        if (branch.parentNoteId === fromParentNoteId) {
          await trilium.deleteBranch(bid);
          break;
        }
      }
      return txt({ ok: true, noteId, movedTo: toParentNoteId, newBranchId: newBranch.branchId });
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
      return txt(revs.map((r) => ({ id: r.revisionId, title: r.title, date: r.utcDateCreated, size: r.contentLength })));
    }
  );

  server.tool(
    "get_revision_content",
    "Content of a historical revision snapshot.",
    { revisionId: z.string() },
    async ({ revisionId }) => txt(await trilium.getRevisionContent(revisionId))
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
    "Read the content of a text/code attachment.",
    { attachmentId: z.string() },
    async ({ attachmentId }) => txt(await trilium.getAttachmentContent(attachmentId))
  );

  server.tool(
    "create_attachment",
    "Attach a file or text blob to a note (role: file | image).",
    { ownerId: z.string(), title: z.string(), mime: z.string(), content: z.string().describe("Text content (base64 for binary)"), role: z.enum(["file", "image"]).optional() },
    async ({ ownerId, title, mime, content, role }) => {
      const att = await trilium.createAttachment(ownerId, title, mime, content, role ?? "file");
      return txt({ id: att.attachmentId, title: att.title, mime: att.mime, size: att.contentLength });
    }
  );

  server.tool(
    "update_attachment",
    "Update an attachment's content and/or metadata (title, mime). Pass content to replace the binary/text data in place; pass title/mime to update metadata only.",
    {
      attachmentId: z.string(),
      title: z.string().optional(),
      mime: z.string().optional().describe("MIME type — also used as Content-Type when writing content"),
      content: z.string().optional().describe("New content (replaces existing; text or base64 for binary)"),
    },
    async ({ attachmentId, title, mime, content }) => {
      if (content != null) {
        await trilium.updateAttachmentContent(attachmentId, content, mime ?? "text/plain");
      }
      if (title != null || mime != null) {
        const fields: { title?: string; mime?: string } = {};
        if (title != null) fields.title = title;
        if (mime != null) fields.mime = mime;
        const att = await trilium.updateAttachment(attachmentId, fields);
        return txt({ id: att.attachmentId, title: att.title, mime: att.mime, contentUpdated: content != null });
      }
      return txt({ ok: true, attachmentId, contentUpdated: content != null });
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
    "Trigger a named Trilium database backup. The backup file is written to Trilium's backup directory as <name>.db (default name: brainllm-{date}). Use a descriptive name for milestone snapshots (e.g. 'before-migration').",
    {
      name: z.string().optional().describe("Backup file name without .db extension (default: brainllm-{today})"),
      date: z.string().optional().describe("ISO date used in the default name when name is omitted (default: today)"),
    },
    async ({ name, date }) => {
      const backupName = name ?? `brainllm-${date ?? localToday()}`;
      await trilium.createBackup(backupName);
      return txt({ ok: true, backup: `${backupName}.db` });
    }
  );
}
