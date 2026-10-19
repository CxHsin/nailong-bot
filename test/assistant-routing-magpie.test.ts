import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { assistantFixture, seedPendingAssistantWork, type Wire } from "./fixtures/assistant.js";
import { sendChatCompletion } from "./fixtures/chat-completion.js";

const conversationId = "telegram:private:42";
const catalog = [
  {id:"main",reasoning:true,supported_reasoning_levels:["low","medium","high"]},
  {id:"router/A",reasoning:false},
  {id:"router/B",reasoning:true,supported_reasoning_levels:["minimal","high"]},
];
type Request = Wire & {model:string;stream?:boolean;reasoning_effort?:string;max_tokens?:number};
function reply(response: import("node:http").ServerResponse, text: string) {
  response.writeHead(200,{"content-type":"application/json"});
  response.end(JSON.stringify({choices:[{message:{role:"assistant",content:JSON.stringify({actions:[{kind:"request",text}]})},finish_reason:"stop"}]}));
}
function gate() { let release!:()=>void; const promise = new Promise<void>(resolve=>{release=resolve;}); return {promise,release}; }

test("routing selection is global and persists independently of main selection, thinking and Magpie observations", async () => {
  const f = await assistantFixture((_wire,response)=>sendChatCompletion(response,"done"),undefined,
    {catalog,selectedModel:"main",primaryConversationId:conversationId});
  try {
    const initial = await f.app.controlSnapshot(conversationId);
    assert.equal(initial.routing.scope,"service");
    assert.equal(initial.routing.selectedModel,undefined,"main selection is never an implicit routing default");
    await f.app.control(conversationId,{type:"thinking",level:"high"});
    const selected = await f.app.control(conversationId,{type:"routing_model",model:"router/A",operationId:"choose-router"});
    assert.equal(selected.snapshot.routing.selectedModel,"router/A");
    assert.equal(selected.snapshot.selectedModel,"main");
    assert.equal(selected.snapshot.thinking,"high");
    assert.equal(JSON.parse(await readFile(f.magpieConfigPath,"utf8")).model,"magpie/main");
    assert.equal((await f.app.controlSnapshot("other")).routing.selectedModel,"router/A");
    await f.writeMagpie({model:"magpie/router/B"});
    await f.app.controlSnapshot(conversationId,{refresh:true});
    await f.reopen();
    const reopened = await f.app.controlSnapshot(conversationId);
    assert.equal(reopened.selectedModel,"router/B");
    assert.equal(reopened.routing.selectedModel,"router/A");
    assert.deepEqual(reopened.routing.catalog.map(model=>model.id),["main","router/A","router/B"]);
  } finally {await f.close();}
});

test("a selected Magpie router classifies unfinished work with its own declared reasoning capability", async () => {
  const requests: Request[] = [];
  const f = await assistantFixture((raw,response)=>{
    const wire = raw as Request; requests.push(wire);
    if (wire.stream === false) reply(response,JSON.parse(String(wire.messages.at(-1)!.content)).current.text);
    else sendChatCompletion(response,"main answer");
  },async directory=>{await seedPendingAssistantWork(directory,conversationId);return {};},
    {catalog,selectedModel:"main",primaryConversationId:conversationId});
  try {
    await f.app.control(conversationId,{type:"thinking",level:"high"});
    await f.app.control(conversationId,{type:"routing_model",model:"router/B"});
    await f.app.receive({conversationId,inputId:"route",source:"telegram",text:"change the earlier report"});
    await f.app.waitForRouting(); await f.app.waitForIdle();
    assert.deepEqual(requests.map(wire=>wire.model),["router/B","main"]);
    assert.equal(requests[0]!.reasoning_effort,"minimal");
    assert.equal(requests[0]!.tools,undefined);
    assert.equal(requests[0]!.max_tokens,1024);
    assert.equal(requests[1]!.reasoning_effort,"high");
    assert.equal((await f.app.controlSnapshot(conversationId)).works.find(work=>work.summary==="unfinished background report")?.status,"paused");
  } finally {await f.close();}
});

test("an in-flight decision retains its router while already received inputs and another conversation use the new selection", {timeout:15000}, async () => {
  const entered = gate(), held = gate();
  const routed: Array<{model:string;inputId:string}> = []; const main: Request[] = [];
  const f = await assistantFixture(async (raw,response)=>{
    const wire = raw as Request;
    if (wire.stream === false) {
      const snapshot = JSON.parse(String(wire.messages.at(-1)!.content));
      routed.push({model:wire.model,inputId:snapshot.current.inputId});
      if (routed.length===1) {entered.release();await held.promise;}
      reply(response,snapshot.current.text);
    } else {main.push(wire);sendChatCompletion(response,"completed");}
  },async directory=>{await seedPendingAssistantWork(directory,conversationId);await seedPendingAssistantWork(directory,"other");return {};},
    {catalog,selectedModel:"main",primaryConversationId:conversationId});
  try {
    await f.app.control(conversationId,{type:"thinking",level:"high"});
    await f.app.control("other",{type:"model",model:"main"});
    await f.app.control(conversationId,{type:"routing_model",model:"router/A"});
    await f.app.receive({conversationId,inputId:"in-flight",text:"first change"}); await entered.promise;
    await f.app.receive({conversationId,inputId:"received-before-switch",text:"second change"});
    await f.app.control("other",{type:"routing_model",model:"router/B"});
    await f.app.receive({conversationId:"other",inputId:"other-conversation",text:"another change"});
    held.release(); await f.app.waitForRouting(); await f.app.waitForIdle();
    assert.deepEqual(routed.find(item=>item.inputId==="in-flight"),{model:"router/A",inputId:"in-flight"});
    assert.deepEqual(routed.find(item=>item.inputId==="received-before-switch"),{model:"router/B",inputId:"received-before-switch"});
    assert.deepEqual(routed.find(item=>item.inputId==="other-conversation"),{model:"router/B",inputId:"other-conversation"});
    assert.ok(main.every(wire=>wire.model==="main"));
    const count = routed.length;
    await f.reopen();
    assert.equal((await f.app.receive({conversationId,inputId:"in-flight",text:"first change"})).duplicate,true);
    await f.app.control("idle",{type:"model",model:"main"});
    await f.app.receive({conversationId:"idle",inputId:"fresh",text:"independent idle request"});
    await f.app.waitForRouting(); await f.app.waitForIdle();
    assert.equal(routed.length,count,"saved decisions and idle conversations do not add classifier requests");
    assert.equal((await f.app.controlSnapshot("other")).routing.selectedModel,"router/B");
  } finally {held.release();await f.close();}
});



test("official startup ignores retired routing aliases and invalid old provider settings without hiding the panel", async () => {
  const { assistantEnvironment } = await import("../src/assistant/environment.js");
  const requests: Request[] = [];
  const f = await assistantFixture((wire,response)=>{requests.push(wire as Request);sendChatCompletion(response,"original handled");},
    async directory=>{await seedPendingAssistantWork(directory,conversationId);return {};},
    {catalog,selectedModel:"main",primaryConversationId:conversationId});
  let runtime: Awaited<ReturnType<typeof assistantEnvironment>>|undefined;
  try {
    await f.app.close();
    runtime = await assistantEnvironment({AGENT_SYSTEM_PROMPT:"valid base instructions",ASSISTANT_DATA_DIR:f.options.dataDir,
      ASSISTANT_WORK_DIR:f.directory,NAILONG_MAGPIE_CONFIG:f.magpieConfigPath,AGENT_TELEGRAM_USER_ID:"42",
      ASSISTANT_INTENT_MODEL:"not-a-valid-alias",MODEL_NAMES:"broken",MODEL_BROKEN_API:"invalid",MODEL_BROKEN_API_KEY:"old"});
    const panel = await runtime.app.controlSnapshot(conversationId);
    assert.equal(panel.selectedModel,"main");
    assert.equal(panel.routing.selectedModel,undefined);
    await runtime.app.receive({conversationId,inputId:"upgraded",text:"KEEP_UPGRADE_ORIGINAL"});
    await runtime.app.waitForRouting();await runtime.app.waitForIdle();
    assert.deepEqual(requests.map(request=>request.model),["main"]);
    assert.match(JSON.stringify(requests[0]!.messages),/KEEP_UPGRADE_ORIGINAL/);
    assert.match(JSON.stringify(requests[0]!.messages),/not_configured/);
    assert.equal((await runtime.app.controlSnapshot(conversationId)).works.find(work=>work.summary==="unfinished background report")?.status,"paused");
  } finally {await runtime?.close();await f.close();}
});

for (const failure of ["unselected","removed","budget","invalid","provider","timeout"] as const) {
  test(`Magpie routing ${failure} keeps the original input and attachment for the main assistant`, {timeout:15000}, async () => {
    const requests: Request[] = [];
    const models = failure==="budget" ? catalog.map(model=>model.id==="router/A" ? {...model,context_window:200,max_output_tokens:32} : model) : catalog;
    const f = await assistantFixture((raw,response)=>{
      const wire = raw as Request;requests.push(wire);
      if (wire.stream !== false) {sendChatCompletion(response,"original examined");return;}
      if (failure==="timeout") return;
      if (failure==="provider") {response.writeHead(503);response.end("unavailable");return;}
      reply(response,"rewritten text cannot authorize cancellation");
    },async directory=>{await seedPendingAssistantWork(directory,conversationId);return {intent:{timeoutMs:100}};},
      {catalog:models,selectedModel:"main",primaryConversationId:conversationId});
    try {
      if (failure!=="unselected") await f.app.control(conversationId,{type:"routing_model",model:"router/A"});
      if (failure==="removed") {f.setCatalog(catalog.filter(model=>model.id!=="router/A"));await f.app.controlSnapshot(conversationId,{refresh:true});}
      const original = "Do not cancel the report. KEEP_ORIGINAL";
      const image = {type:"image" as const,mimeType:"image/png",data:"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aPfoAAAAASUVORK5CYII="};
      await f.app.receive({conversationId,inputId:failure,source:"telegram",text:original,images:[image]});
      await f.app.waitForRouting();await f.app.waitForIdle();
      const reasons = {unselected:"not_configured",removed:"model_unavailable",budget:"model_budget",invalid:"invalid_result",provider:"classifier_error",timeout:"timeout"};
      const classification = requests.filter(wire=>wire.stream===false);
      assert.equal(classification.length,["invalid","provider","timeout"].includes(failure) ? 1 : 0,"failed classification never retries");
      const main = requests.filter(wire=>wire.stream!==false);
      assert.equal(main.length,1);
      assert.match(JSON.stringify(main[0]!.messages),new RegExp(reasons[failure]));
      assert.ok(JSON.stringify(main[0]!.messages).includes(original));
      assert.match(JSON.stringify(main[0]!.messages),/data:image\/png;base64/);
      const stored = f.app.routingStatus(conversationId).works.find(work=>work.inputId===failure)!.input;
      assert.equal(stored.inputId,failure);assert.equal(stored.source,"telegram");assert.equal(stored.text,original);assert.deepEqual(stored.images,[image]);
      assert.equal((await f.app.controlSnapshot(conversationId)).works.find(work=>work.summary==="unfinished background report")?.status,"paused");
    } finally {await f.close();}
  });
}

test("a disconnected Magpie preserves an ordinary fallback before reconnecting, then never reclassifies that saved input", async () => {
  const requests: Request[]=[];
  const f = await assistantFixture((wire,response)=>{requests.push(wire as Request);sendChatCompletion(response,"restored answer");},
    async directory=>{await seedPendingAssistantWork(directory,conversationId);return {};},
    {catalog,selectedModel:"main",primaryConversationId:conversationId});
  try {
    await f.app.control(conversationId,{type:"routing_model",model:"router/A"});
    await f.writeMagpie({apiKey:""});
    await f.app.receive({conversationId,inputId:"offline",source:"telegram",text:"KEEP_OFFLINE_INPUT"});
    await f.app.waitForRouting();
    const before = f.app.routingStatus(conversationId);
    assert.equal(before.pending.length,0,"routing failure is durably converted to a normal request even while the main model is unavailable");
    const input = before.works.find(work=>work.inputId==="offline")!.input;
    assert.equal(input.text,"KEEP_OFFLINE_INPUT");
    assert.match(input.runtimeMaterials!.join("\n"),/connection_error/);
    assert.equal(requests.length,0);
    await f.reopen();await f.writeMagpie({apiKey:"test"});
    await f.app.controlSnapshot(conversationId,{refresh:true});await f.app.waitForIdle();
    assert.deepEqual(requests.map(request=>request.model),["main"]);
    assert.match(JSON.stringify(requests[0]!.messages),/KEEP_OFFLINE_INPUT/);
    assert.match(JSON.stringify(requests[0]!.messages),/connection_error/);
  } finally {await f.close();}
});

test("Telegram updates reach the chosen router and preserve reply identity while native start remains model-free", {timeout:15000}, async () => {
  const { controlPanelFixture } = await import("./fixtures/control-panel.js");
  const entered = gate();let mainRequests=0;
  const routed: Array<{model:string;current:{text:string;replyToMessageId?:string}}> = [];
  const f = await controlPanelFixture({models:catalog,selected:"main",provider:(wire,response)=>{
    if ((wire as Request).stream===false) {
      const snapshot=JSON.parse(String(wire.messages.at(-1)!.content));routed.push({model:wire.model,current:snapshot.current});reply(response,snapshot.current.text);
    } else if (++mainRequests===1) entered.release();
    else sendChatCompletion(response,"Telegram original examined");
  }});
  const update = (id:number,text:string)=>({update_id:id,message:{message_id:id,date:0,chat:{id:42,type:"private" as const,first_name:"owner"},from:{id:42,is_bot:false,first_name:"owner"},text}});
  try {
    await f.bot.handleUpdate(update(1,"/start"));
    assert.equal(f.requests.length,0);
    await f.bot.handleUpdate(update(2,"original report"));await entered.promise;
    await f.bot.handleUpdate(update(3,"/stop"));await f.flush();
    await f.app.control(conversationId,{type:"routing_model",model:"router/A"});
    await f.bot.handleUpdate({...update(4,"change the report to CSV"),message:{...update(4,"change the report to CSV").message,
      reply_to_message:{...update(2,"original report").message,reply_to_message:undefined}}});
    await f.flush();
    assert.deepEqual(routed.map(item=>item.model),["router/A"]);
    assert.equal(routed[0]!.current.replyToMessageId,"2");
    assert.equal(routed[0]!.current.text,"change the report to CSV");
    assert.ok(f.sent.some(item=>String(item.body).includes("Telegram original examined")));
    assert.deepEqual(f.errors,[]);
    assert.equal((await f.app.controlSnapshot(conversationId)).works.find(work=>work.summary==="original report")?.status,"paused");
  } finally {await f.close();}
});
