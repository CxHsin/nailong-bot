import { test } from "node:test";
import assert from "node:assert/strict";
import { fork, type ChildProcess } from "node:child_process";
import { createServer, type ServerResponse } from "node:http";
import { mkdtemp, readFile, writeFile, appendFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { sendChatCompletion } from "./fixtures/chat-completion.js";

function deferred() {
  let resolve!: () => void;
  const promise=new Promise<void>((done)=>{resolve=done;});
  return {promise,resolve};
}
function classification(response:ServerResponse,actions:unknown[]) {
  response.writeHead(200,{"content-type":"application/json"});
  response.end(JSON.stringify({choices:[{message:{role:"assistant",content:JSON.stringify({actions})},finish_reason:"stop"}]}));
}
function spawn(directory:string) {
  function child(mode:string) {
    const process=fork(resolve("test/fixtures/assistant-routing-child.ts"),[directory,mode],{execArgv:["--import","tsx"],windowsHide:true,silent:true});
    const received=deferred();
    const observation:{raw?:{eventId:string;replyToMessageId?:string};input?:{eventId:string;replyToMessageId?:string}}={};
    let logs="";
    process.stdout?.on("data",(part)=>{logs+=part;});
    process.stderr?.on("data",(part)=>{logs+=part;});
    process.on("message",(message)=>{
      const value=message as {type?:string;raw?:{eventId:string;replyToMessageId?:string};input?:{eventId:string;replyToMessageId?:string}};
      if(value.type==="received") {observation.raw=value.raw;received.resolve();}
      if(value.type==="settled") observation.input=value.input;
    });
    const exited=new Promise<number|null>((done)=>{process.once("exit",done);});
    return {process,exited,received:received.promise,observation,logs:()=>logs};
  }
  return child;
}
async function kill(process:ChildProcess,exited:Promise<number|null>) {
  if(process.exitCode===null && process.signalCode===null) process.kill("SIGKILL");
  await exited;
}

for(const scenario of ["raw","decision","sending"] as const) {
  test(`SIGKILL after routing ${scenario} boundary retains identity and avoids repeating confirmed or unknown helper sends`,{timeout:25_000},async()=>{
    const directory=await mkdtemp(join(tmpdir(),`assistant-routing-${scenario}-`));
    const boundary=deferred();
    let recovering=false;
    let rawClassifications=0;
    let supplementClassifications=0;
    let rawToolRequests=0;
    const mainInputs:unknown[]=[];
    const classifierInputs:Array<{current:{text:string;inputId:string;replyToMessageId?:string};works:Array<{id:string;helperId?:string}>}>=[];
    const prompts:string[]=[];
    const cliCalls:string[][]=[];
    const server=createServer(async(request,response)=>{
      try {
        let body="";for await(const part of request)body+=part;
        const wire=JSON.parse(body);
        if(request.url==="/herdr") {
          assert.equal(wire.session,"fixture");
          const args=wire.args as string[];
          cliCalls.push(args);
          if(args[1]==="get") {
            if(scenario==="decision" && supplementClassifications>0 && !recovering) {boundary.resolve();return;}
            response.end(JSON.stringify({result:{agent:{name:"coder",pane_id:"coder:p1",workspace_id:"w1",cwd:directory,agent_status:"working",state_change_seq:1}}}));
            return;
          }
          if(args[1]==="prompt") {
            prompts.push(args[3]!);
            await appendFile(join(directory,"helper-effects.jsonl"),JSON.stringify(args[3])+"\n");
            if(scenario==="sending" && !recovering) {boundary.resolve();return;}
            response.end(JSON.stringify({result:{submitted:true}}));
            return;
          }
          throw new Error(`unexpected controlled CLI ${JSON.stringify(args)}`);
        }
        if(wire.model==="router") {
          const context=JSON.parse(wire.messages.at(-1).content);
          classifierInputs.push(context);
          const text=context.current.text as string;
          if(text==="write raw-result.txt exactly once") {
            rawClassifications++;
            if(!recovering) {boundary.resolve();return;}
          }
          if(text.startsWith("helper supplement")) {
            supplementClassifications++;
            const helper=context.works.find((work:{helperId?:string})=>work.helperId);
            assert.ok(helper,"registered helper must remain a real routing target");
            classification(response,[{kind:"supplement",text,target:helper.id}]);
          } else classification(response,[{kind:"request",text}]);
          return;
        }
        mainInputs.push(wire.messages);
        const last=wire.messages.at(-1);
        if(last.role==="tool") {sendChatCompletion(response,"work confirmed");return;}
        if(JSON.stringify(last).includes("register helper")) {
          sendChatCompletion(response,"",[{index:0,id:"registered-coder",type:"function",function:{name:"herdr_watch",arguments:JSON.stringify({session:"fixture",agent:"coder",paneId:"coder:p1",workspaceId:"w1",cwd:directory,promptPath:join(directory,"helper-prompt.txt"),summary:"original helper task"})}}]);
          return;
        }
        rawToolRequests++;
        sendChatCompletion(response,"",[{index:0,id:"raw-write-once",type:"function",function:{name:"write",arguments:JSON.stringify({path:"raw-result.txt",content:"raw original persisted and executed once"})}}]);
      } catch(error) {response.writeHead(500);response.end(String(error));}
    });
    await new Promise<void>((done)=>{server.listen(0,"127.0.0.1",done);});
    const address=server.address();assert.ok(address&&typeof address!=="string");
    const endpoint=`http://127.0.0.1:${address.port}`;
    await writeFile(join(directory,"helper-prompt.txt"),"the original helper assignment");
    await writeFile(join(directory,"routing-options.json"),JSON.stringify({scenario,endpoint,options:{cwd:directory,dataDir:join(directory,"fresh"),pollMs:60_000,intent:{model:"router",timeoutMs:10_000},modelConfiguration:{defaultModel:"local",models:[
      {alias:"local",api:"openai-completions",model:"local",apiKey:"test",baseUrl:endpoint},
      {alias:"router",api:"openai-completions",model:"router",apiKey:"test",baseUrl:endpoint},
    ]}}}));
    const child=spawn(directory);
    const first=child("initial");
    let second:ReturnType<typeof child>|undefined;
    try {
      await Promise.race([Promise.all([boundary.promise,first.received]),first.exited.then(()=>{throw new Error(first.logs()||"child exited before the recovery boundary");})]);
      if(scenario==="raw") {
        assert.equal(rawToolRequests,0);
        assert.equal(mainInputs.length,0,"persisted raw receipt must not reach the main model while classification is unresolved");
      } else assert.equal(prompts.length,scenario==="sending"?1:0);
      await kill(first.process,first.exited);
      recovering=true;
      server.closeAllConnections();
      second=child("recover");
      assert.equal(await second.exited,0,second.logs());
      const outputs=(await readFile(join(directory,"routing-delivered.jsonl"),"utf8")).trim().split("\n").map((line)=>JSON.parse(line));
      if(scenario==="raw") {
        assert.equal(rawClassifications,2,"unfinished classification may rerun once after recovery, duplicate receipt must not create another");
        assert.equal(rawToolRequests,1);
        assert.equal(await readFile(join(directory,"raw-result.txt"),"utf8"),"raw original persisted and executed once");
        const original=classifierInputs.filter((input)=>input.current.text==="write raw-result.txt exactly once");
        assert.equal(original[1]!.current.inputId,original[0]!.current.inputId);
        assert.equal(first.observation.raw?.replyToMessageId,"original-reply");
        assert.equal(second.observation.input?.replyToMessageId,"original-reply");
        assert.equal(second.observation.input?.eventId,first.observation.raw?.eventId);
        assert.equal((JSON.stringify(mainInputs[0]).match(/<event identity=\\"raw-original\\"/g)??[]).length,1);
        assert.equal(outputs.filter((output)=>output.text==="work confirmed").length,1);
      } else {
        assert.equal(supplementClassifications,1,"committed routing decision is reused after SIGKILL");
        assert.equal(prompts.length,1,"a possibly sent helper supplement is never blindly resent");
        assert.match(prompts[0]!,/helper supplement: CSV, preserve original data/);
        assert.match(prompts[0]!,/稳定身份/);
        const effects=(await readFile(join(directory,"helper-effects.jsonl"),"utf8")).trim().split("\n");
        assert.equal(effects.length,1);
        if(scenario==="decision") assert.ok(outputs.some((output)=>/已转交.*采纳仍待核实/.test(output.text)));
        else {
          assert.ok(outputs.some((output)=>/投递结果待核实/.test(output.text)));
          assert.ok(!outputs.some((output)=>/已转交对应帮手|已采纳|已生效/.test(output.text)));
        }
        assert.ok(cliCalls.some((args)=>args[1]==="get"));
      }
    } finally {
      await kill(first.process,first.exited);
      if(second) await kill(second.process,second.exited);
      server.closeAllConnections();
      await new Promise<void>((done)=>{server.close(()=>done());});
      await rm(directory,{recursive:true,force:true});
    }
  });
}
