// ─────────────────────────────────────────────────────────────────────────────
// BrainLLM — tool annotations
//
// Clients group tools by their annotation hints. Without them every tool lands
// in one undifferentiated "Other tools" bucket, and the user's only choice is
// to allow every tool or approve each call — which is the same failure mode as a
// maintenance flag that always fires: an all-or-nothing prompt gets answered
// "always allow" once and then never read again.
//
// Splitting reads from writes lets the reads run unattended while anything that
// touches the brain still asks. That is the whole point of the classification,
// so the safe default matters: a tool absent from this table is treated as a
// WRITE, never as a read. Marking a write read-only by mistake would let it
// through a blanket "always allow" on the read-only group.
//
// The hints are advisory per the MCP spec — clients are told to treat
// annotations from untrusted servers as untrusted. They shape presentation, not
// enforcement; BrainLLM's own guards (structural-note protection, the
// backlink check on hard delete, the pre-close gate) are the real controls.
// ─────────────────────────────────────────────────────────────────────────────

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

interface Hints {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  /** Human-facing label; clients fall back to the tool name without it. */
  title?: string;
}

/** Reads nothing but the brain — no writes of any kind. */
const READ: Hints = { readOnlyHint: true };
/** Writes, but only ever adds or amends; re-running converges. */
const WRITE: Hints = { readOnlyHint: false, destructiveHint: false, idempotentHint: true };
/** Writes non-idempotently — a second call is a second effect. */
const APPEND: Hints = { readOnlyHint: false, destructiveHint: false };
/** Removes or overwrites something that existed. */
const DESTRUCTIVE: Hints = { readOnlyHint: false, destructiveHint: true };

export const TOOL_ANNOTATIONS: Record<string, Hints> = {
  // ── Core: pure reads ────────────────────────────────────────────────────────
  remarks: WRITE,         // cue-only, but durably marks the pre-close gate
  day: READ,
  brain: READ,
  recall: READ,
  domain: READ,
  read: READ,             // batched multi-note read — N bodies, one round trip
  outline: READ,
  inspect: READ,
  template: READ,
  explore: READ,
  consistency: READ,
  assembly: READ,
  diff: READ,             // reads a revision snapshot and current content; takes none
  health: READ,
  master: READ, master_recall: READ,
  llm: READ, llm_recall: READ,
  memory: READ, memory_recall: READ,
  knowledge: READ, knowledge_recall: READ,
  insights: READ, insights_recall: READ,

  // ── Core: writes ────────────────────────────────────────────────────────────
  // start() and session() look like reads and are not: start creates today's
  // diary and session stubs and runs the lite sweep, session runs the sweep and
  // marks the gate. graph() upserts the Insights/Graph note. Each would be a
  // genuine mistake to classify as read-only.
  start: WRITE,
  session: WRITE,
  graph: WRITE,
  maintain: WRITE,
  addendum: WRITE,        // searches/reports and durably marks the pre-close gate
  // claim() is mode-inferred, and its modes disagree: listing and reading write
  // nothing, registering is idempotent (deduped by assertion), and recording a
  // verification appends a dated line every time. A tool gets one annotation,
  // so it takes the weakest guarantee any of its modes can honour — APPEND
  // rather than WRITE, because a second verify call really is a second effect.
  // Classifying it by its cheapest mode would be the mistake this table exists
  // to prevent.
  claim: APPEND,
  remember: WRITE,
  diary: APPEND,
  // revise can replace a whole body, remove a section or rewrite a domain.
  // A revision is taken first, but the hint describes the edit, not the undo.
  revise: DESTRUCTIVE,
  split: WRITE,           // moves sections out of a note into a new one
  close: APPEND,
  connect: DESTRUCTIVE,   // remove=true deletes an edge
  label: DESTRUCTIVE,     // remove=true deletes a label; setting one overwrites its value
  attach: WRITE,
  backup: APPEND,
  bootstrap: WRITE,
  resolve: WRITE,
  withdraw: WRITE,
  recover: WRITE,

  // ── Core: destructive ───────────────────────────────────────────────────────
  forget: DESTRUCTIVE,    // archives by default, hard-deletes with hard=true
  detach: DESTRUCTIVE,    // attachments have no archive tier — removal is final

  // ── Full mode: raw ETAPI reads ──────────────────────────────────────────────
  get_note: READ,
  get_note_content: READ,
  get_attachments: READ,
  get_attachment_content: READ,
  get_attribute: READ,
  get_branch: READ,
  get_revisions: READ,
  get_revision_content: READ,
  search_notes: READ,
  note_history: READ,
  get_app_info: READ,

  // ── Full mode: raw ETAPI writes ─────────────────────────────────────────────
  // The calendar getters are deliberately NOT read: Trilium's day/week/month/
  // year and inbox endpoints create the note when it doesn't exist yet.
  get_day_note: WRITE,
  get_week_note: WRITE,
  get_month_note: WRITE,
  get_year_note: WRITE,
  get_inbox_note: WRITE,
  create_note: APPEND,
  patch_note: DESTRUCTIVE,          // overwrites title, type or mime
  update_note_content: DESTRUCTIVE, // replaces the whole body
  clone_note: APPEND,
  move_note: WRITE,
  undelete_note: WRITE,
  add_label: WRITE,
  add_relation: WRITE,
  update_attribute: DESTRUCTIVE,    // overwrites a value
  create_attachment: APPEND,
  update_attachment: DESTRUCTIVE,   // replaces attachment content
  create_revision: APPEND,
  create_backup: APPEND,

  // ── Full mode: destructive ──────────────────────────────────────────────────
  delete_note: DESTRUCTIVE,
  delete_attribute: DESTRUCTIVE,
  delete_branch: DESTRUCTIVE,
  delete_attachment: DESTRUCTIVE,
};

/** Human-facing tool titles. Directory review and client permission prompts
 *  show these where they would otherwise show the bare identifier. */
export const TOOL_TITLES: Record<string, string> = {
  start: "Open the brain for this session",
  session: "Review the session before closing",
  remarks: "Get diary prompts",
  close: "Close the session and write its log",
  backup: "Back up the brain",
  health: "Check storage and runtime health",
  diary: "Write the daily diary",
  remember: "Remember something",
  recall: "Search the brain",
  domain: "Read everything about an area",
  read: "Read several notes",
  revise: "Edit a note",
  resolve: "Resolve a thread",
  split: "Split a note into two",
  withdraw: "Reopen a thread",
  label: "Set or remove a label",
  connect: "Link two notes",
  explore: "Explore a note's links",
  consistency: "Check the brain agrees with itself",
  outline: "Show a note's headings",
  inspect: "Inspect a note's raw form",
  claim: "Register or verify a claim",
  diff: "Show what changed",
  attach: "Attach a file to a note",
  detach: "Remove an attachment",
  addendum: "Find notes with pending addenda",
  maintain: "Run brain maintenance",
  forget: "Archive or delete a note",
  recover: "Restore an archived note",
  template: "Show a note kind's template",
  graph: "Render the relation graph",
  day: "Summarise the day",
  brain: "List the brain's inventory",
  assembly: "List what the brain holds",
  bootstrap: "Create or refresh the brain's structure",
  master: "Read a note about the user",
  master_recall: "Skim notes about the user",
  llm: "Read the model's operating notes",
  llm_recall: "Skim the model's operating notes",
  memory: "Read a thread or session",
  memory_recall: "Skim threads and sessions",
  knowledge: "Read a knowledge note",
  knowledge_recall: "Skim knowledge",
  insights: "Read a day's change log",
  insights_recall: "Skim insights",
  get_note: "Get note metadata (raw)",
  get_note_content: "Get note content (raw)",
  get_attachments: "List attachments (raw)",
  get_attachment_content: "Get attachment content (raw)",
  get_attribute: "Get an attribute (raw)",
  get_branch: "Get a branch (raw)",
  get_revisions: "List revisions (raw)",
  get_revision_content: "Get revision content (raw)",
  search_notes: "Search notes (raw query)",
  note_history: "List recent changes (raw)",
  get_app_info: "Get Trilium version (raw)",
  get_day_note: "Get or create a day note (raw)",
  get_week_note: "Get or create a week note (raw)",
  get_month_note: "Get or create a month note (raw)",
  get_year_note: "Get or create a year note (raw)",
  get_inbox_note: "Get or create the inbox note (raw)",
  create_note: "Create a note (raw)",
  patch_note: "Change note properties (raw)",
  update_note_content: "Replace note content (raw)",
  clone_note: "Clone a note (raw)",
  move_note: "Move a note (raw)",
  undelete_note: "Undelete a note (raw)",
  add_label: "Add a label (raw)",
  add_relation: "Add a relation (raw)",
  update_attribute: "Update an attribute (raw)",
  create_attachment: "Create an attachment (raw)",
  update_attachment: "Update an attachment (raw)",
  create_revision: "Snapshot a revision (raw)",
  create_backup: "Create a backup (raw)",
  delete_note: "Delete a note (raw)",
  delete_attribute: "Delete an attribute (raw)",
  delete_branch: "Delete a branch (raw)",
  delete_attachment: "Delete an attachment (raw)",
};

/** Apply the table to every registered tool./** Apply the table to every registered tool.
 *
 *  Done as one pass over the registry rather than an extra argument on every
 *  registration calls, so the read/write split is legible as a single table.
 *  Scattered across the call sites it could not be reviewed — and reviewing it
 *  is the point, since a wrong entry here is a safety bug rather than a typo. */
export function applyToolAnnotations(server: McpServer): { annotated: number; unclassified: string[] } {
  const registry = (server as unknown as {
    _registeredTools?: Record<string, { annotations?: Hints; title?: string }>;
  })._registeredTools;
  if (!registry) return { annotated: 0, unclassified: [] };

  let annotated = 0;
  const unclassified: string[] = [];
  for (const [name, tool] of Object.entries(registry)) {
    const hints = TOOL_ANNOTATIONS[name];
    if (!hints) {
      // Absent means unclassified, which means treated as a write. Surfaced so
      // a tool added later is noticed rather than silently mis-grouped.
      const fallback = TOOL_TITLES[name] ?? name;
      tool.annotations = { ...tool.annotations, ...APPEND, title: fallback };
      tool.title = fallback;
      unclassified.push(name);
      continue;
    }
    const title = TOOL_TITLES[name] ?? name;
    // Both places the spec allows: the tool's own title (preferred by current
    // clients) and annotations.title (read by older ones).
    tool.annotations = { ...tool.annotations, ...hints, title };
    tool.title = title;
    annotated++;
  }
  return { annotated, unclassified };
}
