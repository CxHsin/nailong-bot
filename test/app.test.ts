import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createApp } from "../src/app.js";

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
  assert.equal(events.length, 8);
  assert.match(events[4] ?? "", /reset/);
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
  assert.equal(events.length, 1);
  assert.match(events[0] ?? "", /请回答/);
});

test("long context is limited while the complete append-only record remains", async () => {
  const dir = await mkdtemp(join(tmpdir(), "telegram-agent-"));
  const seen: string[][] = [];
  const app = createApp({ ownerId: 42, dataDir: dir, contextChars: 8,
    send: async () => {},
    answer: async (messages) => { seen.push(messages.map((message) => message.text)); return "ok"; },
  });
  await app.handle({ userId: 42, chatType: "private", text: "first", messageId: 1 });
  await app.handle({ userId: 42, chatType: "private", text: "second", messageId: 2 });
  assert.deepEqual(seen[1], ["second"]);
  assert.match(await readFile(join(dir, "events.jsonl"), "utf8"), /first/);
});

test("a Telegram delivery failure does not record a successful answer", async () => {
  const dir = await mkdtemp(join(tmpdir(), "telegram-agent-"));
  const app = createApp({ ownerId: 42, dataDir: dir,
    send: async () => { throw new Error("Telegram unavailable"); },
    answer: async () => "not delivered",
  });
  await assert.rejects(app.handle({ userId: 42, chatType: "private", text: "hello", messageId: 1 }));
  assert.doesNotMatch(await readFile(join(dir, "events.jsonl"), "utf8"), /not delivered/);
});
