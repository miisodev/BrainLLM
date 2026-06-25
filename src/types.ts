// ─────────────────────────────────────────────────────────────────────────────
// BrainLLM — shared domain types (V6)
//
// The enums in this file are the single canonical vocabulary. Tool schemas, the
// router, the structure builder, and placement all derive from these constants —
// there is no second copy anywhere.
//
// V5 is a clean break: a fresh instance, no v3/v4 migration layer. The note
// vocabulary is organised by the five first-level areas of the brain tree.
// ─────────────────────────────────────────────────────────────────────────────

export type NoteType =
  | "text" | "code" | "book" | "canvas"
  | "mermaid" | "relationMap" | "render"
  | "search" | "file" | "image" | "launcher";

// ── Areas ─────────────────────────────────────────────────────────────────────
// The five content areas of the brain. (Templates is structural, not content.)

export const Areas = ["master", "llm", "memory", "knowledge", "insights"] as const;
export type Area = (typeof Areas)[number];

// ── Kinds ─────────────────────────────────────────────────────────────────────
// Every content note carries exactly one kind in #noteType. Grouped by area.

export const Kinds = [
  // Master — the user (each a single maintained note)
  "biography",
  "goals",
  "preferences",
  // LLM — the assistant's self-model
  "responsibilities", // single maintained note
  "protocols",        // single maintained note
  "diary",            // dated entry under LLM/diary
  // Memory — operational record
  "session",          // dated entry under Memory/sessions
  "thread",           // titled entry under Memory/threads
  // Knowledge — learned information beyond/contradicting training
  "knowledge",        // user-knowledge note under Knowledge/Master
  "domain",           // a domain book under Knowledge/Domains
  "information",      // an information note inside a domain
  "sources",          // the per-domain sources note
  // Insights — the brain's record of itself
  "log",              // dated, auto-generated change log under Insights/logs
] as const;

export type Kind = (typeof Kinds)[number];

// Unified vocabulary — kept as an alias so existing signatures stay valid.
export type AnyKind = Kind;

// Which area each kind belongs to — drives placement and the namespaced tools.
export const KIND_AREA: Record<Kind, Area> = {
  biography: "master", goals: "master", preferences: "master",
  responsibilities: "llm", protocols: "llm", diary: "llm",
  session: "memory", thread: "memory",
  knowledge: "knowledge", domain: "knowledge", information: "knowledge", sources: "knowledge",
  log: "insights",
};

// Singletons — exactly one maintained note exists; writes upsert into it instead
// of creating a child. (The per-domain `sources` note is a singleton *within*
// each domain and is handled specially by the router.)
export const SingletonKinds: readonly Kind[] = [
  "biography", "goals", "preferences", "responsibilities", "protocols",
];

// Dated entries — titled by the day they belong to (one per day).
export const DatedKinds: readonly Kind[] = ["diary", "session", "log"];

// ── Status ────────────────────────────────────────────────────────────────────
// Lifecycle state. The V5 aging/maintenance model is authored in the templates
// and interconnection phases; the vocabulary is fixed here.

export const Statuses = ["active", "resolved", "superseded", "dormant"] as const;
export type Status = (typeof Statuses)[number];

// ── Relations ─────────────────────────────────────────────────────────────────
// Closed vocabulary — connect() rejects anything else. The interconnection phase
// revisits this; left intact for now.

export const RelationTypes = [
  "relatesTo",   // generic association — last resort
  "extends",     // builds upon / elaborates
  "contradicts", // conflicts with
  "supports",    // provides evidence or justification for
  "causes",      // produces / leads to
  "references",  // cites as source
  "partOf",      // semantically belongs to
  "worksWith",   // collaboration — symmetric, auto-bidirectional
  "mentors",     // teaches / shapes
  "instanceOf",  // concrete example of
  "supersedes",  // replaces entirely
  "implements",  // concrete realisation of
  "inspiredBy",  // conceptually influenced by
  "sourceOf",    // origin / provenance of
  "derivedFrom", // synthesised from
] as const;

export type RelationType = (typeof RelationTypes)[number];
export const SymmetricRelations: readonly RelationType[] = ["worksWith"];

// ── Lifecycle policy ───────────────────────────────────────────────────────────

export interface LifecyclePolicy {
  /** Active dated note untouched this many days → dormant (review queue). */
  dormantAfterDays: number;
  /** Dormant this many further days → archived in place. */
  archiveDormantAfterDays: number;
  /** Core-invaluability rule: content untouched this many days is surfaced for review. */
  staleAfterDays: number;
}

export const DEFAULT_POLICY: LifecyclePolicy = {
  dormantAfterDays: 21,
  archiveDormantAfterDays: 45,
  staleAfterDays: 7,
};

// ── Compact output shapes reused across tools ────────────────────────────────

export interface NoteStub {
  id: string;
  title: string;
  type?: string;
}

export interface AttrStub {
  id: string;
  noteId: string;
  type: string;
  name: string;
  value: string;
}

export interface BranchStub {
  id: string;
  noteId: string;
  parentNoteId: string;
}

export interface RevisionStub {
  id: string;
  noteId: string;
  title: string;
  date: string;
  size: number;
}

export interface AttachmentStub {
  id: string;
  title: string;
  mime: string;
  size: number;
}

export interface BacklinkEntry {
  noteId: string;
  title: string;
  relationName: string;
}

export interface GraphNode {
  noteId: string;
  title: string;
  depth: number;
  via?: string;        // relation name that led here
  fromNoteId?: string; // which node expanded to reach this
}
