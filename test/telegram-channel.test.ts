import assert from "node:assert/strict";
import test from "node:test";
import { telegramConversationId, normalizeTelegramInput, createTelegramHostProjection, telegramEnvironment } from "../src/channel/telegram/index.js";
import type { HostEvent, RunHandle } from "../src/host/host.js";

function controlledRun(runId: string) {
  const values: HostEvent[] = [];
  let wake: (() => void) | undefined;
  let terminal: HostEvent | undefined;
  let resolve!: (event: HostEvent) => void;
  const done = new Promise<HostEvent>((res) => { resolve = res; });
  const handle: RunHandle = { runId, conversationId: "c1", done, cancel: async () => false,
    events: async function* () {
      while (!terminal || values.length) {
        if (!values.length) await new Promise<void>((res) => { wake = res; });
        const event = values.shift();
        if (event) yield event;
      }
    },
  };
  return { handle, push(type: HostEvent["type"], extra: Partial<HostEvent> = {}) {
    const event: HostEvent = { type, schemaVersion: 1, runId, conversationId: "c1", sequence: 1, at: "now", ...extra };
    values.push(event);
    if (["run_succeeded", "run_failed", "run_cancelled"].includes(type)) { terminal = event; resolve(event); }
    wake?.(); wake = undefined;
  } };
}

const drain = () => new Promise<void>((resolve) => setImmediate(resolve));

test("Telegram input maps private identity to a stable Host conversation and ContentParts", () => {
  assert.equal(telegramConversationId(42), "telegram:private:42");
  const input = normalizeTelegramInput({ fromId: 42, chatId: 42, chatType: "private", messageId: 7, text: "看图", image: { mimeType: "image/jpeg", data: "aW1n" } });
  assert.deepEqual(input.actor, { id: "telegram:42", kind: "user" });
  assert.equal(input.conversationId, "telegram:private:42");
  assert.deepEqual(input.parts.map((part) => part.type), ["text", "image"]);
  assert.throws(() => normalizeTelegramInput({ fromId: 42, chatId: 99, chatType: "group", messageId: 1, text: "no" }), /private/);
});

test("Telegram Host projection converges one editable draft into one final message", async () => {
  const calls: string[] = [];
  const projection = createTelegramHostProjection({ chatId: 42, draft: async (_id, text) => { calls.push(`draft:${text}`); }, send: async (text) => { calls.push(`send:${text}`); return 9; } });
  const events: HostEvent[] = [
    { type: "run_submitted", schemaVersion: 1, runId: "r1", conversationId: "c1", sequence: 1, at: "now" },
    { type: "progress", schemaVersion: 1, runId: "r1", conversationId: "c1", sequence: 2, at: "now", phase: "working", source: "provider", visibility: "normal", contextPolicy: "exclude", text: "处理中" },
    { type: "run_succeeded", schemaVersion: 1, runId: "r1", conversationId: "c1", sequence: 3, at: "now", result: { text: "完成" } },
  ];
  const handle = { runId: "r1", conversationId: "c1", events: async function* () { yield* events; }, done: Promise.resolve(events.at(-1)!), cancel: async () => false } as RunHandle;
  await projection.consume(handle);
  assert.deepEqual(calls, ["send:完成"]); // Short runs need no transient draft.
});

test("Telegram Host projection closes failed runs with a visible error", async () => {
  const calls: string[] = [];
  const projection = createTelegramHostProjection({ chatId: 42, draft: async (_id, text) => { calls.push(`draft:${text}`); },
    send: async (text) => { calls.push(`send:${text}`); return 10; } });
  const events: HostEvent[] = [
    { type: "run_submitted", schemaVersion: 1, runId: "r2", conversationId: "c1", sequence: 1, at: "now" },
    { type: "progress", schemaVersion: 1, runId: "r2", conversationId: "c1", sequence: 2, at: "now", phase: "working", source: "provider", visibility: "normal", contextPolicy: "exclude", text: "处理中" },
    { type: "run_failed", schemaVersion: 1, runId: "r2", conversationId: "c1", sequence: 3, at: "now", error: "模型协议纠正次数耗尽" },
  ];
  const handle = { runId: "r2", conversationId: "c1", events: async function* () { yield* events; }, done: Promise.resolve(events.at(-1)!), cancel: async () => false } as RunHandle;
  await projection.consume(handle);
  assert.deepEqual(calls, ["send:抱歉，这条消息处理失败，请稍后重试。"]);
});

test("legacy Telegram environment variables remain accepted with migration guidance", () => {
  const warnings: string[] = [];
  const result = telegramEnvironment({ TELEGRAM_BOT_TOKEN: "old-token", TELEGRAM_USER_ID: "42" }, (message) => warnings.push(message));
  assert.deepEqual(result, { token: "old-token", ownerId: 42 });
  assert.equal(warnings.length, 1);
});

test("Telegram coalesces snapshots, keeps one draft per run and stops refreshing after completion", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval", "Date"] });
  const drafts: Array<{ id: number; text: string }> = [];
  const sent: string[] = [];
  const projection = createTelegramHostProjection({ chatId: 42,
    draft: async (id, text) => { drafts.push({ id, text }); }, send: async (text) => { sent.push(text); return 1; } });
  const first = controlledRun("first");
  const consume = projection.consume(first.handle);
  first.push("run_started");
  for (let i = 1; i <= 50; i++) first.push("progress", { progress: { type: "text", segmentId: "s1", kind: "status", text: `进展 ${i}`, finalized: false } });
  await drain();
  assert.equal(drafts.length, 0);
  t.mock.timers.tick(750); await drain();
  assert.deepEqual(drafts.map((draft) => draft.text), ["进展 50"]);
  first.push("progress", { progress: { type: "tool", name: "ls", state: "started" } });
  await drain(); t.mock.timers.tick(750); await drain();
  assert.equal(drafts.at(-1)?.text, "进展 50\n\n正在调用：ls");
  assert.equal(new Set(drafts.map((draft) => draft.id)).size, 1);
  const before = drafts.length;
  first.push("run_succeeded", { result: { text: "完成" } });
  await consume; t.mock.timers.tick(30_000); await drain();
  assert.equal(drafts.length, before);
  assert.deepEqual(sent, ["完成"]);
  const second = controlledRun("second");
  const next = projection.consume(second.handle);
  second.push("run_started"); await drain(); t.mock.timers.tick(750); await drain();
  assert.notEqual(drafts.at(-1)?.id, drafts[0]?.id);
  second.push("run_cancelled"); await next;
  assert.equal(sent.at(-1), "这条消息已取消。");
});

test("draft rejection does not lose final delivery or its receipt", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval", "Date"] });
  let attempts = 0;
  const sent: string[] = [];
  const receipts: number[] = [];
  const projection = createTelegramHostProjection({ chatId: 42,
    draft: async () => { attempts++; throw new Error("draft API unavailable"); },
    send: async (text) => { sent.push(text); return 9; }, onDelivered: async (_event, id) => { receipts.push(id); } });
  const run = controlledRun("rejected-draft");
  const consume = projection.consume(run.handle);
  run.push("run_started"); await drain(); t.mock.timers.tick(750); await drain();
  t.mock.timers.tick(30_000); await drain();
  run.push("run_succeeded", { result: { text: "完整答案" } }); await consume;
  assert.equal(attempts, 1);
  assert.deepEqual(sent, ["完整答案"]);
  assert.deepEqual(receipts, [9]);
});

test("discarded previews are withdrawn and in-flight draft finishes before the terminal message", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval", "Date"] });
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  const calls: string[] = [];
  const projection = createTelegramHostProjection({ chatId: 42,
    draft: async (_id, text) => { calls.push(text); await blocked; calls.push("draft-finished"); },
    send: async (text) => { calls.push(text); return 1; } });
  const run = controlledRun("invalid-preview");
  const consume = projection.consume(run.handle);
  run.push("progress", { progress: { type: "text", segmentId: "invalid", kind: "final", text: "未校验正文", finalized: false } });
  run.push("progress", { progress: { type: "discard", segmentId: "invalid" } });
  await drain(); t.mock.timers.tick(750); await drain();
  assert.deepEqual(calls, ["处理中"]);
  run.push("run_failed"); await drain();
  assert.equal(calls.length, 1);
  release(); await consume;
  assert.deepEqual(calls, ["处理中", "draft-finished", "抱歉，这条消息处理失败，请稍后重试。"]);
});

test("long silent runs refresh the same truthful draft without adding chat messages", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval", "Date"] });
  const drafts: string[] = [];
  const sent: string[] = [];
  const projection = createTelegramHostProjection({ chatId: 42, draft: async (_id, text) => { drafts.push(text); },
    send: async (text) => { sent.push(text); return 1; } });
  const run = controlledRun("waiting");
  const consume = projection.consume(run.handle);
  run.push("progress", { progress: { type: "tool", name: "web_fetch", state: "started" } });
  await drain(); t.mock.timers.tick(750); await drain();
  t.mock.timers.tick(15_000); await drain();
  assert.deepEqual(drafts, ["正在调用：web_fetch", "正在调用：web_fetch"]);
  assert.deepEqual(sent, []);
  run.push("run_cancelled"); await consume;
});

for (const terminal of ["run_succeeded", "run_failed", "run_cancelled"] as const) {
  test(`a hanging draft cannot block ${terminal} delivery`, async (t) => {
    t.mock.timers.enable({ apis: ["setInterval", "setTimeout", "Date"] });
    const drafts: number[] = [];
    const sent: string[] = [];
    const projection = createTelegramHostProjection({ chatId: 42,
      draft: async (id) => { drafts.push(id); await new Promise<void>(() => {}); },
      send: async (text) => { sent.push(text); return 1; } });
    const run = controlledRun(`hanging-${terminal}`);
    const consume = projection.consume(run.handle);
    run.push("run_started"); await drain(); t.mock.timers.tick(750); await drain();
    assert.equal(drafts.length, 1);
    run.push(terminal, { result: { text: "完整答案" } }); await drain();
    t.mock.timers.tick(5_000); await drain();
    assert.equal(sent.length, 1, "terminal delivery must survive a draft that never settles");
    await consume;
    t.mock.timers.tick(30_000); await drain();
    assert.equal(drafts.length, 1);
  });
}

test("draft deadline cancels the request and disables late draft updates", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval", "setTimeout", "Date"] });
  let signal: AbortSignal | undefined;
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  const sent: string[] = [];
  let attempts = 0;
  const projection = createTelegramHostProjection({ chatId: 42, draftTimeoutMs: 1000,
    draft: async (_id, _text, _chat, abort) => { attempts++; signal = abort; await blocked; },
    send: async (text) => { sent.push(text); return 1; } });
  const run = controlledRun("draft-deadline");
  const consume = projection.consume(run.handle);
  run.push("run_started"); await drain(); t.mock.timers.tick(750); await drain();
  assert.equal(signal?.aborted, false);
  t.mock.timers.tick(1000); await drain();
  assert.equal(signal?.aborted, true);
  release(); await drain();
  run.push("progress", { progress: { type: "tool", name: "ls", state: "started" } });
  await drain(); t.mock.timers.tick(30_000); await drain();
  assert.equal(attempts, 1);
  run.push("run_succeeded", { result: { text: "完成" } }); await consume;
  assert.deepEqual(sent, ["完成"]);
});
