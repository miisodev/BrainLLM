/**
 * test.ts — Integration tests for the Trilium MCP client.
 * Run with: bun run src/test.ts
 * Requires TRILIUM_BASE_URL and TRILIUM_ETAPI_TOKEN env vars.
 */

import { TriliumClient } from "./trilium.js";
import { loadConfig, discoverBrainLLM } from "./config.js";

const baseUrl = process.env.TRILIUM_BASE_URL;
const token = process.env.TRILIUM_ETAPI_TOKEN;

if (!baseUrl || !token) {
  console.error("Missing TRILIUM_BASE_URL or TRILIUM_ETAPI_TOKEN");
  process.exit(1);
}

const trilium = new TriliumClient(baseUrl, token);

// Resolve real structural IDs — brainllm.json if co-located, else live discovery.
const Trilium = loadConfig() ?? (await discoverBrainLLM(trilium));
if (!Trilium) {
  console.error("No brain found in Trilium — run `bun run init` or the bootstrap tool first.");
  process.exit(1);
}
let passed = 0;
let failed = 0;
const cleanup: string[] = []; // noteIds to delete at the end

function pass(label: string, detail?: string) {
  passed++;
  console.log(`✓ ${label}${detail ? `: ${detail}` : ""}`);
}

function fail(label: string, err: unknown) {
  failed++;
  console.error(`✗ ${label}: ${err instanceof Error ? err.message : String(err)}`);
}

// ── App info ──────────────────────────────────────────────────────────────────
try {
  const info = await trilium.getAppInfo();
  pass("getAppInfo", `v${info.appVersion} db=${info.dbVersion}`);
} catch (err) { fail("getAppInfo", err); }

// ── Search ────────────────────────────────────────────────────────────────────
try {
  const result = await trilium.searchNotes("note", { limit: 5 });
  pass("searchNotes", `${result.results.length} results`);
} catch (err) { fail("searchNotes", err); }

try {
  const result = await trilium.searchNotes("#noteType", { fastSearch: true, limit: 5 });
  pass("searchNotes #noteType (fast)", `${result.results.length} results`);
} catch (err) { fail("searchNotes #noteType", err); }

// ── Note CRUD ─────────────────────────────────────────────────────────────────
let testNoteId = "";
try {
  const r = await trilium.createNote(Trilium.knowledge.root, "MCP Test Note", "<p>Test content.</p>");
  testNoteId = r.note.noteId;
  cleanup.push(testNoteId);
  pass("createNote", `id=${testNoteId}`);
} catch (err) { fail("createNote", err); }

if (testNoteId) {
  try {
    const note = await trilium.getNote(testNoteId);
    pass("getNote", `title="${note.title}" type=${note.type}`);
  } catch (err) { fail("getNote", err); }

  try {
    const content = await trilium.getNoteContent(testNoteId);
    pass("getNoteContent", JSON.stringify(content.slice(0, 40)));
  } catch (err) { fail("getNoteContent", err); }

  try {
    await trilium.updateNoteContent(testNoteId, "<p>Updated by test.</p>");
    pass("updateNoteContent");
  } catch (err) { fail("updateNoteContent", err); }

  try {
    await trilium.patchNote(testNoteId, { title: "MCP Test Note (renamed)" });
    pass("patchNote");
  } catch (err) { fail("patchNote", err); }
}

// ── Attributes ────────────────────────────────────────────────────────────────
let attrId = "";
if (testNoteId) {
  try {
    const attr = await trilium.addLabel(testNoteId, "testLabel", "hello");
    attrId = attr.attributeId;
    pass("addLabel", `id=${attrId}`);
  } catch (err) { fail("addLabel", err); }

  try {
    await trilium.addLabel(testNoteId, "noteType", "knowledge");
    pass("addLabel noteType");
  } catch (err) { fail("addLabel noteType", err); }

  try {
    const byLabel = await trilium.getNotesByLabel("testLabel", "hello");
    pass("getNotesByLabel", `${byLabel.results.length} notes found`);
  } catch (err) { fail("getNotesByLabel", err); }

  if (attrId) {
    try {
      await trilium.deleteAttribute(attrId);
      pass("deleteAttribute");
    } catch (err) { fail("deleteAttribute", err); }
  }
}

// ── Revisions ─────────────────────────────────────────────────────────────────
if (testNoteId) {
  try {
    await trilium.createRevision(testNoteId);
    pass("createRevision");
  } catch (err) { fail("createRevision", err); }

  try {
    const revs = await trilium.getNoteRevisions(testNoteId);
    pass("getNoteRevisions", `${revs.length} revision(s)`);
    if (revs.length > 0) {
      const content = await trilium.getRevisionContent(revs[0].revisionId);
      pass("getRevisionContent", `${content.length} chars`);
    }
  } catch (err) { fail("getNoteRevisions", err); }
}

// ── Attachments ───────────────────────────────────────────────────────────────
let attachmentId = "";
if (testNoteId) {
  try {
    const att = await trilium.createAttachment(testNoteId, "test.txt", "text/plain", "hello from test");
    attachmentId = att.attachmentId;
    pass("createAttachment", `id=${attachmentId}`);
  } catch (err) { fail("createAttachment", err); }

  try {
    const list = await trilium.getNoteAttachments(testNoteId);
    pass("getNoteAttachments", `${list.length} attachment(s)`);
  } catch (err) { fail("getNoteAttachments", err); }

  if (attachmentId) {
    try {
      const content = await trilium.getAttachmentContent(attachmentId);
      pass("getAttachmentContent", JSON.stringify(content));
    } catch (err) { fail("getAttachmentContent", err); }

    try {
      await trilium.deleteAttachment(attachmentId);
      pass("deleteAttachment");
    } catch (err) { fail("deleteAttachment", err); }
  }
}

// ── Clone + move ──────────────────────────────────────────────────────────────
let cloneNoteId = "";
if (testNoteId) {
  try {
    const r = await trilium.createNote(Trilium.knowledge.root, "Clone Source", "to be cloned");
    cloneNoteId = r.note.noteId;
    cleanup.push(cloneNoteId);
    const branch = await trilium.cloneNote(cloneNoteId, Trilium.knowledge.master);
    pass("cloneNote", `branchId=${branch.branchId}`);
    // clean up the extra branch (leave original)
    await trilium.deleteBranch(branch.branchId);
    pass("deleteBranch (clone cleanup)");
  } catch (err) { fail("cloneNote/deleteBranch", err); }
}

// ── Backlinks (relation reverse traversal) ──────────────────────────────────────
try {
  const a = await trilium.createNote(Trilium.knowledge.root, "Backlink Source", "points to target");
  const b = await trilium.createNote(Trilium.knowledge.root, "Backlink Target", "the target");
  cleanup.push(a.note.noteId, b.note.noteId);
  await trilium.addRelation(a.note.noteId, "relatesTo", b.note.noteId);
  const backlinks = await trilium.getBacklinks(b.note.noteId);
  const found = backlinks.find((x) => x.noteId === a.note.noteId && x.relationName === "relatesTo");
  if (found) pass("getBacklinks", `found source via ~relatesTo (${backlinks.length} total)`);
  else fail("getBacklinks", new Error(`expected source ${a.note.noteId}, got ${JSON.stringify(backlinks)}`));
} catch (err) { fail("getBacklinks", err); }

// ── History ───────────────────────────────────────────────────────────────────
try {
  const history = await trilium.getNoteHistory(Trilium.root);
  pass("getNoteHistory", `${history.length} entries`);
} catch (err) { fail("getNoteHistory", err); }

// ── Calendar ──────────────────────────────────────────────────────────────────
try {
  const today = new Date().toISOString().slice(0, 10);
  const day = await trilium.getDayNote(today);
  pass("getDayNote", `id=${day.noteId}`);
} catch (err) { fail("getDayNote", err); }

try {
  const month = new Date().toISOString().slice(0, 7);
  const mn = await trilium.getMonthNote(month);
  pass("getMonthNote", `id=${mn.noteId}`);
} catch (err) { fail("getMonthNote", err); }

// ── Backup ────────────────────────────────────────────────────────────────────
try {
  const today = new Date().toISOString().slice(0, 10);
  await trilium.createBackup(today);
  pass("createBackup");
} catch (err) { fail("createBackup", err); }

// ── Cleanup ───────────────────────────────────────────────────────────────────
console.log(`\nCleaning up ${cleanup.length} test note(s)...`);
for (const id of cleanup) {
  try { await trilium.deleteNote(id); } catch { /* ignore */ }
}

// ── Summary ───────────────────────────────────────────────────────────────────
console.log(`\n${"─".repeat(40)}`);
console.log(`Passed: ${passed}  Failed: ${failed}`);
if (failed > 0) process.exit(1);
