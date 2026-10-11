import assert from "node:assert/strict";
import test from "node:test";
import { observeProviderResponse } from "../src/agent/provider-stream-evidence.js";
import type { ProviderError } from "../src/runtime/transport-diagnostics.js";

test("bounded SSE observation handles byte boundaries and skips oversized frames without changing bytes", async () => {
  const text = `data: ${JSON.stringify({ error: { code: "server_error", message: "PRIVATE".repeat(12000) } })}\r\n\r\n` +
    'data: {"error":\r\ndata: {"message":"PRIVATE"}}\r\n\r\n' +
    'data: {"type":"response.failed","response":{"error":{"code":"server_error"}}}\n\n';
  const bytes = new TextEncoder().encode(text); let offset = 0;
  const input = new Response(new ReadableStream({ pull(controller) {
    if (offset === bytes.length) { controller.close(); return; }
    const end = Math.min(bytes.length, offset + 7); controller.enqueue(bytes.slice(offset, end)); offset = end;
  } }), { headers: { "content-type": "text/event-stream", "x-request-id": "synthetic" } });
  Object.defineProperty(input, "url", { value: "https://synthetic.invalid/responses" });
  const errors: ProviderError[] = []; const output = observeProviderResponse(input, (error) => errors.push(error));
  assert.equal(output.url, input.url); assert.equal(output.status, input.status);
  assert.equal(output.headers.get("x-request-id"), "synthetic");
  assert.equal(await output.text(), text);
  assert.deepEqual(errors, [{ source: "stream-event", code: null, eventType: null },
    { source: "stream-event", code: "server_error", eventType: "response.failed" }]);
  assert.doesNotMatch(JSON.stringify(errors), /PRIVATE/);
});

test("observation preserves backpressure and forwards reader cancellation once", async () => {
  let pulls = 0; let cancels = 0; const reason = new Error("synthetic cancellation");
  const input = new Response(new ReadableStream<Uint8Array>({
    pull(controller) { pulls++; controller.enqueue(new TextEncoder().encode('data: {"error":{"code":"server_error"}}\n\n')); },
    cancel(value) { cancels++; assert.equal(value, reason); },
  }, { highWaterMark: 0 }), { headers: { "content-type": "text/event-stream" } });
  const errors: ProviderError[] = [];
  const output = observeProviderResponse(input, (error) => errors.push(error));
  await new Promise((resolve) => setImmediate(resolve)); assert.equal(pulls, 0);
  const reader = output.body!.getReader(); await reader.read();
  assert.equal(pulls, 1); assert.equal(errors.length, 1);
  await reader.cancel(reason); assert.equal(cancels, 1);
  assert.equal(input.body!.locked, false);
});

test("non-SSE responses pass through by identity", () => {
  const response = new Response('{"error":{"code":"server_error"}}');
  assert.equal(observeProviderResponse(response, () => assert.fail("unrelated body observed")), response);
});
