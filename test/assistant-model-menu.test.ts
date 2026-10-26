import { test } from "node:test";
import assert from "node:assert/strict";
import { controlPanelFixture } from "./fixtures/control-panel.js";
import { botInfo } from "./fixtures/telegram.js";
import { createServer } from "node:http";
import type { EmbeddingConfig } from "../src/assistant/embedding.js";
import { embeddingFixture } from "./fixtures/embedding.js";
import { setTimeout as delay } from "node:timers/promises";

const conversation = "telegram:private:42";
const command = (id: number, text: string) => ({ update_id: id, message: { message_id: id, date: 0,
  chat: { id: 42, type: "private" as const, first_name: "owner" }, from: { id: 42, is_bot: false, first_name: "owner" }, text } });
type Fixture = Awaited<ReturnType<typeof controlPanelFixture>>;
function gate() {
  let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve };
}
function panel(f: Fixture) {
  const sent = f.sent.filter(item => ["sendMessage", "editMessageText"].includes(item.method)).at(-1)!;
  const body = JSON.parse(String(sent.body));
  return { id: sent.messageId, text: body.text as string,
    buttons: (body.reply_markup?.inline_keyboard.flat() ?? []) as Array<{text:string;callback_data:string}> };
}
let callback = 40000;
async function click(f: Fixture, label: string, current = panel(f), actor = 42, chat = 42, messageId = current.id, group = false) {
  const button = current.buttons.find(item => item.text === label) ?? current.buttons.find(item => item.text.includes(label));
  assert.ok(button, `missing ${label}: ${current.buttons.map(item => item.text).join(", ")}`);
  await f.bot.handleUpdate({ update_id: ++callback, callback_query: { id: `cb:${callback}`, from: { id: actor, is_bot: false, first_name: "owner" },
    chat_instance: "private", data: button.callback_data, message: { message_id: messageId, date: 0,
      chat: group ? { id: chat, type: "group", title: "group" } : { id: chat, type: "private", first_name: "owner" }, from: botInfo, text: current.text } } });
}

test("home and /model open three independent model choices; thinking belongs to main models and IDs remain complete", async () => {
  const f = await controlPanelFixture();
  try {
    await f.bot.handleUpdate(command(4001, "/start"));
    const original = panel(f);
    const labels = original.buttons.map(item => item.text);
    assert.ok(labels.includes("🤖 模型：Alpha"));
    assert.ok(!labels.some(label => /路由|思考等级|Embedding/.test(label)));
    await click(f, "模型：Alpha");
    assert.deepEqual(panel(f).buttons.map(item => item.text), ["🤖 主模型：Alpha", "🧭 路由模型：未选择", "🔎 Embedding 模型：未选择", "返回首页"]);
    await click(f, "主模型");
    assert.match(panel(f).text, /当前：Alpha/);
    assert.ok(panel(f).buttons.some(item => item.text === "🧠 思考等级：medium"));
    await click(f, "思考等级"); await click(f, "high");
    await click(f, "返回主模型"); await click(f, "返回模型菜单");
    assert.equal(panel(f).id, original.id);
    await click(f, "路由模型");
    assert.ok(!panel(f).buttons.some(item => item.text.includes("思考等级")));
    await click(f, "Gamma"); await click(f, "返回模型菜单");
    assert.ok(panel(f).buttons.some(item => item.text === "🧭 路由模型：Gamma"));
    await f.bot.handleUpdate(command(4002, "/model"));
    assert.ok(panel(f).buttons.some(item => item.text === "🔎 Embedding 模型：未选择"));
    await f.bot.handleUpdate(command(4003, "/model provider/B"));
    assert.match(panel(f).text, /当前：Beta/);
    await click(f, "返回首页");
    assert.ok(panel(f).buttons.some(item => item.text === "🤖 模型：Beta"));
    await f.bot.handleUpdate(command(4004, "/thinking"));
    assert.match(panel(f).text, /不支持推理/);
    const state = await f.app.controlSnapshot(conversation);
    assert.equal(state.selectedModel, "provider/B");
    assert.equal(state.routing.selectedModel, "route/team/C");
    assert.equal(f.requests.length, 0);
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

test("Embedding menu lists local identities and only explicit testing sends synthetic HTTP, with persisted service-wide results", async () => {
  const requests: Array<{ model: string; input: string[] }> = [];
  const remote = createServer(async (request, response) => {
    assert.equal(request.url, "/v1/embeddings");
    let body = ""; for await (const part of request) body += part;
    const wire = JSON.parse(body); requests.push(wire);
    response.writeHead(200, {"content-type":"application/json"});
    response.end(JSON.stringify({data: wire.input.map((_: string, index: number) => ({index, embedding:[1,2,3]}))}));
  });
  await new Promise<void>(resolve => remote.listen(0, "127.0.0.1", resolve));
  const address = remote.address(); assert.ok(address && typeof address !== "string");
  const f = await controlPanelFixture({embedding:{env:{SECRET:"embedding-private-secret"}, configs:[
    {id:"local/first",displayName:"Same name",model:"provider/semantic-A",baseUrl:`http://127.0.0.1:${address.port}/v1`,apiKeyEnv:"SECRET"},
    {id:"local/second",displayName:"Same name",model:"provider/semantic-B",baseUrl:`http://127.0.0.1:${address.port}/v1`,apiKeyEnv:"SECRET"},
    {id:"local/broken",displayName:"Broken",model:"provider/missing-key",baseUrl:`http://127.0.0.1:${address.port}/v1`,apiKeyEnv:"MISSING"},
  ]}});
  try {
    await f.bot.handleUpdate(command(4101, "/model")); await click(f, "Embedding 模型：Same name");
    assert.match(panel(f).text, /独立本地配置/);
    assert.match(panel(f).text, /ID：local\/first/);
    assert.match(panel(f).text, /模型：provider\/semantic-A/);
    assert.match(panel(f).text, /连接：未测试/);
    assert.match(panel(f).text, /准备：未开始/);
    assert.match(panel(f).text, /已提交 0\/0 · 失败 0/);
    assert.ok(panel(f).buttons.some(item => item.text.includes("Broken") && item.text.includes("不可用")));
    await click(f, "Same name · local/second");
    assert.match(panel(f).text, /ID：local\/second/);
    assert.match(panel(f).text, /模型：provider\/semantic-B/);
    assert.equal((await f.app.controlSnapshot("cli:other")).embedding.selectedId, "local/second");
    assert.equal(requests.length, 0, "viewing and choosing do not test or generate");
    await click(f, "详情", panel(f));
    await click(f, "Same name · local/first");
    assert.match(panel(f).text, /ID：local\/first/);
    assert.match(panel(f).text, /模型：provider\/semantic-A/);
    await click(f, "返回 Embedding 列表");
    await click(f, "测试连接");
    assert.match(panel(f).text, /连接：可用/);
    assert.match(panel(f).text, /连接测试：成功 · 3 维 · \d+ ms/);
    assert.deepEqual(requests.map(({model,input}) => ({model,input})), [{ model:"provider/semantic-B",input:["Nailong Embedding connection test. 奶龙连接测试。"] }]);
    await click(f, "返回模型菜单");
    assert.ok(panel(f).buttons.some(item => item.text === "🔎 Embedding 模型：Same name"));
    await f.reopen();
    await f.bot.handleUpdate(command(4102, "/model")); await click(f, "Embedding 模型");
    assert.match(panel(f).text, /ID：local\/second/);
    assert.match(panel(f).text, /连接测试：成功 · 3 维/);
    const state = await f.app.controlSnapshot(conversation);
    assert.equal(state.selectedModel, "provider/A"); assert.equal(state.routing.selectedModel, undefined);
    assert.equal(state.waiting, 0); assert.deepEqual(state.works, []);
    assert.equal(f.requests.length, 0); assert.equal(requests.length, 1);
    assert.doesNotMatch(JSON.stringify(f.sent), /embedding-private-secret|127\.0\.0\.1/);
    assert.deepEqual(f.errors, []);
  } finally {
    await f.close(); remote.closeAllConnections(); await new Promise<void>(resolve => remote.close(() => resolve()));
  }
});

test("abbreviations fall back to the final model ID segment and matching names still select stable Magpie IDs", async () => {
  const f = await controlPanelFixture({models:[
    {id:"provider/full/model-without-name",reasoning:false},
    {id:"provider/first/shared",display_name:"Same name",reasoning:false},
    {id:"provider/second/shared",display_name:"Same name",reasoning:false},
  ],embedding:{env:{SECRET:"local-secret"},configs:[
    {id:"local/configuration",displayName:"",model:"remote/models/semantic-without-name",baseUrl:"http://127.0.0.1:1/v1",apiKeyEnv:"SECRET"},
  ]}});
  try {
    await f.bot.handleUpdate(command(4201, "/start"));
    assert.ok(panel(f).buttons.some(item => item.text === "🤖 模型：model-without-name"));
    await click(f, "模型：");
    assert.ok(panel(f).buttons.some(item => item.text === "🔎 Embedding 模型：semantic-without-name"));
    await click(f, "主模型"); await click(f, "Same name · provider/second");
    assert.equal((await f.app.controlSnapshot(conversation)).selectedModel, "provider/second/shared");
    await click(f, "返回模型菜单"); await click(f, "路由模型"); await click(f, "Same name · provider/first");
    const state = await f.app.controlSnapshot(conversation);
    assert.equal(state.routing.selectedModel, "provider/first/shared");
    assert.equal(state.selectedModel, "provider/second/shared");
    assert.equal(state.embedding.selectedId, "local/configuration");
    await click(f, "返回模型菜单");
    assert.ok(panel(f).buttons.some(item => item.text === "🤖 主模型：Same name"));
    assert.ok(panel(f).buttons.some(item => item.text === "🧭 路由模型：Same name"));
    assert.equal(f.requests.length, 0); assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

test("Embedding reports safe HTTP failure, invalid or removed configuration, and unconfigured state independently of Magpie", async () => {
  let calls = 0;
  const remote = createServer(async (request, response) => {
    for await (const _part of request) { /* consume the actual request */ }
    calls++; response.writeHead(401, {"content-type":"application/json"});
    response.end(JSON.stringify({error:{message:"embedding-private-secret http://sensitive-host/v1"}}));
  });
  await new Promise<void>(resolve => remote.listen(0, "127.0.0.1", resolve));
  const address = remote.address(); assert.ok(address && typeof address !== "string");
  const configs: EmbeddingConfig[] = [
    {id:"working",displayName:"Remote",model:"semantic",baseUrl:`http://127.0.0.1:${address.port}/v1`,apiKeyEnv:"SECRET"},
    {id:"broken",displayName:"Broken",model:"missing-credential",baseUrl:`http://127.0.0.1:${address.port}/v1`,apiKeyEnv:"MISSING"},
  ];
  const f = await controlPanelFixture({embedding:{env:{SECRET:"embedding-private-secret"},configs}});
  try {
    f.setCatalogFailure(true);
    await f.bot.handleUpdate(command(4301, "/model")); await click(f, "Embedding 模型");
    assert.doesNotMatch(panel(f).text, /目录刷新失败|模型目录暂不可用/, "independent local list is not a failed Magpie catalog");
    await click(f, "测试连接");
    assert.match(panel(f).text, /连接：不可用/); assert.match(panel(f).text, /连接测试：失败 · Embedding 认证失败/);
    assert.equal(calls, 1);
    await click(f, "Broken"); assert.match(panel(f).text, /连接：配置无效/);
    await click(f, "配置详情"); await click(f, "Broken");
    assert.match(panel(f).text, /ID：broken/); assert.match(panel(f).text, /配置无效或本地凭据缺失/);
    await click(f, "返回 Embedding 列表");
    configs.splice(0, configs.length);
    await click(f, "刷新状态与本地列表");
    assert.match(panel(f).text, /ID：broken/); assert.match(panel(f).text, /没有本地 Embedding 配置/);
    await f.reopen(); await f.bot.handleUpdate(command(4302, "/model")); await click(f, "Embedding 模型");
    assert.match(panel(f).text, /ID：broken/); assert.match(panel(f).text, /已保存的 Embedding 选择不可用/);
    assert.equal(calls, 1); assert.equal(f.requests.length, 0);
    assert.doesNotMatch(JSON.stringify(f.sent), /embedding-private-secret|sensitive-host|127\.0\.0\.1/);
    assert.deepEqual(f.errors, []);
  } finally {
    await f.close(); remote.closeAllConnections(); await new Promise<void>(resolve => remote.close(() => resolve()));
  }
  const empty = await controlPanelFixture({embedding:{env:{},configs:[]}});
  try {
    await empty.bot.handleUpdate(command(4303, "/model")); await click(empty, "Embedding 模型");
    assert.match(panel(empty).text, /连接：未配置/); assert.match(panel(empty).text, /当前：未选择/);
    await click(empty, "测试连接"); assert.match(panel(empty).text, /连接测试：失败/);
    assert.equal(empty.requests.length, 0); assert.deepEqual(empty.errors, []);
  } finally { await empty.close(); }
});

test("native Embedding controls stay responsive during work, reject wrong identities and repeat tests once without resuming paused work", { timeout: 60_000 }, async () => {
  const generation = gate(), testing = gate(), releaseTest = gate();
  const synthetic = "Nailong Embedding connection test. 奶龙连接测试。";
  const requests: Array<{model:string;input:string[]}> = [];
  const remote = createServer(async (request, response) => {
    let body = ""; for await (const part of request) body += part;
    const wire = JSON.parse(body); requests.push(wire);
    if (wire.input.join("") === synthetic && requests.filter(item => item.input.join("") === synthetic).length === 1) {
      testing.resolve(); await releaseTest.promise;
    }
    response.writeHead(200, {"content-type":"application/json"});
    response.end(JSON.stringify({data:wire.input.map((_:string,index:number) => ({index,embedding:[1,2,3]}))}));
  });
  await new Promise<void>(resolve => remote.listen(0, "127.0.0.1", resolve));
  const address = remote.address(); assert.ok(address && typeof address !== "string");
  const f = await controlPanelFixture({provider:() => {generation.resolve();},embedding:{env:{SECRET:"local-secret"},configs:[
    {id:"one",displayName:"First",model:"semantic-one",baseUrl:`http://127.0.0.1:${address.port}/v1`,apiKeyEnv:"SECRET"},
    {id:"two",displayName:"Second",model:"semantic-two",baseUrl:`http://127.0.0.1:${address.port}/v1`,apiKeyEnv:"SECRET"},
  ]}});
  try {
    await f.bot.handleUpdate(command(4401, "KEEP_PAUSED_GOAL")); await generation.promise;
    await f.bot.handleUpdate(command(4402, "/model")); await click(f, "Embedding 模型");
    const original = panel(f);
    for (const [actor, chat, messageId, group] of [[43,42,original.id,false], [42,99,original.id,false], [42,42,original.id+1,false], [42,42,original.id,true]] as const) {
      await click(f, "Second", original, actor, chat, messageId, group);
      await click(f, "测试连接", original, actor, chat, messageId, group);
    }
    assert.equal((await f.app.controlSnapshot(conversation)).embedding.selectedId, "one");
    assert.equal(requests.filter(item => item.input.join("") === synthetic).length, 0);
    await click(f, "Second");
    assert.equal((await f.app.controlSnapshot(conversation)).status, "running");
    const testPanel = panel(f);
    const pendingTest = click(f, "测试连接", testPanel);
    await testing.promise;
    assert.match(String(f.sent.findLast(item => item.method === "answerCallbackQuery")?.body), /正在更新/);
    await click(f, "测试连接", testPanel);
    assert.match(String(f.sent.at(-1)?.body), /已使用/);
    assert.equal(requests.filter(item => item.input.join("") === synthetic).length, 1);
    await f.bot.handleUpdate(command(4403, "/stop")); await f.flush();
    assert.equal((await f.app.controlSnapshot(conversation)).status, "paused");
    releaseTest.resolve(); await pendingTest;
    assert.match(panel(f).text, /连接测试：成功 · 3 维/);
    await click(f, "First"); await click(f, "测试连接");
    assert.equal((await f.app.controlSnapshot(conversation)).status, "paused");
    assert.equal(f.requests.length, 1);
    await f.reopen();
    await click(f, "测试连接", testPanel); assert.match(String(f.sent.at(-1)?.body), /过期/);
    await f.bot.handleUpdate(command(4404, "/model")); await click(f, "Embedding 模型");
    assert.match(panel(f).text, /ID：one/);
    assert.match(panel(f).text, /连接测试：成功 · 3 维/);
    const restored = await f.app.controlSnapshot(conversation);
    assert.equal(restored.status, "paused"); assert.equal(restored.works.length, 1);
    assert.equal(restored.works[0]?.summary, "KEEP_PAUSED_GOAL");
    assert.equal(f.requests.length, 1);
    assert.deepEqual(requests.filter(item => item.input.join("") === synthetic).map(item => item.model), ["semantic-two", "semantic-one"]);
    assert.deepEqual(f.errors, []);
  } finally {
    releaseTest.resolve(); await f.close(); remote.closeAllConnections(); await new Promise<void>(resolve => remote.close(() => resolve()));
  }
});

test("routing model pages retain Magpie pagination, details and shared favorites with return navigation", async () => {
  const f = await controlPanelFixture({models:Array.from({length:8},(_,index) => ({
    id:`provider/route/model-${index}`,display_name:`Route ${index}`,reasoning:false,context_window:32000,
  }))});
  try {
    await f.bot.handleUpdate(command(4501, "/model")); await click(f, "路由模型");
    const reads = f.catalogReads;
    await click(f, "下一页"); assert.match(panel(f).text, /第 2\/2 页/);
    await click(f, "详情与收藏"); await click(f, "Route 7");
    assert.match(panel(f).text, /ID：provider\/route\/model-7/); assert.match(panel(f).text, /上下文窗口：32000/);
    await click(f, "加入常用"); await click(f, "返回模型列表"); await click(f, "常用模型");
    assert.equal(panel(f).buttons.filter(item => item.text.includes("Route")).length, 1);
    await click(f, "Route 7"); await click(f, "返回模型菜单");
    assert.ok(panel(f).buttons.some(item => item.text === "🧭 路由模型：Route 7"));
    await click(f, "主模型"); await click(f, "常用模型"); await click(f, "Route 7");
    const state = await f.app.controlSnapshot(conversation);
    assert.equal(state.selectedModel, "provider/route/model-7"); assert.equal(state.routing.selectedModel, "provider/route/model-7");
    assert.ok(state.favorites.includes("provider/route/model-7"));
    assert.equal(f.catalogReads, reads + 1, "only entering a fresh main model list refreshes the catalog");
    assert.equal(f.requests.length, 0); assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

test("Embedding progress renders actual background source commits and remains visible after reopen without triggering a test", async () => {
  const remote = await embeddingFixture(() => [1,2,3]);
  const f = await controlPanelFixture({embedding:{env:{SECRET:"local-secret"},configs:[
    {id:"semantic",displayName:"Semantic",model:"source-model",baseUrl:remote.baseUrl,apiKeyEnv:"SECRET"},
  ]}});
  try {
    await f.bot.handleUpdate(command(4601, "Remember that my preferred drink is white tea.")); await f.flush();
    const deadline = Date.now() + 5000;
    while ((await f.app.controlSnapshot(conversation)).embedding.progress.completed < 2 && Date.now() < deadline) await delay(15);
    const progress = (await f.app.controlSnapshot(conversation)).embedding.progress;
    assert.equal(progress.completed, 2, "the user input and confirmed assistant reply are actually indexed");
    assert.equal(progress.total, 2); assert.equal(progress.failed, 0);
    await f.bot.handleUpdate(command(4602, "/model")); await click(f, "Embedding 模型");
    assert.match(panel(f).text, /已提交 2\/2 · 失败 0/);
    assert.match(panel(f).text, /准备：已就绪/);
    const requests = remote.requests.length;
    await click(f, "刷新状态与本地列表"); await click(f, "返回模型菜单"); await click(f, "Embedding 模型");
    await f.reopen();
    await f.bot.handleUpdate(command(4603, "/model")); await click(f, "Embedding 模型");
    assert.match(panel(f).text, /已提交 2\/2 · 失败 0/);
    assert.equal(remote.requests.length, requests, "viewing and reopen reuse committed vectors");
    assert.ok(remote.requests.every(item => !item.input.join("").includes("Nailong Embedding connection test")));
    assert.equal(f.requests.length, 1); assert.deepEqual(f.errors, []);
  } finally { await f.close(); await remote.close(); }
});
