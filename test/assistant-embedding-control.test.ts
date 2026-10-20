import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type ServerResponse } from "node:http";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { assistantEnvironment } from "../src/assistant/environment.js";
import { assistantFixture } from "./fixtures/assistant.js";
import { sendChatCompletion } from "./fixtures/chat-completion.js";

type EmbeddingWire = { model: string; input: string[] };
async function embeddingServer(handle?: (wire: EmbeddingWire, response: ServerResponse) => void | Promise<void>) {
  const requests: EmbeddingWire[] = [];
  const server = createServer(async (request, response) => {
    let body = ""; for await (const part of request) body += part;
    const wire = JSON.parse(body) as EmbeddingWire; requests.push(wire);
    if (handle) await handle(wire, response);
    else { response.writeHead(200, { "content-type": "application/json" }); response.end(JSON.stringify({data:wire.input.map((_,index)=>({index,embedding:[1,2,3]}))})); }
  });
  await new Promise<void>(resolve => server.listen(0,"127.0.0.1",resolve));
  const address = server.address(); if (!address || typeof address === "string") throw new Error("Missing embedding address");
  return {requests,baseUrl:`http://127.0.0.1:${address.port}/v1`,async close() {server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}};
}

test("service-wide Embedding choices and synthetic connection receipts survive reset and reopen without generation", async () => {
  const remote = await embeddingServer();
  let generations = 0;
  const f = await assistantFixture((_wire,response)=>{generations++;sendChatCompletion(response,"ok");},async()=>({embedding:{env:{EMBED_SECRET:"sensitive-fixture-key"},configs:[
    {id:"one",displayName:"First",baseUrl:remote.baseUrl,model:"semantic-one",apiKeyEnv:"EMBED_SECRET"},
    {id:"two",displayName:"Second",baseUrl:remote.baseUrl,model:"semantic-two",apiKeyEnv:"EMBED_SECRET"},
  ]}}));
  try {
    const first = await f.app.controlSnapshot("first");
    assert.equal(first.embedding.selectedId,"one");
    assert.equal(first.embedding.connectionStatus,"untested");
    assert.equal(first.embedding.progress.completed,0);
    assert.equal(remote.requests.length,0,"viewing does not test the connection");
    const selection = await f.app.control("first",{type:"embedding_model",id:"two",operationId:"select-two"});
    assert.equal(selection.snapshot.embedding.connectionStatus,"untested");
    const tested = await f.app.control("second",{type:"embedding_test",operationId:"synthetic-test"});
    assert.equal(tested.snapshot.embedding.test?.status,"success");
    assert.equal(tested.snapshot.embedding.test?.dimensions,3);
    assert.equal(remote.requests.length,1);
    assert.equal(remote.requests[0]!.model,"semantic-two");
    assert.deepEqual(remote.requests[0]!.input,["Nailong Embedding connection test. 奶龙连接测试。"]);
    await f.app.control("second",{type:"embedding_test",operationId:"synthetic-test"});
    assert.equal(remote.requests.length,1,"duplicate controls do not spend again");
    await f.app.control("first",{type:"reset",operationId:"reset"}); await f.app.waitForIdle();
    await f.reopen();
    const restored = await f.app.controlSnapshot("third");
    assert.equal(restored.embedding.selectedId,"two");
    assert.equal(restored.embedding.test?.status,"success");
    assert.equal(restored.waiting,0);
    assert.equal(restored.works.length,0);
    assert.equal(generations,0);
    assert.doesNotMatch(JSON.stringify(restored),/sensitive-fixture-key/);
  } finally {await f.close();await remote.close();}
});

test("formal environment loads legacy Embedding variables and bounds contiguous Unicode slices", async () => {
  const remote = await embeddingServer((wire,response)=>{
    response.writeHead(wire.input.length>10 ? 400 : 200,{"content-type":"application/json"});
    response.end(JSON.stringify({data:wire.input.map((_,index)=>({index,embedding:[1,2,3]}))}));
  });
  const f = await assistantFixture((_wire,response)=>sendChatCompletion(response,"ok"));
  const environment = await assistantEnvironment({AGENT_SYSTEM_PROMPT:"fixture assistant",ASSISTANT_DATA_DIR:join(f.directory,"formal"),
    ASSISTANT_WORK_DIR:f.directory,NAILONG_MAGPIE_CONFIG:f.magpieConfigPath,EMBEDDING_BASE_URL:remote.baseUrl,EMBEDDING_MODEL:"legacy-semantic",
    EMBEDDING_API_KEY:"private-legacy-secret",EMBEDDING_MAX_INPUT_CHARS:"4",EMBEDDING_TIMEOUT_MS:"500"});
  try {
    const initial = await environment.app.controlSnapshot("formal");
    assert.equal(initial.embedding.selectedId,"environment");
    assert.equal(initial.embedding.catalog[0]!.model,"legacy-semantic");
    const tested = await environment.app.control("formal",{type:"embedding_test",operationId:"legacy-test"});
    assert.equal(tested.snapshot.embedding.test?.status,"success");
    assert.equal(remote.requests.length,2,"long input fits the supported provider's ten-input limit");
    assert.ok(remote.requests.every(request=>request.input.length<=10));
    const slices=remote.requests.flatMap(request=>request.input);
    assert.ok(slices.every(input=>Array.from(input).length<=4));
    assert.equal(slices.join(""),"Nailong Embedding connection test. 奶龙连接测试。");
    assert.doesNotMatch(JSON.stringify(tested),/private-legacy-secret|127\.0\.0\.1/);
  } finally {await environment.close();await f.close();await remote.close();}
});

test("explicit local Embedding list overrides legacy variables, removed selections remain unavailable across reopen", async () => {
  const remote = await embeddingServer();
  let file = "";
  const f = await assistantFixture((_wire,response)=>sendChatCompletion(response,"ok"),async(directory)=>{
    file=join(directory,"embeddings.json");
    await writeFile(file,JSON.stringify({models:[{id:"explicit",displayName:"Explicit model",baseUrl:remote.baseUrl,model:"explicit-model",apiKeyEnv:"LOCAL_SECRET"}]}));
    return {embedding:{configPath:file,env:{LOCAL_SECRET:"local-secret",EMBEDDING_BASE_URL:remote.baseUrl,EMBEDDING_MODEL:"must-not-use",EMBEDDING_API_KEY:"legacy-secret"}}};
  });
  try {
    assert.equal((await f.app.controlSnapshot("one")).embedding.selectedId,"explicit");
    await writeFile(file,JSON.stringify({models:[]}));
    const removed=await f.app.controlSnapshot("two");
    assert.equal(removed.embedding.selectedId,"explicit");
    assert.equal(removed.embedding.selectedAvailable,false);
    assert.equal(removed.embedding.connectionStatus,"invalid_config");
    await f.reopen();
    assert.equal((await f.app.controlSnapshot("three")).embedding.selectedId,"explicit");
    const test=await f.app.control("three",{type:"embedding_test",operationId:"removed"});
    assert.equal(test.snapshot.embedding.test?.status,"failed");
    assert.equal(remote.requests.length,0);
    await writeFile(file,"broken JSON including local-secret");
    const broken=await f.app.controlSnapshot("three");
    assert.equal(broken.embedding.connectionStatus,"invalid_config");
    assert.doesNotMatch(JSON.stringify(broken),/local-secret|legacy-secret/);
  } finally {await f.close();await remote.close();}
});

test("authentication, malformed vectors, timeout and network failures stay distinct and do not prevent chatting", async () => {
  let mode="authentication"; let generations=0;
  const remote = await embeddingServer((wire,response)=>{
    if(mode==="timeout") return;
    if(mode==="network") {response.destroy();return;}
    if(mode==="json") {response.writeHead(200);response.end("not JSON sensitive-fixture-key");return;}
    response.writeHead(mode==="authentication" ? 401 : 200,{"content-type":"application/json"});
    const rows=wire.input.map((_,index)=>({index,embedding:[1,2,3]}));
    if(mode==="zero") rows[0]!.embedding=[0,0,0];
    if(mode==="empty") rows[0]!.embedding=[];
    if(mode==="nonfinite") rows[0]!.embedding=[Number.NaN,2,3];
    if(mode==="order") rows[0]!.index=99;
    if(mode==="dimensions") rows[1]!.embedding=[1,2];
    response.end(JSON.stringify(mode==="authentication" ? {error:{message:"sensitive-fixture-key"}} : {data:mode==="count" ? [] : rows}));
  });
  const f=await assistantFixture((_wire,response)=>{generations++;sendChatCompletion(response,"ordinary chat continues");},async()=>({embedding:{env:{SECRET:"sensitive-fixture-key"},configs:[
    {id:"remote",displayName:"Remote",baseUrl:remote.baseUrl,model:"semantic",apiKeyEnv:"SECRET",timeoutMs:1000,maxInputChars:12},
  ]}}));
  try {
    for (const [failure,reason] of [["authentication",/认证失败/],["zero",/向量或顺序无效/],["empty",/向量或顺序无效/],["nonfinite",/向量或顺序无效/],["order",/向量或顺序无效/],["count",/条数无效/],["dimensions",/维度不一致/],["json",/不是有效 JSON/],["timeout",/请求超时/],["network",/网络连接失败/]] as const) {
      mode=failure;
      const tested=await f.app.control("one",{type:"embedding_test",operationId:`failure-${failure}`});
      assert.equal(tested.snapshot.embedding.test?.status,"failed",failure);
      assert.equal(tested.snapshot.embedding.connectionStatus,"unavailable",failure);
      assert.match(tested.snapshot.embedding.test?.reason ?? "",reason,failure);
      assert.doesNotMatch(JSON.stringify(tested),/sensitive-fixture-key/);
    }
    await f.app.receive({conversationId:"one",inputId:"chat",text:"keep chatting"});await f.app.waitForIdle();
    assert.equal(generations,1);
    mode="success";
    const restored=await f.app.control("one",{type:"embedding_test",operationId:"repaired"});
    assert.equal(restored.snapshot.embedding.connectionStatus,"ready");
  } finally {await f.close();await remote.close();}
});

test("unconfigured Embedding never sends a request and reports failure rather than an empty successful search", async () => {
  const f=await assistantFixture((_wire,response)=>sendChatCompletion(response,"ok"),async()=>({embedding:{env:{}}}));
  try {
    assert.equal((await f.app.controlSnapshot("one")).embedding.connectionStatus,"not_configured");
    const tested=await f.app.control("one",{type:"embedding_test",operationId:"not-configured"});
    assert.equal(tested.snapshot.embedding.test?.status,"failed");
    assert.equal(tested.snapshot.embedding.connectionStatus,"not_configured");
    assert.equal(tested.snapshot.embedding.progress.completed,0);
  } finally {await f.close();}
});

test("an in-flight connection test freezes its model and cannot mark a newly selected service ready", async () => {
  let release!:()=>void;let entered!:()=>void;
  const held=new Promise<void>(resolve=>{release=resolve;});const started=new Promise<void>(resolve=>{entered=resolve;});
  const remote=await embeddingServer(async(wire,response)=>{
    if(wire.model==="old-model") {entered();await held;}
    response.writeHead(200,{"content-type":"application/json"});response.end(JSON.stringify({data:wire.input.map((_,index)=>({index,embedding:[1,2,3]}))}));
  });
  const f=await assistantFixture((_wire,response)=>sendChatCompletion(response,"ok"),async()=>({embedding:{env:{SECRET:"private-key"},configs:[
    {id:"old",displayName:"Old",baseUrl:remote.baseUrl,model:"old-model",apiKeyEnv:"SECRET"},
    {id:"new",displayName:"New",baseUrl:remote.baseUrl,model:"new-model",apiKeyEnv:"SECRET"},
  ]}}));
  try {
    const pending=f.app.control("one",{type:"embedding_test",operationId:"held-test"});await started;
    const duplicate=await f.app.control("one",{type:"embedding_test",operationId:"held-test"});
    assert.equal(duplicate.accepted,false);assert.equal(remote.requests.length,1);
    await f.app.control("two",{type:"embedding_model",id:"new",operationId:"switch"});release();
    const completed=await pending;
    assert.equal(completed.snapshot.embedding.selectedId,"new");
    assert.equal(completed.snapshot.embedding.connectionStatus,"untested");
    assert.equal(completed.snapshot.embedding.test,undefined);
    await f.app.control("two",{type:"embedding_test",operationId:"new-test"});
    assert.deepEqual(remote.requests.map(request=>request.model),["old-model","new-model"]);
  } finally {release();await f.close();await remote.close();}
});
