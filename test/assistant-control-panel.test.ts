import { test } from "node:test";
import assert from "node:assert/strict";
import { telegramFixture, botInfo } from "./fixtures/telegram.js";
import { sendChatCompletion } from "./fixtures/chat-completion.js";

function gate() {
  let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve };
}

const command = (id: number, text: string, actor = 42) => ({ update_id: id, message: { message_id: id, date: 0,
  chat: { id: actor, type: "private" as const, first_name: "owner" }, from: { id: actor, is_bot: false, first_name: "owner" }, text } });
const body = (value: unknown) => JSON.parse(String(value)) as { text?: string; reply_markup?: { inline_keyboard: Array<Array<{text: string; callback_data: string}>> } };

test("Telegram /start opens owner conversation controls without a model request", async () => {
  let requests = 0;
  const f = await telegramFixture((_wire, response) => { requests++; sendChatCompletion(response, "unexpected"); });
  try {
    await f.bot.handleUpdate(command(1, "/start", 43));
    await f.bot.handleUpdate(command(2, "/start@other_bot"));
    await f.bot.handleUpdate(command(3, "/start@test_bot"));
    const panel = f.sent.filter(s => s.method === "sendMessage").map(s => body(s.body)).at(-1);
    assert.ok(panel?.reply_markup, "native inline controls are immediately available");
    assert.match(panel.text!, /模型/);
    const labels = panel.reply_markup.inline_keyboard.flat().map(b => b.text).join(" ");
    assert.match(labels, /模型/); assert.match(labels, /工作/); assert.match(labels, /缓存/); assert.match(labels, /会话/); assert.match(labels, /草稿/);
    assert.equal(requests, 0);
  } finally { await f.close(); }
});

test("catalog output limits equal to context windows do not block other models, selection or restart", async () => {
  const f = await controlPanelFixture();
  try {
    f.setModels([
      { id: "provider/A", reasoning: false, context_window: 128000, max_output_tokens: 16384 },
      { id: "provider/equal-limits", reasoning: false, context_window: 64000, max_output_tokens: 64000 },
    ]);
    const state = await f.app.controlSnapshot("telegram:private:42", { refresh: true });
    assert.equal(state.selectedModel, "provider/A");
    assert.equal(state.selectedAvailable, true);
    await f.bot.handleUpdate(command(501, "FIRST_GOAL"));
    await f.flush();
    assert.equal(f.requests[0]?.model, "provider/A");

    await f.bot.handleUpdate(command(502, "/model provider/equal-limits"));
    await f.flush();
    await f.reopen();
    await f.bot.handleUpdate(command(503, "/start"));
    assert.match(latestPanel(f).text, /provider\/equal-limits/);
    await f.bot.handleUpdate(command(504, "SECOND_GOAL"));
    await f.flush();
    assert.deepEqual(f.requests.map(request => request.model), ["provider/A", "provider/equal-limits"]);
    assert.match(JSON.stringify(f.requests[1]?.messages), /FIRST_GOAL/);
    assert.match(JSON.stringify(f.requests[1]?.messages), /SECOND_GOAL/);
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { controlPanelFixture } from "./fixtures/control-panel.js";
import { Type } from "typebox";

type PanelFixture = Awaited<ReturnType<typeof controlPanelFixture>>;
type Panel = { text: string; id: number; buttons: Array<{text: string; callback_data: string}> };
function latestPanel(f: {sent: Array<{method: string;body: unknown;messageId: number}>}): Panel {
  const messages = f.sent.filter(s => s.method === "sendMessage").map(s => body(s.body));
  const last = messages.at(-1)!;
  return { text: last?.text ?? "", id: f.sent.filter(s => s.method === "sendMessage").at(-1)!.messageId,
    buttons: last?.reply_markup?.inline_keyboard.flat() ?? [] };
}
let updateId = 100;
async function click(f: PanelFixture, label: string | RegExp, panel = latestPanel(f), actor = 42, chat = 42, messageId = panel.id, group = false) {
  const button = panel.buttons.find(b => typeof label === "string" ? b.text === label : label.test(b.text));
  assert.ok(button, `missing button ${String(label)}: ${panel.buttons.map(b => b.text).join(", ")}`);
  await f.bot.handleUpdate({ update_id: ++updateId, callback_query: { id: `cb-${updateId}`, from: { id: actor, is_bot: false, first_name: "owner" },
    chat_instance: "private", data: button.callback_data,
    message: { message_id: messageId, date: 0, chat: group ? { id: chat, type: "group", title: "group" } : { id: chat, type: "private", first_name: "owner" }, from: botInfo, text: panel.text } } });
}

test("native model pagination, detail and favorites preserve opaque catalog IDs and selection", async () => {
  const models = Array.from({length: 8}, (_, i) => ({ id: `provider/route/team/model-${i}`, display_name: `Model ${i}`, owned_by: "provider", context_window: 32000, reasoning: false }));
  const f = await controlPanelFixture({ models });
  try {
    await f.bot.handleUpdate(command(1, "/model"));
    let panel = latestPanel(f); assert.match(panel.text, /✓ Model 0/);
    for (const button of panel.buttons) assert.ok(Buffer.byteLength(button.callback_data, "utf8") <= 64);
    const reads = f.catalogReads;
    await click(f, "下一页"); panel = latestPanel(f); assert.match(panel.text, /Model 7/); assert.equal(f.catalogReads, reads);
    await click(f, "详情"); panel = latestPanel(f); assert.match(panel.text, /provider\/route\/team\/model-6/); assert.match(panel.text, /32000/);
    await click(f, "加入常用"); await click(f, "返回模型列表"); await click(f, "常用模型");
    panel = latestPanel(f); assert.match(panel.text, /Model 6/); assert.doesNotMatch(panel.text, /Model 7/);
    await click(f, "Model 6");
    const config = JSON.parse(await readFile(f.configPath, "utf8"));
    assert.equal(config.model, "magpie/provider/route/team/model-6"); assert.equal(config.unrelated, "keep");
    await f.bot.handleUpdate(command(2, "use selected model")); await f.flush();
    assert.equal(f.requests[0]?.model, "provider/route/team/model-6");
    assert.equal(f.requests.length, 1);
  } finally { await f.close(); }
});

test("busy model controls acknowledge immediately and only the last selected settings reach the next real request", { timeout: 20000 }, async () => {
  const entered = gate(); const release = gate();
  const f = await controlPanelFixture({ provider: async (_wire, response) => {
    if (f.requests.length === 1) { entered.resolve(); await release.promise; }
    sendChatCompletion(response, "confirmed answer");
  } });
  try {
    await f.bot.handleUpdate(command(1, "hold A")); await entered.promise;
    await f.bot.handleUpdate(command(2, "/model"));
    await click(f, "Beta"); await click(f, "Gamma");
    await f.bot.handleUpdate(command(3, "/thinking high"));
    await f.bot.handleUpdate(command(4, "/start"));
    const panel = latestPanel(f);
    assert.match(panel.text, /期望模型：route\/team\/C · high/);
    assert.match(panel.text, /实际请求：provider\/A · medium/); assert.match(panel.text, /待生效/);
    assert.equal(f.requests.length, 1);
    assert.ok(f.sent.some(s => s.method === "answerCallbackQuery"));
    await click(f, "缓存统计"); assert.match(latestPanel(f).text, /胃囊报表/);
    await f.bot.handleUpdate(command(5, "/model")); await click(f, "☆"); await click(f, "常用模型");
    assert.equal(f.requests.length, 1);
    release.resolve(); await f.flush();
    await f.bot.handleUpdate(command(6, "next C")); await f.flush();
    assert.deepEqual(f.requests.map(r => r.model), ["provider/A", "route/team/C"]);
    assert.equal(f.requests[1]?.reasoning_effort, "high");
    assert.match(JSON.stringify(f.requests[1]?.messages), /hold A/);
    assert.match(JSON.stringify(f.requests[1]?.messages), /confirmed answer/);
    assert.deepEqual(f.errors, []);
  } finally { release.resolve(); await f.close(); }
});

test("callbacks enforce owner, chat, message and restart scope and repeated draft changes have one effect", async () => {
  const f = await controlPanelFixture();
  try {
    await f.bot.handleUpdate(command(1, "/start")); const original = latestPanel(f);
    const before = f.sent.length;
    await click(f, /草稿预览/, original, 43);
    await click(f, /草稿预览/, original, 42, 99);
    await click(f, /草稿预览/, original, 42, 42, original.id + 200);
    await click(f, /草稿预览/, original, 42, 42, original.id, true);
    assert.equal(f.sent.slice(before).filter(s => s.method === "answerCallbackQuery").length, 4);
    await f.bot.handleUpdate(command(2, "/start")); assert.match(latestPanel(f).buttons.map(b => b.text).join(" "), /草稿预览：开/);
    await click(f, /草稿预览/, original);
    assert.match(latestPanel(f).buttons.map(b => b.text).join(" "), /草稿预览：关/);
    await click(f, /草稿预览/, original);
    await f.reopen();
    await click(f, /草稿预览/, original);
    assert.match(String(f.sent.at(-1)?.body), /过期/);
    await f.bot.handleUpdate(command(3, "/start")); assert.match(latestPanel(f).buttons.map(b => b.text).join(" "), /草稿预览：关/);
    await f.bot.handleUpdate(command(4, "final reply still delivered")); await f.flush();
    assert.ok(f.sent.some(s => s.method === "sendRichMessage" && /confirmed answer/.test(String(s.body))));
    assert.match(await readFile(join(f.directory, "telegram-sends.jsonl"), "utf8"), /"status":"sent"/);
    assert.equal(f.requests.length, 1);
  } finally { await f.close(); }
});

test("reset asks for confirmation, cancelling preserves history, and duplicate confirmation resets once without losing settings", async () => {
  const f = await controlPanelFixture();
  try {
    await f.bot.handleUpdate(command(1, "OLD_CONTEXT")); await f.flush();
    await f.bot.handleUpdate(command(2, "/thinking high"));
    await f.bot.handleUpdate(command(3, "/reset")); assert.match(latestPanel(f).text, /确认重置/); assert.match(latestPanel(f).text, /保留/);
    await click(f, "取消");
    await f.bot.handleUpdate(command(4, "AFTER_CANCEL")); await f.flush();
    assert.match(JSON.stringify(f.requests[1]?.messages), /OLD_CONTEXT/);
    await f.bot.handleUpdate(command(5, "/reset")); const confirmation = latestPanel(f);
    await click(f, "确认重置", confirmation); await click(f, "确认重置", confirmation); await f.flush();
    const confirmations = f.sent.filter(s => s.method === "sendRichMessage" && /已重置主会话上下文/.test(String(s.body)));
    assert.equal(confirmations.length, 1);
    await f.bot.handleUpdate(command(6, "NEW_CONTEXT")); await f.flush();
    assert.doesNotMatch(JSON.stringify(f.requests[2]?.messages), /OLD_CONTEXT|AFTER_CANCEL/);
    assert.equal(f.requests[2]?.model, "provider/A"); assert.equal(f.requests[2]?.reasoning_effort, "high");
  } finally { await f.close(); }
});

test("catalog failure retains snapshot, successful removal invalidates old choices and refresh never sends a generation", async () => {
  const f = await controlPanelFixture();
  try {
    await f.bot.handleUpdate(command(1, "/model")); const old = latestPanel(f);
    f.setCatalogFailure(true); await click(f, "刷新目录");
    assert.match(latestPanel(f).text, /刷新失败/); assert.match(latestPanel(f).text, /Beta/);
    f.setCatalogFailure(false); f.setModels([{ id: "route/new/D", display_name: "Delta", reasoning: false }]);
    await click(f, "刷新目录"); assert.match(latestPanel(f).text, /Delta/); assert.doesNotMatch(latestPanel(f).text, /Beta/);
    await click(f, "Beta", old); assert.match(latestPanel(f).text, /未完成/);
    assert.equal(f.requests.length, 0);
    await f.bot.handleUpdate(command(2, "/start")); assert.match(latestPanel(f).text, /不可用/);
    await f.bot.handleUpdate(command(3, "/model route/new/D"));
    await f.bot.handleUpdate(command(4, "use new model")); await f.flush();
    assert.equal(f.requests[0]?.model, "route/new/D");
  } finally { await f.close(); }
});

test("turning drafts off during a streamed response stops later previews while final text, files and receipts still deliver", { timeout: 20000 }, async () => {
  const firstDraft = gate(); const proceed = gate();
  const f = await controlPanelFixture({ onApi(method) { if (method === "sendRichMessageDraft") firstDraft.resolve(); },
    provider: async (_wire, response) => {
      if (f.requests.length === 1) {
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { role: "assistant", content: "working preview" }, finish_reason: null }] })}\n\n`);
        await proceed.promise;
        response.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: " later preview", tool_calls: [{ index: 0, id: "file", type: "function", function: { name: "send_file", arguments: '{"path":"report.txt"}' } }] }, finish_reason: "tool_calls" }] })}\n\ndata: [DONE]\n\n`);
      } else sendChatCompletion(response, "FINAL_TEXT");
    } });
  try {
    await writeFile(join(f.directory, "report.txt"), "real report");
    await f.bot.handleUpdate(command(1, "send report.txt")); await firstDraft.promise;
    await f.bot.handleUpdate(command(2, "/draft off"));
    const previews = f.sent.filter(s => s.method === "sendRichMessageDraft").length; assert.ok(previews > 0);
    proceed.resolve(); await f.flush();
    assert.equal(f.sent.filter(s => s.method === "sendRichMessageDraft").length, previews);
    assert.equal(f.sent.filter(s => s.method === "sendDocument").length, 1);
    assert.ok(f.sent.some(s => s.method === "sendRichMessage" && /FINAL_TEXT/.test(String(s.body))));
    const receipts = await readFile(join(f.directory, "telegram-sends.jsonl"), "utf8");
    assert.match(receipts, /"kind":"file"/); assert.match(receipts, /"status":"sent"/);
    await f.reopen(); await f.bot.handleUpdate(command(3, "/start"));
    assert.match(latestPanel(f).buttons.map(b => b.text).join(" "), /草稿预览：关/);
    assert.deepEqual(f.errors, []);
  } finally { proceed.resolve(); await f.close(); }
});

test("work details identify one queued target and cancellation preserves other FIFO work", { timeout: 20000 }, async () => {
  const entered = gate(); const release = gate();
  const f = await controlPanelFixture({ provider: async (_wire, response) => {
    if (f.requests.length === 1) { entered.resolve(); await release.promise; }
    sendChatCompletion(response, "work completed");
  } });
  try {
    await f.bot.handleUpdate(command(1, "RUN_A")); await entered.promise;
    await f.bot.handleUpdate(command(2, "CANCEL_B")); await f.app.waitForRouting();
    await f.bot.handleUpdate(command(3, "KEEP_C")); await f.app.waitForRouting();
    await f.bot.handleUpdate(command(4, "/work"));
    assert.match(latestPanel(f).buttons.map(b => b.text).join(" "), /排队中.*CANCEL_B/);
    await click(f, /CANCEL_B/); const target = latestPanel(f); assert.match(target.text, /目标：/); assert.match(target.text, /CANCEL_B/);
    await click(f, "取消此工作", target); await click(f, "取消此工作", target);
    assert.match(latestPanel(f).text, /已取消/);
    release.resolve(); await f.flush();
    assert.equal(f.requests.length, 2);
    assert.match(JSON.stringify(f.requests[1]?.messages), /KEEP_C/);
    await f.bot.handleUpdate(command(5, "/work")); await click(f, /CANCEL_B/);
    assert.match(latestPanel(f).text, /已取消/);
    assert.ok(!latestPanel(f).buttons.some(b => /继续/.test(b.text)));
    assert.deepEqual(f.errors, []);
  } finally { release.resolve(); await f.close(); }
});

test("replayed shortcut after restart cannot overwrite a newer explicit model choice", async () => {
  const f = await controlPanelFixture();
  try {
    await f.bot.handleUpdate(command(1, "/model provider/B"));
    await f.bot.handleUpdate(command(2, "/model route/team/C"));
    await f.reopen();
    await f.bot.handleUpdate(command(1, "/model provider/B"));
    await f.bot.handleUpdate(command(3, "current model")); await f.flush();
    assert.equal(f.requests[0]?.model, "route/team/C");
    assert.equal(JSON.parse(await readFile(f.configPath, "utf8")).model, "magpie/route/team/C");
  } finally { await f.close(); }
});

test("Telegram without a model keeps ordinary inputs across channel restart until an explicit catalog selection", async () => {
  const f = await controlPanelFixture({ noSelection: true });
  try {
    await f.bot.handleUpdate(command(1, "/start")); assert.match(latestPanel(f).text, /未选择/);
    await f.bot.handleUpdate(command(2, "WAIT_FIRST")); await f.bot.handleUpdate(command(3, "WAIT_SECOND")); await f.flush();
    assert.equal(f.requests.length, 0);
    await f.reopen(); await f.bot.handleUpdate(command(4, "/start"));
    assert.match(latestPanel(f).text, /等待选择/); assert.equal(f.requests.length, 0);
    await f.bot.handleUpdate(command(5, "/model")); await click(f, "Beta"); await f.flush();
    assert.ok(f.requests.length > 0); assert.equal(f.requests[0]?.model, "provider/B");
    const messages = JSON.stringify(f.requests.map(r => r.messages));
    assert.ok(messages.indexOf("WAIT_FIRST") < messages.indexOf("WAIT_SECOND"));
    assert.match(messages, /WAIT_FIRST/); assert.match(messages, /WAIT_SECOND/);
  } finally { await f.close(); }
});

test("Magpie disconnect blocks independent Conversation tool continuations at dispatch and retains confirmed effects", async t => {
  for (const observedByPanel of [true, false]) await t.test(observedByPanel ? "recognized by primary panel" : "recognized at request dispatch", async () => {
    const entered = gate(), release = gate();
    let effects = 0;
    const f = await controlPanelFixture({ tools: [{name:"hold_effect",label:"hold",description:"Hold a real confirmed tool effect",parameters:Type.Object({}),
      async execute() {effects++;entered.resolve();await release.promise;return {content:[{type:"text",text:"CONFIRMED_INDEPENDENT_EFFECT"}],details:{}};}}],
      provider: (_wire,response) => f.requests.length === 1 ? sendChatCompletion(response,"",[{index:0,id:"hold-effect",type:"function",function:{name:"hold_effect",arguments:"{}"}}]) : sendChatCompletion(response,"continued result"),
    });
    try {
      await f.app.control("cli:other",{type:"model",model:"provider/A"});
      await f.app.receive({conversationId:"cli:other",inputId:"work",text:"INDEPENDENT_GOAL"});
      await entered.promise;
      const config = JSON.parse(await readFile(f.configPath,"utf8"));
      await writeFile(f.configPath,JSON.stringify({...config,baseUrl:"",apiKey:""}));
      if (observedByPanel) {
        await f.bot.handleUpdate(command(1001,"/start"));
        assert.match(latestPanel(f).text,/未连接|断开/);
      }
      release.resolve();await f.flush();
      assert.equal(f.requests.length,1,"no HTTP request may follow a disconnected tool boundary");
      assert.equal(effects,1);
      const work = (await f.app.controlSnapshot("cli:other")).works.find(work=>work.summary.includes("INDEPENDENT_GOAL"))!;
      assert.ok(["paused","needs_confirmation"].includes(work.status));
      await writeFile(f.configPath,JSON.stringify(config));
      await f.bot.handleUpdate(command(1002,"/start"));
      await f.flush();assert.equal(f.requests.length,1,"reconnection does not resume paused work");
      await f.app.control("cli:other",{type:"resume",target:work.id,operationId:`restore-${observedByPanel}`});
      await f.flush();
      assert.equal(f.requests.length,2);assert.equal(effects,1);
      assert.match(JSON.stringify(f.requests[1]!.messages),/CONFIRMED_INDEPENDENT_EFFECT/);
      assert.match(JSON.stringify(f.requests[1]!.messages),/INDEPENDENT_GOAL/);
    } finally {release.resolve();await f.close();}
  });
});

test("thinking capability adjustment remains visible after catalog refresh and reopen until an explicit preference", async () => {
  const f = await controlPanelFixture();
  try {
    await f.bot.handleUpdate(command(1101,"/thinking high"));
    f.setModels([{id:"provider/A",reasoning:true,supported_reasoning_levels:["low"]}]);
    await f.bot.handleUpdate(command(1102,"/model"));
    await f.bot.handleUpdate(command(1103,"/thinking"));
    assert.match(latestPanel(f).text,/当前：low/);
    assert.match(latestPanel(f).text,/能力已更新.*原偏好不再支持/);
    await f.reopen();
    await f.bot.handleUpdate(command(1104,"/thinking"));
    assert.match(latestPanel(f).text,/能力已更新.*原偏好不再支持/);
    await f.bot.handleUpdate(command(1105,"/thinking low"));
    assert.doesNotMatch(latestPanel(f).text,/原偏好不再支持/);
    assert.equal(f.requests.length,0);
  } finally {await f.close();}
});

test("primary catalog refresh propagates removals and thinking capabilities to independent active Conversations", async t => {
  for (const removed of [true,false]) await t.test(removed ? "removed model pauses continuation" : "changed capabilities govern the next prepare", async () => {
    const entered=gate(),release=gate();let effects=0;
    const f = await controlPanelFixture({tools:[{name:"catalog_effect",label:"catalog",description:"Hold completed effect across a global catalog change",parameters:Type.Object({}),
      async execute(){effects++;entered.resolve();await release.promise;return {content:[{type:"text",text:"CATALOG_EFFECT_CONFIRMED"}],details:{}};}}],
      provider:(_wire,response)=>f.requests.length===1 ? sendChatCompletion(response,"",[{index:0,id:"catalog-effect",type:"function",function:{name:"catalog_effect",arguments:"{}"}}]) : sendChatCompletion(response,"continued with current capabilities")});
    try {
      await f.app.control("cli:catalog",{type:"model",model:"provider/A"});
      await f.app.control("cli:catalog",{type:"thinking",level:"high"});
      await f.app.receive({conversationId:"cli:catalog",inputId:"catalog-goal",text:"KEEP_CATALOG_GOAL"});await entered.promise;
      assert.equal(f.requests[0]?.reasoning_effort,"high");
      f.setModels(removed ? [{id:"provider/B",reasoning:false}] : [{id:"provider/A",reasoning:true,supported_reasoning_levels:["low"]}]);
      await f.bot.handleUpdate(command(1201,"/model"));
      release.resolve();await f.flush();
      assert.equal(effects,1);
      if (removed) {
        assert.equal(f.requests.length,1);
        const snapshot=await f.app.controlSnapshot("cli:catalog");
        assert.equal(snapshot.selectedModel,"provider/A");assert.equal(snapshot.selectedAvailable,false);
        assert.ok(snapshot.works.some(work=>work.status==="paused"));
      } else {
        assert.equal(f.requests.length,2);
        assert.equal(f.requests[1]?.reasoning_effort,"low");
        assert.match(JSON.stringify(f.requests[1]!.messages),/CATALOG_EFFECT_CONFIRMED/);
      }
    } finally {release.resolve();await f.close();}
  });
});
