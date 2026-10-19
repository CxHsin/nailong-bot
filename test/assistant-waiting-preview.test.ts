import { test } from "node:test";
import assert from "node:assert/strict";
import { Response as ApiResponse } from "node-fetch";
import { telegramFixture } from "./fixtures/telegram.js";
import { sendChatCompletion } from "./fixtures/chat-completion.js";

function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
async function within(promise: Promise<void>) {
  let timer: ReturnType<typeof setTimeout>;
  try { await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("preview did not arrive")), 2500); })]); }
  finally { clearTimeout(timer!); }
}
const command = (id: number, text: string) => ({ update_id: id, message: { message_id: id, date: 0,
  chat: { id: 42, type: "private" as const, first_name: "owner" }, from: { id: 42, is_bot: false, first_name: "owner" }, text } });

test("a real processing preview precedes body text and uses the same draft lane without claiming success", async () => {
  const release = gate(), waiting = gate(), body = gate();
  const f = await telegramFixture(async (_wire, response) => {
    await release.promise;
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { role: "assistant", content: "ACTUAL_BODY" }, finish_reason: null }] })}\n\n`);
    await body.promise;
    response.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`);
  }, undefined, undefined, undefined, (method, payload) => {
    if (method === "sendRichMessageDraft") {
      const text = String(payload);
      if (/正在.*处理/.test(text)) waiting.resolve();
      if (text.includes("ACTUAL_BODY")) body.resolve();
    }
  });
  try {
    await f.bot.handleUpdate(command(4001, "DO_WORK"));
    await within(waiting.promise);
    const first = f.sent.find(item => item.method === "sendRichMessageDraft")!;
    assert.doesNotMatch(String(first.body), /完成|成功|失败|吃饱/);
    release.resolve(); await within(body.promise); await f.flush();
    const previews = f.sent.filter(item => item.method === "sendRichMessageDraft").map(item => JSON.parse(String(item.body)));
    assert.ok(previews.length >= 2);
    assert.equal(new Set(previews.map(item => item.draft_id)).size, 1);
    assert.ok(f.sent.some(item => item.method === "sendRichMessage" && String(item.body).includes("ACTUAL_BODY")));
    assert.deepEqual(f.errors, []);
  } finally { release.resolve(); body.resolve(); await f.close(); }
});

test("drafts off suppresses waiting previews and preserves the final answer", async () => {
  const f = await telegramFixture((_wire, response) => sendChatCompletion(response, "FINAL_BODY"));
  try {
    await f.bot.handleUpdate(command(4100, "/draft off"));
    await f.bot.handleUpdate(command(4101, "DO_WORK")); await f.flush();
    assert.equal(f.sent.filter(item => item.method === "sendRichMessageDraft").length, 0);
    assert.ok(f.sent.some(item => item.method === "sendRichMessage" && String(item.body).includes("FINAL_BODY")));
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

test("a decorative reaction preserves the active body preview until formal delivery", async () => {
  const waiting = gate(), body = gate(); let stage = 0;
  const f = await telegramFixture(async (_wire, response) => {
    if (++stage === 1) {
      await waiting.promise;
      sendChatCompletion(response, "", [{index:0,id:"reaction",type:"function",function:{name:"telegram_expression",arguments:JSON.stringify({kind:"reaction",inputId:"4301",messageId:4301,emoji:"👍",explicit:false})}}]);
      return;
    }
    response.writeHead(200, {"content-type":"text/event-stream"});
    response.write(`data: ${JSON.stringify({choices:[{index:0,delta:{role:"assistant",content:"BODY_AFTER_REACTION"},finish_reason:null}]})}\n\n`);
    await body.promise;
    response.end(`data: ${JSON.stringify({choices:[{index:0,delta:{},finish_reason:"stop"}]})}\n\ndata: [DONE]\n\n`);
  }, undefined, undefined, undefined, (method, payload) => {
    if (method === "sendRichMessageDraft") {
      if (/正在.*处理/.test(String(payload))) waiting.resolve();
      if (String(payload).includes("BODY_AFTER_REACTION")) body.resolve();
    }
  });
  try {
    await f.bot.handleUpdate(command(4301,"处理任务并回应一下"));
    await within(body.promise); await f.flush();
    assert.equal(f.sent.filter(item=>item.method === "setMessageReaction").length,1);
    const drafts = f.sent.filter(item=>item.method === "sendRichMessageDraft").map(item=>JSON.parse(String(item.body)));
    assert.equal(new Set(drafts.map(item=>item.draft_id)).size,1);
    assert.ok(f.sent.some(item=>item.method === "sendRichMessage" && String(item.body).includes("BODY_AFTER_REACTION")));
  } finally {waiting.resolve();body.resolve();await f.close();}
});

test("a failed waiting preview cannot block or repeat the formal answer", async () => {
  const previewAttempt = gate();
  const f = await telegramFixture(async (_wire, response) => {
    await previewAttempt.promise;
    sendChatCompletion(response, "FORMAL_RESULT");
  }, async method => {
    if (method === "sendRichMessageDraft") { previewAttempt.resolve(); throw new Error("draft connection lost"); }
    return new ApiResponse(JSON.stringify({ ok: true, result: { message_id: 8, date: 0, chat: { id: 42, type: "private" } } }));
  });
  try {
    await f.bot.handleUpdate(command(4201, "DO_WORK"));
    await within(previewAttempt.promise); await f.flush();
    assert.equal(f.sent.filter(item => item.method === "sendRichMessageDraft").length, 1);
    assert.equal(f.sent.filter(item => item.method === "sendRichMessage" && String(item.body).includes("FORMAL_RESULT")).length, 1);
    assert.equal((await f.app.controlSnapshot("telegram:private:42")).status, "idle");
    assert.match(String(f.errors[0]), /sendRichMessageDraft.*failed/);
  } finally { previewAttempt.resolve(); await f.close(); }
});
