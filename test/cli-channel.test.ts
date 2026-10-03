import assert from "node:assert/strict";
import test from "node:test";
import { createHost } from "../src/host/host.js";
import { createRuntimeLog } from "../src/runtime/runtime-log.js";
import { createCliChannel, parseCliArgs } from "../src/cli/cli-channel.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("CLI send uses the shared Host and keeps machine events on stdout", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "cli-channel-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const host = createHost({ log: createRuntimeLog(dir), execute: async (input, context) => {
    context.emit({ type: "progress", phase: "working", source: "runtime", visibility: "normal", contextPolicy: "exclude", text: "检查中" });
    return { text: `答复:${input.conversationId}` };
  } });
  const stdout: string[] = []; const stderr: string[] = [];
  const cli = createCliChannel({ host, actor: { id: "cli-user", kind: "user" }, stdout: (line) => stdout.push(line), stderr: (line) => stderr.push(line) });
  const terminal = await cli.send("你好", { json: true, conversationId: "shared" });
  const events = stdout.map((line) => JSON.parse(line) as { type: string; seq: number; runId: string });
  assert.equal(terminal.type, "run_succeeded");
  assert.ok(events.length >= 3);
  assert.deepEqual(events.map((event) => event.seq), events.map((_, index) => index + 1));
  assert.equal(new Set(events.map((event) => event.runId)).size, 1);
  assert.deepEqual(stderr, []);
});

test("human chat renders a timeline and explicit conversation IDs continue the same session", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "cli-chat-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const host = createHost({ log: createRuntimeLog(dir), execute: async (input) => ({ text: `seen:${input.conversationId}` }) });
  const output: string[] = [];
  const cli = createCliChannel({ host, actor: { id: "cli-user", kind: "user" }, stdout: (line) => output.push(line), stderr: () => {} });
  await cli.chat(["one", "two"], { conversationId: "shared" });
  assert.ok(output.some((line) => line.includes("run_succeeded")));
  assert.equal(output.filter((line) => line.includes("shared")).length >= 2, true);
});

test("CLI argument parser supports chat/send, continuation and images", () => {
  assert.deepEqual(parseCliArgs(["send", "hello", "--conversation-id", "c1", "--json", "--image", "photo.png"]), {
    command: "send", text: "hello", conversationId: "c1", json: true, imagePath: "photo.png",
  });
});
