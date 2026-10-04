import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createHost, normalizeHostInput, type HostEvent, type HostInput } from "../src/host/host.js";
import { createRuntimeLog } from "../src/runtime/runtime-log.js";
import { createSqliteRuntimeLog } from "../src/runtime/sqlite-runtime-log.js";

async function collect(handle: { events(): AsyncIterable<HostEvent> }) {
  const result: HostEvent[] = [];
  for await (const event of handle.events()) result.push(event);
  return result;
}

function input(text: string, conversationId = "conversation-1"): HostInput {
  return { actor: { id: "owner", kind: "user" }, conversationId, parts: [{ type: "text", text }] };
}

test("Host normalizes text and image parts at the channel boundary", () => {
  const value = normalizeHostInput({ actor: { id: "owner" }, conversationId: "c1", text: " hello ", images: [
    { type: "image", mimeType: "image/png", data: Buffer.from("png").toString("base64") },
  ] });
  assert.equal(value.conversationId, "c1");
  assert.deepEqual(value.parts, [
    { type: "text", text: " hello " },
    { type: "image", mimeType: "image/png", data: Buffer.from("png").toString("base64") },
  ]);
  assert.throws(() => normalizeHostInput({ actor: { id: "owner" }, conversationId: "c1", parts: [] }), /ContentPart/);
});

test("Host serializes runs globally and exposes ordered terminal events", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "host-lifecycle-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const log = createRuntimeLog(dir);
  const active: string[] = [];
  const host = createHost({ log, execute: async (request, context) => {
    active.push(request.parts.find((part) => part.type === "text")?.text ?? "");
    context.emit({ type: "progress", phase: "working", source: "runtime", visibility: "normal", contextPolicy: "exclude" });
    await new Promise((resolve) => setTimeout(resolve, 10));
    return { text: `done:${request.conversationId}` };
  } });
  const first = host.submit(input("one"));
  const second = host.submit(input("two", "conversation-2"));
  const [firstEvents, secondEvents] = await Promise.all([collect(first), collect(second)]);
  assert.deepEqual(active, ["one", "two"]);
  assert.equal(firstEvents.at(-1)?.type, "run_succeeded");
  assert.equal(secondEvents.at(-1)?.type, "run_succeeded");
  assert.deepEqual(firstEvents.map((event) => event.sequence), firstEvents.map((_, index) => index + 1));
  assert.equal(firstEvents[0]?.runId, first.runId);
  assert.equal((await log.read()).filter((event) => event.runId === first.runId).length, firstEvents.length);
});

test("Host persists envelopes through SQLite without claiming log identities", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "host-sqlite-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const log = createSqliteRuntimeLog(dir);
  const host = createHost({ log, execute: async () => ({ text: "ok" }) });
  const handle = host.submit(input("sqlite"));
  const emitted = await collect(handle);
  const persisted = (await log.read()).filter((event) => event.runId === handle.runId);
  assert.equal(persisted.length, emitted.length);
  assert.deepEqual(persisted.map((event) => event.type), emitted.map((event) => event.type));
});

test("cancellation is explicit and reset is an ordered barrier", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "host-barrier-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const log = createRuntimeLog(dir);
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  const host = createHost({ log, execute: async (_request, context) => {
    await blocked;
    if (context.signal.aborted) throw new DOMException("aborted", "AbortError");
    return { text: "ok" };
  } });
  const first = host.submit(input("one"));
  const reset = host.reset("conversation-1");
  await host.cancel(first.runId);
  release();
  const events = await collect(first);
  await reset;
  assert.equal(events.at(-1)?.type, "run_cancelled");
  const all = await log.read();
  assert.ok(all.find((event) => event.type === "conversation_reset"));
  assert.ok(all.findIndex((event) => event.type === "run_cancelled") < all.findIndex((event) => event.type === "conversation_reset"));
});

test("legacy runtime events are upcast without changing stored records", async () => {
  const { upcastHostEvent } = await import("../src/host/event-envelope.js");
  const event = upcastHostEvent({ type: "message", at: "2026-01-01T00:00:00.000Z", role: "user", text: "hi" });
  assert.equal(event.schemaVersion, 1);
  assert.equal(event.type, "message");
  assert.equal(event.sequence, undefined);
});

test("a finalized result can be redelivered after a Host restart without executing again", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "host-redelivery-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const log = createRuntimeLog(dir); let executions = 0;
  const host = createHost({ log, execute: async () => { executions++; return { text: "reusable" }; } });
  const handle = host.submit(input("once"));
  const events = await collect(handle); const resultId = String((events.at(-1)?.result as { resultId?: string }).resultId);
  const restarted = createHost({ log, execute: async () => { executions++; return { text: "should not run" }; } });
  const delivered: string[] = [];
  await restarted.redeliver(resultId, async (result) => { delivered.push(String(result.text)); });
  assert.equal(executions, 1);
  assert.deepEqual(delivered, ["reusable"]);
});
