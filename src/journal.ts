// ─────────────────────────────────────────────────────────────────────────────
// BrainLLM — daily log generation (Insights/Logs)
//
// Builds and keeps fresh the per-day Insights/Logs note recording the brain
// content created, updated, or deleted that day — sourced from Trilium's own
// note dates and change history, so there is no parallel bookkeeping. Idempotent:
// regenerating a day's log replaces its content, so it can run on every
// close, on a periodic server tick, and on startup catch-up without
// duplicating.
// ─────────────────────────────────────────────────────────────────────────────

import { type TriliumClient, type Note, ownedLabel } from "./trilium.js";
import type { BrainLLMConfig } from "./config.js";
import { isStructural } from "./lifecycle.js";
import { escapeHtml } from "./normalize.js";

export interface LogReport {
  date: string;
  noteId?: string;
  created: number;
  updated: number;
  deleted: number;
  action: "created" | "updated" | "unchanged" | "skipped";
}

export async function generateDailyLog(trilium: TriliumClient, cfg: BrainLLMConfig, date: string): Promise<LogReport> {
  if (!cfg.root || !cfg.insights.logs) return { date, created: 0, updated: 0, deleted: 0, action: "skipped" };

  const nextDay = new Date(Date.parse(`${date}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);

  // Content notes touched on `date` (excluding scaffolding, blueprints, and logs).
  const touched = await trilium
    .searchNotes(`#noteType note.dateModified >= '${date}' note.dateModified < '${nextDay}'`, {
      ancestorNoteId: cfg.root,
      fastSearch: true,
      includeArchivedNotes: true,
      limit: 300,
    })
    .catch(() => ({ results: [] as Note[] }));

  const created: Array<{ title: string; noteId: string }> = [];
  const updated: Array<{ title: string; noteId: string }> = [];
  for (const n of touched.results) {
    const kind = ownedLabel(n, "noteType");
    if (!kind || kind === "blueprint" || kind === "log") continue;
    if (isStructural(cfg, n.noteId)) continue;
    (n.dateCreated.startsWith(date) ? created : updated).push({ title: `${n.title} (${kind})`, noteId: n.noteId });
  }

  // Deletions from Trilium's change feed.
  const history = await trilium.getNoteHistory(cfg.root).catch(() => []);
  const deleted = history
    .filter((h) => h.current_isDeleted && h.date.startsWith(date))
    .map((h) => ({ title: h.current_title || h.title, noteId: h.noteId }));

  const list = (items: Array<{ title: string; noteId: string }>) =>
    items.length
      ? `<ul>${items.map((i) => `<li>${escapeHtml(i.title)} — <code>${i.noteId}</code></li>`).join("")}</ul>`
      : "<p><em>none</em></p>";

  const body = [
    `<p><em>log · ${date}</em></p>\n<hr>`,
    "<h2>Created</h2>", list(created),
    "<h2>Updated</h2>", list(updated),
    "<h2>Deleted</h2>", list(deleted),
  ].join("\n");

  const counts = { created: created.length, updated: updated.length, deleted: deleted.length };

  // Upsert the day's log note in Insights/Logs.
  const existing = await trilium
    .searchNotes(`#noteType=log #created=${date}`, { ancestorNoteId: cfg.insights.logs, fastSearch: true, limit: 1 })
    .catch(() => ({ results: [] as Note[] }));

  if (existing.results[0]) {
    const id = existing.results[0].noteId;
    const current = await trilium.getNoteContent(id).catch(() => "");
    if (current.trim() === body.trim()) return { date, noteId: id, ...counts, action: "unchanged" };
    await trilium.updateNoteContent(id, body);
    return { date, noteId: id, ...counts, action: "updated" };
  }

  const note = await trilium.createNote(cfg.insights.logs, date, body);
  const logNoteId = note.note.noteId;
  await trilium.addLabel(logNoteId, "noteType", "log");
  await trilium.addLabel(logNoteId, "created", date);
  const tpl = cfg.templates.byKind["log"];
  if (tpl) await trilium.addRelation(logNoteId, "template", tpl).catch(() => null);
  return { date, noteId: logNoteId, ...counts, action: "created" };
}
