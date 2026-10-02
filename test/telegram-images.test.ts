import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Bot } from "grammy";
import { Response as ApiResponse } from "node-fetch";
import test from "node:test";
import { createApp } from "../src/application/app.js";
import { createPiAgent } from "../src/agent/pi-agent.js";
import { createSqliteRuntimeLog } from "../src/runtime/sqlite-runtime-log.js";
import { registerTelegramInput, downloadTelegramPhoto } from "../src/telegram/telegram-input.js";
import { estimateInput } from "../src/context/input-budget.js";
import { summaryInput } from "../src/context/history-summary.js";
import { closeFixture } from "./fixtures/cleanup.js";

const image = { type: "image" as const, mimeType: "image/png", data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aE1cAAAAASUVORK5CYII=" };
function update(id: number, owner = 42, caption?: string, text?: string) {
  return { update_id: id, message: { message_id: id, date: 1,
    chat: { id: owner, first_name: "Owner", type: "private" as const }, from: { id: owner, is_bot: false, first_name: "Owner" },
    ...(text !== undefined ? { text } : { photo: [{ file_id: "small", file_unique_id: "small", width: 10, height: 10 },
      { file_id: "large", file_unique_id: "large", width: 100, height: 100 }], ...(caption ? { caption } : {}) }) } };
}
function bot(notices?: string[]) { return new Bot("123:test", { botInfo: {
  id: 123, is_bot: true, first_name: "Test", username: "test_bot", can_join_groups: false,
  can_read_all_group_messages: false, supports_inline_queries: false, can_connect_to_business: false,
  has_main_web_app: false, has_topics_enabled: false, allows_users_to_create_topics: false,
  can_manage_bots: false, supports_join_request_queries: false,
}, client: { fetch: async (_url, init) => {
  const payload = JSON.parse(String(init?.body));
  if (notices && payload.text) notices.push(payload.text);
  return new ApiResponse(JSON.stringify({ ok: true, result: payload.file_id
    ? { file_id: payload.file_id, file_unique_id: "unique", file_path: "photos/example.png" }
    : { message_id: 100, date: 1, chat: { id: 42, type: "private", first_name: "Owner" }, text: payload.text } }));
} } }); }

test("actual Telegram photo updates keep caption and images through model calls, restart and reset", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "telegram-image-"));
  const promptFile = join(dir, "prompt.md"); await writeFile(promptFile, "请分析用户图片。");
  const payloads: Array<{ messages: Array<{ role: string; content: unknown }> }> = [];
  const server = createServer(async (req, res) => {
    let body = ""; for await (const chunk of req) body += chunk;
    payloads.push(JSON.parse(body));
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end("data: " + JSON.stringify({ choices: [{ index: 0, delta: { content: JSON.stringify({ type: "final", text: "图片已分析" }) }, finish_reason: "stop" }] }) + "\n\ndata: [DONE]\n\n");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const options = { dataDir: dir, promptFile, deepseekKey: "test", modelBaseUrl: "http://127.0.0.1:" + address.port };
  const inputs: Array<ReturnType<typeof registerTelegramInput>> = [];
  let agent = await createPiAgent(options);
  t.after(() => closeFixture({ server, dir, shutdown: async () => {
    try { await Promise.all(inputs.map((input) => input.finish())); } finally { await agent.close(); }
  } }));
  const log = createSqliteRuntimeLog(dir);
  const replies: string[] = [];
  let downloads = 0;
  const install = () => {
    const b = bot();
    const app = createApp({ ownerId: 42, dataDir: dir, log, answer: agent.answer, send: async (text) => { replies.push(text); } });
    inputs.push(registerTelegramInput(b, { ownerId: 42, download: async (fileId) => { assert.equal(fileId, "large"); downloads++; return image; },
      handle: (input, started) => app.handle(input, started), reportFailure: () => {} }));
    return b;
  };
  let b = install();
  await b.handleUpdate(update(1, 42, "你怎么看"));
  // The production middleware releases after durable acceptance, so wait for the final reply.
  for (let i = 0; i < 100 && replies.length < 1; i++) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(replies[0], "图片已分析");
  await b.handleUpdate(update(1, 42, "你怎么看"));
  assert.equal(payloads.length, 1, "replayed photos cannot execute the model twice");
  const first = JSON.stringify(payloads[0]);
  assert.match(first, /你怎么看/); assert.match(first, /image_url/); assert.ok(first.includes("data:image/png;base64," + image.data));
  await b.handleUpdate(update(2, 42, undefined, "再解释一下图中的文字"));
  for (let i = 0; i < 100 && replies.length < 2; i++) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.match(JSON.stringify(payloads.at(-1)), /image_url/);
  await inputs.at(-1)!.finish(); await agent.close(); agent = await createPiAgent(options); b = install();
  await b.handleUpdate(update(3, 42, undefined, "继续分析这张图"));
  for (let i = 0; i < 100 && replies.length < 3; i++) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.match(JSON.stringify(payloads.at(-1)), /image_url/);
  await b.handleUpdate(update(4, 42, undefined, "/reset"));
  await b.handleUpdate(update(5, 42, undefined, "新对话"));
  for (let i = 0; i < 100 && replies.length < 5; i++) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.ok(!JSON.stringify(payloads.at(-1)).includes("image_url"));
  await b.handleUpdate(update(6));
  for (let i = 0; i < 100 && replies.length < 6; i++) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.match(JSON.stringify(payloads.at(-1)), /image_url/);
  assert.equal(downloads, 3);
  assert.equal((await log.read()).filter((event) => event.type === "message" && event.role === "user" && Array.isArray(event.images)).length, 2);
});

test("photo permissions are checked before download and failures never silently drop caption", async () => {
  const notices: string[] = []; const b = bot(notices); let downloads = 0; let handled = 0;
  registerTelegramInput(b, { ownerId: 42, download: async () => { downloads++; throw new Error("secret download URL"); },
    handle: async () => { handled++; }, reportFailure: () => {} });
  await b.handleUpdate(update(1, 99, "偷看"));
  assert.equal(downloads, 0); assert.equal(handled, 0);
  await b.handleUpdate(update(2, 42, "你怎么看"));
  assert.equal(downloads, 1); assert.equal(handled, 0);
  assert.equal(notices.length, 1); assert.match(notices[0]!, /图片.*失败/);
  assert.ok(!notices[0]!.includes("secret"));
});

test("image budgets ignore base64 inflation and compaction sends actual image blocks", () => {
  const large = { ...image, data: "A".repeat(3_000_000) };
  const message = { role: "user" as const, timestamp: 0, content: [{ type: "text" as const, text: "分析图片" }, large] };
  assert.ok(estimateInput({ messages: [message] }) < 30000, "image bytes are not ordinary text tokens");
  const input = summaryInput(undefined, [message]);
  assert.ok(Array.isArray(input.messages[0]!.content));
  const content = input.messages[0]!.content;
  assert.ok(typeof content !== "string" && content.some((part) => part.type === "image" && part.data === large.data));
  const text = typeof content !== "string" ? content.filter((part) => part.type === "text").map((part) => part.text).join("") : content;
  assert.ok(!text.includes(large.data), "summary metadata must reference, not stringify, image bytes");
});


test("photo downloads preserve bytes and reject non-image responses", async () => {
  const b = bot();
  const bytes = Buffer.from(image.data, "base64");
  const downloaded = await downloadTelegramPhoto(b, "test-token", "large", async (_url, init) => {
    assert.ok(init?.signal);
    return new Response(bytes);
  });
  assert.deepEqual(downloaded, image);
  await assert.rejects(downloadTelegramPhoto(b, "test-token", "large", async () => new Response("not an image")), /格式/);
  await assert.rejects(downloadTelegramPhoto(b, "test-token", "large", async () =>
    new Response(new Uint8Array(10 * 1024 * 1024 + 1))), /限制/);
});

test("shutdown acceptance waits for photo download and durable input start", async () => {
  const b = bot();
  let releaseDownload!: () => void;
  const download = new Promise<void>((resolve) => { releaseDownload = resolve; });
  let markStarted!: () => void;
  let releaseRequest!: () => void;
  const request = new Promise<void>((resolve) => { releaseRequest = resolve; });
  const input = registerTelegramInput(b, { ownerId: 42,
    download: async () => { await download; return image; },
    handle: async (_update, started) => { markStarted = started; await request; }, reportFailure: () => {} });
  const updateDone = b.handleUpdate(update(1));
  await new Promise((resolve) => setTimeout(resolve, 0));
  let accepted = false;
  const waiting = input.accepted().then(() => { accepted = true; });
  await new Promise((resolve) => setTimeout(resolve, 0)); assert.equal(accepted, false);
  releaseDownload(); await new Promise((resolve) => setTimeout(resolve, 0)); assert.equal(accepted, false);
  markStarted(); await updateDone; await waiting; assert.equal(accepted, true);
  releaseRequest(); await input.finish();
});
