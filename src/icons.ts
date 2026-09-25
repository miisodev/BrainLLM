// ─────────────────────────────────────────────────────────────────────────────
// BrainLLM — icons
//
// Every note in the brain carries an icon, except log notes. The icon is set
// when a note is created (the caller's icon=, else the kind default below) and
// the maintenance sweep backfills any note that arrived without one — through
// create_note, the Trilium UI, or a path that predates this rule.
// ─────────────────────────────────────────────────────────────────────────────

import { type TriliumClient, type Note, ownedLabel } from "./trilium.js";

/** Default icon per kind. A thread entry takes its thread's icon instead. */
export const KIND_ICONS: Record<string, string> = {
  biography: "bx bx-id-card",
  goals: "bx bx-target-lock",
  preferences: "bx bxs-smile",
  responsibilities: "bx bxs-analyse",
  protocols: "bx bx-shield-quarter",
  selfcorrection: "bx bxs-adjust-alt",
  diary: "bx bx-book-heart",
  session: "bx bx-calendar-check",
  thread: "bx bx-conversation",
  threadEntry: "bx bx-conversation",
  user: "bx bx-user",
  domain: "bx bx-folder",
  information: "bx bx-info-circle",
  sources: "bx bx-link",
  claim: "bx bx-check-shield",
};

/** A note with no kind label (a container, or a folder the user made). */
export const FALLBACK_ICON = "bx bx-note";

/** Kinds that never carry an icon. */
export const ICON_EXEMPT = new Set(["log"]);

/** The icon a note should carry when it has none, or null when it is exempt.
 *  `parent` is only consulted for a thread entry. */
export function defaultIcon(note: Note, parent?: Note | null): string | null {
  const kind = ownedLabel(note, "noteType");
  if (kind && ICON_EXEMPT.has(kind)) return null;
  if (kind === "threadEntry") return (parent && ownedLabel(parent, "iconClass")) || KIND_ICONS.threadEntry;
  return (kind && KIND_ICONS[kind]) || FALLBACK_ICON;
}

/** Give a note its default icon if it has none. Returns the class applied, or
 *  undefined when the note already had one or is exempt. A thread entry whose
 *  thread has no icon gets the thread fixed first, so the two match. */
export async function ensureIcon(trilium: TriliumClient, noteId: string, known?: Note): Promise<string | undefined> {
  const note = known ?? (await trilium.getNote(noteId).catch(() => null));
  if (!note || ownedLabel(note, "iconClass")) return undefined;
  let parent: Note | null = null;
  if (ownedLabel(note, "noteType") === "threadEntry" && note.parentNoteIds[0]) {
    parent = await trilium.getNote(note.parentNoteIds[0]).catch(() => null);
    if (parent && !ownedLabel(parent, "iconClass")) {
      const set = await ensureIcon(trilium, parent.noteId, parent);
      if (set) parent = await trilium.getNote(parent.noteId).catch(() => parent);
    }
  }
  const cls = defaultIcon(note, parent);
  if (!cls) return undefined;
  await trilium.addLabel(noteId, "iconClass", cls).catch(() => null);
  return cls;
}
