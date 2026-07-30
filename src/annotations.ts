// ─────────────────────────────────────────────────────────────────────────────
// BrainLLM — tool annotations
//
// Clients group tools by their annotation hints. Without them every tool lands
// in one undifferentiated "Other tools" bucket, and the user's only choice is
// to allow all 71 or approve each call — which is the same failure mode as a
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
  remarks: READ,          // cue-only; the docstring promises it writes nothing
  day: READ,
  brain: READ,
  recall: READ,
  domain: READ,
  outline: READ,
  inspect: READ,
  template: READ,
  explore: READ,
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
  addendum: READ,         // searches and reports; the merging is done by revise
  remember: WRITE,
  diary: APPEND,
  revise: WRITE,
  close: APPEND,
  connect: WRITE,
  label: WRITE,
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
  patch_note: WRITE,
  update_note_content: WRITE,
  clone_note: APPEND,
  move_note: WRITE,
  undelete_note: WRITE,
  add_label: WRITE,
  add_relation: WRITE,
  update_attribute: WRITE,
  create_attachment: APPEND,
  update_attachment: WRITE,
  create_revision: APPEND,
  create_backup: APPEND,

  // ── Full mode: destructive ──────────────────────────────────────────────────
  delete_note: DESTRUCTIVE,
  delete_attribute: DESTRUCTIVE,
  delete_branch: DESTRUCTIVE,
  delete_attachment: DESTRUCTIVE,
};

/** Apply the table to every registered tool.
 *
 *  Done as one pass over the registry rather than an extra argument on 71
 *  registration calls, so the read/write split is legible as a single table.
 *  Scattered across the call sites it could not be reviewed — and reviewing it
 *  is the point, since a wrong entry here is a safety bug rather than a typo. */
export function applyToolAnnotations(server: McpServer): { annotated: number; unclassified: string[] } {
  const registry = (server as unknown as {
    _registeredTools?: Record<string, { annotations?: Hints }>;
  })._registeredTools;
  if (!registry) return { annotated: 0, unclassified: [] };

  let annotated = 0;
  const unclassified: string[] = [];
  for (const [name, tool] of Object.entries(registry)) {
    const hints = TOOL_ANNOTATIONS[name];
    if (!hints) {
      // Absent means unclassified, which means treated as a write. Surfaced so
      // a tool added later is noticed rather than silently mis-grouped.
      tool.annotations = { ...tool.annotations, ...APPEND, title: name };
      unclassified.push(name);
      continue;
    }
    tool.annotations = { ...tool.annotations, ...hints, title: name };
    annotated++;
  }
  return { annotated, unclassified };
}
