import { test } from "node:test";
import assert from "node:assert/strict";
import { fork, type ChildProcess } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { ProcessingBatch } from "../src/assistant/queue.js";
import { sendChatCompletion } from "./fixtures/chat-completion.js";
import { createAssistant } from "../src/assistant/runtime.js";
import { once } from "node:events";

function deferred() {let resolve!:()=>void;const promise=new Promise<void>((done)=>{resolve=done;});return {promise,resolve};}

for (const withHistory of [false,true]) test(`SIGKILL between persisted stop and native abort leaves the request paused until explicit resume${withHistory?" with a completed historical turn":""}`, {timeout:25000}, async () => {
  const directory = await mkdtemp(join(tmpdir(),"assistant-stop-window-"));
  const entered = deferred(); let recovering = false; let requests = 0;
  const server = createServer(async (request,response) => {
    let body="";for await (const part of request) body+=part;
    requests++;
    if(body.includes("HISTORICAL_COMPLETED_GOAL")&&!body.includes("PERSISTED_STOP_GOAL")){sendChatCompletion(response,"HISTORY_COMPLETED");return;}
    if (!recovering) entered.resolve(); else sendChatCompletion(response,"RESUMED");
  });
  await new Promise<void>(done => server.listen(0,"127.0.0.1",done));
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const options = {cwd:directory,dataDir:join(directory,"fresh"),modelConfiguration:{defaultModel:"local",models:[{
    alias:"local",model:"local",api:"openai-completions" as const,apiKey:"test",baseUrl:`http://127.0.0.1:${address.port}`}]}};
  await writeFile(join(directory,"options.json"),JSON.stringify(options));
  const child = fork(resolve("test/fixtures/assistant-stop-window-child.ts"),[directory,...(withHistory?["history"]:[])],{execArgv:["--import","tsx"],windowsHide:true,silent:true});
  let app: Awaited<ReturnType<typeof createAssistant>> | undefined;
  const exited = once(child,"exit");
  try {
    await Promise.race([entered.promise,exited.then(() => {throw new Error("child exited before model request");})]);
    const stopped = once(child,"message");child.send({type:"stop"});await stopped;
    child.kill("SIGKILL");await exited;
    server.closeAllConnections();recovering = true;
    app = await createAssistant(options);app.subscribe(() => {});
    const snapshot = await app.controlSnapshot("one");
    await app.waitForIdle();assert.equal(requests,withHistory?2:1,"opening native state cannot bypass a saved stop");
    assert.equal(snapshot.works.filter(work=>work.status==="paused").length,1);
    assert.equal(snapshot.works.filter(work=>work.status==="completed").length,withHistory?1:0);
    await app.receive({conversationId:"one",inputId:"stop",text:"/stop"});
    assert.equal(requests,withHistory?2:1,"replayed stop cannot enqueue a new command");
    await app.resume("one");await app.waitForIdle();
    assert.equal(requests,withHistory?3:2);
    assert.ok((await app.controlSnapshot("one")).works.every(work=>work.status==="completed"));
  } finally {
    if (child.exitCode === null && child.signalCode === null) {child.kill("SIGKILL");await exited;}
    await app?.close();server.closeAllConnections();await new Promise<void>(done => server.close(() => done()));
    await rm(directory,{recursive:true,force:true});
  }
});
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
