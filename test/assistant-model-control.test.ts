import { test } from "node:test";
import { Type } from "typebox";
import assert from "node:assert/strict";
import { assistantFixture, type Wire } from "./fixtures/assistant.js";
import { sendChatCompletion } from "./fixtures/chat-completion.js";

const conversationId = "telegram:private:42";
const catalog = [
  { id: "vendor/deep/A", display_name: "A", reasoning: true, supported_reasoning_levels: ["low", "medium", "high"] },
  { id: "route/group/C", display_name: "C", reasoning: true, supported_reasoning_levels: ["low", "high"] },
];

test("unselected first inputs persist across reopen and selecting a model releases their original FIFO", async () => {
  const requests: Wire[] = [];
  const f = await assistantFixture((wire, response) => { requests.push(wire); sendChatCompletion(response, "done"); }, undefined,
    { catalog, selectedModel: null, primaryConversationId: conversationId });
  try {
    await f.app.receive({ conversationId, inputId: "first", text: "FIRST_GOAL" });
    await f.app.waitForIdle();
    assert.equal(requests.length, 0);
    await f.reopen();
    await f.app.receive({ conversationId, inputId: "second", text: "SECOND_GOAL" });
    await f.app.waitForIdle();
    const waiting = await f.app.controlSnapshot(conversationId);
    assert.equal(waiting.status, "waiting_model");
    assert.equal(waiting.waiting, 2);
    await f.app.control(conversationId, { type: "model", model: "vendor/deep/A" });
    await f.app.waitForIdle();
    assert.equal(requests.length, 1);
    const text = JSON.stringify(requests[0]!.messages);
    assert.ok(text.indexOf("FIRST_GOAL") < text.indexOf("SECOND_GOAL"));
    assert.equal((requests[0] as Wire & {model:string}).model, "vendor/deep/A");
    assert.equal((requests[0] as Wire & {reasoning_effort:string}).reasoning_effort, "medium");
  } finally { await f.close(); }
});

function latch() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return {promise,release};
}

test("settings remain frozen for an in-flight request, the last choice reaches the next tool continuation", async () => {
  const entered = latch(), held = latch(), toolEntered = latch(), toolHeld = latch();
  const requests: Array<Wire & {model:string;reasoning_effort?:string}> = [];
  let effects = 0;
  const f = await assistantFixture(async (wire, response) => {
    requests.push(wire as typeof requests[number]);
    if (requests.length === 1) {
      entered.release(); await held.promise;
      sendChatCompletion(response, "", [{index:0,id:"once",type:"function",function:{name:"effect_once",arguments:"{}"}}]);
    } else sendChatCompletion(response, "retained results complete");
  }, async () => ({tools:[{name:"effect_once",label:"effect",description:"Observable completed effect",parameters: Type.Object({}),
    async execute() { effects++; toolEntered.release(); await toolHeld.promise; return {content:[{type:"text",text:"EFFECT_CONFIRMED"}],details:{}}; }
  }]}), {catalog:[...catalog,{id:"unused/B",reasoning:false}],selectedModel:"vendor/deep/A",primaryConversationId:conversationId});
  try {
    await f.app.receive({conversationId,inputId:"work",text:"ORIGINAL_GOAL"});
    await entered.promise;
    await f.app.control(conversationId,{type:"model",model:"unused/B"});
    const selected = await f.app.control(conversationId,{type:"model",model:"route/group/C"});
    assert.equal(selected.snapshot.actual?.model,"vendor/deep/A");
    assert.equal(selected.snapshot.selectedModel,"route/group/C");
    assert.equal(selected.snapshot.pending,true);
    assert.equal(requests.length,1);
    held.release(); await toolEntered.promise;
    await f.app.control(conversationId,{type:"thinking",level:"high"});
    const status = await f.app.controlSnapshot(conversationId);
    assert.equal(status.status,"running");
    assert.equal(requests.length,1);
    toolHeld.release(); await f.app.waitForIdle();
    assert.deepEqual(requests.map(request => request.model),["vendor/deep/A","route/group/C"]);
    assert.equal(requests[1]!.reasoning_effort,"high");
    assert.match(JSON.stringify(requests[1]!.messages),/ORIGINAL_GOAL/);
    assert.match(JSON.stringify(requests[1]!.messages),/EFFECT_CONFIRMED/);
    assert.equal(effects,1);
  } finally {held.release();toolHeld.release();await f.close();}
});


test("switching to a known text-only model pauses without discarding an existing image, explicit resume keeps it", async () => {
  const requests: Wire[] = [];
  const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aPfoAAAAASUVORK5CYII=";
  const f = await assistantFixture((wire,response) => {requests.push(wire);sendChatCompletion(response,"image retained");}, undefined,
    {catalog:[{id:"text",modalities:["text"],reasoning:false},{id:"vision",modalities:["text","image"],reasoning:false}],selectedModel:"text",primaryConversationId:conversationId});
  try {
    await f.app.receive({conversationId,inputId:"photo",text:"KEEP_IMAGE",images:[{type:"image",mimeType:"image/png",data:png}]});
    await f.app.waitForIdle();
    assert.equal(requests.length,0,"known unsupported images must pause before sending a partial context");
    const paused = await f.app.controlSnapshot(conversationId);
    assert.equal(paused.status,"paused");
    const target = paused.works.find(work => work.status === "paused")!.id;
    await f.app.control(conversationId,{type:"model",model:"vision"});
    await f.app.waitForIdle();
    assert.equal(requests.length,0,"selection does not resume a paused work target");
    await f.app.control(conversationId,{type:"resume",target,operationId:"resume-image"});
    await f.app.waitForIdle();
    assert.equal(requests.length,1);
    assert.match(JSON.stringify(requests[0]!.messages),/data:image\/png;base64/);
    assert.match(JSON.stringify(requests[0]!.messages),/KEEP_IMAGE/);
  } finally {await f.close();}
});

test("switching after a transient failure keeps four total attempts, selection never wakes exhausted work", {timeout:30000}, async () => {
  const first = latch(), failed = latch();
  const requests: Array<Wire & {model:string}> = [];
  let succeed = false;
  const f = await assistantFixture(async (wire,response) => {
    requests.push(wire as typeof requests[number]);
    if (requests.length === 1) {first.release();await failed.promise;}
    if (succeed) sendChatCompletion(response,"explicitly resumed");
    else {response.writeHead(503,{"content-type":"application/json"});response.end(JSON.stringify({error:{message:"temporary gateway failure"}}));}
  },undefined,{catalog,selectedModel:"vendor/deep/A",primaryConversationId:conversationId});
  try {
    await f.app.receive({conversationId,inputId:"retry",text:"KEEP_PROGRESS"});
    await first.promise;
    await f.app.control(conversationId,{type:"model",model:"route/group/C"});
    failed.release();await f.app.waitForIdle();
    assert.equal(requests.length,4);
    assert.deepEqual(requests.map(request=>request.model),["vendor/deep/A","route/group/C","route/group/C","route/group/C"]);
    const paused = await f.app.controlSnapshot(conversationId);
    assert.equal(paused.status,"paused");
    await f.app.control(conversationId,{type:"model",model:"vendor/deep/A"});
    await f.app.waitForIdle();assert.equal(requests.length,4);
    const target = paused.works.find(work=>work.status==="paused")!.id;
    succeed = true;
    await f.app.control(conversationId,{type:"resume",target,operationId:"retry-resume"});
    await f.app.control(conversationId,{type:"resume",target,operationId:"retry-resume"});
    await f.app.waitForIdle();assert.equal(requests.length,5);
    assert.equal(requests[4]!.model,"vendor/deep/A");
  } finally {failed.release();await f.close();}
});

test("thinking preferences use declared levels and survive reset, reopen and capability changes", async () => {
  const requests: Array<Wire & {model:string;reasoning_effort?:string}> = [];
  const models = [
    {id:"medium",reasoning:true,reasoning_levels:["low","medium","high"]},
    {id:"low",reasoning:true,reasoning_levels:["low","high"]},
    {id:"least",reasoning:true,reasoning_levels:["minimal","high"]},
    {id:"text",reasoning:false}, {id:"unknown",reasoning:true},
    {id:"extended",reasoning:true,reasoning_levels:["ultra"]},
  ];
  const f = await assistantFixture((wire,response)=>{requests.push(wire as typeof requests[number]);sendChatCompletion(response,"ok");},undefined,
    {catalog:models,selectedModel:"medium",primaryConversationId:conversationId});
  let sequence = 0;
  const ask = async () => {await f.app.receive({conversationId,inputId:`p${++sequence}`,text:"preference request"});await f.app.waitForIdle();};
  try {
    await ask();assert.equal(requests.at(-1)!.reasoning_effort,"medium");
    for (const [model,level] of [["low","low"],["least","minimal"],["text",undefined],["unknown",undefined],["extended","ultra"]] as const) {
      await f.app.control(conversationId,{type:"model",model});await ask();assert.equal(requests.at(-1)!.reasoning_effort,level);
    }
    await f.app.control(conversationId,{type:"model",model:"medium"});
    await f.app.control(conversationId,{type:"thinking",level:"high"});
    await f.app.control(conversationId,{type:"model",model:"low"});
    await f.app.control(conversationId,{type:"model",model:"medium"});
    await f.app.control(conversationId,{type:"reset",operationId:"prefs-reset"});await f.app.waitForIdle();
    await f.reopen();await ask();assert.equal(requests.at(-1)!.reasoning_effort,"high");
    f.setCatalog(models.map(model=>model.id==="medium" ? {...model,reasoning_levels:["low"]} : model));
    const refreshed = await f.app.controlSnapshot(conversationId,{refresh:true});
    assert.equal(refreshed.thinking,"low");assert.equal(refreshed.thinkingAdjusted,true);
    await ask();assert.equal(requests.at(-1)!.reasoning_effort,"low");
  } finally {await f.close();}
});
