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
    assert.match(panel.text!, /Status:<\/b> <code>idle<\/code>/);
    assert.match(panel.text!, /Tokens:<\/b> <code>↑未知 ↓未知<\/code>/);
    const labels = panel.reply_markup.inline_keyboard.flat().map(b => b.text).join(" ");
    assert.match(labels, /模型：local/); assert.match(labels, /工作/); assert.match(labels, /设置/);
    assert.match(labels, /缓存统计/);
    assert.match(labels, /饱食/);
    assert.match(labels, /投喂/);
    assert.doesNotMatch(labels, /全局路由模型|思考等级/, "home exposes a single model menu entry");
    assert.equal(requests, 0);
  } finally { await f.close(); }
});

test("Telegram stop aborts a live request immediately, persists pause and ignores a replay after restart", { timeout: 60_000 }, async () => {
  const entered = gate(), disconnected = gate();
  const f = await controlPanelFixture({provider: (_wire, response) => {
    if (f.requests.length === 1) {
      response.on("close", disconnected.resolve); entered.resolve();
    } else sendChatCompletion(response,"RESUMED_RESULT");
  }});
  try {
    await f.bot.handleUpdate(command(2201,"STOP_GOAL")); await entered.promise;
    await f.bot.handleUpdate(command(2202,"/stop",43));
    assert.equal((await f.app.controlSnapshot("telegram:private:42")).status,"running");
    await f.bot.handleUpdate(command(2203,"/stop@test_bot"));
    assert.match(latestPanel(f).text,/已请求暂停|正在停止/);
    await disconnected.promise; await f.flush();
    let snapshot = await f.app.controlSnapshot("telegram:private:42");
    assert.equal(snapshot.status,"paused"); assert.equal(snapshot.works.length,1);
    assert.equal(snapshot.works[0]?.reason,"user_stop"); assert.equal(f.requests.length,1);
    await f.reopen(); await f.flush();
    assert.equal(f.requests.length,1);
    await f.bot.handleUpdate(command(2203,"/stop@test_bot"));
    assert.match(latestPanel(f).text,/未重复执行/);
    await f.bot.handleUpdate(command(2204,"/resume")); await f.flush();
    assert.equal(f.requests.length,2); assert.match(JSON.stringify(f.requests[1]!.messages),/STOP_GOAL/);
    snapshot = await f.app.controlSnapshot("telegram:private:42");
    assert.equal(snapshot.works[0]?.status,"completed");
    await f.bot.handleUpdate(command(2205,"/stop"));
    assert.match(latestPanel(f).text,/当前没有正在执行/);
    assert.deepEqual(f.errors,[]);
  } finally {await f.close();}
});

test("resume with several paused goals asks for a target and later discussion retains pause and scope facts", async () => {
  const entered = [gate(), gate()];
  const f = await controlPanelFixture({provider: (_wire, response) => {
    if (f.requests.length <= 2) entered[f.requests.length - 1]!.resolve();
    else sendChatCompletion(response, "DISCUSSION_ONLY");
  }});
  try {
    for (let index = 0; index < 2; index++) {
      await f.bot.handleUpdate(command(2300 + index * 2, `DISCUSS_${index}`)); await entered[index]!.promise;
      await f.bot.handleUpdate(command(2301 + index * 2, "/stop")); await f.flush();
    }
    await f.reopen();
    await f.bot.handleUpdate(command(2304, "/resume")); await f.flush();
    assert.match(latestPanel(f).text, /2 项暂停工作，尚未恢复任何工作/);
    assert.equal(f.requests.length, 2);
    assert.ok((await f.app.controlSnapshot("telegram:private:42")).works.every(work => work.status === "paused"));
    await click(f, "DISCUSS_1"); await click(f, "继续此工作"); await f.flush();
    assert.equal(f.requests.length, 3);
    const resumed = JSON.stringify(f.requests[2]!.messages.at(-1));
    assert.match(resumed, /原始历史输入/);
    assert.match(resumed, /不代表用户批准了助手后来提出的实施方案/);
    assert.match(resumed, /DISCUSS_1/);
    const snapshot = await f.app.controlSnapshot("telegram:private:42");
    assert.equal(snapshot.works.find(work => work.summary === "DISCUSS_0")?.status, "paused");
    assert.equal(snapshot.works.find(work => work.summary === "DISCUSS_1")?.status, "completed");
    await f.reopen();
    await f.bot.handleUpdate(command(2305, "结合anthropic那篇evel来讲")); await f.flush();
    assert.equal(f.requests.length, 4);
    const discussion = JSON.stringify(f.requests[3]!.messages.at(-1));
    assert.match(discussion, /已暂停的目标/);
    assert.ok(discussion.includes(snapshot.works.find(work => work.summary === "DISCUSS_0")!.id));
    assert.match(discussion, /本轮新消息不自动恢复这些目标/);
    assert.match(discussion, /讨论、解释和方案建议不授权实施/);
    assert.equal((await f.app.controlSnapshot("telegram:private:42")).works.find(work => work.summary === "DISCUSS_0")?.status, "paused");
    assert.deepEqual(f.errors, []);
  } finally {await f.close();}
});

test("home summarizes real settled usage and current context across tools, model switches, restart and reset", async () => {
  const f = await controlPanelFixture({models:[
    {id:"provider/A",context_window:1000000,max_output_tokens:16000},
    {id:"provider/B",context_window:200000,max_output_tokens:16000}],
    tools:[{name:"read_fact",label:"read",description:"Read fact",parameters:Type.Object({}),async execute() {
      return {content:[{type:"text",text:"KNOWN_FACT"}],details:{}};
    }}],
    provider: (_wire,response) => {
      const first = f.requests.length === 1;
      response.writeHead(200,{"content-type":"text/event-stream"});
      response.end(`data: ${JSON.stringify({choices:[{index:0,delta:{content:first ? "" : "done",...(first ? {tool_calls:[{index:0,id:"fact",type:"function",function:{name:"read_fact",arguments:"{}"}}]} : {})},finish_reason:first ? "tool_calls" : "stop"}],
        usage:{prompt_tokens:first ? 1000 : 2000,completion_tokens:100,prompt_tokens_details:{cached_tokens:first ? 900 : 1000}}})}\n\ndata: [DONE]\n\n`);
    }});
  try {
    await f.bot.handleUpdate(command(2301,"USE_TOOL")); await f.flush();
    assert.equal(f.requests.length,2);
    await f.bot.handleUpdate(command(2302,"/start"));
    assert.match(latestPanel(f).text,/Tokens:<\/b> <code>↑1\.1k ↓200<\/code>/);
    assert.match(latestPanel(f).text,/Cache:<\/b> <code>R1\.9k CH50\.0%<\/code>/);
    assert.match(latestPanel(f).text,/Context:<\/b> <code>~0\.2%\/1\.0M<\/code>/);
    assert.doesNotMatch(latestPanel(f).text,/\*|条缺失/);
    const snapshot = await f.app.controlSnapshot("telegram:private:42");
    assert.equal(snapshot.context.tokens,2100,"current context uses last request, not cumulative input");
    assert.equal((await f.app.controlSnapshot("cli:other")).usage.input,null);
    await f.reopen(); await f.bot.handleUpdate(command(2303,"/start"));
    assert.match(latestPanel(f).text,/↑1\.1k ↓200/);
    assert.equal((await f.app.controlSnapshot("telegram:private:42")).context.tokens,2100);
    await f.bot.handleUpdate(command(2304,"/model provider/B"));
    await f.bot.handleUpdate(command(2305,"/start"));
    assert.match(latestPanel(f).text,/Context:<\/b> <code>~1\.1%\/200k<\/code>/);
    await f.bot.handleUpdate(command(2306,"/reset")); await click(f,"确认重置"); await f.flush();
    assert.equal((await f.app.controlSnapshot("telegram:private:42")).context.tokens,0);
    assert.equal(f.requests.length,2,"controls never generate model usage");
    assert.deepEqual(f.errors,[]);
  } finally {await f.close();}
});

test("home shows known totals with compact per-field markers after missing usage and restart", async () => {
  const f = await controlPanelFixture({provider: (_wire,response) => {
    response.writeHead(200,{"content-type":"text/event-stream"});
    response.end(`data: ${JSON.stringify({choices:[{index:0,delta:{content:"done"},finish_reason:"stop"}],
      usage:f.requests.length === 1 ? {completion_tokens:7} :
        {prompt_tokens:1000,completion_tokens:10,prompt_tokens_details:{cached_tokens:900}}})}\n\ndata: [DONE]\n\n`);
  }});
  try {
    await f.bot.handleUpdate(command(2401,"PARTIAL_USAGE")); await f.flush();
    await f.bot.handleUpdate(command(2402,"/start"));
    assert.match(latestPanel(f).text,/Tokens:<\/b> <code>↑未知 ↓7<\/code>/);
    assert.match(latestPanel(f).text,/Cache:<\/b> <code>R未知 CH未知<\/code>/);
    assert.match(latestPanel(f).text,/\* 仅已知用量 · 1 条缺失/);
    await f.bot.handleUpdate(command(2403,"KNOWN_USAGE")); await f.flush();
    await f.bot.handleUpdate(command(2404,"/start"));
    assert.match(latestPanel(f).text,/Tokens:<\/b> <code>↑100\* ↓17<\/code>/);
    assert.match(latestPanel(f).text,/Cache:<\/b> <code>R900\* CH90\.0%<\/code>/);
    assert.match(latestPanel(f).text,/\* 仅已知用量 · 1 条缺失/);
    await f.reopen();
    await f.bot.handleUpdate(command(2405,"/start"));
    assert.match(latestPanel(f).text,/↑100\* ↓17/);
    assert.match(latestPanel(f).text,/\* 仅已知用量 · 1 条缺失/);
    assert.equal(f.requests.length,2,"opening the panel and reopening do not generate usage");
    assert.deepEqual(f.errors,[]);
  } finally {await f.close();}
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
    assert.match(latestPanel(f).buttons.map(b => b.text).join(" "), /模型：equal-limits/);
    await f.bot.handleUpdate(command(504, "SECOND_GOAL"));
    await f.flush();
    assert.deepEqual(f.requests.map(request => request.model), ["provider/A", "provider/equal-limits"]);
    assert.match(JSON.stringify(f.requests[1]?.messages), /FIRST_GOAL/);
    assert.match(JSON.stringify(f.requests[1]?.messages), /SECOND_GOAL/);
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

test("Telegram /start renders a calm fallback and a persisted source-backed mood without doing work", async () => {
  const moodCall = (inputId: string, request: string, mood: string, id: string) => [{
    index: 0,
    id,
    type: "function",
    function: { name: "persona_mood", arguments: JSON.stringify({ inputId, request, mood }) },
  }];
  const f = await controlPanelFixture({ provider: (_wire, response) => {
    if (f.requests.length === 1) sendChatCompletion(response, "", moodCall("6002", "MOOD_GOAL", "happy", "mood-happy"));
    else sendChatCompletion(response, "已记录。");
  }});
  try {
    await f.bot.handleUpdate(command(6001, "/start"));
    const calm = latestPanel(f);
    assert.match(calm.text, /情绪：平稳/);
    assert.match(calm.text, /暂无特别变化/);
    assert.equal(f.requests.length, 0, "opening /start does not call the model");
    assert.equal(f.outputs.length, 0, "opening /start does not enqueue or produce an assistant output");
    const before = await f.app.controlSnapshot("telegram:private:42");

    await f.bot.handleUpdate(command(6002, "MOOD_GOAL"));
    await f.flush();
    assert.equal(f.requests.length, 2, "the user input and its tool follow-up are the only model requests");
    await f.bot.handleUpdate(command(6003, "/start"));
    assert.match(latestPanel(f).text, /情绪：开心/);
    const active = await f.app.controlSnapshot("telegram:private:42");
    assert.equal(active.mood.state, "happy");
    assert.equal(active.mood.source?.inputId, "6002");
    assert.equal(f.requests.length, 2, "reading the active mood does not call the model");
    assert.equal(f.outputs.length, 1, "reading the active mood does not create another assistant output");

    await f.reopen();
    await f.bot.handleUpdate(command(6004, "/start"));
    assert.match(latestPanel(f).text, /情绪：开心/);
    assert.equal((await f.app.controlSnapshot("telegram:private:42")).mood.state, "happy");
    assert.equal(f.requests.length, 2, "reopening and rendering the panel do not call the model");
    assert.equal(f.outputs.length, 1, "reopening the panel does not enqueue or produce an assistant output");
    assert.equal((await f.app.controlSnapshot("telegram:private:42")).expressionFrequency, before.expressionFrequency);
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
  const messages = f.sent.filter(s => s.method === "sendMessage" || s.method === "editMessageText");
  const last = body(messages.at(-1)!.body);
  return { text: last?.text ?? "", id: messages.at(-1)!.messageId,
    buttons: last?.reply_markup?.inline_keyboard.flat() ?? [] };
}
let updateId = 100;
async function click(f: PanelFixture, label: string | RegExp, panel = latestPanel(f), actor = 42, chat = 42, messageId = panel.id, group = false) {
  const button = panel.buttons.find(b => typeof label === "string" ? b.text === label : label.test(b.text))
    ?? panel.buttons.find(b => typeof label === "string" && b.text.includes(label));
  assert.ok(button, `missing button ${String(label)}: ${panel.buttons.map(b => b.text).join(", ")}`);
  await f.bot.handleUpdate({ update_id: ++updateId, callback_query: { id: `cb-${updateId}`, from: { id: actor, is_bot: false, first_name: "owner" },
    chat_instance: "private", data: button.callback_data,
    message: { message_id: messageId, date: 0, chat: group ? { id: chat, type: "group", title: "group" } : { id: chat, type: "private", first_name: "owner" }, from: botInfo, text: panel.text } } });
}

test("panel buttons navigate and change settings in one Telegram message without generating replies", async () => {
  const f = await controlPanelFixture({ models: Array.from({ length: 8 }, (_, i) => ({
    id: `provider/model-${i}`, display_name: `Model ${i}`, reasoning: true, supported_reasoning_levels: ["low", "medium", "high"],
  })) });
  try {
    await f.bot.handleUpdate(command(2001, "/start"));
    const original = latestPanel(f);
    await click(f, "缓存统计"); assert.match(latestPanel(f).text, /胃囊报表/);
    assert.equal(f.sent.filter(s => s.method === "sendMessage").length, 1, "cache navigation must reuse the original panel");
    await click(f, "返回首页");
    await click(f, "模型");
    await click(f, "主模型");
    await click(f, "下一页"); assert.match(latestPanel(f).text, /第 2\/2 页/);
    await click(f, "详情与收藏"); await click(f, "Model 6"); assert.match(latestPanel(f).text, /provider\/model-6/);
    await click(f, "加入常用");
    await click(f, "选择此模型");
    await click(f, "常用模型"); assert.match(latestPanel(f).buttons.map(b => b.text).join(" "), /✓ Model 6/);
    await click(f, "刷新目录");
    await click(f, "返回首页");
    await click(f, "模型"); await click(f, "主模型");
    await click(f, "思考等级"); await click(f, "high"); assert.match(latestPanel(f).text, /当前：high/);
    await click(f, "返回首页");
    await click(f, "设置");
    await click(f, /草稿预览/); assert.match(latestPanel(f).buttons.map(b => b.text).join(" "), /草稿预览：关/);
    await click(f, "返回首页");
    await click(f, "工作列表"); assert.match(latestPanel(f).text, /暂无工作/);
    await click(f, "返回首页");
    await click(f, "设置"); await click(f, "会话操作"); await click(f, "重置上下文…"); await click(f, "取消");
    await click(f, "返回首页");
    const updates = f.sent.filter(s => s.method === "editMessageText");
    assert.ok(updates.length >= 20);
    assert.ok(updates.every(s => JSON.parse(String(s.body)).message_id === original.id));
    assert.equal(f.sent.filter(s => s.method === "sendMessage").length, 1);
    const editedCount = updates.length;
    await click(f, "模型", original);
    assert.match(String(f.sent.at(-1)?.body), /过期/);
    assert.equal(f.sent.filter(s => s.method === "editMessageText").length, editedCount, "buttons replaced on this message cannot navigate an old view");
    assert.equal(f.requests.length, 0);
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

test("a failed panel action displays the error in the same message and expires its old buttons", async () => {
  const f = await controlPanelFixture();
  try {
    await f.bot.handleUpdate(command(2101, "/model"));
    await click(f, "主模型");
    const original = latestPanel(f);
    const config = JSON.parse(await readFile(f.configPath, "utf8"));
    await writeFile(f.configPath, JSON.stringify({ ...config, baseUrl: "", apiKey: "" }));
    await click(f, "Beta", original);
    assert.equal(latestPanel(f).id, original.id);
    assert.match(latestPanel(f).text, /操作未完成.*未连接/s);
    assert.equal(f.sent.filter(s => s.method === "sendMessage").length, 1);
    await click(f, "Beta", original);
    assert.match(String(f.sent.at(-1)?.body), /过期/);
    assert.equal(f.requests.length, 0);
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

test("native model pagination, detail and favorites preserve opaque catalog IDs and selection", async () => {
  const models = Array.from({length: 8}, (_, i) => ({ id: `provider/route/team/model-${i}`, display_name: `Model ${i}`, owned_by: "provider", context_window: 32000, reasoning: false }));
  const f = await controlPanelFixture({ models });
  try {
    await f.bot.handleUpdate(command(1, "/model"));
    await click(f, "主模型");
    let panel = latestPanel(f); assert.match(panel.buttons.map(b => b.text).join(" "), /✓ Model 0/);
    for (const button of panel.buttons) assert.ok(Buffer.byteLength(button.callback_data, "utf8") <= 64);
    const reads = f.catalogReads;
    await click(f, "下一页"); panel = latestPanel(f); assert.match(panel.buttons.map(b => b.text).join(" "), /Model 7/); assert.equal(f.catalogReads, reads);
    await click(f, "详情与收藏"); await click(f, "Model 6"); panel = latestPanel(f); assert.match(panel.text, /provider\/route\/team\/model-6/); assert.match(panel.text, /32000/);
    await click(f, "加入常用"); await click(f, "返回模型列表"); await click(f, "常用模型");
    panel = latestPanel(f); assert.match(panel.buttons.map(b => b.text).join(" "), /Model 6/); assert.doesNotMatch(panel.buttons.map(b => b.text).join(" "), /Model 7/);
    await click(f, "Model 6");
    const config = JSON.parse(await readFile(f.configPath, "utf8"));
    assert.equal(config.model, "magpie/provider/route/team/model-6"); assert.equal(config.unrelated, "keep");
    await f.bot.handleUpdate(command(2, "use selected model")); await f.flush();
    assert.equal(f.requests[0]?.model, "provider/route/team/model-6");
    assert.equal(f.requests.length, 1);
  } finally { await f.close(); }
});

test("busy model controls acknowledge immediately and only the last selected settings reach the next real request", { timeout: 60_000 }, async () => {
  const entered = gate(); const release = gate();
  const f = await controlPanelFixture({ provider: async (_wire, response) => {
    if (f.requests.length === 1) { entered.resolve(); await release.promise; }
    sendChatCompletion(response, "confirmed answer");
  } });
  try {
    await f.bot.handleUpdate(command(1, "hold A")); await entered.promise;
    await f.bot.handleUpdate(command(2, "/model"));
    await click(f, "主模型");
    await click(f, "Beta"); await click(f, "Gamma");
    await f.bot.handleUpdate(command(3, "/thinking high"));
    await f.bot.handleUpdate(command(4, "/start"));
    const panel = latestPanel(f);
    assert.match(panel.text, /待生效：route\/team\/C · high/);
    assert.match(panel.text, /实际请求：provider\/A · medium/); assert.match(panel.text, /待生效/);
    assert.equal(f.requests.length, 1);
    assert.ok(f.sent.some(s => s.method === "answerCallbackQuery"));
    await click(f, "缓存统计"); assert.match(latestPanel(f).text, /胃囊报表/);
    await f.bot.handleUpdate(command(5, "/model")); await click(f, "主模型"); await click(f, "详情与收藏"); await click(f, "Alpha"); await click(f, "加入常用"); await click(f, "返回模型列表"); await click(f, "常用模型");
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
    await f.bot.handleUpdate(command(1, "/start")); await click(f, "设置"); const original = latestPanel(f);
    const before = f.sent.length;
    await click(f, /草稿预览/, original, 43);
    await click(f, /草稿预览/, original, 42, 99);
    await click(f, /草稿预览/, original, 42, 42, original.id + 200);
    await click(f, /草稿预览/, original, 42, 42, original.id, true);
    assert.equal(f.sent.slice(before).filter(s => s.method === "answerCallbackQuery").length, 4);
    await f.bot.handleUpdate(command(2, "/start")); await click(f, "设置"); assert.match(latestPanel(f).buttons.map(b => b.text).join(" "), /草稿预览：开/);
    await click(f, /草稿预览/, original);
    assert.match(latestPanel(f).buttons.map(b => b.text).join(" "), /草稿预览：关/);
    await click(f, /草稿预览/, original);
    await f.reopen();
    await click(f, /草稿预览/, original);
    assert.match(String(f.sent.at(-1)?.body), /过期/);
    await f.bot.handleUpdate(command(3, "/start")); await click(f, "设置"); assert.match(latestPanel(f).buttons.map(b => b.text).join(" "), /草稿预览：关/);
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
    await f.bot.handleUpdate(command(1, "/model")); await click(f, "主模型"); const old = latestPanel(f);
    f.setCatalogFailure(true); await click(f, "刷新目录");
    assert.match(latestPanel(f).text, /刷新失败/); assert.match(latestPanel(f).buttons.map(b => b.text).join(" "), /Beta/);
    f.setCatalogFailure(false); f.setModels([{ id: "route/new/D", display_name: "Delta", reasoning: false }]);
    await click(f, "刷新目录"); assert.match(latestPanel(f).buttons.map(b => b.text).join(" "), /Delta/); assert.doesNotMatch(latestPanel(f).buttons.map(b => b.text).join(" "), /Beta/);
    await click(f, "Beta", old); assert.match(String(f.sent.at(-1)?.body), /过期/);
    assert.match(latestPanel(f).buttons.map(b => b.text).join(" "), /Delta/);
    assert.equal(f.sent.filter(s => s.method === "sendMessage").length, 1);
    assert.equal(f.requests.length, 0);
    await f.bot.handleUpdate(command(2, "/start")); assert.match(latestPanel(f).text, /不可用/);
    await f.bot.handleUpdate(command(3, "/model route/new/D"));
    await f.bot.handleUpdate(command(4, "use new model")); await f.flush();
    assert.equal(f.requests[0]?.model, "route/new/D");
  } finally { await f.close(); }
});

test("turning drafts off during a streamed response stops later previews while final text, files and receipts still deliver", { timeout: 60_000 }, async () => {
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
    assert.match(latestPanel(f).buttons.map(b => b.text).join(" "), /草稿预览：关/);
    const previews = f.sent.filter(s => s.method === "sendRichMessageDraft").length; assert.ok(previews > 0);
    proceed.resolve(); await f.flush();
    assert.equal(f.sent.filter(s => s.method === "sendRichMessageDraft").length, previews);
    assert.equal(f.sent.filter(s => s.method === "sendDocument").length, 1);
    assert.ok(f.sent.some(s => s.method === "sendRichMessage" && /FINAL_TEXT/.test(String(s.body))));
    const receipts = await readFile(join(f.directory, "telegram-sends.jsonl"), "utf8");
    assert.match(receipts, /"kind":"file"/); assert.match(receipts, /"status":"sent"/);
    await f.reopen(); await f.bot.handleUpdate(command(3, "/start")); await click(f, "设置");
    assert.match(latestPanel(f).buttons.map(b => b.text).join(" "), /草稿预览：关/);
    assert.deepEqual(f.errors, []);
  } finally { proceed.resolve(); await f.close(); }
});

test("work list shows newest first across pages and restart without changing FIFO queue order", async () => {
  const f = await controlPanelFixture();
  const summaries = Array.from({ length: 8 }, (_, index) => `ORDER_WORK_${index + 1}`);
  const displayedWorks = () => latestPanel(f).buttons.filter(button => button.text.includes("ORDER_WORK_")).map(button => button.text);
  const newestPage = summaries.slice(2).reverse().map(summary => `◽ ${summary}`);
  const oldestPage = summaries.slice(0, 2).reverse().map(summary => `◽ ${summary}`);
  try {
    for (const [index, summary] of summaries.entries()) {
      await f.bot.handleUpdate(command(index + 1, summary));
      await f.flush();
    }
    await f.bot.handleUpdate(command(9, "/start"));
    await click(f, "工作列表");
    assert.deepEqual(displayedWorks(), newestPage);
    await click(f, "下一页");
    assert.deepEqual(displayedWorks(), oldestPage);
    assert.ok(!latestPanel(f).buttons.some(button => button.text === "下一页"));
    await click(f, "上一页");
    assert.deepEqual(displayedWorks(), newestPage);
    await click(f, "ORDER_WORK_8");
    assert.match(latestPanel(f).text, /工作详情<\/b>\nORDER_WORK_8\n目标：/);
    await click(f, "返回工作列表");
    assert.deepEqual(displayedWorks(), newestPage);
    assert.deepEqual((await f.app.controlSnapshot("telegram:private:42")).works.map(work => work.summary), summaries);
    await f.reopen();
    await f.bot.handleUpdate(command(10, "/work"));
    assert.deepEqual(displayedWorks(), newestPage);
    await click(f, "下一页");
    assert.deepEqual(displayedWorks(), oldestPage);
    assert.equal(f.requests.length, summaries.length);
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

test("work details identify one queued target and cancellation preserves other FIFO work", { timeout: 60_000 }, async () => {
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
    assert.match(latestPanel(f).buttons.map(b => b.text).join(" "), /⌛ CANCEL_B/);
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
    await f.bot.handleUpdate(command(1, "/start")); assert.match(latestPanel(f).buttons.map(b => b.text).join(" "), /未选择/);
    await f.bot.handleUpdate(command(2, "WAIT_FIRST")); await f.bot.handleUpdate(command(3, "WAIT_SECOND")); await f.flush();
    assert.equal(f.requests.length, 0);
    await f.reopen(); await f.bot.handleUpdate(command(4, "/start"));
    assert.match(latestPanel(f).text, /等待选择/); assert.equal(f.requests.length, 0);
    await f.bot.handleUpdate(command(5, "/model")); await click(f, "主模型"); await click(f, "Beta"); await f.flush();
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
