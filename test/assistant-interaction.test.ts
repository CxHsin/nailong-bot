import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { assistantFixture } from "./fixtures/assistant.js";
import { sendChatCompletion } from "./fixtures/chat-completion.js";

function deferred(){let resolve!:()=>void;const promise=new Promise<void>((done)=>{resolve=done;});return {resolve,promise};}

test("natural-language supplement reaches a running tool boundary",{ timeout: 60_000 },async()=>{
  const ready=deferred();const release=deferred();const requests:string[]=[];
  const f=await assistantFixture(async(wire,response)=>{
    if ((wire as typeof wire & {model:string}).model === "router") {
      const context = JSON.parse(String(wire.messages.at(-1)!.content));
      const text = context.current.text;
      const target = context.works.find((work:{status:string}) => work.status === "running");
      const actions = text === "change to Thursday" && target ? [{kind:"supplement",text,target:target.id}] : [{kind:"request",text}];
      response.writeHead(200,{"content-type":"application/json"});
      response.end(JSON.stringify({choices:[{message:{role:"assistant",content:JSON.stringify({actions})},finish_reason:"stop"}]}));
      return;
    }
    requests.push(JSON.stringify(wire.messages));
    if(requests.length===1){ready.resolve();await release.promise;sendChatCompletion(response,"",[{index:0,id:"read",type:"function",function:{name:"read",arguments:'{"path":"note.txt"}'}}]);}
    else sendChatCompletion(response,"Thursday noted");
  },async()=>({intent:{model:"router"},modelConfiguration:{defaultModel:"local",models:[
    {alias:"local",model:"local",api:"openai-completions",apiKey:"test",baseUrl:""},
    {alias:"router",model:"router",api:"openai-completions",apiKey:"test",baseUrl:""},
  ]}}));
  try{
    await writeFile(join(f.directory,"note.txt"),"background");
    await f.app.receive({conversationId:"telegram:private:owner",inputId:"1",text:"read note"});await ready.promise;
    await f.app.receive({conversationId:"telegram:private:owner",inputId:"2",text:"change to Thursday"});
    await f.app.waitForRouting();
    release.resolve();await f.app.waitForIdle();
    assert.equal(requests.length,2);assert.match(requests[1]!,/change to Thursday/);assert.doesNotMatch(requests[1]!,/\/steer change/);
    assert.deepEqual(f.outputs.filter((out)=>out.type==="text").map((out)=>out.text),["Thursday noted"]);
  }finally{release.resolve();await f.close();}
});

test("reset is an ordered command barrier that preserves queued work and starts a blank main context",{ timeout: 60_000 },async()=>{
  const ready=deferred();const release=deferred();const requests:string[]=[];
  const f=await assistantFixture(async(wire,response)=>{
    requests.push(JSON.stringify(wire.messages));if(requests.length===1){ready.resolve();await release.promise;}
    sendChatCompletion(response,requests.length===1?"old reply":"new reply");
  });
  try{
    await f.app.receive({conversationId:"one",inputId:"1",text:"OLD_ONLY"});await ready.promise;
    await f.app.receive({conversationId:"one",inputId:"2",text:"/reset"});
    await f.app.receive({conversationId:"one",inputId:"3",text:"NEW_ONLY"});
    release.resolve();await f.app.waitForIdle();
    assert.equal(requests.length,2);assert.doesNotMatch(requests[1]!,/OLD_ONLY/);assert.match(requests[1]!,/NEW_ONLY/);
    assert.ok(f.outputs.some((out)=>out.type==="text"&&out.text==="new reply"));
  }finally{release.resolve();await f.close();}
});

test("reset survives restart and file delivery uses the actual artifact",{ timeout: 60_000 },async()=>{
  let phase=0;const requests:string[]=[];
  const f=await assistantFixture((wire,response)=>{
    requests.push(JSON.stringify(wire.messages));
    if(phase++===0)sendChatCompletion(response,"remembered");
    else if(wire.messages.at(-1)!.role!=="tool")sendChatCompletion(response,"",[{index:0,id:"file",type:"function",function:{name:"send_file",arguments:'{"path":"artifact.txt"}'}}]);
    else sendChatCompletion(response,"file sent");
  });
  try{
    await writeFile(join(f.directory,"artifact.txt"),"actual content");
    await f.app.receive({conversationId:"one",inputId:"1",text:"OLD_ONLY"});await f.app.waitForIdle();
    await f.app.receive({conversationId:"one",inputId:"2",text:"/reset"});await f.app.waitForIdle();await f.reopen();
    await f.app.receive({conversationId:"one",inputId:"3",text:"send artifact"});await f.app.waitForIdle();
    assert.doesNotMatch(requests[1]!,/OLD_ONLY/);const output=f.outputs.find((out)=>out.type==="file");
    assert.ok(output?.type==="file");assert.equal(await readFile(output.path,"utf8"),"actual content");
  }finally{await f.close();}
});

test("new durable execution ignores old history and memory databases without deleting them",async()=>{
  const seen:string[]=[];
  const f=await assistantFixture((wire,response)=>{seen.push(JSON.stringify(wire.messages));sendChatCompletion(response,"fresh reply");},async(directory)=>{
    await mkdir(join(directory,"legacy"),{recursive:true});await writeFile(join(directory,"legacy","personal.sqlite"),"LEGACY_SECRET");
    await writeFile(join(directory,"legacy","personal-memory.sqlite"),"LEGACY_SECRET");return {};
  });
  try{
    await f.app.receive({conversationId:"one",inputId:"1",text:"new input"});await f.app.waitForIdle();
    assert.doesNotMatch(seen[0]!,/LEGACY_SECRET/);
    assert.equal(await readFile(join(f.directory,"legacy","personal.sqlite"),"utf8"),"LEGACY_SECRET");
  }finally{await f.close();}
});
