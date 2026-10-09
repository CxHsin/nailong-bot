import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPiAgent } from "../src/agent/pi-agent.js";
import { createAgentHost } from "../src/application/agent-host.js";
import { createRuntimeEventLog } from "../src/runtime/event-log.js";
import { createTelegramHostProjection } from "../src/channel/telegram/projection.js";
import { createTelegramRichTransport } from "../src/channel/telegram/rich-transport.js";
import { createTestServer } from "./fixtures/http-server.js";
import { closeFixture } from "./fixtures/cleanup.js";
import type { RunProgress } from "../src/runtime/progress.js";

test("Telegram shows recall progress while embedding is pending and edits the same card through context preparation", { timeout: 12000 }, async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "memory-preparation-stream-"));
  const promptFile = join(dir, "prompt.md"); await writeFile(promptFile, "answer");
  let release!: () => void;
  const visibleSemanticStage = new Promise<void>((resolve) => { release = resolve; });
  let modelCalls = 0;
  const server = createTestServer(t, async (req, res) => {
    let raw = ""; for await (const chunk of req) raw += chunk;
    if (req.url === "/embeddings") {
      await visibleSemanticStage;
      const input = JSON.parse(raw).input;
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ data: input.map((_text: string, index: number) => ({ index, embedding: [1, 0] })) }));
    } else {
      modelCalls++;
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: "最终答复" }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`);
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const agent = await createPiAgent({ dataDir: dir, promptFile, deepseekKey: "test", modelBaseUrl: baseUrl, memoryBootstrap: false,
    embedding: { baseUrl, model: "test", apiKey: "test", timeoutMs: 6000 } });
  t.after(() => closeFixture({ server, dir, shutdown: () => agent.close() }));
  const log = await createRuntimeEventLog(dir);
  for (let i = 0; i < 40; i++) {
    await log.append({ type: "message", role: "user", chatId: 42, conversationId: "telegram:private:42", requestId: `old${i}`, text: `历史问题${i}` });
    await log.append({ type: "request_completed", requestId: `old${i}` });
  }
  const host = createAgentHost({ dataDir: dir, promptFile, log, agent });
  const cards = new Map<number, string>(); const finals: string[] = []; const snapshots: string[] = [];
  const receive = (id: number, html: string) => {
    cards.set(id, html); snapshots.push(html);
    if (html.includes("正在匹配问题的语义")) {
      assert.equal(modelCalls, 0); release();
    }
  };
  const rich = createTelegramRichTransport({ sendRich: async (_chat, text) => { finals.push(text); return 99; },
    draftRich: async () => {}, draftHtml: async () => {},
    sendHtml: async (_chat, html) => { const id = cards.size + 1; receive(id, html); return id; },
    editHtml: async (id, _chat, html) => receive(id, html) });
  const run = host.submit({ actor: { id: "42" }, conversationId: "telegram:private:42", text: "历史问题" });
  const statuses: RunProgress[] = [];
  await createTelegramHostProjection({ ...rich, chatId: 42, progressIntervalMs: 0 }).consume({ ...run, events: async function* () {
    for await (const event of run.events()) { if (event.progress) statuses.push(event.progress); yield event; }
  } });
  assert.equal((await run.done).type, "run_succeeded");
  assert.equal(cards.size, 1);
  assert.ok(snapshots.some((html) => html.includes("正在匹配问题的语义")));
  const text = cards.get(1)!;
  assert.match(text, /检索完成：40 条候选记忆/);
  assert.match(text, /历史上下文已恢复|筛选完成|上下文已准备好/);
  assert.deepEqual(finals, ["最终答复"]);
  assert.ok(statuses.some((status) => status.type === "text" && /正在扫描记忆：32\/40/.test(status.text)));
  assert.ok(statuses.some((status) => status.type === "text" && /已检查 16\/40/.test(status.text)));
  assert.ok(statuses.some((status) => status.type === "text" && /正在恢复历史记录：/.test(status.text)));
  assert.ok(statuses.some((status) => status.type === "text" && status.text === "正在装载上下文与记忆引用……"));
  assert.ok(statuses.some((status) => status.type === "text" && status.text === "上下文预算检查通过。"));
  assert.ok(statuses.every((status) => status.type !== "text" || status.kind !== "status" || status.formal === false));
});
