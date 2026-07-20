// ─────────────────────────────────────────────────────────────────────────────
// BrainLLM — the router (V9)
//
// Single source of truth for WHERE a note lives, WHICH labels it carries and
// WHICH template it follows, derived from its kind. The model never chooses a
// parent — placement is policy, and policy lives here. Singleton kinds resolve
// to the one maintained note they own; collection kinds resolve to a container.
// ─────────────────────────────────────────────────────────────────────────────

import type { BrainLLMConfig } from "./config.js";
import type { TriliumClient } from "./trilium.js";
import {
  SingletonKinds,
  KIND_AREA,
  type AnyKind,
  type Status,
} from "./types.js";
import { slugify, titleCaseSlug } from "./normalize.js";
import { contentFor, domainContent } from "./templates.js";
import { localToday } from "./time.js";

// ── Options accepted by the write tools and threaded through routing ──────────

export interface RememberOpts {
  domain?: string;   // knowledge: information / sources / domain folder
  topics?: string[]; // free topics — slugged server-side
  status?: Status;   // override initial status (rarely needed)
  date?: string;     // ISO date override (default: today)
}

export interface LabelPlan {
  name: string;
  value: string;
  inheritable?: boolean;
}

// ── Singleton vs collection ───────────────────────────────────────────────────

/** True if the kind owns exactly one maintained note (writes upsert into it
 *  rather than creating a child). */
export function isSingleton(kind: AnyKind): boolean {
  return SingletonKinds.includes(kind);
}

// ── Static placement ──────────────────────────────────────────────────────────

/** Home for a kind: the singleton note itself, or the container that holds its
 *  children. Returns "" for information/sources — those resolve through a domain
 *  (see resolveParent). */
export function kindHome(cfg: BrainLLMConfig, kind: AnyKind): string {
  switch (kind) {
    case "biography":        return cfg.master.biography;
    case "goals":            return cfg.master.goals;
    case "preferences":      return cfg.master.preferences;
    case "responsibilities": return cfg.llm.responsibilities;
    case "protocols":        return cfg.llm.protocols;
    case "diary":            return cfg.llm.diary;
    case "session":          return cfg.memory.sessions;
    case "thread":           return cfg.memory.threads;
    case "threadEntry":      return ""; // never created via the generic path — see appendThreadEntry() in tools.ts
    case "user":             return cfg.knowledge.master;
    case "domain":           return cfg.knowledge.domains;
    case "information":      return ""; // domain-resolved
    case "sources":          return ""; // domain-resolved
    case "log":              return cfg.insights.logs;
  }
}

/** Scope to search when deduplicating or recalling a kind — its area root. */
export function dedupScope(cfg: BrainLLMConfig, kind: AnyKind): string {
  switch (KIND_AREA[kind]) {
    case "master":    return cfg.master.root;
    case "llm":       return cfg.llm.root;
    case "memory":    return cfg.memory.root;
    case "knowledge": return cfg.knowledge.root;
    case "insights":  return cfg.insights.root;
  }
}

// ── Label plan ────────────────────────────────────────────────────────────────

export function labelPlan(kind: AnyKind, opts: RememberOpts, date: string): LabelPlan[] {
  const labels: LabelPlan[] = [
    { name: "noteType", value: kind },
    { name: "created", value: opts.date ?? date },
  ];

  if (kind === "thread") {
    labels.push({ name: "status", value: opts.status ?? "active" });
    // Threads age off this label, not note.dateModified (content activity now
    // lands on threadEntry children, which don't bump the book's own
    // dateModified) — seed it at birth so a never-appended-to thread still
    // ages correctly instead of being permanently invisible to the sweep.
    labels.push({ name: "updated", value: opts.date ?? date });
  }
  if ((kind === "information" || kind === "domain" || kind === "sources") && opts.domain) {
    labels.push({ name: "domain", value: slugify(opts.domain) });
  }
  for (const topic of opts.topics ?? []) {
    const slug = slugify(topic);
    if (slug) labels.push({ name: "topic", value: slug });
  }

  // Dedupe by name+value (topics may repeat after slugging).
  const seen = new Set<string>();
  return labels.filter((l) => {
    const key = `${l.name}=${l.value}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// ── Domain resolution (async — domains auto-create on demand) ─────────────────

/** Find or create a domain book under Knowledge/Domains. Shared by information
 *  notes (children) and the per-domain Sources singleton (resolved by tools).
 *  A fresh domain is born complete: the book AND its canonical Sources note
 *  (legend + Last-updated + grouped ❇️/✅ list + Revision table) — the sources
 *  gate has a home from the first write. The slug is quoted in the search
 *  expression: Trilium's lexer treats "-" as an operator, so an unquoted
 *  hyphenated slug (wall-e) silently truncates to its first segment. */
export async function resolveDomain(
  trilium: TriliumClient,
  cfg: BrainLLMConfig,
  domainName: string
): Promise<{ domainId: string; domainTitle: string; createdDomain: boolean; sourcesId?: string }> {
  const slug = slugify(domainName) || "general";
  // Preserve the caller's casing for the display title ("BrainLLM", not
  // "Brainllm") — the slug stays canonical for routing and dedup. Fall back
  // to the title-cased slug when the raw name is unusable.
  const display = domainName.replace(/\s+/g, " ").trim() || titleCaseSlug(slug);

  const existing = await trilium.searchNotes(`#noteType=domain #domain='${slug}'`, {
    ancestorNoteId: cfg.knowledge.domains,
    fastSearch: true,
    limit: 1,
  });
  if (existing.results[0]) {
    return { domainId: existing.results[0].noteId, domainTitle: existing.results[0].title, createdDomain: false };
  }

  const created = await trilium.createNote(cfg.knowledge.domains, display, domainContent(display), "book");
  const did = created.note.noteId;
  await Promise.all([
    trilium.addLabel(did, "noteType", "domain"),
    trilium.addLabel(did, "domain", slug),
    trilium.addLabel(did, "iconClass", "bx bx-folder"),
  ]);

  // Canonical Sources note — created with the book, not lazily on first write.
  const d = localToday();
  const sources = await trilium.createNote(did, "Sources", contentFor("sources", { date: d, body: "", domain: display }));
  const sid = sources.note.noteId;
  for (const l of labelPlan("sources", { domain: domainName }, d)) {
    await trilium.addLabel(sid, l.name, l.value, l.inheritable ?? false);
  }
  await trilium.addLabel(sid, "iconClass", "bx bx-link");

  return { domainId: did, domainTitle: display, createdDomain: true, sourcesId: sid };
}

export interface ResolvedParent {
  parentId: string;
  /** Display title of the domain book, when domain-routed. */
  domainTitle?: string;
  /** True if the domain book was created by this call. */
  createdDomain?: boolean;
}

/** Parent for a kind. information notes resolve into their domain book; the
 *  per-domain Sources note is a singleton handled by the caller via resolveDomain. */
export async function resolveParent(
  trilium: TriliumClient,
  cfg: BrainLLMConfig,
  kind: AnyKind,
  opts: RememberOpts
): Promise<ResolvedParent> {
  if (kind === "information") {
    const { domainId, domainTitle, createdDomain } = await resolveDomain(trilium, cfg, opts.domain ?? "general");
    return { parentId: domainId, domainTitle, createdDomain };
  }
  if (kind === "sources") {
    throw new Error('"sources" is a per-domain singleton — resolve via resolveDomain, not resolveParent');
  }
  const parentId = kindHome(cfg, kind);
  if (!parentId) throw new Error(`BrainLLM config incomplete for kind "${kind}" — run bootstrap`);
  return { parentId };
}

/** Human-readable location for tool receipts, e.g. "Knowledge → Domains → Technology". */
export function locationLabel(kind: AnyKind, domainTitle?: string): string {
  switch (kind) {
    case "biography":        return "Master → Biography";
    case "goals":            return "Master → Goals";
    case "preferences":      return "Master → Preferences";
    case "responsibilities": return "LLM → Responsibilities";
    case "protocols":        return "LLM → Protocols";
    case "diary":            return "LLM → Diary";
    case "session":          return "Memory → Sessions";
    case "thread":           return "Memory → Threads";
    case "threadEntry":      return "Memory → Threads → <thread>";
    case "user":             return "Knowledge → Master";
    case "domain":           return "Knowledge → Domains";
    case "information":      return `Knowledge → Domains → ${domainTitle ?? "General"}`;
    case "sources":          return `Knowledge → Domains → ${domainTitle ?? "General"} → Sources`;
    case "log":              return "Insights → Logs";
  }
}
