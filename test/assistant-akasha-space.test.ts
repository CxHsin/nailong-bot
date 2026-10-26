import {test} from "node:test";
import assert from "node:assert/strict";
import {setTimeout as delay} from "node:timers/promises";
import {assistantFixture,type Wire} from "./fixtures/assistant.js";
import {embeddingFixture} from "./fixtures/embedding.js";
import {sendChatCompletion} from "./fixtures/chat-completion.js";

async function prepared(f:Awaited<ReturnType<typeof assistantFixture>>,minimum:number){
  const end=Date.now()+5000;
  while(Date.now()<end){const progress=(await f.app.controlSnapshot("one")).embedding.progress;if(progress.completed>=minimum&&progress.status==="ready")return progress;await delay(15);}
  assert.fail("background preparation did not finish");
}

test("same-dimensional services rebuild independently and retain original evidence across reset and reopen",{ timeout: 60_000 },async()=>{
  const first=await embeddingFixture(text=>/白茶|口味/.test(text)?[1,0,0]:[0,0,1]);
  const second=await embeddingFixture(text=>text.includes("白茶")?[0,1,0]:text.includes("口味")?[1,0,0]:[0,0,1]);
  const wires:Wire[]=[];
  const f=await assistantFixture((wire,response)=>{wires.push(wire);sendChatCompletion(response,"已记录");},async()=>({embedding:{env:{KEY:"fixture"},configs:[
    {id:"first",displayName:"First",baseUrl:first.baseUrl,model:"one",apiKeyEnv:"KEY"},
    {id:"second",displayName:"Second",baseUrl:second.baseUrl,model:"two",apiKeyEnv:"KEY"},
  ]}}));
  try{
    await f.app.receive({conversationId:"one",inputId:"original",text:"我偏爱白茶"});await f.app.waitForIdle();await prepared(f,2);
    const previous=first.requests.length;
    await f.app.control("another",{type:"embedding_model",id:"second",operationId:"switch"});await prepared(f,2);
    assert.ok(second.requests.some(wire=>wire.input.includes("我偏爱白茶")),"new service re-embeds retained original history");
    assert.equal((await f.app.controlSnapshot("one")).embedding.selectedId,"second");
    await f.app.control("one",{type:"reset",operationId:"clear"});await f.app.waitForIdle();
    await f.app.receive({conversationId:"one",inputId:"query-second",text:"以前的口味"});await f.app.waitForIdle();
    assert.doesNotMatch(JSON.stringify(wires.at(-1)?.messages),/原文：我偏爱白茶/,"same dimensions do not reuse the first service coordinates");
    assert.equal(first.requests.length,previous,"new work after switch does not schedule the former service");
    await f.reopen();await prepared(f,4);
    const committed=second.requests.length;
    await delay(80);assert.equal(second.requests.length,committed,"reopen reuses committed vectors");
    await f.app.control("one",{type:"embedding_model",id:"first",operationId:"switch-back"});await prepared(f,4);
    await f.app.control("one",{type:"reset",operationId:"clear-again"});await f.app.waitForIdle();
    await f.app.receive({conversationId:"one",inputId:"query-first",text:"以前的口味"});await f.app.waitForIdle();
    assert.match(JSON.stringify(wires.at(-1)?.messages),/原文：我偏爱白茶/);
  }finally{await f.close();await first.close();await second.close();}
});

test("late vectors cannot roll a changed dimension back and reopening reuses the rebuilt space",{ timeout: 60_000 },async()=>{
  let dimensions=3;let release!:()=>void;const hold=new Promise<void>(resolve=>{release=resolve;});
  let entered!:()=>void;const ready=new Promise<void>(resolve=>{entered=resolve;});
  let held=false;
  let holdRebuild=false;let releaseRebuild!:()=>void;const rebuildHold=new Promise<void>(resolve=>{releaseRebuild=resolve;});
  let rebuilding!:()=>void;const rebuildReady=new Promise<void>(resolve=>{rebuilding=resolve;});
  const remote=await embeddingFixture(()=>[],async(wire,response)=>{
    const size=dimensions;
    if(wire.input.includes("旧在途")&&!held){held=true;entered();await hold;}
    if(size===4&&holdRebuild){rebuilding();await rebuildHold;}
    response.writeHead(200,{"content-type":"application/json"});response.end(JSON.stringify({data:wire.input.map((_,index)=>({index,embedding:[1,...new Array(size-1).fill(0)]}))}));
  });
  const f=await assistantFixture((_wire,response)=>sendChatCompletion(response,"记录完成"),async()=>({embedding:{env:{KEY:"fixture"},configs:[{id:"same",displayName:"Same",baseUrl:remote.baseUrl,model:"variable-dimension",apiKeyEnv:"KEY"}]}}));
  try{
    await f.app.receive({conversationId:"one",inputId:"source",text:"初始记录"});await f.app.waitForIdle();await prepared(f,2);
    await f.app.receive({conversationId:"one",inputId:"old",text:"旧在途"});await ready;
    dimensions=4;
    await f.app.receive({conversationId:"two",inputId:"new",text:"触发新空间"});
    const end=Date.now()+4000;while(!remote.requests.some(wire=>wire.input.includes("触发新空间"))&&Date.now()<end)await delay(10);
    assert.ok(remote.requests.some(wire=>wire.input.includes("触发新空间")));
    await delay(20);holdRebuild=true;release();await rebuildReady;
    assert.equal(remote.requests.flatMap(wire=>wire.input).filter(text=>text==="初始记录").length,2,"the first background batch after the late response must still rebuild the active four-dimensional space");
    holdRebuild=false;releaseRebuild();await f.app.waitForIdle();await prepared(f,6);
    assert.equal(remote.requests.flatMap(wire=>wire.input).filter(text=>text==="初始记录").length,2,"one committed vector in each dimension, no rollback to a late old head");
    const count=remote.requests.length;
    await f.reopen();await prepared(f,6);assert.equal(remote.requests.length,count,"all rebuilt vectors remain committed");
    const tested=await f.app.control("one",{type:"embedding_test",operationId:"new-dimension"});
    assert.equal(tested.snapshot.embedding.test?.dimensions,4);
  }finally{release();releaseRebuild();await f.close();await remote.close();}
});

test("failed historical preparation recovers without a new query and closing cancels a held background request",{ timeout: 60_000 },async()=>{
  let offline=true;let holdBackground=false;
  let entered!:()=>void;const ready=new Promise<void>(resolve=>{entered=resolve;});
  const remote=await embeddingFixture(()=>[],(wire,response)=>{
    if(offline){response.writeHead(401);response.end("private-fixture");return;}
    if(holdBackground&&wire.input.includes("后台取消")){entered();return;}
    response.writeHead(200,{"content-type":"application/json"});response.end(JSON.stringify({data:wire.input.map((_,index)=>({index,embedding:[1,0,0]}))}));
  });
  const f=await assistantFixture((_wire,response)=>sendChatCompletion(response,"已接收"),async()=>({embedding:{env:{KEY:"fixture"},configs:[{id:"retry",displayName:"Retry",baseUrl:remote.baseUrl,model:"retry",apiKeyEnv:"KEY",timeoutMs:200}]}}));
  try{
    await f.app.receive({conversationId:"one",inputId:"first",text:"现役历史"});await f.app.waitForIdle();
    assert.equal((await f.app.controlSnapshot("one")).embedding.progress.status,"degraded");
    offline=false;
    // Polling the remote HTTP observation does not refresh/wake the service.
    const end=Date.now()+4000;while(!remote.requests.some(wire=>wire.input.includes("现役历史")&&wire.input.length>1)&&Date.now()<end)await delay(25);
    assert.ok(remote.requests.some(wire=>wire.input.includes("现役历史")&&wire.input.length>1),"background retry starts without a status refresh or new query");
    const progress=await prepared(f,2);
    assert.equal(progress.completed,2);assert.equal(progress.learned,1);assert.equal(progress.status,"ready");
    holdBackground=true;
    await f.app.receive({conversationId:"one",inputId:"cancel",text:"后台取消"});await ready;
    const closing=Date.now();await f.app.close();assert.ok(Date.now()-closing<1000,"shutdown cancels remote preparation");
    const calls=remote.requests.length;await delay(300);assert.equal(remote.requests.length,calls,"closed worker never schedules another request");
  }finally{await f.close();await remote.close();}
});
