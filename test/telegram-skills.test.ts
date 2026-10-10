import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Bot } from "grammy";
import { Response as ApiResponse } from "node-fetch";
import { createPiAgent } from "../src/agent/pi-agent.js";
import { createAgentHost } from "../src/application/agent-host.js";
import { createRuntimeEventLog } from "../src/runtime/event-log.js";
import { initializeTelegramHostChannel } from "../src/channel/telegram/host-channel.js";
import { createTestServer } from "./fixtures/http-server.js";

const image = { type: "image" as const, mimeType: "image/png", data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=" };
async function fixture(t: TestContext, skills: Array<[string, string]>, respond?: (data: any, count: number) => Promise<void>, nativeStream = false) {
  const dir = await mkdtemp(join(tmpdir(), "telegram-skills-"));
  const sources = [...new Set(skills.map(([source]) => source))];
  for (const [source, name] of skills) {
    const root = join(dir, source, name); await mkdir(root, { recursive: true });
    await writeFile(join(root, "SKILL.md"), `---\nname: ${name}\ndescription: ${source} ${name} workflow\n---\nINSTRUCTION ${source}:${name}`);
  }
  const promptFile = join(dir, "prompt.md"); await writeFile(promptFile, "agent");
  const wire: any[] = [];
  const server = createTestServer(t, async (req, res) => {
    let raw = ""; for await (const chunk of req) raw += chunk;
    const data = JSON.parse(raw); wire.push(data); await respond?.(data, wire.length);
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: "任务完成" }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const agent = await createPiAgent({ dataDir: dir, promptFile, deepseekKey: "test", memoryBootstrap: false,
    modelBaseUrl: `http://127.0.0.1:${address.port}`, skillSources: sources.map((name) => ({ name, path: join(dir, name) })) });
  const log = await createRuntimeEventLog(dir); const host = createAgentHost({ dataDir: dir, promptFile, log, agent });
  const replies: string[] = []; const drafts: string[] = []; let downloads = 0;
  const bot = new Bot("123:test", { client: { fetch: async (url) => new ApiResponse(JSON.stringify({ ok: true,
    result: String(url).endsWith("getMe") ? { id: 123, is_bot: true, first_name: "bot", username: "test_bot" } : true })) } });
  const channel = await initializeTelegramHostChannel({ bot, ownerId: 42, host,
    transport: { nativeStream, send: async (text) => { replies.push(text); return 100 + replies.length; }, draft: async (_id, text) => { drafts.push(text); } },
    download: async () => { downloads++; return image; }, reportFailure: (error) => { throw error; },
    onDelivered: (event, telegramMessageId) => host.recordDelivery(event, { channel: "telegram", telegramMessageId }) });
  t.after(async () => { await channel.finish(); await agent.close(); server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve())); await rm(dir, { recursive: true, force: true }); });
  let nextId = 0;
  const send = async (text: string, options: { photo?: boolean; owner?: number; group?: boolean; id?: number; reply?: number; pending?: boolean } = {}) => {
    const id = options.id ?? ++nextId; const owner = options.owner ?? 42;
    await bot.handleUpdate({ update_id: id, message: { message_id: id, date: 0,
      from: { id: owner, is_bot: false, first_name: "owner" },
      chat: options.group ? { id: owner, type: "group", title: "group" } : { id: owner, type: "private", first_name: "owner" },
      ...(options.reply ? { reply_to_message: { message_id: options.reply, date: 0, chat: { id: 42, type: "private" as const, first_name: "owner" }, text: "prior answer", reply_to_message: undefined } } : {}),
      ...(options.photo ? { caption: text, photo: [{ file_id: "photo", file_unique_id: "photo", width: 1, height: 1 }] } : { text }) } });
    if (!options.pending) await channel.finish();
  };
  return { dir, wire, log, host, send, replies, drafts, channel, downloads: () => downloads };
}

test("Telegram caption slash skills normalize bot suffixes and preserve attachments and metadata", async (t) => {
  const f = await fixture(t, [["team", "subtitle-refine"], ["team", "other"]]);
  await f.send("/kvcache", { id: 90 });
  await f.send("/team:subtitle-refine@test_bot /other@TEST_BOT /team:subtitle-refine 精修字幕", { photo: true, reply: 101 });
  assert.equal(f.wire.length, 1);
  const facts = await f.log.read();
  assert.deepEqual(facts.filter((event) => event.type === "skill_loaded").map((event) => `${event.source}:${event.name}`), ["team:subtitle-refine", "team:other"]);
  const user = facts.find((event) => event.type === "message" && event.role === "user")!;
  assert.equal(user.text, "/team:subtitle-refine /other /team:subtitle-refine 精修字幕");
  assert.equal(user.messageId, 1); assert.equal(user.replyToMessageId, 101); assert.deepEqual(user.images, [image]);
  assert.match(JSON.stringify(f.wire[0]), /INSTRUCTION team:subtitle-refine/);
  assert.match(JSON.stringify(f.wire[0]), /用户明确回复的 KV 缓存统计报表/);
  assert.ok(JSON.stringify(f.wire[0]).includes(`data:image/png;base64,${image.data}`));
  await f.send("/team:subtitle-refine@other_bot", { photo: true });
  await f.send("/subtitle-refine /other@other_bot");
  await f.send("/subtitle-refine", { owner: 99 }); await f.send("/subtitle-refine", { group: true });
  assert.equal(f.wire.length, 1); assert.equal(f.downloads(), 1);
  await f.send("/subtitle-refine@test_bot\r\n继续处理");
  assert.equal(f.wire.length, 2);
  assert.equal((await f.log.read()).filter((event) => event.type === "skill_loaded").length, 3);
});

test("Telegram resolves every leading reference before loading and keeps built-in commands available", async (t) => {
  const f = await fixture(t, [["first", "demo"], ["second", "demo"], ["first", "help"], ["first", "clean-up"]]);
  await f.send("/demo task");
  assert.match(f.replies.at(-1)!, /歧义.*\/first:demo.*\/second:demo/);
  await f.send("/clean-up /missing task");
  assert.match(f.replies.at(-1)!, /未知.*\/missing.*\/first:clean-up/);
  assert.equal(f.wire.length, 0);
  assert.equal((await f.log.read()).some((event) => event.type === "skill_loaded"), false);
  await f.send("/help");
  assert.match(f.replies.at(-1)!, /技能调用：\/skill-name/);
  assert.equal(f.wire.length, 0);
  await f.send("/first:help");
  await f.send("/clean-up");
  assert.equal(f.wire.length, 2);
  assert.deepEqual((await f.log.read()).filter((event) => event.type === "skill_loaded").map((event) => event.name), ["help", "clean-up"]);
});

test("Telegram legacy mentions, paths, URLs and quoted or later references remain ordinary user input", async (t) => {
  const f = await fixture(t, [["personal", "demo"]]);
  for (const text of ["@demo task", "/tmp/demo.txt", "/demo/file", "https://example.com/demo", "Use /demo now", "> /demo task", "`/demo task`", "task\n/demo", "\n/demo"]) await f.send(text);
  assert.equal(f.wire.length, 9);
  assert.equal((await f.log.read()).some((event) => event.type === "skill_loaded"), false);
  await f.send("/demo task\n/missing quoted material");
  assert.equal(f.wire.length, 10);
  assert.deepEqual((await f.log.read()).filter((event) => event.type === "skill_loaded").map((event) => event.name), ["demo"]);
});

for (const nativeStream of [false, true]) test(`Telegram skill tasks queue and show ${nativeStream ? "native" : "standard"} progress without duplicate execution`, async (t) => {
  let release!: () => void; const gate = new Promise<void>((resolve) => { release = resolve; });
  let started!: () => void; const providerStarted = new Promise<void>((resolve) => { started = resolve; });
  const f = await fixture(t, [["personal", "demo"]], async (_data, count) => { if (count === 1) { started(); await gate; } }, nativeStream);
  t.after(() => release());
  try {
    await f.send("/demo first", { id: 1, pending: true }); await providerStarted;
    await f.send("/demo second", { id: 2, pending: true });
    await new Promise((resolve) => setTimeout(resolve, 350));
    assert.equal(f.wire.length, 1, "second skill must wait for the active Run");
    assert.ok(f.drafts.length > 0, "skill work must expose normal processing progress");
  } finally { release(); }
  await f.channel.finish();
  assert.equal(f.wire.length, 2); assert.equal(f.replies.filter((text) => text === "任务完成").length, 2);
  const delivered = f.replies.length;
  await f.send("/demo second", { id: 2 });
  assert.equal(f.wire.length, 2); assert.equal(f.replies.length, delivered);
});
