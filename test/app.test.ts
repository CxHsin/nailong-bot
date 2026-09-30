import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createApp, DeliveryRejected } from "../src/app.js";

test("owner can chat, restart, and reset without deleting the event log", async () => {
  const dir = await mkdtemp(join(tmpdir(), "telegram-agent-"));
  const seen: string[][] = [];
  const replies: string[] = [];
  const makeApp = () => createApp({
    ownerId: 42,
    dataDir: dir,
    send: async (text) => { replies.push(text); },
    answer: async (messages) => {
      seen.push(messages.map((message) => message.text));
      return `答复 ${seen.length}`;
    },
  });

  await makeApp().handle({ userId: 42, chatType: "private", text: "第一句", messageId: 1 });
  await makeApp().handle({ userId: 42, chatType: "private", text: "第二句", messageId: 2 });
  assert.deepEqual(seen[1], ["第一句", "答复 1", "第二句"]);
  await makeApp().handle({ userId: 42, chatType: "private", text: "/reset", messageId: 3 });
  await makeApp().handle({ userId: 42, chatType: "private", text: "新会话", messageId: 4 });
  assert.deepEqual(seen[2], ["新会话"]);
  assert.equal(replies.at(-2), "已开始新对话，旧记录仍保留在本地。");
  const events = (await readFile(join(dir, "events.jsonl"), "utf8")).trim().split("\n");
  assert.equal(events.filter((line) => JSON.parse(line).type === "message").length, 4);
  assert.equal(events.filter((line) => JSON.parse(line).type === "reset").length, 1);
  assert.equal(events.filter((line) => JSON.parse(line).type === "request_completed").length, 3);
});

test("strangers and groups cannot use the agent or enter its history", async () => {
  const dir = await mkdtemp(join(tmpdir(), "telegram-agent-"));
  const replies: string[] = [];
  let prompts = 0;
  const app = createApp({ ownerId: 42, dataDir: dir,
    send: async (text) => { replies.push(text); },
    answer: async () => { prompts++; return "secret"; },
  });
  await app.handle({ userId: 7, chatType: "private", text: "你好", messageId: 1 });
  await app.handle({ userId: 42, chatType: "supergroup", text: "你好", messageId: 2 });
  assert.equal(prompts, 0);
  assert.deepEqual(replies, []);
  await assert.rejects(readFile(join(dir, "events.jsonl"), "utf8"), { code: "ENOENT" });
});

test("a failed model turn is visible and never recorded as an assistant reply", async () => {
  const dir = await mkdtemp(join(tmpdir(), "telegram-agent-"));
  const replies: string[] = [];
  const app = createApp({ ownerId: 42, dataDir: dir,
    send: async (text) => { replies.push(text); },
    answer: async () => { throw new Error("provider failed"); },
  });
  await app.handle({ userId: 42, chatType: "private", text: "请回答", messageId: 1 });
  assert.match(replies[0] ?? "", /暂时处理失败/);
  const events = (await readFile(join(dir, "events.jsonl"), "utf8")).trim().split("\n");
  assert.equal(events.filter((line) => JSON.parse(line).type === "message").length, 1);
  assert.match(events[0] ?? "", /请回答/);
  assert.ok(events.some((line) => JSON.parse(line).type === "request_failed"));
});

test("the app leaves history selection to Projection without silently dropping messages", async () => {
  const dir = await mkdtemp(join(tmpdir(), "telegram-agent-"));
  const seen: string[][] = [];
  const app = createApp({ ownerId: 42, dataDir: dir,
    send: async () => {},
    answer: async (messages) => { seen.push(messages.map((message) => message.text)); return "ok"; },
  });
  await app.handle({ userId: 42, chatType: "private", text: "first", messageId: 1 });
  await app.handle({ userId: 42, chatType: "private", text: "second", messageId: 2 });
  assert.deepEqual(seen[1], ["first", "ok", "second"]);
  assert.match(await readFile(join(dir, "events.jsonl"), "utf8"), /first/);
});

test("a Telegram delivery failure preserves the generated answer without treating it as delivered", async () => {
  const dir = await mkdtemp(join(tmpdir(), "telegram-agent-"));
  const app = createApp({ ownerId: 42, dataDir: dir,
    send: async () => { throw new Error("Telegram unavailable"); },
    answer: async () => "not delivered",
  });
  await assert.rejects(app.handle({ userId: 42, chatType: "private", text: "hello", messageId: 1 }));
  const events = (await readFile(join(dir, "events.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  assert.ok(events.some((event) => event.type === "answer_generated" && event.text === "not delivered"));
  assert.ok(events.some((event) => event.type === "delivery_unknown"));
  assert.ok(!events.some((event) => event.type === "delivery_succeeded"));
});

test("a partially delivered answer records the delivered chunk and stays out of later context", async () => {
  const dir = await mkdtemp(join(tmpdir(), "telegram-agent-"));
  const seen: string[][] = [];
  let sendCount = 0;
  const makeApp = () => createApp({ ownerId: 42, dataDir: dir,
    answer: async (messages) => { seen.push(messages.map((message) => message.text)); return "long answer"; },
    send: async (text, _update, onChunk) => {
      if (text === "long answer" && sendCount++ === 0) {
        await onChunk?.(1, 2);
        throw new Error("second chunk failed");
      }
    },
  });
  await makeApp().handle({ userId: 42, chatType: "private", text: "first", messageId: 1 });
  const events = (await readFile(join(dir, "events.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  assert.ok(events.some((event) => event.type === "delivery_chunk_succeeded" && event.index === 1 && event.total === 2));
  assert.ok(events.some((event) => event.type === "delivery_unknown"));
  assert.ok(!events.some((event) => event.type === "delivery_succeeded"));
  await makeApp().handle({ userId: 42, chatType: "private", text: "second", messageId: 2 });
  assert.deepEqual(seen[1], ["first", "second"]);
});

test("legacy message events remain readable after the runtime log upgrade", async () => {
  const dir = await mkdtemp(join(tmpdir(), "telegram-agent-"));
  await writeFile(join(dir, "events.jsonl"), [
    { type: "message", role: "user", text: "old user", at: "2026-01-01T00:00:00Z" },
    { type: "message", role: "assistant", text: "old reply", at: "2026-01-01T00:00:01Z" },
  ].map((event) => JSON.stringify(event)).join("\n") + "\n");
  let seen: string[] = [];
  const app = createApp({ ownerId: 42, dataDir: dir, send: async () => {},
    answer: async (messages) => { seen = messages.map((message) => message.text); return "new reply"; },
  });
  await app.handle({ userId: 42, chatType: "private", text: "new user", messageId: 3 });
  assert.deepEqual(seen, ["old user", "old reply", "new user"]);
});

test("initial runtime log failure informs the user and does not start the agent", async () => {
  const dir = await mkdtemp(join(tmpdir(), "telegram-agent-"));
  await mkdir(join(dir, "events.jsonl"));
  const replies: string[] = [];
  let calls = 0;
  const app = createApp({ ownerId: 42, dataDir: dir,
    answer: async () => { calls++; return "should not run"; },
    send: async (text) => { replies.push(text); },
  });
  await assert.rejects(app.handle({ userId: 42, chatType: "private", text: "hello", messageId: 1 }));
  assert.equal(calls, 0);
  assert.match(replies[0] ?? "", /运行日志暂时不可用/);
});

test("a definite Telegram rejection is recorded as failed delivery", async () => {
  const dir = await mkdtemp(join(tmpdir(), "telegram-agent-"));
  const app = createApp({ ownerId: 42, dataDir: dir, answer: async () => "answer",
    send: async () => { throw new DeliveryRejected("Telegram rejected"); },
  });
  await assert.rejects(app.handle({ userId: 42, chatType: "private", text: "hello", messageId: 1 }));
  const events = (await readFile(join(dir, "events.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  assert.ok(events.some((event) => event.type === "delivery_failed"));
  assert.ok(!events.some((event) => event.type === "delivery_unknown"));
});


test("owner can configure bot prompt without adding commands to model history", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "prompt-config-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const replies: string[] = [];
  const prompts: Array<string | undefined> = [];
  const appOptions = { ownerId: 42, dataDir: dir, send: async (text: string) => { replies.push(text); },
    answer: async (_messages: unknown, request: { botPrompt?: string }) => { prompts.push(request.botPrompt); return "答案"; } };
  const app = createApp(appOptions);
  await app.handle({ userId: 99, chatType: "private", text: "/prompt set 不能生效", messageId: 1 });
  await app.handle({ userId: 42, chatType: "private", text: "/prompt set 详细解释", messageId: 2 });
  await app.handle({ userId: 42, chatType: "private", text: "/prompt", messageId: 3 });
  assert.match(replies.at(-1) ?? "", /详细解释/);
  await createApp(appOptions).handle({ userId: 42, chatType: "private", text: "你好", messageId: 4 });
  assert.deepEqual(prompts, ["详细解释"]);
  await app.handle({ userId: 42, chatType: "private", text: "/prompt reset", messageId: 5 });
  await app.handle({ userId: 42, chatType: "private", text: "你好", messageId: 6 });
  assert.deepEqual(prompts, ["详细解释", undefined]);
});
