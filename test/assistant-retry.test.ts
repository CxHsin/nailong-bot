import { test } from "node:test";
import assert from "node:assert/strict";
import { assistantFixture } from "./fixtures/assistant.js";
import { sendChatCompletion } from "./fixtures/chat-completion.js";

function fail(response: Parameters<typeof sendChatCompletion>[0],status=429){response.writeHead(status,{"content-type":"application/json"});response.end(JSON.stringify({error:{message:status===401?"invalid api key":"rate limit"}}));}

test("temporary model failure retries only the request and then allows the next input",{timeout:15000},async()=>{
  let requests=0;const f=await assistantFixture((_wire,response)=>{requests++;if(requests===1)fail(response);else sendChatCompletion(response,"任务完成");});
  try{
    await f.app.receive({conversationId:"retry",inputId:"1",text:"执行任务"});await f.app.waitForIdle();
    assert.equal(requests,2);assert.equal(f.outputs.filter((out)=>out.type==="text"&&out.text==="任务完成").length,1);
    await f.app.receive({conversationId:"retry",inputId:"2",text:"下一个任务"});await f.app.waitForIdle();
    assert.equal(requests,3);assert.equal(f.outputs.filter((out)=>out.type==="text"&&out.text==="任务完成").length,2);
  }finally{await f.close();}
});

test("four failed requests pause once, survive restart, allow other input and require explicit resume",{timeout:30000},async()=>{
  let requests=0;let failing=true;const f=await assistantFixture((_wire,response)=>{requests++;if(failing)fail(response);else sendChatCompletion(response,"continued");});
  try{
    await f.app.receive({conversationId:"retry",inputId:"1",text:"执行任务"});await f.app.waitForIdle();
    assert.equal(requests,4);
    const pauses=f.outputs.filter((out)=>out.type==="text"&&/暂停/.test(out.text));assert.equal(pauses.length,1);
    await f.reopen();await f.app.waitForIdle();assert.equal(requests,4);
    assert.equal(f.outputs.filter((out)=>out.type==="text"&&/暂停/.test(out.text)).length,1);
    failing=false;await f.app.receive({conversationId:"retry",inputId:"2",text:"other request"});await f.app.waitForIdle();assert.equal(requests,5);
    await f.app.resume("retry");await f.app.waitForIdle();assert.equal(requests,6);
    assert.equal(f.outputs.filter((out)=>out.type==="text"&&out.text==="continued").length,2);
  }finally{await f.close();}
});

test("authentication errors pause without provider or executor retries",{timeout:10000},async()=>{
  let requests=0;const f=await assistantFixture((_wire,response)=>{requests++;fail(response,401);});
  try{
    await f.app.receive({conversationId:"retry",inputId:"1",text:"执行任务"});await f.app.waitForIdle();
    assert.equal(requests,1);assert.equal(f.outputs.filter((out)=>out.type==="text"&&/暂停/.test(out.text)).length,1);
  }finally{await f.close();}
});
