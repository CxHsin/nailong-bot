import { test } from "node:test";
import assert from "node:assert/strict";
import { assistantFixture } from "./fixtures/assistant.js";
import { sendChatCompletion } from "./fixtures/chat-completion.js";

function classification(response: import('node:http').ServerResponse, actions: unknown[]) {
  response.writeHead(200, { 'content-type': 'application/json' });
  response.end(JSON.stringify({ id: 'intent', object: 'chat.completion', choices: [{ index: 0, message: {role: 'assistant', content: JSON.stringify({actions})}, finish_reason: 'stop' }] }));
}

test('retired steer commands ask for natural language and never become model work', async () => {
  const seen: unknown[] = [];
  const f = await assistantFixture((wire, response) => { seen.push(wire); sendChatCompletion(response, 'unexpected'); });
  try {
    await f.app.receive({conversationId:'one',inputId:'old',text:'/steer change to CSV'});
    await f.app.waitForIdle();
    assert.equal(seen.length, 0);
    assert.ok(f.outputs.some(out => out.type === 'text' && /自然语言/.test(out.text)));
  } finally { await f.close(); }
});

test('queued report receives CSV modification before first execution while unrelated weather retains FIFO', { timeout: 60_000 }, async () => {
  let release!: () => void;
  const hold = new Promise<void>(resolve => {release=resolve;});
  let entered!: () => void;
  const ready = new Promise<void>(resolve => {entered=resolve;});
  const actual: string[] = [];
  const f = await assistantFixture(async (wire, response) => {
    const request = wire as typeof wire & {model:string;stream?:boolean};
    if (request.model === 'router') {
      const context = JSON.parse(String(wire.messages.at(-1)!.content));
      const text = context.current.text;
      if (text === '报表改为 CSV') classification(response,[{kind:'supplement',text,target:context.works.find((w: {summary:string})=>w.summary==='生成报表').id}]);
      else classification(response,[{kind:'request',text}]);
      return;
    }
    actual.push(JSON.stringify(wire.messages.at(-1)));
    if (actual.length === 1) { entered(); await hold; }
    sendChatCompletion(response,'已处理');
  },async () => ({intent:{model:'router'},modelConfiguration:{defaultModel:'local',models:[
    {alias:'local',model:'local',api:'openai-completions',apiKey:'test',baseUrl:''},
    {alias:'router',model:'router',api:'openai-completions',apiKey:'test',baseUrl:''},
  ]}}));
  try {
    await f.app.receive({conversationId:'one',inputId:'a',text:'当前工作'}); await ready;
    await f.app.receive({conversationId:'one',inputId:'report',text:'生成报表'});
    await f.app.receive({conversationId:'one',inputId:'weather',text:'查询天气'});
    await f.app.receive({conversationId:'one',inputId:'csv',source:'telegram',text:'报表改为 CSV',
      replyToMessageId:'98765',replyToMessage:{role:'user',text:'ORIGINAL_REPORT_REFERENCE',hasImages:false},
      runtimeMaterials:['Telegram 素材身份（未自动收录）：{"replySticker":{"file_unique_id":"queued-sticker-identity"}}']});
    release(); await f.app.waitForIdle();
    assert.equal(actual.length,2);
    assert.match(actual[1]!,/报表改为 CSV/);
    assert.ok(actual[1]!.indexOf('生成报表') < actual[1]!.indexOf('查询天气'));
    assert.match(actual[1]!,/identity=\\"csv\\"/);
    assert.match(actual[1]!,/replyToMessageId[^0-9]+98765/);
    assert.match(actual[1]!,/ORIGINAL_REPORT_REFERENCE/);
    assert.match(actual[1]!,/queued-sticker-identity/);
    assert.equal(f.app.routingStatus('one').model,'router','legacy fixture keeps its explicit alias');
  } finally {release();await f.close();}
});
