import {test} from "node:test";
import assert from "node:assert/strict";
import {setTimeout as delay} from "node:timers/promises";
import {assistantFixture,type Wire} from "./fixtures/assistant.js";
import {embeddingFixture} from "./fixtures/embedding.js";
import {sendChatCompletion} from "./fixtures/chat-completion.js";

test("forgetting wins over a held historical vector commit and old-space restoration",{timeout:15000},async()=>{
  let held=false;let release!:()=>void;const hold=new Promise<void>(resolve=>{release=resolve;});
  let entered!:()=>void;const ready=new Promise<void>(resolve=>{entered=resolve;});
  const first=await embeddingFixture(()=>[1,0,0]);
  const second=await embeddingFixture(()=>[],async(wire,response)=>{
    if(wire.input.includes("我偏爱白茶")&&!held){held=true;entered();await hold;}
    response.writeHead(200,{"content-type":"application/json"});response.end(JSON.stringify({data:wire.input.map((_,index)=>({index,embedding:[1,0,0]}))}));
  });
  const wires:Wire[]=[];let original="";
  const f=await assistantFixture((wire,response)=>{
    wires.push(wire);const last=wire.messages.at(-1);
    if(last?.role==="user"&&JSON.stringify(last.content).includes("我偏爱白茶")){
      original=JSON.stringify(last.content).match(/sourceId=(source:[a-f0-9]{64})/)![1]!;sendChatCompletion(response,"白茶是你的选择");
    }else if(last?.role==="user"&&JSON.stringify(last.content).includes("执行遗忘"))sendChatCompletion(response,"",[{index:0,id:"forget-race",type:"function",function:{name:"memory_forget",arguments:JSON.stringify({id:original,expectedVersion:0})}}]);
    else sendChatCompletion(response,"已处理");
  },async()=>({embedding:{env:{KEY:"fixture"},configs:[{id:"a",displayName:"A",baseUrl:first.baseUrl,model:"a",apiKeyEnv:"KEY"},{id:"b",displayName:"B",baseUrl:second.baseUrl,model:"b",apiKeyEnv:"KEY"}]}}));
  const wait=async()=>{const end=Date.now()+4000;while(Date.now()<end){const p=(await f.app.controlSnapshot("one")).embedding.progress;if(p.status==="ready")return p;await delay(15);}assert.fail("preparation did not settle");};
  try{
    await f.app.receive({conversationId:"one",inputId:"source",text:"我偏爱白茶"});await f.app.waitForIdle();await wait();assert.ok(original);
    await f.app.control("one",{type:"embedding_model",id:"b",operationId:"hold-new-space"});await ready;
    await f.app.control("one",{type:"reset",operationId:"clear-before-forget"});await f.app.waitForIdle();
    await f.app.receive({conversationId:"one",inputId:"forget",text:"执行遗忘"});await f.app.waitForIdle();
    release();const remaining=await wait();assert.ok(remaining.total<4,"forgotten originals and their derivatives are excluded from preparation");
    await f.app.control("one",{type:"embedding_model",id:"a",operationId:"old-space"});await wait();
    await f.reopen();await f.app.control("one",{type:"reset",operationId:"clear-after-forget"});await f.app.waitForIdle();
    await f.app.receive({conversationId:"one",inputId:"query",text:"以前的饮品口味"});await f.app.waitForIdle();
    const final=JSON.stringify(wires.at(-1)?.messages);
    assert.doesNotMatch(final,/原文：我偏爱白茶|原文：白茶是你的选择/);
    assert.equal((await f.app.controlSnapshot("one")).embedding.selectedId,"a");
  }finally{release();await f.close();await first.close();await second.close();}
});
