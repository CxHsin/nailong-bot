import { test } from "node:test";
import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { sendChatCompletion } from "./fixtures/chat-completion.js";

for (const phase of ["tool-result","output","steer-admitted"] as const) {
  test(`formal service SIGKILL at ${phase} reuses confirmed effects and does not repeat delivery`, { timeout: 60_000 }, async () => {
    const directory = await mkdtemp(join(tmpdir(),"assistant-service-recovery-"));
    let requests = 0;
    let toolRequests = 0;
    let reached!:()=>void;
    const boundary=new Promise<void>((resolve)=>{reached=resolve;});
    let recovering=false;
    const server=createServer(async(request,response)=>{
      let raw="";for await(const part of request)raw+=part;
      const wire=JSON.parse(raw);
      if(wire.model==="router"){
        const context=JSON.parse(wire.messages.at(-1).content);
        const text=context.current.text;
        const target=context.works.find((work:{status:string})=>work.status==="running");
        const actions=text==="amend date Thursday"&&target?[{kind:"supplement",text,target:target.id}]:[{kind:"request",text}];
        response.writeHead(200,{"content-type":"application/json"});
        response.end(JSON.stringify({choices:[{message:{role:"assistant",content:JSON.stringify({actions})},finish_reason:"stop"}]}));return;
      }
      requests++;
      if(wire.messages.at(-1)?.role==="user"&&JSON.stringify(wire.messages.at(-1)).includes("amend date Thursday")){
        sendChatCompletion(response,"Thursday recorded");return;
      }
      if(wire.messages.at(-1)?.role!=="tool"){
        toolRequests++;
        sendChatCompletion(response,"",[{index:0,id:"write-confirmed",type:"function",function:{name:"write",arguments:JSON.stringify({path:"result.txt",content:"one confirmed result"})}}]);
      } else {
        assert.match(JSON.stringify(wire.messages.at(-1)),/result.txt|written|Successfully|bytes/i);
        if((phase==="tool-result"||phase==="steer-admitted")&&!recovering){reached();return;}
        sendChatCompletion(response,"result ready");
      }
    });
    await new Promise<void>((resolve)=>server.listen(0,"127.0.0.1",resolve));
    const address=server.address();assert.ok(address&&typeof address!=="string");
    await writeFile(join(directory,"options.json"),JSON.stringify({cwd:directory,dataDir:join(directory,"durable"),intent:{model:"router"},modelConfiguration:{defaultModel:"local",models:[{alias:"local",api:"openai-completions",model:"local",apiKey:"test",baseUrl:`http://127.0.0.1:${address.port}`},{alias:"router",api:"openai-completions",model:"router",apiKey:"test",baseUrl:`http://127.0.0.1:${address.port}`}]}}));
    function child(mode:string){
      const process=fork(resolve("test/fixtures/assistant-service-child.ts"),[directory,mode],{execArgv:["--import","tsx"],windowsHide:true,silent:true});
      let logs="";process.stdout?.on("data",(part)=>logs+=part);process.stderr?.on("data",(part)=>logs+=part);
      const exited=new Promise<number|null>((resolve)=>process.once("exit",resolve));
      process.on("message",(message)=>{if((message as {type?:string}).type==="output"&&phase==="output")reached();});
      return {process,exited,logs:()=>logs};
    }
    const first=child(phase);
    let second:ReturnType<typeof child>|undefined;
    try {
      await Promise.race([boundary,first.exited.then(()=>{throw new Error(first.logs());})]);
      if(phase==="steer-admitted"){
        const admitted=new Promise<void>((resolve)=>{first.process.on("message",(message)=>{if((message as {type?:string}).type==="steer-admitted")resolve();});});
        first.process.send({type:"steer"});await admitted;
      }
      assert.equal(await readFile(join(directory,"result.txt"),"utf8"),"one confirmed result");
      first.process.kill("SIGKILL");await first.exited;
      recovering=true;server.closeAllConnections();
      second=child("recover");
      assert.equal(await second.exited,0,second.logs());
      assert.equal(toolRequests,1);
      assert.equal(await readFile(join(directory,"result.txt"),"utf8"),"one confirmed result");
      const delivered=(await readFile(join(directory,"delivered.jsonl"),"utf8")).trim().split("\n").map((line)=>JSON.parse(line));
      assert.deepEqual(delivered.map((output)=>output.text),phase==="steer-admitted"?["result ready","Thursday recorded"]:["result ready"]);
      assert.equal(requests,phase==="steer-admitted"?4:phase==="tool-result"?3:2);
    } finally {
      if(first.process.exitCode===null)first.process.kill("SIGKILL");
      if(second?.process.exitCode===null)second.process.kill("SIGKILL");
      server.closeAllConnections();await new Promise<void>((resolve)=>server.close(()=>resolve()));
      await rm(directory,{recursive:true,force:true});
    }
  });
}
