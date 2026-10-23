import { test } from "node:test";
import assert from "node:assert/strict";
import { controlPanelFixture } from "./fixtures/control-panel.js";
import { botInfo } from "./fixtures/telegram.js";

const command = (id: number, text: string) => ({ update_id: id, message: { message_id: id, date: 0,
  chat: { id: 42, type: "private" as const, first_name: "owner" }, from: { id: 42, is_bot: false, first_name: "owner" }, text } });
let callback = 30000;
function panel(f: Awaited<ReturnType<typeof controlPanelFixture>>) {
  const sent = f.sent.filter(item => ["sendMessage", "editMessageText"].includes(item.method)).at(-1)!;
  const body = JSON.parse(String(sent.body));
  return { id: sent.messageId, text: body.text as string, buttons: body.reply_markup.inline_keyboard.flat() as Array<{text:string;callback_data:string}> };
}
async function click(f: Awaited<ReturnType<typeof controlPanelFixture>>, label: string) {
  const current = panel(f), button = current.buttons.find(item => item.text.includes(label));
  assert.ok(button, `missing ${label}`);
  await f.bot.handleUpdate({ update_id: ++callback, callback_query: { id: `cb:${callback}`, from: { id: 42, is_bot: false, first_name: "owner" },
    chat_instance: "private", data: button.callback_data, message: { message_id: current.id, date: 0,
      chat: { id: 42, type: "private", first_name: "owner" }, from: botInfo, text: current.text } } });
}

test("home cache navigation returns directly home and feed and expression preferences survive restart without generation", async () => {
  const f = await controlPanelFixture();
  try {
    await f.bot.handleUpdate(command(3001, "/start"));
    await click(f, "缓存统计");
    assert.match(panel(f).text, /胃囊报表/);
    assert.deepEqual(panel(f).buttons.map(item => item.text), ["返回首页"]);
    await click(f, "返回首页"); await click(f, "饱食");
    assert.match(panel(f).text, /100\/100/);
    await click(f, "投喂"); assert.match(panel(f).text, /100\/100/);
    await click(f, "返回首页"); await click(f, "设置");
    assert.match(panel(f).text, /自然活跃/);
    assert.equal(panel(f).buttons.some(item => item.text.includes("缓存统计")), false);
    for (const frequency of ["安静", "克制", "热闹", "自然活跃", "安静"]) {
      await click(f, frequency); assert.ok(panel(f).buttons.some(item => item.text === `✓ ${frequency}`));
    }
    await f.bot.handleUpdate(command(3002, "/draft off"));
    await f.reopen(); await f.bot.handleUpdate(command(3003, "/start"));
    await click(f, "设置");
    assert.ok(panel(f).buttons.some(item => item.text === "✓ 安静"));
    assert.ok(panel(f).buttons.some(item => /草稿预览：关/.test(item.text)));
    await f.bot.handleUpdate(command(3004, "/feed@test_bot"));
    assert.match(panel(f).text, /100\/100/);
    assert.equal(f.requests.length, 0);
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

test("global routing menu shares catalog and capabilities while preserving the Conversation main model", async () => {
  const f = await controlPanelFixture();
  try {
    await f.bot.handleUpdate(command(3101, "/start"));
    await click(f, "模型"); await click(f, "路由模型");
    assert.match(panel(f).text, /整个助手服务共用/);
    assert.match(panel(f).text, /当前：未选择/);
    await click(f, "Beta");
    assert.match(panel(f).text, /当前：Beta/);
    await click(f, "详情与收藏"); await click(f, "Gamma");
    assert.match(panel(f).text, /route\/team\/C/);
    assert.match(panel(f).text, /low、high/);
    await click(f, "选择此模型");
    const snapshot = await f.app.controlSnapshot("telegram:private:42");
    assert.equal(snapshot.selectedModel, "provider/A");
    assert.equal(snapshot.routing.selectedModel, "route/team/C");
    assert.equal(snapshot.thinking, "medium");
    assert.equal((await f.app.controlSnapshot("cli:other")).routing.selectedModel, "route/team/C");
    await f.reopen(); await f.bot.handleUpdate(command(3102, "/start"));
    await click(f, "模型");
    assert.ok(panel(f).buttons.some(item => item.text === "🧭 路由模型：Gamma"));
    assert.equal(f.requests.length, 0);
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});
