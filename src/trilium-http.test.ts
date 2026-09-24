import { describe, expect, test } from "bun:test";
import {
  BinaryContentError,
  TriliumClient,
  decodeBase64Strict,
  normalizeTriliumBaseUrl,
  MAX_ETAPI_CONTENT_BYTES,
} from "./trilium.js";

type FetchCall = { url: string; init: RequestInit };

async function withMockFetch(
  calls: FetchCall[],
  handler: (call: FetchCall) => Response | Promise<Response>,
  body: () => Promise<void>
): Promise<void> {
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const call = { url: String(input), init };
    calls.push(call);
    return handler(call);
  }) as typeof fetch;
  try { await body(); } finally { globalThis.fetch = original; }
}

const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), {
  status,
  headers: { "Content-Type": "application/json" },
});

describe("Trilium content transport", () => {
  test("preserves binary note bytes as an explicit base64 envelope", async () => {
    const calls: FetchCall[] = [];
    await withMockFetch(calls, () => new Response(new Uint8Array([0, 255, 254, 128, 65]), {
      headers: { "Content-Type": "application/octet-stream" },
    }), async () => {
      const result = await new TriliumClient("https://trilium.example", "token").getNoteContentResult("note1234");
      expect(result).toEqual({ encoding: "base64", mime: "application/octet-stream", content: "AP/+gEE=" });
    });
    expect(calls[0].url).toBe("https://trilium.example/etapi/notes/note1234/content");
  });

  test("uploads binary bytes with octet-stream and does not replace empty content with a space", async () => {
    const calls: FetchCall[] = [];
    const bytes = decodeBase64Strict("AP/+gEE=");
    await withMockFetch(calls, () => new Response(null, { status: 204 }), async () => {
      const client = new TriliumClient("https://trilium.example/etapi", "token");
      await client.updateNoteContent("note1234", "AP/+gEE=", "application/octet-stream", "base64");
      await client.updateNoteContent("note5678", "", "text/plain", "text");
    });
    expect(calls[0].url).toBe("https://trilium.example/etapi/notes/note1234/content");
    expect(calls[0].init.headers).toMatchObject({ "Content-Type": "application/octet-stream" });
    expect(calls[0].init.body).toEqual(bytes);
    const puts = calls.filter((call) => call.init.method === "PUT" && call.url.endsWith("/content"));
    expect(puts).toHaveLength(2);
    expect(puts[1].init.body).toEqual(new Uint8Array(0));
    expect(calls.some((call) => call.init.method === "PATCH" && call.url.endsWith("/notes/note5678"))).toBe(true);
  });

  test("binary create uses an empty JSON create followed by a raw PUT", async () => {
    const calls: FetchCall[] = [];
    await withMockFetch(calls, (call) => {
      if (call.init.method === "POST") return json({ note: { noteId: "note1234" }, branch: { branchId: "branch123" } });
      return new Response(null, { status: 204 });
    }, async () => {
      const result = await new TriliumClient("https://trilium.example", "token").createNote(
        "parent123", "Image", "AP/+gEE=", "image", "image/png", undefined, "base64"
      );
      expect(result.contentUploaded).toBe(true);
    });
    expect(calls).toHaveLength(2);
    expect(JSON.parse(String(calls[0].init.body)).content).toBe("");
    expect(JSON.parse(String(calls[0].init.body)).mime).toBe("image/png");
    expect(calls[1].init.body).toEqual(new Uint8Array([0, 255, 254, 128, 65]));
  });

  test("bounds authenticated content reads before allocating an oversized body", async () => {
    const calls: FetchCall[] = [];
    await withMockFetch(calls, () => new Response("x", {
      headers: { "Content-Type": "text/html", "Content-Length": String(MAX_ETAPI_CONTENT_BYTES + 1) },
    }), async () => {
      await expect(new TriliumClient("https://trilium.example", "token").getNoteContentResult("note1234")).rejects.toThrow("50 MiB");
    });
  });

  test("text reads stay text, while the legacy string API refuses binary", async () => {
    const calls: FetchCall[] = [];
    await withMockFetch(calls, (call) => {
      if (call.url.includes("/notes/")) return new Response("<p>hello</p>", { headers: { "Content-Type": "text/html" } });
      return new Response(new Uint8Array([0, 255]), { headers: { "Content-Type": "application/octet-stream" } });
    }, async () => {
      const client = new TriliumClient("https://trilium.example", "token");
      expect(await client.getNoteContent("note1234")).toBe("<p>hello</p>");
      await expect(client.getAttachmentContent("att12345")).rejects.toBeInstanceOf(BinaryContentError);
    });
  });
});

describe("Trilium URL and retry boundaries", () => {
  test("canonicalizes both supported base URL forms", () => {
    expect(normalizeTriliumBaseUrl("https://host/")).toBe("https://host");
    expect(normalizeTriliumBaseUrl("https://host/etapi/")).toBe("https://host");
    expect(normalizeTriliumBaseUrl("https://host/prefix/etapi")).toBe("https://host/prefix");
  });

  test("rejects impossible date-shaped backup names before making a request", async () => {
    const calls: FetchCall[] = [];
    await withMockFetch(calls, () => new Response(null, { status: 204 }), async () => {
      await expect(new TriliumClient("https://host", "token").createBackup("2026-02-30")).rejects.toThrow("real calendar date");
    });
    expect(calls).toHaveLength(0);
  });

  test("login accepts /etapi, applies a timeout, and does not retry", async () => {
    const calls: FetchCall[] = [];
    await withMockFetch(calls, () => json({ authToken: "minted" }), async () => {
      expect(await TriliumClient.login("https://host/etapi/", "password")).toBe("minted");
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://host/etapi/auth/login");
    expect(calls[0].init.signal).toBeDefined();
  });

  test("an explicit prefix updates an existing branch without resetting placement fields", async () => {
    const calls: FetchCall[] = [];
    await withMockFetch(calls, (call) => {
      if (call.url.endsWith("/notes/note1234")) return json({ noteId: "note1234", parentBranchIds: ["branch123"] });
      if (call.url.endsWith("/branches/branch123")) return json({ branchId: "branch123", parentNoteId: "parent123" });
      if (call.init.method === "PATCH") return json({ branchId: "branch123", parentNoteId: "parent123", prefix: "new", notePosition: 7, isExpanded: true });
      return json({});
    }, async () => {
      await new TriliumClient("https://host", "token").cloneNote("note1234", "parent123", "new");
    });
    const patch = calls.find((call) => call.init.method === "PATCH");
    expect(patch).toBeDefined();
    expect(JSON.parse(String(patch!.init.body))).toEqual({ prefix: "new" });
  });

  test("relation vocabulary scans all notes, including untyped and archived candidates", async () => {
    const calls: FetchCall[] = [];
    await withMockFetch(calls, () => json({ results: [{ noteId: "untyped123", title: "raw", type: "text", attributes: [{ attributeId: "attr1234", noteId: "untyped123", type: "relation", name: "customRel", value: "target123", position: 1, isInheritable: false }] }] }), async () => {
      expect(await new TriliumClient("https://host", "token").listRelationTypes()).toEqual(["customRel"]);
    });
    expect(calls[0].url).toContain("note.title");
    expect(calls[0].url).toContain("includeArchivedNotes=true");
  });

  test("backlink search failures propagate instead of looking like zero backlinks", async () => {
    const calls: FetchCall[] = [];
    await withMockFetch(calls, () => { throw new Error("search offline"); }, async () => {
      await expect(new TriliumClient("https://host", "token").getBacklinks("note1234", ["relatesTo"])).rejects.toThrow("Backlink search failed");
    });
  });

  test("rejects unsafe custom relation names before the ETAPI request", async () => {
    const calls: FetchCall[] = [];
    await withMockFetch(calls, () => json({}), async () => {
      await expect(new TriliumClient("https://host", "token").addRelation("from1234", "bad name OR ~inject", "to12345")).rejects.toThrow("conservative identifier");
    });
    expect(calls).toHaveLength(0);
  });

  test("repeated clone returns the existing branch without a second POST", async () => {
    const calls: FetchCall[] = [];
    await withMockFetch(calls, (call) => {
      if (call.url.endsWith("/notes/note1234")) return json({ noteId: "note1234", parentBranchIds: ["branch123"] });
      if (call.url.endsWith("/branches/branch123")) return json({ branchId: "branch123", parentNoteId: "parent123" });
      return json({});
    }, async () => {
      const branch = await new TriliumClient("https://host", "token").cloneNote("note1234", "parent123");
      expect(branch.branchId).toBe("branch123");
    });
    expect(calls.filter((call) => call.init.method === "POST")).toHaveLength(0);
  });
});

test("base64 validation rejects data URLs, base64url, whitespace, and malformed padding", () => {
  for (const value of ["data:image/png;base64,AAAA", "AP-_", "AA AA", "A"]) {
    expect(() => decodeBase64Strict(value)).toThrow();
  }
});
