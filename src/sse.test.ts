import { describe, expect, test } from "bun:test";
import { BunSseServerTransport } from "./sse.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";

async function readChunk(reader: { read(): Promise<{ done: boolean; value?: Uint8Array }> }): Promise<string> {
  const { value, done } = await reader.read();
  expect(done).toBe(false);
  return new TextDecoder().decode(value);
}

describe("legacy SSE transport", () => {
  test("opens with the endpoint event naming /messages and the session id", async () => {
    const t = new BunSseServerTransport("/messages");
    const res = t.streamResponse();
    expect(res.headers.get("Content-Type")).toBe("text/event-stream");
    const reader = res.body!.getReader();
    const first = await readChunk(reader);
    expect(first).toContain("event: endpoint");
    expect(first).toContain(`/messages?sessionId=${t.sessionId}`);
    await t.close();
  });

  test("frames sent messages and delivers POSTs to onmessage", async () => {
    const t = new BunSseServerTransport("/messages");
    const res = t.streamResponse();
    const reader = res.body!.getReader();
    await readChunk(reader); // endpoint event

    const received: JSONRPCMessage[] = [];
    t.onmessage = (m) => received.push(m);

    const post = new Request(`http://srv.local/messages?sessionId=${t.sessionId}`, {
      method: "POST",
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
      headers: { "Content-Type": "application/json" },
    });
    const ack = await t.handlePost(post);
    expect(ack.status).toBe(202);
    expect(received).toHaveLength(1);
    expect((received[0] as { method?: string }).method).toBe("initialize");

    const reply = { jsonrpc: "2.0", id: 1, result: {} } as JSONRPCMessage;
    await t.send(reply);
    const frame = await readChunk(reader);
    expect(frame).toContain("event: message");
    expect(frame).toContain(JSON.stringify(reply));
    await t.close();
  });

  test("rejects malformed bodies and foreign session ids", async () => {
    const t = new BunSseServerTransport("/messages");
    t.streamResponse();
    const impostor = new Request("http://srv.local/messages?sessionId=nope", {
      method: "POST", body: "{}",
    });
    expect((await t.handlePost(impostor)).status).toBe(404);
    const malformed = new Request(`http://srv.local/messages?sessionId=${t.sessionId}`, {
      method: "POST", body: "{nope",
    });
    expect((await t.handlePost(malformed)).status).toBe(400);
    await t.close();
  });

  test("close() ends the stream, fires onclose once, and refuses further sends", async () => {
    const t = new BunSseServerTransport("/messages");
    const res = t.streamResponse();
    const reader = res.body!.getReader();
    await readChunk(reader); // the endpoint event — buffered chunks precede done
    let closed = 0;
    t.onclose = () => closed++;
    await t.close();
    await t.close(); // retry-safe
    expect(closed).toBe(1);
    const end = await reader.read();
    expect(end.done).toBe(true);
    await expect(t.send({ jsonrpc: "2.0", id: 2, result: {} } as JSONRPCMessage)).rejects.toThrow();
  });
});
