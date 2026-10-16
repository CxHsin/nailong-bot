import { test } from "node:test";
import assert from "node:assert/strict";
import { fork, type ChildProcess } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { ProcessingBatch } from "../src/assistant/queue.js";
import { sendChatCompletion } from "./fixtures/chat-completion.js";

function deferred() {let resolve!:()=>void;const promise=new Promise<void>((done)=>{resolve=done;});return {promise,resolve};}
test("SIGKILL after cancelling a running target but before preemption never reconnects its original Durable submission",{timeout:25_000},async()=>{
  const directory=await mkdtemp(join(tmpdir(),"assistant-cancel-window-"));
  const confirmed=deferred();
  let recovering=false;
  let originalEffectRequested=false;
  const recoveredScopes:string[][]=[];
  const server=createServer(async(request,response)=>{
    try {
      let raw="";for await(const part of request)raw+=part;
      const wire=JSON.parse(raw);
      const last=wire.messages.at(-1);
      const user=wire.messages.filter((message:{role:string})=>message.role==="user").at(-1);
      const text=typeof user.content==="string"?user.content:user.content.map((part:{text?:string})=>part.text??"").join("\n");
      const files=[...text.matchAll(/本轮仅处理此原输入中的要求：write ([a-z]+\.txt)/g)].map((match)=>match[1]!);
      if(!recovering) {
        if(!originalEffectRequested) {
          originalEffectRequested=true;
          sendChatCompletion(response,"",[{index:0,id:"report-confirmed",type:"function",function:{name:"append_result",arguments:JSON.stringify({file:"report.txt"})}}]);
        } else {
          assert.equal(last.role,"tool");
          assert.match(JSON.stringify(last),/confirmed result report.txt/);
          confirmed.resolve();
        }
        return;
      }
      if(last.role==="tool" && last.tool_call_id==="survivor-effect") {sendChatCompletion(response,"survivor complete");return;}
      recoveredScopes.push(files);
      // A real provider follows the currently submitted scope. Reconnecting the old
      // submission therefore makes the cancelled report effect observable again.
      sendChatCompletion(response,"",files.map((file,index)=>({index,id:file==="chart.txt"?"survivor-effect":"cancelled-effect",type:"function",function:{name:"append_result",arguments:JSON.stringify({file})}})));
    } catch(error) {response.writeHead(500);response.end(String(error));}
  });
  await new Promise<void>((done)=>{server.listen(0,"127.0.0.1",done);});
  const address=server.address();assert.ok(address&&typeof address!=="string");
  await writeFile(join(directory,"options.json"),JSON.stringify({cwd:directory,dataDir:join(directory,"fresh"),modelConfiguration:{defaultModel:"local",models:[{alias:"local",model:"local",api:"openai-completions",apiKey:"test",baseUrl:`http://127.0.0.1:${address.port}`} ]}}));
  function child(mode:string) {
    const process=fork(resolve("test/fixtures/assistant-cancel-window-child.ts"),[directory,mode],{execArgv:["--import","tsx"],windowsHide:true,silent:true});
    let logs="";
    const cancelled=deferred();
    const batches:ProcessingBatch[]=[];
    process.stdout?.on("data",(part)=>{logs+=part;});process.stderr?.on("data",(part)=>{logs+=part;});
    process.on("message",(message)=>{const value=message as {type:string;batch:ProcessingBatch};if(value.type==="cancelled")cancelled.resolve();if(value.type==="batch")batches.push(value.batch);});
    const exited=new Promise<number|null>((done)=>{process.once("exit",done);});
    return {process,exited,cancelled:cancelled.promise,batches,logs:()=>logs};
  }
  async function kill(process:ChildProcess,exited:Promise<number|null>) {if(process.exitCode===null&&process.signalCode===null)process.kill("SIGKILL");await exited;}
  const first=child("initial");let second:ReturnType<typeof child>|undefined;
  try {
    await Promise.race([confirmed.promise,first.exited.then(()=>{throw new Error(first.logs()||"child exited before confirmed tool result");})]);
    assert.equal(await readFile(join(directory,"report.txt"),"utf8"),"saved\n");
    first.process.send({type:"cancel"});await first.cancelled;
    await kill(first.process,first.exited);
    recovering=true;server.closeAllConnections();
    second=child("recover");assert.equal(await second.exited,0,second.logs());
    assert.deepEqual(recoveredScopes,[["chart.txt"]]);
    assert.equal(second.batches[0]!.submissionId,undefined);
    assert.ok(second.batches[0]!.previousSubmissionId);
    assert.deepEqual(second.batches[0]!.events.map((event)=>event.inputId),["chart"]);
    assert.equal(await readFile(join(directory,"report.txt"),"utf8"),"saved\n");
    assert.equal(await readFile(join(directory,"chart.txt"),"utf8"),"saved\n");
  } finally {
    await kill(first.process,first.exited);if(second)await kill(second.process,second.exited);
    server.closeAllConnections();await new Promise<void>((done)=>{server.close(()=>done());});
    await rm(directory,{recursive:true,force:true});
  }
});
