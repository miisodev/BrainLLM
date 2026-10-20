// ─────────────────────────────────────────────────────────────────────────────
// BrainLLM — lenient tool-argument coercion
//
// Some MCP clients put booleans, numbers and arrays on the wire as JSON
// strings. The SDK parses tool arguments against each tool's declared Zod
// shape, and Zod is strict — `strict=true` arrived as the string "true" and
// was rejected with "Expected boolean, received string", observed live on
// 2026-09-03 (revise(strict=), maintain(deep=) and revise(edits=[…]) all
// failed through the same client in one session). The caller's only
// workaround was dropping the parameter entirely, which put strict=
// out of reach on exactly the high-stakes writes it exists for.
//
// The fix rewrites each registered tool's inputSchema in place — the same
// post-registration pass applyToolAnnotations() and serializeWrites() use —
// wrapping declared boolean/number/array fields with a preprocessor that
// coerces the string encoding before Zod parses it. The SDK re-normalizes
// tool.inputSchema at every call (mcp.js `schemaToParse = …`), so the rewrite
// changes validation without touching any of the 70+ registration sites.
//
// Scope, stated precisely: only fields whose DECLARED type is boolean,
// number or array are coerced, and only the three lossy encodings —
// "true"/"false" → boolean, numeric string → number, a string starting with
// "[" that JSON-parses to an array → array. A body whose text happens to be
// "true" stays text: string-declared fields are never wrapped. Values already
// carrying the declared type pass through untouched, so well-behaved clients
// see no change at all. Anything else fails exactly as before.
// ─────────────────────────────────────────────────────────────────────────────

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

// Zod 4 uses _def.type; SDK-owned Zod 3 schemas use _def.typeName.
// Optional/Nullable/Default wrap the declared schema in _def.innerType.
interface RawField {
  _def?: { typeName?: string; type?: string; innerType?: RawField };
  _zod?: { def?: { type?: string; innerType?: RawField } };
}

function declaredBase(field: unknown): string | null {
  let f = field as RawField | undefined;
  for (let depth = 0; f && depth < 6; depth++) {
    const def = f._def ?? f._zod?.def;
    if (!def) return null;
    const type = (def as { typeName?: string }).typeName ?? def.type;
    if (["ZodOptional", "ZodNullable", "ZodDefault", "optional", "nullable", "default"].includes(type ?? "")) {
      f = def.innerType;
      continue;
    }
    return type ?? null;
  }
  return null;
}

const asBoolean = (v: unknown): unknown => {
  if (typeof v !== "string") return v;
  const t = v.trim().toLowerCase();
  if (t === "true") return true;
  if (t === "false") return false;
  return v;
};

const asNumber = (v: unknown): unknown => {
  if (typeof v !== "string") return v;
  const t = v.trim();
  return /^-?\d+(\.\d+)?$/.test(t) ? Number(t) : v;
};

const asArray = (v: unknown): unknown => {
  if (typeof v !== "string") return v;
  const t = v.trim();
  if (!t.startsWith("[")) return v;
  try {
    const parsed: unknown = JSON.parse(t);
    return Array.isArray(parsed) ? parsed : v;
  } catch {
    return v;
  }
};

// An object-typed field (revise's closure=) arrives as JSON text from the
// same clients that stringify arrays.
const asObject = (v: unknown): unknown => {
  if (typeof v !== "string") return v;
  const t = v.trim();
  if (!t.startsWith("{")) return v;
  try {
    const parsed: unknown = JSON.parse(t);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : v;
  } catch {
    return v;
  }
};

const COERCERS: Record<string, (v: unknown) => unknown> = {
  ZodBoolean: asBoolean,
  ZodNumber: asNumber,
  ZodArray: asArray,
  ZodObject: asObject,
  boolean: asBoolean,
  number: asNumber,
  array: asArray,
  object: asObject,
};

export interface CoerceReport {
  tools: string[];
  fields: number;
}

/** Rewrite every registered tool's inputSchema with coercing wrappers on its
 *  boolean/number/array fields. Fields already correctly typed by the client
 *  are unaffected; idempotent by construction (re-extending is a no-op the
 *  second time — the preprocessor passes real booleans through untouched). */
export function coerceToolArgs(server: McpServer): CoerceReport {
  const registry = (
    server as unknown as {
      _registeredTools?: Record<string, { inputSchema?: unknown }>;
    }
  )._registeredTools;
  if (!registry) return { tools: [], fields: 0 };

  const touched: string[] = [];
  let fields = 0;
  for (const [name, tool] of Object.entries(registry)) {
    const schema = (tool as { inputSchema?: unknown }).inputSchema as
      | { shape?: Record<string, unknown>; extend?: (u: Record<string, unknown>) => unknown }
      | undefined;
    const miniShape = (schema as { _zod?: { def?: { shape?: Record<string, unknown> } } } | undefined)?._zod?.def?.shape;
    const shape = schema?.shape ?? miniShape;
    if (!shape) continue;

    const updates: Record<string, unknown> = {};
    for (const [key, field] of Object.entries(shape)) {
      const coerce = COERCERS[declaredBase(field) ?? ""];
      if (!coerce) continue;
      updates[key] = z.preprocess(coerce, field as z.ZodTypeAny);
      fields++;
    }
    if (!Object.keys(updates).length) continue;

    tool.inputSchema = typeof schema?.extend === "function" ? schema.extend(updates) : z.object({ ...shape, ...updates } as z.ZodRawShape);
    touched.push(name);
  }
  return { tools: touched, fields };
}