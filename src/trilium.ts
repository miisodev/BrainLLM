// ─────────────────────────────────────────────────────────────────────────────
// BrainLLM — ETAPI client
// ─────────────────────────────────────────────────────────────────────────────

// ── Types ─────────────────────────────────────────────────────────────────────

export interface Attribute {
  attributeId: string;
  noteId: string;
  type: "label" | "relation";
  name: string;
  value: string;
  position: number;
  isInheritable: boolean;
  utcDateModified?: string;
}

export interface Branch {
  branchId: string;
  noteId: string;
  parentNoteId: string;
  prefix: string | null;
  notePosition: number;
  isExpanded: boolean;
  utcDateModified: string;
}

export interface Note {
  noteId: string;
  title: string;
  type: string;
  mime: string;
  isProtected: boolean;
  blobId?: string;
  attributes: Attribute[];
  parentNoteIds: string[];
  childNoteIds: string[];
  parentBranchIds: string[];
  childBranchIds: string[];
  dateCreated: string;
  dateModified: string;
  utcDateCreated: string;
  utcDateModified: string;
}

export interface Revision {
  revisionId: string;
  noteId: string;
  type: string;
  mime: string;
  isProtected: boolean;
  title: string;
  blobId: string;
  dateLastEdited: string;
  dateCreated: string;
  utcDateLastEdited: string;
  utcDateCreated: string;
  utcDateModified: string;
  contentLength: number;
}

export interface Attachment {
  attachmentId: string;
  ownerId: string;
  contentUploaded?: boolean;
  role: string;
  mime: string;
  title: string;
  position: number;
  blobId: string;
  dateModified: string;
  utcDateModified: string;
  utcDateScheduledForErasureSince?: string;
  contentLength: number;
}

export interface RecentChange {
  noteId: string;
  title: string;
  utcDate: string;
  date: string;
  current_title: string;
  current_isDeleted: boolean;
  current_isProtected: boolean;
  canBeUndeleted?: boolean;
}

export interface SearchResult {
  results: Note[];
  debugInfo?: unknown;
}

export interface CreateNoteResponse {
  note: Note;
  branch: Branch;
  contentUploaded?: boolean;
}

export type ContentEncoding = "auto" | "text" | "base64";

export interface BinaryContent {
  encoding: "base64";
  mime: string;
  content: string;
}

export type ContentResult = string | BinaryContent;

/** Authenticated ETAPI content reads are bounded so a large note cannot turn
 * a client into an unbounded allocation. The same ceiling matches the HTTP
 * server's request-body budget and is explicit rather than an SDK default. */
export const MAX_ETAPI_CONTENT_BYTES = 50 * 1024 * 1024;

export class ContentMetadataUpdateError extends Error {
  readonly noteId: string;
  readonly contentUploaded = true;
  constructor(noteId: string, cause: unknown) {
    super(`Note ${noteId} content was updated but its MIME metadata could not be patched: ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = "ContentMetadataUpdateError";
    this.noteId = noteId;
  }
}

export class PartialContentUploadError extends Error {
  readonly entityId: string;
  readonly entityType: "note" | "attachment";
  readonly contentUploaded = false;
  constructor(entityType: "note" | "attachment", entityId: string, cause: unknown) {
    super(`${entityType} ${entityId} was created but its binary content upload failed: ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = "PartialContentUploadError";
    this.entityType = entityType;
    this.entityId = entityId;
  }
}

export class BinaryContentError extends Error {
  readonly content: BinaryContent;
  constructor(content: BinaryContent) {
    super(`Content is binary (${content.mime}); use the raw content result or provide encoding="base64" when writing.`);
    this.name = "BinaryContentError";
    this.content = content;
  }
}

export function isTextMime(mime: string | undefined): boolean {
  const value = (mime ?? "text/plain").split(";", 1)[0].trim().toLowerCase();
  return value.startsWith("text/") || new Set([
    "application/json", "application/ld+json", "application/xml", "application/javascript",
    "application/x-javascript", "application/sql", "image/svg+xml",
  ]).has(value);
}

export function decodeBase64Strict(value: string): Uint8Array {
  if (value.startsWith("data:") || !/^[A-Za-z0-9+/]*={0,2}$/.test(value) || value.length % 4 === 1) {
    throw new Error("content is not standard RFC 4648 base64");
  }
  const padded = value.padEnd(Math.ceil(value.length / 4) * 4, "=");
  const bytes = Buffer.from(padded, "base64");
  if (Buffer.from(bytes).toString("base64") !== padded) throw new Error("content is not canonical base64");
  return new Uint8Array(bytes);
}

export interface EncodedContent {
  bytes: Uint8Array;
  contentType: string;
  binary: boolean;
}

export function encodeContent(content: string, mime: string, encoding: ContentEncoding = "auto"): EncodedContent {
  const binary = encoding === "base64" || (encoding === "auto" && !isTextMime(mime));
  if (binary) {
    return { bytes: decodeBase64Strict(content), contentType: "application/octet-stream", binary: true };
  }
  return { bytes: new TextEncoder().encode(content), contentType: "text/plain; charset=utf-8", binary: false };
}

async function readBoundedResponseBytes(response: Response, maxBytes = MAX_ETAPI_CONTENT_BYTES): Promise<Uint8Array> {
  const declared = Number(response.headers.get("content-length") ?? 0);
  if (Number.isFinite(declared) && declared > maxBytes) throw new Error("Trilium content exceeds the 50 MiB client limit");
  if (!response.body) return new Uint8Array(0);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      total += part.value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        throw new Error("Trilium content exceeds the 50 MiB client limit");
      }
      chunks.push(part.value);
    }
  } finally {
    reader.releaseLock();
  }
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.byteLength; }
  return result;
}

async function readContentResponse(
  response: Response,
  fallbackMime = "application/octet-stream",
  noteType?: string
): Promise<ContentResult> {
  if (!response.ok) throw new Error(`Trilium API error ${response.status}: ${await response.text()}`);
  const responseMime = response.headers.get("content-type")?.split(";", 1)[0]?.trim();
  const mime = responseMime || fallbackMime;
  const bytes = await readBoundedResponseBytes(response);
  if (noteType === "text" || isTextMime(mime)) {
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      // A mislabeled text response still gets an envelope rather than replacement
      // characters; the caller can decide whether to repair its metadata.
    }
  }
  return { encoding: "base64", mime, content: Buffer.from(bytes).toString("base64") };
}

export interface AppInfo {
  appVersion: string;
  dbVersion: number;
  nodeVersion?: string;
  syncVersion: number;
  buildDate: string;
  buildRevision: string;
  dataDirectory?: string;
  clipperProtocolVersion?: string;
  utcDateTime?: string;
}

export interface SearchOpts {
  ancestorNoteId?: string;
  ancestorDepth?: string;
  limit?: number;
  orderBy?: string;
  orderDirection?: "asc" | "desc";
  fastSearch?: boolean;
  includeArchivedNotes?: boolean;
  debug?: boolean;
}

// ── Attribute helpers (pure) ─────────────────────────────────────────────────

export function isOwnedAttribute(note: Note, attribute: Attribute): boolean {
  return attribute.noteId === note.noteId;
}

/** Value of a label from ONLY the note's own (non-inherited) attributes.
 *  The ETAPI /notes/{id} response includes inherited attributes (where
 *  attribute.noteId ≠ note.noteId, inherited via parent hierarchy or ~template).
 *  Use this when note-kind logic must not be fooled by a blueprint note's
 *  inheritable labels propagating down to content notes. */
export function ownedLabel(note: Note, name: string): string | undefined {
  return note.attributes.find(
    (a) => a.type === "label" && a.name === name && isOwnedAttribute(note, a)
  )?.value;
}

export interface RelationEdge {
  relation: string;
  toNoteId: string;
}

/** Compact outbound-relation snippet for a note — zero extra fetches, since
 *  `note.attributes` is already populated on every Note returned by search or
 *  get. Excludes Trilium's internal ~template relation and caps to `max` so a
 *  heavily-connected note doesn't bloat a tool return. Returns undefined (not
 *  an empty array) when there's nothing to show, so callers can spread it in
 *  conditionally. */
export function relationSnippet(note: Note, max = 8): RelationEdge[] | undefined {
  const rels = note.attributes
    .filter((a) => isOwnedAttribute(note, a) && a.type === "relation" && a.name !== "template")
    .slice(0, max)
    .map((a) => ({ relation: a.name, toNoteId: a.value }));
  return rels.length ? rels : undefined;
}

// ── Client ────────────────────────────────────────────────────────────────────

import { RelationTypes } from "./types.js";
import { checkedDate, localNowDateTime } from "./time.js";

// ── Backlink query helpers (pure) ───────────────────────────────────────────
// Trilium's search DSL has no generic "any relation → X" predicate, and
// `note.ownedAttributes.value` is NOT a valid search property — it returns HTTP
// 400, which was the cause of the old silently-empty backlinks. Instead we OR
// one `~name.noteId` clause per relation name. `~rel.prop` compiles to
// RelationWhereExp, which matches ALL relations of that name, so multi-valued
// relations (e.g. several `references`) are handled correctly.

const SAFE_RELATION_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const quoteSearchValue = (value: string): string => JSON.stringify(value);

export function buildBacklinkQuery(targetNoteId: string, relationNames: string[]): string {
  const unique = [...new Set(relationNames)];
  const unsafe = unique.find((name) => !SAFE_RELATION_NAME.test(name));
  if (unsafe) throw new Error(`relation name "${unsafe}" cannot be safely queried in Trilium's search DSL`);
  return unique.map((name) => `~${name}.noteId = ${quoteSearchValue(targetNoteId)}`).join(" OR ");
}

// Canonical relation vocabulary ∪ discovered relation names, minus Trilium's
// internal ~template relation.
export function backlinkRelationNames(discovered: string[]): string[] {
  return [...new Set<string>([...RelationTypes, ...discovered])].filter((name) => name !== "template");
}

// ETAPI entity IDs are opaque to this client, but they are not URL fragments.
// Validate before interpolation and encode again at the boundary so a malformed
// tool argument cannot turn into a different ETAPI route.
const ENTITY_ID_RE = /^[A-Za-z0-9_]{4,128}$/;
const CALENDAR_SEGMENT_RE = /^[A-Za-z0-9_-]{1,64}$/;
const BACKUP_NAME_RE = /^[A-Za-z0-9_-]{1,64}$/;

export function normalizeTriliumBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "").replace(/\/etapi$/, "");
}

function assertEntityId(value: string, label: string): string {
  if (!ENTITY_ID_RE.test(value)) throw new Error(`${label} is not a valid ETAPI entity id`);
  return value;
}

function pathSegment(value: string, label: string): string {
  return encodeURIComponent(assertEntityId(value, label));
}

function calendarSegment(value: string, label: string): string {
  if (!CALENDAR_SEGMENT_RE.test(value)) throw new Error(`${label} is not a valid calendar value`);
  return encodeURIComponent(value);
}

function backupSegment(value: string): string {
  if (!BACKUP_NAME_RE.test(value)) throw new Error("backup name must contain only letters, numbers, underscores, or hyphens (max 64 characters)");
  return encodeURIComponent(value);
}

// Trilium entity IDs are 12-char alphanumeric. We generate the attributeId
// client-side so attribute creation succeeds even on forks/versions that mark
// it mandatory on POST /attributes (ETAPI requires /^[A-Za-z0-9_]{4,128}$/).
function newEntityId(): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  let id = "";
  for (let i = 0; i < 12; i++) id += alphabet[bytes[i] % alphabet.length];
  return id;
}

// Every ETAPI call is bounded: a hung Trilium must fail a tool call, not hang
// the MCP session (stdio and HTTP alike). Idempotent reads (GET) additionally
// retry once on network errors and transient upstream statuses.
const REQUEST_TIMEOUT_MS = 30_000;
const RETRYABLE_STATUSES = new Set([502, 503, 504]);

export class TriliumClient {
  private baseUrl: string;
  private token: string;

  constructor(baseUrl: string, token: string) {
    this.baseUrl = normalizeTriliumBaseUrl(baseUrl);
    this.token = token;
  }

  // ── Core request helpers ───────────────────────────────────────────────────

  /** Bounded fetch with a single retry for idempotent reads. Writes (POST/PUT/
   *  PATCH/DELETE) never retry — Trilium doesn't dedupe them, so the tool
   *  layer's own idempotency guards are the retry story there. */
  private async boundedFetch(url: string, options: RequestInit = {}): Promise<Response> {
    const method = (options.method ?? "GET").toUpperCase();
    const retryable = method === "GET";
    for (let attempt = 0; ; attempt++) {
      try {
        const res = await fetch(url, { ...options, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
        if (retryable && attempt < 1 && RETRYABLE_STATUSES.has(res.status)) {
          await new Promise((r) => setTimeout(r, 250));
          continue;
        }
        return res;
      } catch (e) {
        if (retryable && attempt < 1) {
          await new Promise((r) => setTimeout(r, 250));
          continue;
        }
        throw e;
      }
    }
  }

  private async request<T>(path: string, options: RequestInit = {}): Promise<T> {
    const url = `${this.baseUrl}/etapi${path}`;
    const res = await this.boundedFetch(url, {
      ...options,
      headers: {
        Authorization: `Bearer ${this.token}`,
        "Content-Type": "application/json",
        "trilium-local-now-datetime": localNowDateTime(),
        ...options.headers,
      },
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Trilium API error ${res.status}: ${body}`);
    }

    if (res.status === 204) return undefined as T;
    return res.json() as Promise<T>;
  }

  // ── App info ───────────────────────────────────────────────────────────────

  async getAppInfo(): Promise<AppInfo> {
    return this.request<AppInfo>("/app-info");
  }

  // ── Notes ──────────────────────────────────────────────────────────────────

  async searchNotes(query: string, opts: SearchOpts = {}): Promise<SearchResult> {
    const params = new URLSearchParams({ search: query });
    if (opts.ancestorNoteId)       params.set("ancestorNoteId", opts.ancestorNoteId);
    if (opts.ancestorDepth)        params.set("ancestorDepth", opts.ancestorDepth);
    if (opts.limit != null)        params.set("limit", String(opts.limit));
    if (opts.orderBy)              params.set("orderBy", opts.orderBy);
    if (opts.orderDirection)       params.set("orderDirection", opts.orderDirection);
    if (opts.fastSearch)           params.set("fastSearch", "true");
    if (opts.includeArchivedNotes) params.set("includeArchivedNotes", "true");
    if (opts.debug)                params.set("debug", "true");
    return this.request<SearchResult>(`/notes?${params}`);
  }

  async getNote(noteId: string): Promise<Note> {
    return this.request<Note>(`/notes/${pathSegment(noteId, "noteId")}`);
  }

  /** Mint an ETAPI token from the Trilium password (`POST /auth/login`).
   *  Static because it is the one call made BEFORE a client exists — setup used
   *  to require opening the Trilium UI, finding Options → ETAPI, creating a
   *  token by hand and pasting it into an env var, which is the highest-friction
   *  step in the whole install. Returns the token for the caller to persist. */
  static async login(baseUrl: string, password: string): Promise<string> {
    const root = normalizeTriliumBaseUrl(baseUrl);
    const url = `${root}/etapi/auth/login`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new Error(`ETAPI login failed (${res.status}): ${detail.slice(0, 200) || res.statusText}`);
    }
    const body = (await res.json()) as { authToken?: string };
    if (!body.authToken) throw new Error("ETAPI login returned no authToken.");
    return body.authToken;
  }

  async createNote(
    parentNoteId: string,
    title: string,
    content: string,
    type: string = "text",
    mime?: string,
    noteId?: string,
    encoding: ContentEncoding = "auto"
  ): Promise<CreateNoteResponse> {
    assertEntityId(parentNoteId, "parentNoteId");
    if (noteId) assertEntityId(noteId, "noteId");
    const targetMime = mime ?? ((type === "image" || type === "file") ? "application/octet-stream" : "text/html");
    const encoded = encodeContent(content, targetMime, encoding);
    const body: Record<string, unknown> = { parentNoteId, title, content: encoded.binary ? "" : content, type, mime: targetMime };
    if (noteId) body.noteId = noteId;
    const created = await this.request<CreateNoteResponse>("/create-note", {
      method: "POST",
      body: JSON.stringify(body),
    });
    if (!encoded.binary) return created;
    try {
      await this.updateNoteContent(created.note.noteId, content, targetMime, "base64", false);
      return { ...created, contentUploaded: true };
    } catch (error) {
      throw new PartialContentUploadError("note", created.note.noteId, error);
    }
  }

  async patchNote(noteId: string, fields: { title?: string; type?: string; mime?: string }): Promise<Note> {
    return this.request<Note>(`/notes/${pathSegment(noteId, "noteId")}`, {
      method: "PATCH",
      body: JSON.stringify(fields),
    });
  }

  async deleteNote(noteId: string): Promise<void> {
    return this.request<void>(`/notes/${pathSegment(noteId, "noteId")}`, { method: "DELETE" });
  }

  async undeleteNote(noteId: string): Promise<void> {
    return this.request<void>(`/notes/${pathSegment(noteId, "noteId")}/undelete`, { method: "POST" });
  }

  // ── Note content ───────────────────────────────────────────────────────────

  async getNoteContentResult(noteId: string, noteType?: string): Promise<ContentResult> {
    const url = `${this.baseUrl}/etapi/notes/${pathSegment(noteId, "noteId")}/content`;
    const res = await this.boundedFetch(url, { headers: { Authorization: `Bearer ${this.token}` } });
    return readContentResponse(res, "text/html", noteType);
  }

  async getNoteContent(noteId: string, noteType?: string): Promise<string> {
    const result = await this.getNoteContentResult(noteId, noteType);
    if (typeof result !== "string") throw new BinaryContentError(result);
    return result;
  }

  async updateNoteContent(noteId: string, content: string, mime?: string, encoding: ContentEncoding = "auto", persistMime = true): Promise<void> {
    const current = mime ? undefined : await this.getNote(noteId);
    const targetMime = mime ?? current!.mime;
    const url = `${this.baseUrl}/etapi/notes/${pathSegment(noteId, "noteId")}/content`;
    const encoded = encodeContent(content, targetMime, encoding);
    const res = await this.boundedFetch(url, {
      method: "PUT",
      headers: { Authorization: `Bearer ${this.token}`, "Content-Type": encoded.contentType, "trilium-local-now-datetime": localNowDateTime() },
      body: encoded.bytes,
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Trilium API error ${res.status}: ${body}`);
    }
    if (mime && persistMime) {
      try {
        await this.patchNote(noteId, { mime });
      } catch (error) {
        throw new ContentMetadataUpdateError(noteId, error);
      }
    }
  }

  // ── Revisions ──────────────────────────────────────────────────────────────

  async getNoteRevisions(noteId: string): Promise<Revision[]> {
    return this.request<Revision[]>(`/notes/${pathSegment(noteId, "noteId")}/revisions`);
  }

  async getRevision(revisionId: string): Promise<Revision> {
    return this.request<Revision>(`/revisions/${pathSegment(revisionId, "revisionId")}`);
  }

  async getRevisionContentResult(revisionId: string, revisionType?: string): Promise<ContentResult> {
    const url = `${this.baseUrl}/etapi/revisions/${pathSegment(revisionId, "revisionId")}/content`;
    const res = await this.boundedFetch(url, { headers: { Authorization: `Bearer ${this.token}` } });
    return readContentResponse(res, "application/octet-stream", revisionType);
  }

  async getRevisionContent(revisionId: string, revisionType?: string): Promise<string> {
    const result = await this.getRevisionContentResult(revisionId, revisionType);
    if (typeof result !== "string") throw new BinaryContentError(result);
    return result;
  }

  async createRevision(noteId: string): Promise<void> {
    const url = `${this.baseUrl}/etapi/notes/${pathSegment(noteId, "noteId")}/revision`;
    const res = await this.boundedFetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${this.token}`, "Content-Type": "application/json", "trilium-local-now-datetime": localNowDateTime() },
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Trilium API error ${res.status}: ${body}`);
    }
  }

  // ── History ────────────────────────────────────────────────────────────────

  async getNoteHistory(ancestorNoteId?: string): Promise<RecentChange[]> {
    const params = new URLSearchParams();
    if (ancestorNoteId) params.set("ancestorNoteId", ancestorNoteId);
    return this.request<RecentChange[]>(`/notes/history?${params}`);
  }

  // ── Attributes ─────────────────────────────────────────────────────────────

  async getAttribute(attributeId: string): Promise<Attribute> {
    return this.request<Attribute>(`/attributes/${pathSegment(attributeId, "attributeId")}`);
  }

  async addLabel(
    noteId: string,
    name: string,
    value: string = "",
    isInheritable: boolean = false
  ): Promise<Attribute> {
    assertEntityId(noteId, "noteId");
    return this.request<Attribute>(`/attributes`, {
      method: "POST",
      body: JSON.stringify({ attributeId: newEntityId(), noteId, type: "label", name, value, isInheritable }),
    });
  }

  async addRelation(
    fromNoteId: string,
    name: string,
    toNoteId: string,
    isInheritable: boolean = false
  ): Promise<Attribute> {
    assertEntityId(fromNoteId, "fromNoteId");
    assertEntityId(toNoteId, "toNoteId");
    if (!SAFE_RELATION_NAME.test(name)) throw new Error("relationName must be a conservative identifier ([A-Za-z_][A-Za-z0-9_]*)");
    return this.request<Attribute>(`/attributes`, {
      method: "POST",
      body: JSON.stringify({ attributeId: newEntityId(), noteId: fromNoteId, type: "relation", name, value: toNoteId, isInheritable }),
    });
  }

  async updateAttribute(
    attributeId: string,
    fields: { value?: string; position?: number }
  ): Promise<Attribute> {
    const attribute = await this.getAttribute(attributeId);
    if (attribute.type === "relation" && fields.value !== undefined) {
      throw new Error("TRILIUM_ETAPI_RELATION_TARGET_IMMUTABLE: delete and re-add a relation to retarget it");
    }
    try {
      return await this.request<Attribute>(`/attributes/${pathSegment(attributeId, "attributeId")}`, {
        method: "PATCH",
        body: JSON.stringify(fields),
      });
    } catch (error) {
      if (attribute.type === "relation" && fields.position !== undefined) {
        throw new Error(`TRILIUM_ETAPI_RELATION_POSITION_UNSUPPORTED: ${error instanceof Error ? error.message : String(error)}`);
      }
      throw error;
    }
  }

  async deleteAttribute(attributeId: string): Promise<void> {
    return this.request<void>(`/attributes/${pathSegment(attributeId, "attributeId")}`, { method: "DELETE" });
  }

  // ── Branches ───────────────────────────────────────────────────────────────

  async getBranch(branchId: string): Promise<Branch> {
    return this.request<Branch>(`/branches/${pathSegment(branchId, "branchId")}`);
  }

  async cloneNote(noteId: string, parentNoteId: string, prefix?: string): Promise<Branch> {
    assertEntityId(noteId, "noteId");
    assertEntityId(parentNoteId, "parentNoteId");
    // POST /branches creates a placement, but repeating it is not harmless:
    // Trilium's existing-branch path resets omitted position/expansion fields.
    // Return the existing placement instead, making the raw primitive retry-safe.
    const note = await this.getNote(noteId);
    for (const branchId of note.parentBranchIds) {
      const branch = await this.getBranch(branchId);
      if (branch.parentNoteId !== parentNoteId) continue;
      if (prefix === undefined) return branch;
      return this.request<Branch>(`/branches/${pathSegment(branch.branchId, "branchId")}`, {
        method: "PATCH",
        body: JSON.stringify({ prefix }),
      });
    }
    return this.request<Branch>(`/branches`, {
      method: "POST",
      body: JSON.stringify({ noteId, parentNoteId, prefix: prefix ?? "" }),
    });
  }

  async deleteBranch(branchId: string): Promise<void> {
    return this.request<void>(`/branches/${pathSegment(branchId, "branchId")}`, { method: "DELETE" });
  }

  // ── Attachments ────────────────────────────────────────────────────────────

  async getNoteAttachments(noteId: string): Promise<Attachment[]> {
    return this.request<Attachment[]>(`/notes/${pathSegment(noteId, "noteId")}/attachments`);
  }

  async getAttachment(attachmentId: string): Promise<Attachment> {
    return this.request<Attachment>(`/attachments/${pathSegment(attachmentId, "attachmentId")}`);
  }

  async getAttachmentContentResult(attachmentId: string, fallbackMime: string = "application/octet-stream"): Promise<ContentResult> {
    const url = `${this.baseUrl}/etapi/attachments/${pathSegment(attachmentId, "attachmentId")}/content`;
    const res = await this.boundedFetch(url, { headers: { Authorization: `Bearer ${this.token}` } });
    return readContentResponse(res, fallbackMime);
  }

  async getAttachmentContent(attachmentId: string, fallbackMime?: string): Promise<string> {
    const result = await this.getAttachmentContentResult(attachmentId, fallbackMime);
    if (typeof result !== "string") throw new BinaryContentError(result);
    return result;
  }

  async createAttachment(
    ownerId: string,
    title: string,
    mime: string,
    content: string,
    role: string = "file",
    encoding: ContentEncoding = "auto"
  ): Promise<Attachment> {
    assertEntityId(ownerId, "ownerId");
    const encoded = encodeContent(content, mime, encoding);
    const created = await this.request<Attachment>(`/attachments`, {
      method: "POST",
      body: JSON.stringify({ ownerId, role, mime, title, content: encoded.binary ? "" : content }),
    });
    if (!encoded.binary) return created;
    try {
      await this.updateAttachmentContent(created.attachmentId, content, mime, "base64");
      return { ...created, contentUploaded: true };
    } catch (error) {
      throw new PartialContentUploadError("attachment", created.attachmentId, error);
    }
  }

  async deleteAttachment(attachmentId: string): Promise<void> {
    return this.request<void>(`/attachments/${pathSegment(attachmentId, "attachmentId")}`, { method: "DELETE" });
  }

  async updateAttachmentContent(attachmentId: string, content: string, mime?: string, encoding: ContentEncoding = "auto"): Promise<void> {
    const targetMime = mime ?? (await this.getAttachment(attachmentId)).mime;
    const url = `${this.baseUrl}/etapi/attachments/${pathSegment(attachmentId, "attachmentId")}/content`;
    const encoded = encodeContent(content, targetMime, encoding);
    const res = await this.boundedFetch(url, {
      method: "PUT",
      headers: { Authorization: `Bearer ${this.token}`, "Content-Type": encoded.contentType, "trilium-local-now-datetime": localNowDateTime() },
      body: encoded.bytes,
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Trilium API error ${res.status}: ${body}`);
    }
  }

  async updateAttachment(
    attachmentId: string,
    fields: { title?: string; mime?: string }
  ): Promise<Attachment> {
    return this.request<Attachment>(`/attachments/${pathSegment(attachmentId, "attachmentId")}`, {
      method: "PATCH",
      body: JSON.stringify(fields),
    });
  }

  // ── Calendar / special notes ───────────────────────────────────────────────

  async getDayNote(date: string): Promise<{ noteId: string; title: string }> {
    const note = await this.request<Note>(`/calendar/days/${calendarSegment(date, "date")}`);
    return { noteId: note.noteId, title: note.title };
  }

  async getWeekNote(week: string): Promise<{ noteId: string; title: string }> {
    const note = await this.request<Note>(`/calendar/weeks/${calendarSegment(week, "week")}`);
    return { noteId: note.noteId, title: note.title };
  }

  async getMonthNote(month: string): Promise<{ noteId: string; title: string }> {
    const note = await this.request<Note>(`/calendar/months/${calendarSegment(month, "month")}`);
    return { noteId: note.noteId, title: note.title };
  }

  async getYearNote(year: string): Promise<{ noteId: string; title: string }> {
    const note = await this.request<Note>(`/calendar/years/${calendarSegment(year, "year")}`);
    return { noteId: note.noteId, title: note.title };
  }

  async getInboxNote(date: string): Promise<{ noteId: string; title: string }> {
    const note = await this.request<Note>(`/inbox/${calendarSegment(date, "date")}`);
    return { noteId: note.noteId, title: note.title };
  }

  // ── Backup ─────────────────────────────────────────────────────────────────

  async createBackup(nameOrDate: string): Promise<void> {
    // Accepts either a full backup name (e.g. "brainllm-2024-01-15" or "before-migration")
    // or a bare date (YYYY-MM-DD), which is prefixed to match the default convention.
    const backupName = /^\d{4}-\d{2}-\d{2}$/.test(nameOrDate) ? `brainllm-${checkedDate(nameOrDate)}` : nameOrDate;
    const url = `${this.baseUrl}/etapi/backup/${backupSegment(backupName)}`;
    const res = await this.boundedFetch(url, {
      method: "PUT",
      headers: { Authorization: `Bearer ${this.token}` },
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Trilium backup failed (HTTP ${res.status}): ${body}`);
    }
  }

  // ── Graph traversal ────────────────────────────────────────────────────────

  // Find notes that have a relation pointing TO this note (reverse traversal).
  // Trilium's search DSL has no generic "any relation → X" predicate, so we OR a
  // `~name.noteId` clause per known relation name. Callers (e.g. getNeighborhood)
  // may pass a precomputed `relationNames` set to avoid rediscovering the vocabulary
  // on every hop; otherwise we discover it once per call.
  async getBacklinks(
    noteId: string,
    relationNames?: string[]
  ): Promise<Array<{ noteId: string; title: string; relationName: string }>> {
    const names = relationNames ?? backlinkRelationNames(await this.listRelationTypes());
    const query = buildBacklinkQuery(noteId, names);
    if (!query) return [];

    let results: Note[] = [];
    try {
      const res = await this.searchNotes(query, { limit: 200, includeArchivedNotes: true });
      if (res.results.length >= 200) throw new Error("backlink result safety cap reached");
      results = res.results;
    } catch (error) {
      // A backend failure is not the same thing as a note with no backlinks.
      // Propagate it so explore() can report the outage instead of presenting a
      // silently incomplete graph.
      throw new Error(`Backlink search failed: ${error instanceof Error ? error.message : String(error)}`);
    }

    // Extract relation names directly from search result attributes (avoids N+1 fetches)
    const backlinks: Array<{ noteId: string; title: string; relationName: string }> = [];
    for (const n of results) {
      const rels = n.attributes.filter((a) => isOwnedAttribute(n, a) && a.type === "relation" && a.value === noteId);
      for (const rel of rels) {
        backlinks.push({ noteId: n.noteId, title: n.title, relationName: rel.name });
      }
    }

    return backlinks;
  }

  // BFS to find the shortest relation path between two notes
  async findNeuralPath(
    fromId: string,
    toId: string,
    maxDepth: number = 6
  ): Promise<Array<{ noteId: string; title: string; via?: string }> | null> {
    const visited = new Map<string, string[]>(); // noteId → path of IDs
    const titleMap = new Map<string, string>(); // accumulate titles during BFS
    const queue: Array<{ id: string; path: string[]; vias: string[] }> = [
      { id: fromId, path: [fromId], vias: [] },
    ];

    while (queue.length > 0) {
      const current = queue.shift()!;
      if (visited.has(current.id)) continue;
      visited.set(current.id, current.path);

      if (current.path.length - 1 >= maxDepth) continue;

      let note: Note;
      try {
        note = await this.getNote(current.id);
      } catch {
        continue;
      }

      titleMap.set(note.noteId, note.title);

      const relations = note.attributes.filter((a) => isOwnedAttribute(note, a) && a.type === "relation");
      for (const rel of relations) {
        const nextId = rel.value;
        if (!nextId || visited.has(nextId)) continue;

        if (nextId === toId) {
          // Fetch the target note so its title is available in titleMap
          try {
            const targetNote = await this.getNote(toId);
            titleMap.set(toId, targetNote.title);
          } catch {
            // Falls back to "?" if the fetch fails
          }
          const fullPath = [...current.path, toId];
          const fullVias = [...current.vias, rel.name];
          const result = fullPath.map((id, i) => ({
            noteId: id,
            title: titleMap.get(id) ?? "?",
            via: i > 0 ? fullVias[i - 1] : undefined,
          }));
          return result;
        }

        queue.push({
          id: nextId,
          path: [...current.path, nextId],
          vias: [...current.vias, rel.name],
        });
      }
    }

    return null;
  }

  // BFS neighborhood: all notes reachable within `depth` hops, walking BOTH
  // outbound relations and inbound backlinks. A note wired only via inbound
  // edges (e.g. a domain/hub container its members point at, but which points
  // at nothing itself) is otherwise invisible to forward traversal even
  // though explore(mode="backlinks") clearly shows it's connected — "within N
  // hops" means reachable in either direction, not outbound-only. `via` is
  // prefixed with ← for inbound edges so direction stays visible in the walk.
  // The start node itself is always included (depth 0, no via/fromNoteId).
  async getNeighborhood(
    noteId: string,
    depth: number = 2,
    relationType?: string
  ): Promise<Array<{ noteId: string; title: string; depth: number; via?: string; fromNoteId?: string }>> {
    const visited = new Map<string, { title: string; depth: number; via?: string; fromNoteId?: string }>();
    const queue: Array<{ id: string; dist: number; via?: string; from?: string }> = [
      { id: noteId, dist: 0 },
    ];
    // Relation-name universe for backlink queries — discovered once up front
    // (only when there's actually a hop to take) so inbound expansion doesn't
    // re-scan the brain at every node.
    const inboundNames = depth > 0 ? backlinkRelationNames(await this.listRelationTypes()) : [];

    while (queue.length > 0) {
      const current = queue.shift()!;
      if (visited.has(current.id)) continue;

      let note: Note;
      try {
        note = await this.getNote(current.id);
      } catch {
        continue;
      }

      visited.set(current.id, {
        title: note.title,
        depth: current.dist,
        via: current.via,
        fromNoteId: current.from,
      });

      if (current.dist < depth) {
        const relations = note.attributes.filter(
          (a) => isOwnedAttribute(note, a) && a.type === "relation" && (!relationType || a.name === relationType)
        );
        for (const rel of relations) {
          if (rel.value && !visited.has(rel.value)) {
            queue.push({ id: rel.value, dist: current.dist + 1, via: rel.name, from: current.id });
          }
        }

        try {
          const backlinks = await this.getBacklinks(current.id, inboundNames);
          for (const bl of backlinks) {
            if ((!relationType || bl.relationName === relationType) && !visited.has(bl.noteId)) {
              queue.push({ id: bl.noteId, dist: current.dist + 1, via: `←${bl.relationName}`, from: current.id });
            }
          }
        } catch (error) {
          throw new Error(`Neighborhood backlink traversal failed at ${current.id}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    }

    return Array.from(visited.entries()).map(([id, data]) => ({
      noteId: id,
      ...data,
    }));
  }

  // ── Relation helpers ──────────────────────────────────────────────────────

  // Remove a specific named relation from fromNote to toNote
  async removeRelation(fromNoteId: string, relationName: string, toNoteId: string): Promise<void> {
    const note = await this.getNote(fromNoteId);
    const rel = note.attributes.find(
      (a) => a.type === "relation" && a.noteId === fromNoteId && a.name === relationName && a.value === toNoteId
    );
    if (!rel) {
      throw new Error(
        `No '${relationName}' relation found from ${fromNoteId} to ${toNoteId}`
      );
    }
    try {
      await this.deleteAttribute(rel.attributeId);
    } catch (err) {
      throw new Error(`Found relation '${relationName}' (${rel.attributeId}) but failed to delete it: ${err}`);
    }
  }

  // Discover all distinct relation type names used across the whole note set.
  // The previous #noteType-only scan missed custom relations on untyped and
  // archived notes, which made a hard-delete backlink check unsound. Trilium's
  // title wildcard matches every note; a cap is treated as an explicit failure
  // rather than silently returning a partial vocabulary.
  async listRelationTypes(ancestorNoteId?: string): Promise<string[]> {
    const types = new Set<string>();
    const limit = 5_000;
    try {
      const res = await this.searchNotes('note.title *=* ""', {
        ancestorNoteId,
        limit,
        fastSearch: true,
        includeArchivedNotes: true,
      });
      if (res.results.length >= limit) {
        throw new Error(`relation vocabulary exceeds the ${limit}-note safety cap`);
      }
      for (const n of res.results) {
        n.attributes
          .filter((a) => isOwnedAttribute(n, a) && a.type === "relation")
          .forEach((a) => types.add(a.name));
      }
    } catch (error) {
      throw new Error(`Relation vocabulary discovery failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    return Array.from(types).sort();
  }

  // Update the value of an existing label in-place (preserving isInheritable/position).
  // Deduplicates any extra labels with the same name. Falls back to add if none exist.
  async updateLabelValue(noteId: string, labelName: string, newValue: string): Promise<Attribute> {
    const note = await this.getNote(noteId);
    const existing = note.attributes.filter(
      (a) => a.type === "label" && a.noteId === noteId && a.name === labelName
    );
    if (existing.length > 0) {
      const [primary, ...duplicates] = existing;
      // PATCH the primary in-place so isInheritable and position are preserved
      const updated = await this.updateAttribute(primary.attributeId, { value: newValue });
      // Remove any surplus labels only after the update succeeds
      await Promise.all(duplicates.map((a) => this.deleteAttribute(a.attributeId)));
      return updated;
    }
    return this.addLabel(noteId, labelName, newValue);
  }
}
