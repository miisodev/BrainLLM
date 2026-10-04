/**
 * diffing.ts — block-level diffs of stored note bodies, and revision selection
 * for "everything changed since" reviews. Pure: no I/O.
 */

/** The revision fields the selection reads. Trilium stamps dateCreated with the
 *  local-now header BrainLLM sends, so it orders like a local datetime string. */
export interface RevisionStamp {
  revisionId: string;
  dateCreated: string;
}

/** Revisions taken at or after a "YYYY-MM-DD HH:mm" cutoff. A revision is taken
 *  before every content write, so each one marks a write made since the cutoff. */
export function revisionsSince<R extends RevisionStamp>(revisions: R[], cutoff: string): R[] {
  return revisions.filter((r) => (r.dateCreated ?? "").slice(0, 16) >= cutoff);
}

/** The earliest revision at or after the cutoff: the note as it stood before
 *  the first write since then. Null when nothing was written since. */
export function firstRevisionSince<R extends RevisionStamp>(revisions: R[], cutoff: string): R | null {
  const since = revisionsSince(revisions, cutoff);
  if (!since.length) return null;
  return since.reduce((a, b) => ((a.dateCreated ?? "") <= (b.dateCreated ?? "") ? a : b));
}

export interface BlockDiff {
  identical: boolean;
  sizeBefore: number;
  sizeAfter: number;
  contextBefore?: string[];
  removed?: string[];
  added?: string[];
  contextAfter?: string[];
  /** Table edits, cell by cell — present when any table row changed. */
  tables?: TableDiff;
  summary: string;
}

export interface TableDiff {
  changedCells: Array<{ row: string; column: number; before: string; after: string }>;
  rowsAdded: string[];
  rowsRemoved: string[];
}

/** Diff two stored bodies by block. They are one long line of HTML, so
 *  splitting on element boundaries is what makes a diff readable at all.
 *  Common prefix and suffix, then the middle: adequate and honest for the edit
 *  shapes this exists to verify, and it never claims a similarity it did not
 *  check. `cap` bounds each reported list. */
export function blockDiff(before: string, after: string, pad = 1, cap = 40): BlockDiff {
  if (before === after)
    return { identical: true, sizeBefore: before.length, sizeAfter: after.length, summary: "Identical: the writes left the body byte-for-byte as it was." };
  const lines = (s: string) => s.replace(/></g, ">\n<").split("\n");
  const a = lines(before);
  const b = lines(after);
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
  const midA = a.slice(head, a.length - tail);
  const midB = b.slice(head, b.length - tail);
  // Several separate edits leave unchanged blocks between them. A longest
  // common subsequence over the middle reports only the changed blocks, so two
  // one-cell edits at either end of a note read as two cells, not the whole
  // table between them. Bounded: past the cell budget the middle is reported
  // whole, which is still true, only coarser.
  const lcs = changedLines(midA, midB);
  // A bare closing tag on its own line is a split artefact, not content.
  const meaningful = (arr: string[]) => arr.filter((l) => !/^<\/[a-zA-Z0-9]+>$/.test(l.trim()));
  const removed = meaningful(lcs ? lcs.removed : midA);
  const added = meaningful(lcs ? lcs.added : midB);
  const tables = tableDiff(before, after);
  const bound = (arr: string[]) => (arr.length > cap ? [...arr.slice(0, cap), `… ${arr.length - cap} more line(s)`] : arr);
  const delta = after.length - before.length;
  return {
    identical: false,
    sizeBefore: before.length,
    sizeAfter: after.length,
    contextBefore: bound(a.slice(Math.max(0, head - pad), head)),
    removed: bound(removed),
    added: bound(added),
    contextAfter: bound(a.slice(a.length - tail, a.length - tail + pad)),
    ...(tables ? { tables } : {}),
    summary: `${lcs ? `${lcs.hunks} change(s): ` : ""}${removed.length} block(s) removed, ${added.length} added, ${delta >= 0 ? "+" : ""}${delta} characters.`,
  };
}

/** Lines only in `a` (removed) and only in `b` (added), by longest common
 *  subsequence, with the number of separate change runs. Null when the
 *  table would exceed the cell budget. */
export function changedLines(a: string[], b: string[], budget = 4_000_000): { removed: string[]; added: string[]; hunks: number } | null {
  const n = a.length;
  const m = b.length;
  if ((n + 1) * (m + 1) > budget) return null;
  const w = m + 1;
  const t = new Uint32Array((n + 1) * w);
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      t[i * w + j] = a[i] === b[j] ? t[(i + 1) * w + j + 1]! + 1 : Math.max(t[(i + 1) * w + j]!, t[i * w + j + 1]!);
  const removed: string[] = [];
  const added: string[] = [];
  let hunks = 0;
  let inHunk = false;
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && a[i] === b[j]) {
      inHunk = false;
      i++;
      j++;
      continue;
    }
    if (!inHunk) {
      hunks++;
      inHunk = true;
    }
    if (j >= m || (i < n && t[(i + 1) * w + j]! >= t[i * w + j + 1]!)) removed.push(a[i++]!);
    else added.push(b[j++]!);
  }
  return { removed, added, hunks };
}

/** Rows of every table in a body, each as its cells' plain text. */
function tableRows(html: string): string[][] {
  const rows: string[][] = [];
  for (const tr of html.matchAll(/<tr(?=[\s>])[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const cells = [...tr[1]!.matchAll(/<t[dh](?=[\s>])[^>]*>([\s\S]*?)<\/t[dh]>/gi)].map((c) =>
      c[1]!.replace(/<[^>]+>/g, "").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim()
    );
    rows.push(cells);
  }
  return rows;
}

/** Table changes as cells rather than markup lines. Rows present on only one
 *  side are paired by their first cell (the anchor a reader names a row by);
 *  a pair reports the cells that differ, and anything unpaired is a whole row
 *  added or removed. Null when no table row changed. */
export function tableDiff(before: string, after: string, cap = 30): TableDiff | null {
  const key = (r: string[]) => r.join("\u0000");
  const a = tableRows(before);
  const b = tableRows(after);
  const inB = new Map<string, number>();
  for (const r of b) inB.set(key(r), (inB.get(key(r)) ?? 0) + 1);
  const inA = new Map<string, number>();
  for (const r of a) inA.set(key(r), (inA.get(key(r)) ?? 0) + 1);
  const onlyIn = (rows: string[][], other: Map<string, number>) => {
    const left = new Map(other);
    return rows.filter((r) => {
      const n = left.get(key(r)) ?? 0;
      if (n > 0) { left.set(key(r), n - 1); return false; }
      return true;
    });
  };
  const gone = onlyIn(a, inB);
  const fresh = onlyIn(b, inA);
  if (!gone.length && !fresh.length) return null;
  const changedCells: TableDiff["changedCells"] = [];
  const rowsRemoved: string[] = [];
  const unpaired = [...fresh];
  for (const r of gone) {
    const i = unpaired.findIndex((x) => x[0] === r[0] && x.length === r.length);
    if (i < 0) { rowsRemoved.push(r.join(" | ")); continue; }
    const [pair] = unpaired.splice(i, 1);
    r.forEach((cell, col) => {
      if (cell !== pair![col]) changedCells.push({ row: r[0]!.slice(0, 80), column: col + 1, before: cell, after: pair![col]! });
    });
  }
  const clip = <T,>(arr: T[]) => arr.slice(0, cap);
  return { changedCells: clip(changedCells), rowsAdded: clip(unpaired.map((r) => r.join(" | "))), rowsRemoved: clip(rowsRemoved) };
}
