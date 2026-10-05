import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createApp } from "../src/application/app.js";
import { createTelegramProjection } from "../src/telegram/telegram-projection.js";
import { createSqliteRuntimeLog } from "../src/runtime/sqlite-runtime-log.js";

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
import { createPiAgent } from "../src/agent/pi-agent.js";

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
  const agent = await createPiAgent({ outputProtocol: "json-text-v2", dataDir: dir, promptFile: "system-prompt.md", deepseekKey: "test",
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
  const agent = await createPiAgent({ outputProtocol: "json-text-v2", dataDir: dir, promptFile: "system-prompt.md", deepseekKey: "test",
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
  const sent: string[] = [];
  // Simulate a process crash by stopping directly at the projection boundary.
  await log.append({ type: "request_started", requestId: "complete-request" });
  await log.append({ type: "text_snapshot", requestId: "complete-request", textSegmentId: "complete-body",
    protocolVersion: "json-text-v2", contentKind: "final", text: "已经送达" });
  await log.append({ type: "text_finalized", requestId: "complete-request", textSegmentId: "complete-body",
    protocolVersion: "json-text-v2", contentKind: "final", text: "已经送达" });
  const projection = createTelegramProjection({ log, chatId: 42,
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

test("malformed append frames cannot send unvalidated body or execute their tool calls", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "output-invalid-frame-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const log = createSqliteRuntimeLog(dir);
  let calls = 0;
  const sent: string[] = [];
  const server = createServer(async (req, res) => {
    for await (const _ of req) {}
    const raw = calls++ === 0 ? JSON.stringify({ type: "result", text: "不应发送正文", end: false, extra: true }) :
      JSON.stringify({ type: "final", text: "纠正后的正文" });
    const toolCalls = calls === 1 ? [{ index: 0, id: "forbidden", type: "function",
      function: { name: "write", arguments: JSON.stringify({ path: "bad.md", content: "bad" }) } }] : undefined;
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(`data: ${JSON.stringify({ id: "test", choices: [{ index: 0,
      delta: { content: raw, ...(toolCalls ? { tool_calls: toolCalls } : {}) }, finish_reason: toolCalls ? "tool_calls" : "stop" }] })}\n\ndata: [DONE]\n\n`);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const agent = await createPiAgent({ outputProtocol: "json-text-v2", dataDir: dir, promptFile: "system-prompt.md", deepseekKey: "test",
    modelBaseUrl: `http://127.0.0.1:${address.port}` });
  t.after(() => agent.close());
  const app = createApp({ ownerId: 42, dataDir: dir, log, answer: agent.answer,
    send: async () => {}, telegram: { send: async (text) => { sent.push(text); return sent.length; },
      draft: async () => {}, edit: async () => {} } });
  await app.handle(update);
  assert.deepEqual(sent, ["纠正后的正文"]);
  assert.ok(!(await log.read()).some((event) => event.type === "tool_dispatch"));
});

test("failed generation after a valid long prefix keeps only that prefix and a single failure notice", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "output-prefix-failure-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const log = createSqliteRuntimeLog(dir);
  const first = "第一段" + "甲".repeat(3500);
  const sent: string[] = [];
  const app = createApp({ ownerId: 42, dataDir: dir, log,
    answer: async (_messages, request) => {
      await log.append({ type: "text_snapshot", requestId: request.id, textSegmentId: "failed-prefix",
        protocolVersion: "json-text-v2", contentKind: "final", validatedPrefix: true,
        text: first + "\n\n" + "乙".repeat(1500) + "\n\n未完成" });
      await request.onText?.("failed-prefix");
      await new Promise((resolve) => setTimeout(resolve, 220));
      throw new Error("generation failed");
    }, send: async () => {}, telegram: { send: async (text) => { sent.push(text); return sent.length; },
      draft: async () => {}, edit: async () => {} } });
  await app.handle(update);
  await app.recover();
  assert.equal(sent[0], first);
  assert.equal(sent.length, 2);
  assert.match(sent[1]!, /尚未完成/);
  assert.ok(!sent.join("").includes("乙"));
});

test("late Markdown reference definitions cannot mutate an already sent prefix", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "output-reference-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const log = createSqliteRuntimeLog(dir);
  const sent: string[] = [];
  let sentBeforeDefinition = -1;
  const prefix = "[label][ref]\n\n" + "甲".repeat(3990) + "\n\n尾段";
  const body = prefix + "\n\n[ref]: https://example.com";
  const app = createApp({ ownerId: 42, dataDir: dir, log,
    answer: async (_messages, request) => {
      await log.append({ type: "text_snapshot", requestId: request.id, textSegmentId: "reference",
        protocolVersion: "json-text-v2", contentKind: "final", validatedPrefix: true, text: prefix });
      await request.onText?.("reference");
      await new Promise((resolve) => setTimeout(resolve, 220));
      sentBeforeDefinition = sent.length;
      await log.append({ type: "text_snapshot", requestId: request.id, textSegmentId: "reference",
        protocolVersion: "json-text-v2", contentKind: "final", text: body });
      await log.append({ type: "text_finalized", requestId: request.id, textSegmentId: "reference",
        protocolVersion: "json-text-v2", contentKind: "final", text: body });
      await request.onText?.("reference"); return body;
    }, send: async () => {}, telegram: { send: async (text) => { sent.push(text); return sent.length; },
      draft: async () => {}, edit: async () => {} } });
  await app.handle(update);
  assert.equal(sentBeforeDefinition, 0);
  assert.match(sent.join(""), /<a href="https:\/\/example.com">label<\/a>/);
  assert.ok(!sent.join("").includes("尚未完成"));
  assert.ok((await log.read()).some((event) => event.type === "delivery_succeeded"));
});

test("known long cooldown retries after its deadline without repeating unknown deliveries", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "output-cooldown-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const log = createSqliteRuntimeLog(dir);
  let attempts = 0;
  await log.append({ type: "text_snapshot", requestId: "cool", textSegmentId: "cool-body",
    protocolVersion: "json-text-v2", contentKind: "final", text: "限流正文" });
  await log.append({ type: "text_finalized", requestId: "cool", textSegmentId: "cool-body",
    protocolVersion: "json-text-v2", contentKind: "final", text: "限流正文" });
  const projection = createTelegramProjection({ log, chatId: 42, edit: async () => {},
    send: async () => { if (++attempts === 1) throw new Error("rate limit"); return 1; },
    isRejected: () => true, retryAfter: () => 1700 });
  assert.equal(await projection.reconcile("cool-body"), false);
  await new Promise((resolve) => setTimeout(resolve, 2000));
  assert.equal(attempts, 2);
  assert.equal(await projection.finalDelivered("cool-body"), true);
  assert.ok((await log.read()).some((event) => event.type === "delivery_succeeded"));
});

import { previewTelegramText } from "../src/telegram/telegram-layout.js";
import { replayEvents } from "../src/context/projection.js";
import { getModel } from "@mariozechner/pi-ai";

test("unfinished emphasis previews render without exposing markers or altering escaped text and lists", () => {
  assert.deepEqual(previewTelegramText("*强调"), ["<i>强调</i>"]);
  assert.deepEqual(previewTelegramText("_强调"), ["<i>强调</i>"]);
  assert.deepEqual(previewTelegramText("**强调"), ["<b>强调</b>"]);
  assert.deepEqual(previewTelegramText("\\*原样"), ["*原样"]);
  assert.deepEqual(previewTelegramText("* 列表"), ["• 列表"]);
  assert.deepEqual(previewTelegramText("a_b"), ["a_b"]);
  assert.deepEqual(previewTelegramText("**强调*"), ["<b>强调</b>"]);
});

test("an incomplete result delivery plan never replays its unseen tail as a delivered stage", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "output-result-replay-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const log = createSqliteRuntimeLog(dir);
  await log.append({ type: "message", role: "user", requestId: "old", text: "旧问题" });
  const text = "甲".repeat(3500) + "\n\n" + "未送达乙".repeat(400) + "\n\n尾部";
  await log.append({ type: "text_snapshot", requestId: "old", textSegmentId: "result-prefix",
    protocolVersion: "json-text-v2", contentKind: "result", validatedPrefix: true, text });
  await createTelegramProjection({ log, chatId: 42, send: async () => 1, edit: async () => {} }).reconcile("result-prefix");
  await log.append({ type: "text_finalized", requestId: "old", textSegmentId: "result-prefix",
    protocolVersion: "json-text-v2", contentKind: "result", text });
  await log.append({ type: "request_interrupted", requestId: "old" });
  await log.append({ type: "message", role: "user", requestId: "new", text: "继续" });
  const model = getModel("deepseek", "deepseek-v4-flash"); assert.ok(model);
  const replay = await replayEvents(log, "new", model, true);
  assert.ok(!JSON.stringify(replay.units).includes("未送达乙"));
});

test("brackets added after a committed prefix leave that prefix fixed and allow completion", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "output-later-link-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const log = createSqliteRuntimeLog(dir);
  const sent: string[] = [];
  const projection = createTelegramProjection({ log, chatId: 42, send: async (text) => { sent.push(text); return sent.length; }, edit: async () => {} });
  const prefix = "甲".repeat(3500) + "\n\n" + "乙".repeat(1500) + "\n\n尾部";
  const append = async (text: string) => log.append({ type: "text_snapshot", requestId: "later", textSegmentId: "later-link",
    protocolVersion: "json-text-v2", contentKind: "final", validatedPrefix: true, text });
  await append(prefix);
  await projection.reconcile("later-link");
  await append(prefix + " [链接](https://example.com)");
  await projection.reconcile("later-link");
  await log.append({ type: "text_finalized", requestId: "later", textSegmentId: "later-link",
    protocolVersion: "json-text-v2", contentKind: "final", text: prefix + " [链接](https://example.com)" });
  await projection.reconcile("later-link");
  assert.equal(sent.length, 2);
  assert.equal(sent[0], "甲".repeat(3500));
  assert.match(sent[1]!, /<a href="https:\/\/example.com">链接<\/a>/);
});

test("discarded protocol segments cancel previously scheduled known-failure retries", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "output-discard-retry-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const log = createSqliteRuntimeLog(dir);
  let attempts = 0;
  await log.append({ type: "text_snapshot", requestId: "discard", textSegmentId: "discard-body",
    protocolVersion: "json-text-v2", contentKind: "final", validatedPrefix: true,
    text: "甲".repeat(3500) + "\n\n" + "乙".repeat(1500) + "\n\n尾部" });
  const projection = createTelegramProjection({ log, chatId: 42, send: async () => { attempts++; throw new Error("rejected"); },
    edit: async () => {}, isRejected: () => true });
  await projection.reconcile("discard-body");
  await log.append({ type: "text_discarded", requestId: "discard", textSegmentId: "discard-body" });
  await projection.stop();
  await new Promise((resolve) => setTimeout(resolve, 400));
  assert.equal(attempts, 1);
});

import { assistantText } from "../src/agent/model-message.js";

for (const delivery of ["none", "prefix", "complete", "active"] as const) {
  test(`tool-associated result replay respects ${delivery} delivery while preserving tool facts`, async (t) => {
    const dir = await mkdtemp(join(tmpdir(), "result-tool-replay-"));
    t.after(() => rm(dir, { recursive: true, force: true }));
    const log = createSqliteRuntimeLog(dir);
    const model = getModel("deepseek", "deepseek-v4-flash"); assert.ok(model);
    const text = "阶段性成果尚未展示";
    const message = assistantText(JSON.stringify({ type: "result", text }), model);
    message.content.push({ type: "toolCall", id: "call", name: "ls", arguments: { path: "." } });
    message.stopReason = "toolUse";
    await log.append({ type: "message", role: "user", requestId: "old", text: "分析目录" });
    await log.append({ type: "model_message", requestId: "old", modelStepId: "step", protocolVersion: "json-text-v2", message });
    await log.append({ type: "protocol_validated", requestId: "old", modelStepId: "step", valid: true });
    await log.append({ type: "text_finalized", requestId: "old", modelStepId: "step", textSegmentId: "stage",
      contentKind: "result", text, protocolVersion: "json-text-v2" });
    await log.append({ type: "tool_dispatch", requestId: "old", toolCallId: "call", toolName: "ls", args: { path: "." } });
    await log.append({ type: "tool_result", requestId: "old", toolCallId: "call", toolName: "ls",
      result: { content: [{ type: "text", text: "真实目录结果" }], details: {}, isError: false } });
    if (delivery === "prefix" || delivery === "complete") {
      await log.append({ type: "telegram_page", textSegmentId: "stage", partIndex: 0 });
      await log.append({ type: "telegram_delivery_succeeded", textSegmentId: "stage", partIndex: 0 });
      if (delivery === "complete") await log.append({ type: "telegram_plan_finalized", textSegmentId: "stage", parts: 1 });
    }
    if (delivery !== "active") {
      await log.append({ type: "request_failed", requestId: "old" });
      await log.append({ type: "message", role: "user", requestId: "new", text: "继续" });
    }
    for (const structured of [true, false]) {
      const replay = await replayEvents(log, delivery === "active" ? "old" : "new", model, structured);
      const messages = replay.units.flatMap((unit) => unit.messages);
      assert.ok(messages.some((entry) => entry.role === "toolResult" && entry.toolCallId === "call"));
      assert.ok(JSON.stringify(messages).includes("真实目录结果"));
      const assistant = messages.find((entry) => entry.role === "assistant");
      assert.ok(assistant && assistant.content.some((part) => part.type === "toolCall" && part.id === "call"));
      if (delivery === "complete") assert.ok(JSON.stringify(assistant).includes(text));
      else if (delivery === "active") {
        assert.ok(JSON.stringify(assistant).includes(text));
        assert.ok(JSON.stringify(assistant).includes("尚未确认送达用户"));
        if (structured) assert.ok(!assistant.content.some((part) => part.type === "text" && JSON.parse(part.text).type === "result"));
      } else assert.ok(!JSON.stringify(replay.units).includes(text));
    }
  });
}


test("independent Telegram and model views refresh and rebuild regardless of read order", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "independent-views-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const log = createSqliteRuntimeLog(dir);
  const model = getModel("deepseek", "deepseek-v4-flash");
  await log.append({ type: "message", role: "user", text: "旧问题", requestId: "old" });
  await log.append({ type: "text_snapshot", requestId: "old", textSegmentId: "stage",
    protocolVersion: "json-text-v2", contentKind: "result", text: "独立视图成果" });
  await log.append({ type: "text_finalized", requestId: "old", textSegmentId: "stage",
    protocolVersion: "json-text-v2", contentKind: "result", text: "独立视图成果" });
  await log.append({ type: "message", role: "user", text: "当前问题", requestId: "current" });
  const sent: string[] = [];
  const transport = { send: async (text: string) => { sent.push(text); return sent.length; }, edit: async () => {} };
  const telegram = createTelegramProjection({ log, chatId: 42, ...transport });
  const replay = () => replayEvents(log, "current", model, true);
  const before = await replay();
  assert.ok(!JSON.stringify(before.units).includes("独立视图成果"));
  await telegram.reconcile("stage");
  const after = await replay();
  assert.ok(JSON.stringify(after.units).includes("独立视图成果"));
  assert.ok(!JSON.stringify(before.units).includes("独立视图成果"));
  await createTelegramProjection({ log, chatId: 42, ...transport }).reconcile("stage");
  assert.deepEqual((await replay()).units, after.units);
  assert.deepEqual(sent, ["独立视图成果"]);
  await log.append({ type: "text_snapshot", requestId: "old", textSegmentId: "next-stage",
    protocolVersion: "json-text-v2", contentKind: "result", text: "追加成果" });
  await log.append({ type: "text_finalized", requestId: "old", textSegmentId: "next-stage",
    protocolVersion: "json-text-v2", contentKind: "result", text: "追加成果" });
  // The existing Telegram reader refreshes even after another view reads the new prefix.
  assert.ok(!JSON.stringify((await replay()).units).includes("追加成果"));
  await telegram.reconcile("next-stage");
  const refreshed = await replay();
  assert.ok(JSON.stringify(refreshed.units).includes("追加成果"));
  await createTelegramProjection({ log, chatId: 42, ...transport }).reconcile("next-stage");
  assert.deepEqual((await replay()).units, refreshed.units);
  assert.deepEqual(sent, ["独立视图成果", "追加成果"]);
});
