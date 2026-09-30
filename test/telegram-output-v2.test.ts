import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createApp } from "../src/app.js";
import { createTelegramProjection } from "../src/telegram-projection.js";
import { createSqliteRuntimeLog } from "../src/sqlite-runtime-log.js";

const update = { userId: 42, chatType: "private", text: "分析", messageId: 1 };

test("long Telegram code remains code and following prose remains formatted prose", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "output-v2-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const log = createSqliteRuntimeLog(dir);
  const code = "const value = 1;\n".repeat(450);
  const body = "```ts\n" + code + "```\n\n### 后续正文\n**结论**：完整。";
  const sent: string[] = [];
  const app = createApp({ ownerId: 42, dataDir: dir, log,
    answer: async (_messages, request) => {
      await log.append({ type: "text_snapshot", requestId: request.id, textSegmentId: "answer",
        protocolVersion: "json-text-v2", contentKind: "final", text: body });
      await log.append({ type: "text_finalized", requestId: request.id, textSegmentId: "answer",
        protocolVersion: "json-text-v2", contentKind: "final", text: body });
      await request.onText?.("answer");
      return body;
    }, send: async () => { throw new Error("use Telegram projection"); },
    telegram: { draft: async () => {}, send: async (text) => { sent.push(text); return sent.length; },
      edit: async () => { throw new Error("formal messages must stay fixed"); } },
  });
  await app.handle(update);
  assert.ok(sent.length >= 3);
  assert.ok(sent.every((text) => text.replace(/<[^>]*>/g, "").length <= 4096));
  const last = sent.at(-1)!;
  assert.match(last, /<b>后续正文<\/b>/);
  assert.match(last, /<b>结论<\/b>/);
  assert.ok(!last.includes("<pre>"));
  assert.equal(sent.join("").match(/const value = 1;/g)?.length, 450);
  assert.ok((await log.read()).some((event) => event.type === "delivery_succeeded"));
});

// Run through the real model adapter and observe only Telegram's public transport.
import { createServer } from "node:http";
import { createPiAgent } from "../src/pi-agent.js";

test("model status stays temporary, results are separate, and the final draft appears before generation ends", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "output-stream-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  let turn = 0;
  let generating = false;
  const server = createServer(async (req, res) => {
    for await (const _ of req) { /* consume request */ }
    const bodies = [JSON.stringify({ type: "status", text: "正在分析" }),
      JSON.stringify({ type: "result", text: "阶段性成果" }),
      JSON.stringify({ type: "final", text: "最终**正文**，你好😀。" })];
    const body = bodies[Math.min(turn++, 2)]!;
    generating = turn === 3;
    res.writeHead(200, { "content-type": "text/event-stream" });
    const write = (content: string) => res.write(`data: ${JSON.stringify({ id: "test", choices: [{ index: 0, delta: { content }, finish_reason: null }] })}\n\n`);
    if (turn === 3) {
      const at = body.indexOf("，你好");
      write(body.slice(0, at));
      await new Promise((resolve) => setTimeout(resolve, 450));
      write(body.slice(at));
      await new Promise((resolve) => setTimeout(resolve, 200));
    } else write(body);
    generating = false;
    res.end(`data: ${JSON.stringify({ id: "test", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const agent = await createPiAgent({ dataDir: dir, promptFile: "system-prompt.md", deepseekKey: "test",
    modelBaseUrl: `http://127.0.0.1:${address.port}` });
  t.after(() => agent.close());
  const sent: string[] = [];
  const previews: { text: string; generating: boolean; id: number }[] = [];
  const app = createApp({ ownerId: 42, dataDir: dir, log: createSqliteRuntimeLog(dir), answer: agent.answer,
    send: async (text) => { sent.push(text); },
    telegram: { send: async (text) => { sent.push(text); return sent.length; }, edit: async () => { throw new Error("no edits"); },
      draft: async (id, text) => { previews.push({ id, text, generating }); } },
  });
  await app.handle(update);
  assert.deepEqual(sent, ["阶段性成果", "最终<b>正文</b>，你好😀。"]);
  assert.ok(previews.some((preview) => preview.generating && preview.text.includes("最终")));
  assert.ok(!previews.some((preview) => preview.text.includes('"type"')));
  const finalPreviews = previews.filter((preview) => preview.text.includes("最终"));
  assert.ok(finalPreviews.every((preview) => preview.id === finalPreviews[0]!.id));
});

test("validated long content commits complete prefixes while the remaining draft keeps streaming", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "output-prefix-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const log = createSqliteRuntimeLog(dir);
  const first = "第一段" + "甲".repeat(3500);
  const second = "第二段" + "乙".repeat(1500);
  const sent: string[] = [];
  const drafts: string[] = [];
  let beforeComplete: string[] = [];
  const app = createApp({ ownerId: 42, dataDir: dir, log,
    answer: async (_messages, request) => {
      await log.append({ type: "text_snapshot", requestId: request.id, textSegmentId: "long",
        protocolVersion: "json-text-v2", contentKind: "final", validatedPrefix: true,
        text: first + "\n\n" + second + "\n\n第三段正在生成" });
      await request.onText?.("long");
      await new Promise((resolve) => setTimeout(resolve, 250));
      beforeComplete = [...sent];
      const text = first + "\n\n" + second + "\n\n第三段已经完成";
      await log.append({ type: "text_snapshot", requestId: request.id, textSegmentId: "long",
        protocolVersion: "json-text-v2", contentKind: "final", text });
      await log.append({ type: "text_finalized", requestId: request.id, textSegmentId: "long",
        protocolVersion: "json-text-v2", contentKind: "final", text });
      await request.onText?.("long");
      return text;
    }, send: async () => {},
    telegram: { send: async (text) => { sent.push(text); return sent.length; },
      edit: async () => { throw new Error("fixed formal messages"); }, draft: async (_id, text) => { drafts.push(text); } },
  });
  await app.handle(update);
  assert.deepEqual(beforeComplete, [first]);
  assert.ok(drafts.some((text) => text.startsWith("第二段")));
  assert.equal(sent[0], first);
  assert.equal(sent[1], second + "\n\n第三段已经完成");
});

test("unknown formal delivery is never repeated and the user gets a durable incomplete notice", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "output-unknown-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const log = createSqliteRuntimeLog(dir);
  const attempts: string[] = [];
  const options = { ownerId: 42, dataDir: dir, log,
    answer: async (_messages: unknown, request: { id: string; onText?: (id: string) => Promise<void> }) => {
      await log.append({ type: "text_snapshot", requestId: request.id, textSegmentId: "unknown",
        protocolVersion: "json-text-v2", contentKind: "final", text: "完整正文" });
      await log.append({ type: "text_finalized", requestId: request.id, textSegmentId: "unknown",
        protocolVersion: "json-text-v2", contentKind: "final", text: "完整正文" });
      await request.onText?.("unknown"); return "完整正文";
    }, send: async () => { throw new Error("not durable"); },
    telegram: { send: async (text: string) => { attempts.push(text); if (text === "完整正文") throw new Error("timeout"); return attempts.length; },
      edit: async () => {}, draft: async () => {} },
  };
  await createApp(options).handle(update);
  await createApp(options).recover();
  await createApp(options).recover();
  assert.equal(attempts.filter((text) => text === "完整正文").length, 1);
  assert.equal(attempts.filter((text) => text.includes("可能不完整")).length, 1);
  assert.ok(!(await log.read()).some((event) => event.type === "delivery_succeeded"));
});

test("the real model stream can commit validated frames before the response finishes", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "output-frame-model-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const first = "已完成第一段" + "甲".repeat(3500);
  const rest = "第二段" + "乙".repeat(1500) + "\n\n第三段结束。";
  let generating = true;
  const sent: { text: string; generating: boolean }[] = [];
  const server = createServer(async (req, res) => {
    for await (const _ of req) {}
    res.writeHead(200, { "content-type": "text/event-stream" });
    const write = (content: string) => res.write(`data: ${JSON.stringify({ id: "test", choices: [{ index: 0, delta: { content }, finish_reason: null }] })}\n\n`);
    write(JSON.stringify({ type: "final", text: first + "\n\n" + rest, end: false }) + "\n");
    await new Promise((resolve) => setTimeout(resolve, 500));
    write(JSON.stringify({ type: "final", text: "", end: true }));
    generating = false;
    res.end(`data: ${JSON.stringify({ id: "test", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const agent = await createPiAgent({ dataDir: dir, promptFile: "system-prompt.md", deepseekKey: "test",
    modelBaseUrl: `http://127.0.0.1:${address.port}` });
  t.after(() => agent.close());
  const app = createApp({ ownerId: 42, dataDir: dir, log: createSqliteRuntimeLog(dir), answer: agent.answer,
    send: async () => { throw new Error("projection required"); }, telegram: {
      send: async (text) => { sent.push({ text, generating }); return sent.length; }, draft: async () => {},
      edit: async () => { throw new Error("immutable messages"); },
    } });
  await app.handle(update);
  assert.equal(sent[0]?.text, first);
  assert.equal(sent[0]?.generating, true);
  assert.equal(sent[1]?.text, rest);
});

for (const failure of ["model", "rejected", "rate-limit", "commit"] as const) {
  test(`Telegram v2 preserves delivery boundaries on ${failure} failure`, async (t) => {
    const dir = await mkdtemp(join(tmpdir(), "output-failure-"));
    t.after(() => rm(dir, { recursive: true, force: true }));
    const base = createSqliteRuntimeLog(dir);
    let broken = false;
    const log = failure === "commit" ? { ...base, append: async (event: Parameters<typeof base.append>[0]) => {
      if (!broken && event.type === "telegram_delivery_succeeded" && event.textSegmentId === "failure") {
        broken = true; throw new Error("commit failure");
      }
      return base.append(event);
    } } : base;
    const sent: string[] = [];
    let rejected = false;
    const make = () => createApp({ ownerId: 42, dataDir: dir, log,
      answer: async (_messages, request) => {
        await log.append({ type: "text_snapshot", requestId: request.id, textSegmentId: "failure",
          protocolVersion: "json-text-v2", contentKind: "final", text: "已生成正文" });
        await request.onText?.("failure");
        if (failure === "model") {
          await new Promise((resolve) => setTimeout(resolve, 200));
          throw new Error("model failure");
        }
        await log.append({ type: "text_finalized", requestId: request.id, textSegmentId: "failure",
          protocolVersion: "json-text-v2", contentKind: "final", text: "已生成正文" });
        await request.onText?.("failure"); return "已生成正文";
      }, send: async () => { throw new Error("persistent notice required"); },
      telegram: { draft: async () => {}, edit: async () => { throw new Error("no edits"); },
        send: async (text) => {
          sent.push(text);
          if ((failure === "rejected" || failure === "rate-limit") && text === "已生成正文" && !rejected) {
            rejected = true; throw new Error("known rejection");
          }
          return sent.length;
        }, isRejected: (error) => error instanceof Error && error.message === "known rejection",
        retryAfter: () => failure === "rate-limit" ? 30 : undefined },
    });
    await make().handle(update);
    await make().recover();
    const events = await base.read();
    if (failure === "model") {
      assert.ok(!sent.includes("已生成正文"));
      assert.equal(sent.filter((text) => text.includes("尚未完成")).length, 1);
    } else if (failure === "commit") {
      assert.equal(sent.filter((text) => text === "已生成正文").length, 1);
      assert.ok(!events.some((event) => event.type === "delivery_succeeded"));
    } else {
      assert.equal(sent.filter((text) => text === "已生成正文").length, 2);
      assert.ok(events.some((event) => event.type === "delivery_succeeded"));
    }
  });
}

test("long mixed content retains Unicode, table cells, link labels and list items within Telegram limits", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "output-mixed-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const log = createSqliteRuntimeLog(dir);
  const emoji = "👨‍👩‍👧‍👦";
  const body = "### 内容\n\n" + emoji.repeat(600) + "\n\n" +
    "1. 第一项\n2. 第二项\n\n[来源](https://example.com?a=1&b=2)\n\n" +
    "| 名称 | 值 |\n| --- | --- |\n| 中文 | A&B<值> |\n| emoji | 😀 |\n\n" +
    "```text\n" + "<&>".repeat(1800) + "\n```\n\n尾部结论。";
  const sent: string[] = [];
  const app = createApp({ ownerId: 42, dataDir: dir, log,
    answer: async (_messages, request) => {
      await log.append({ type: "text_snapshot", requestId: request.id, textSegmentId: "mixed",
        protocolVersion: "json-text-v2", contentKind: "final", text: body });
      await log.append({ type: "text_finalized", requestId: request.id, textSegmentId: "mixed",
        protocolVersion: "json-text-v2", contentKind: "final", text: body });
      await request.onText?.("mixed"); return body;
    }, send: async () => {}, telegram: { send: async (text) => { sent.push(text); return sent.length; },
      edit: async () => { throw new Error("immutable"); } },
  });
  await app.handle(update);
  const joined = sent.join("");
  assert.equal(joined.split(emoji).length - 1, 600);
  assert.match(joined, /1\. 第一项\n2\. 第二项/);
  assert.match(joined, /<a href="https:\/\/example.com\?a=1&amp;b=2">来源<\/a>/);
  assert.match(joined, /名称: 中文/);
  assert.match(joined, /值: A&amp;B&lt;值&gt;/);
  assert.match(joined, /尾部结论。/);
  assert.equal(joined.replace(/<[^>]*>/g, "").match(/&lt;&amp;&gt;/g)?.length, 1800);
  for (const message of sent) {
    const visible = message.replace(/<[^>]*>/g, "").replace(/&(?:amp|lt|gt|quot);/g, "x");
    assert.ok(visible.length <= 4096);
    assert.ok(!visible.startsWith("\u200d") && !visible.endsWith("\u200d"));
    assert.equal((message.match(/<pre>/g) ?? []).length, (message.match(/<\/pre>/g) ?? []).length);
  }
});

test("a partially delivered stage prevents claiming the whole request was delivered", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "output-stage-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const log = createSqliteRuntimeLog(dir);
  const sent: string[] = [];
  const app = createApp({ ownerId: 42, dataDir: dir, log,
    answer: async (_messages, request) => {
      for (const [id, kind, text] of [["stage", "result", "阶段性正文"], ["last", "final", "最终正文"]]) {
        await log.append({ type: "text_snapshot", requestId: request.id, textSegmentId: id,
          protocolVersion: "json-text-v2", contentKind: kind, text });
        await log.append({ type: "text_finalized", requestId: request.id, textSegmentId: id,
          protocolVersion: "json-text-v2", contentKind: kind, text });
        await request.onText?.(id!);
      }
      return "最终正文";
    }, send: async () => {}, telegram: { send: async (text) => {
      sent.push(text); if (text === "阶段性正文") throw new Error("unknown"); return sent.length;
    }, edit: async () => {} },
  });
  await app.handle(update);
  assert.ok(sent.includes("最终正文"));
  assert.ok(sent.some((text) => text.includes("可能不完整")));
  assert.ok(!(await log.read()).some((event) => event.type === "delivery_succeeded"));
});

test("restart acknowledges fully sent v2 content without resending body or showing an incomplete notice", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "output-restart-complete-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const log = createSqliteRuntimeLog(dir);
  let crash = true;
  const wrapped = { ...log, append: async (event: Parameters<typeof log.append>[0]) => {
    if (event.type === "answer_generated" && crash) { crash = false; throw new Error("crash after send"); }
    return log.append(event);
  } };
  const sent: string[] = [];
  // Simulate a process crash by stopping directly at the projection boundary.
  await log.append({ type: "request_started", requestId: "complete-request" });
  await log.append({ type: "text_snapshot", requestId: "complete-request", textSegmentId: "complete-body",
    protocolVersion: "json-text-v2", contentKind: "final", text: "已经送达" });
  await log.append({ type: "text_finalized", requestId: "complete-request", textSegmentId: "complete-body",
    protocolVersion: "json-text-v2", contentKind: "final", text: "已经送达" });
  const projection = createTelegramProjection({ log: wrapped, chatId: 42,
    send: async (text) => { sent.push(text); return 1; }, edit: async () => {} });
  await projection.reconcile("complete-body");
  const app = createApp({ ownerId: 42, dataDir: dir, log, answer: async () => "unused", send: async () => {},
    telegram: { send: async (text) => { sent.push(text); return 2; }, edit: async () => {} } });
  await app.recover();
  await app.recover();
  assert.deepEqual(sent, ["已经送达"]);
  assert.equal((await log.read()).filter((event) => event.type === "delivery_succeeded").length, 1);
});

test("restart cannot confuse a delivered long prefix with the completed full answer", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "output-prefix-crash-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const log = createSqliteRuntimeLog(dir);
  const sent: string[] = [];
  const transport = { send: async (text: string) => { sent.push(text); return sent.length; }, edit: async () => {} };
  const text = "甲".repeat(3500) + "\n\n" + "乙".repeat(1500) + "\n\n结束";
  await log.append({ type: "request_started", requestId: "prefix-request" });
  await log.append({ type: "text_snapshot", requestId: "prefix-request", textSegmentId: "prefix-body",
    protocolVersion: "json-text-v2", contentKind: "final", validatedPrefix: true, text });
  await createTelegramProjection({ log, chatId: 42, ...transport }).reconcile("prefix-body");
  assert.equal(sent.length, 1);
  await log.append({ type: "text_finalized", requestId: "prefix-request", textSegmentId: "prefix-body",
    protocolVersion: "json-text-v2", contentKind: "final", text });
  const app = createApp({ ownerId: 42, dataDir: dir, log, telegram: transport, send: async () => {}, answer: async () => "unused" });
  await app.recover();
  assert.ok(!(await log.read()).some((event) => event.type === "delivery_succeeded"));
  assert.ok(sent.some((text) => text.includes("可能不完整")));
  assert.ok(!sent.some((text) => text.includes("乙")));
});
