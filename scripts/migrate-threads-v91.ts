/**
 * scripts/migrate-threads-v91.ts — V9.1 thread restructuring migration
 *
 * Converts every existing thread from a single flat note (Context/Goal +
 * stacked `Addendum — <date>` blocks + Resolution) into a book note (type
 * "book", holding only Context/Goal + Resolution) with one [yyyy-mm-dd]
 * threadEntry child per day of Addendum activity. Withdrawn/Recovered/
 * Reopened lifecycle markers stay on the book, near Resolution — rare
 * transitions, not routine content — matching how withdraw()/recover()
 * write going forward.
 *
 * Dry-run by default — prints the plan, writes nothing. Pass --apply to
 * actually write. Order per thread is deliberately safe: children are
 * created FIRST; the book's original content is only trimmed once every
 * child for that thread is confirmed written. A crash mid-run loses
 * nothing — a re-run skips children that already exist and finishes the
 * job. Already-migrated threads (type already "book") are skipped
 * entirely, so re-running is always safe.
 *
 * No content is ever silently dropped: an Addendum block whose heading
 * somehow carries no parseable date (never seen in practice — the heading
 * is always server-generated with an ISO date) is kept on the book rather
 * than discarded, and flagged in the report for a human look.
 *
 * Usage:
 *   bun run scripts/migrate-threads-v91.ts                        # dry run, all threads
 *   bun run scripts/migrate-threads-v91.ts --apply --only=<noteId> # write, one thread (pilot)
 *   bun run scripts/migrate-threads-v91.ts --apply                 # write, all threads
 *
 * Requires TRILIUM_BASE_URL and TRILIUM_ETAPI_TOKEN. Reads brainllm.json
 * from dist/ (next to the built bundle) or BRAIN_CONFIG_PATH.
 */

import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { TriliumClient, type Note } from "../src/trilium.js";
import { contentFor, RESOLUTION_ANCHOR } from "../src/templates.js";
import { closeDangling } from "../src/normalize.js";
import { DEFAULT_POLICY } from "../src/types.js";
import type { BrainLLMConfig } from "../src/config.js";

const baseUrl = process.env.TRILIUM_BASE_URL;
const token = process.env.TRILIUM_ETAPI_TOKEN;
if (!baseUrl || !token) {
  console.error("Missing TRILIUM_BASE_URL or TRILIUM_ETAPI_TOKEN");
  process.exit(1);
}

const here = dirname(fileURLToPath(import.meta.url));
const configPath = process.env.BRAIN_CONFIG_PATH ?? join(here, "..", "dist", "brainllm.json");

let cfg: BrainLLMConfig;
try {
  const parsed = JSON.parse(readFileSync(configPath, "utf-8"));
  cfg = { ...parsed, policy: { ...DEFAULT_POLICY, ...(parsed.policy ?? {}) } };
} catch (err) {
  console.error(`Could not read brain config at ${configPath}: ${err}`);
  process.exit(1);
}

const apply = process.argv.includes("--apply");
const onlyArg = process.argv.find((a) => a.startsWith("--only="));
const only = onlyArg ? onlyArg.slice("--only=".length) : null;

const trilium = new TriliumClient(baseUrl, token);

// ── Parsing ──────────────────────────────────────────────────────────────────

const MARKER_RE = /<h2(?:\s[^>]*)?>\s*((?:Addendum|Withdrawn|Recovered|Reopened)\s*(?:—|–|-)\s*([^<]*))<\/h2>/gi;

interface Block {
  kind: "addendum" | "lifecycle";
  date: string | null; // parsed YYYY-MM-DD from the marker text, when present
  html: string;         // the full block, marker heading included
}

function splitBlocks(rest: string): { head: string; blocks: Block[] } {
  const markers: Array<{ index: number; label: string; tail: string }> = [];
  MARKER_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = MARKER_RE.exec(rest)) !== null) {
    markers.push({ index: m.index, label: m[1], tail: m[2] });
  }
  const head = markers.length ? rest.slice(0, markers[0].index) : rest;
  const blocks: Block[] = markers.map((mk, i) => {
    const end = i + 1 < markers.length ? markers[i + 1].index : rest.length;
    const html = rest.slice(mk.index, end);
    const dateMatch = /\d{4}-\d{2}-\d{2}/.exec(mk.tail);
    const isAddendum = /^addendum/i.test(mk.label);
    return { kind: isAddendum ? "addendum" : "lifecycle", date: dateMatch?.[0] ?? null, html };
  });
  return { head, blocks };
}

// ── Per-thread migration ────────────────────────────────────────────────────

interface ThreadPlan {
  id: string;
  title: string;
  alreadyBook: boolean;
  dayGroups: Array<{ date: string; blockCount: number }>;
  lifecycleBlockCount: number;
  undatedAddendumCount: number;
  hasResolution: boolean;
}

interface ThreadParts {
  plan: ThreadPlan;
  head: string;
  resolution: string;
  addendaByDate: Map<string, string[]>;
  lifecycleHtml: string;
  undatedHtml: string;
}

async function planThread(note: Note): Promise<ThreadParts> {
  const content = closeDangling(await trilium.getNoteContent(note.noteId).catch(() => ""));
  const resIdx = content.indexOf(RESOLUTION_ANCHOR);
  const rest = resIdx >= 0 ? content.slice(0, resIdx) : content;
  const resolution = resIdx >= 0 ? content.slice(resIdx) : "";

  const { head, blocks } = splitBlocks(rest);

  const addendaByDate = new Map<string, string[]>();
  let lifecycleHtml = "";
  let undatedHtml = "";
  for (const b of blocks) {
    const html = closeDangling(b.html);
    if (b.kind === "addendum" && b.date) {
      if (!addendaByDate.has(b.date)) addendaByDate.set(b.date, []);
      addendaByDate.get(b.date)!.push(html);
    } else if (b.kind === "addendum") {
      // No parseable date — keep on the book rather than lose it.
      undatedHtml += (undatedHtml ? "\n" : "") + html;
    } else {
      lifecycleHtml += (lifecycleHtml ? "\n" : "") + html;
    }
  }

  const plan: ThreadPlan = {
    id: note.noteId,
    title: note.title,
    alreadyBook: note.type === "book",
    dayGroups: [...addendaByDate.entries()].map(([date, hs]) => ({ date, blockCount: hs.length })),
    lifecycleBlockCount: blocks.filter((b) => b.kind === "lifecycle").length,
    undatedAddendumCount: blocks.filter((b) => b.kind === "addendum" && !b.date).length,
    hasResolution: resIdx >= 0,
  };

  return { plan, head: closeDangling(head), resolution, addendaByDate, lifecycleHtml, undatedHtml };
}

async function migrateThread(note: Note): Promise<ThreadPlan> {
  const parts = await planThread(note);
  if (parts.plan.alreadyBook || !apply) return parts.plan;

  // 1 — children first. The book is untouched until every child for this
  //     thread is confirmed written, so a crash here loses nothing.
  for (const [date, htmls] of parts.addendaByDate) {
    const existing = await trilium
      .searchNotes(`#noteType=threadEntry #created='${date}'`, { ancestorNoteId: note.noteId, fastSearch: true, limit: 1 })
      .catch(() => ({ results: [] as Note[] }));
    if (existing.results[0]) continue; // already migrated on a prior run
    const created = await trilium.createNote(
      note.noteId,
      `[${date}]`,
      contentFor("threadEntry", { date, body: htmls.join("\n") })
    );
    await trilium.addLabel(created.note.noteId, "noteType", "threadEntry");
    await trilium.addLabel(created.note.noteId, "created", date);
  }

  // 2 — only now trim the book and flip its type.
  const newBody = [parts.head.trim(), parts.resolution, parts.lifecycleHtml, parts.undatedHtml]
    .filter(Boolean)
    .join("\n");
  await trilium.createRevision(note.noteId).catch(() => null);
  await trilium.updateNoteContent(note.noteId, newBody);
  await trilium.patchNote(note.noteId, { type: "book" });

  const refreshed = await trilium.getNote(note.noteId);
  const hasUpdated = refreshed.attributes.some((a) => a.type === "label" && a.name === "updated");
  if (!hasUpdated) {
    const latestDate = [...parts.addendaByDate.keys()].sort().at(-1);
    await trilium.updateLabelValue(note.noteId, "updated", latestDate ?? note.dateModified.slice(0, 10));
  }

  return parts.plan;
}

// ── Run ──────────────────────────────────────────────────────────────────────

const threads = await trilium
  .searchNotes("#noteType=thread", { ancestorNoteId: cfg.memory.threads, limit: 200, includeArchivedNotes: true })
  .then((r) => r.results)
  .catch(() => [] as Note[]);

const targets = only ? threads.filter((t) => t.noteId === only) : threads;

console.log(`V9.1 thread migration — apply=${apply} threads=${targets.length}${only ? ` (only=${only})` : ""}\n`);

let migrated = 0;
let skipped = 0;
let flagged = 0;
for (const t of targets) {
  const plan = await migrateThread(t);
  if (plan.alreadyBook) {
    skipped++;
    console.log(`  skip (already book): ${plan.title} [${plan.id}]`);
    continue;
  }
  migrated++;
  console.log(`  ${apply ? "migrated" : "would migrate"}: ${plan.title} [${plan.id}]`);
  console.log(
    `    days: ${plan.dayGroups.length}, lifecycle markers: ${plan.lifecycleBlockCount}, resolution found: ${plan.hasResolution}`
  );
  if (!plan.hasResolution) {
    flagged++;
    console.log(`    ⚠ no Resolution anchor found — check this note by hand`);
  }
  if (plan.undatedAddendumCount) {
    flagged++;
    console.log(`    ⚠ ${plan.undatedAddendumCount} Addendum block(s) with no parseable date — kept on the book, needs a human look`);
  }
}

console.log(`\n${migrated} thread(s) ${apply ? "migrated" : "would be migrated"}, ${skipped} already migrated, ${flagged} flagged for review.`);
if (!apply) console.log("Dry run — nothing was changed. Pass --apply to write.");
