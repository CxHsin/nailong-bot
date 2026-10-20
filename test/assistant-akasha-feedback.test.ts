import {test} from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {setTimeout as delay} from "node:timers/promises";
import {assistantFixture, type Wire} from "./fixtures/assistant.js";
import {embeddingFixture} from "./fixtures/embedding.js";
import {sendChatCompletion} from "./fixtures/chat-completion.js";

type History={node_id:number;session_key:string;user_text:string;assistant_text:string;user_dense:number[];assistant_dense:number[]};
const reference=JSON.parse(readFileSync(new URL("./fixtures/akasha/upstream-golden.json",import.meta.url),"utf8"));
const history:History[]=reference.cases.find((item:{name:string})=>item.name==="chinese-association-and-real-gaps").steps.map((step:{input:History})=>step.input);
const toolText=(wire:Wire)=>{const text=wire.messages.filter(message=>message.role==="tool").at(-1)?.content;return typeof text==="string"?text:JSON.stringify(text);};

async function scenario(remember:boolean,options:{historical?:boolean;incomplete?:boolean}={}){
  const query="关联查询";
  const vectors=new Map(history.flatMap(turn=>[[turn.user_text,turn.user_dense],[turn.assistant_text,turn.assistant_dense]] as Array<[string,number[]]>));
  vectors.set(query,[0,0.8,0.6]);
  const remote=await embeddingFixture(text=>vectors.get(text)??[0,0,1]);
  let reply="已核对。",write=false,search=false,result="",receipt="",targetId="";
  const f=await assistantFixture((wire,response)=>{
    targetId ||= JSON.stringify(wire.messages).match(/input=history-4 sourceId=(source:[a-f0-9]{64})/)?.[1]??"";
    if(wire.messages.at(-1)?.role==="tool"){
      if(write)receipt=toolText(wire);if(search){
        result=toolText(wire);
        response.writeHead(200,{"content-type":"text/event-stream"});response.end(`data: ${JSON.stringify({choices:[{index:0,delta:{content:"查询结果已取得，回答未闭合"},finish_reason:"length"}]})}\n\ndata: [DONE]\n\n`);return;
      }
      if(write&&options.incomplete){response.writeHead(200,{"content-type":"text/event-stream"});response.end(`data: ${JSON.stringify({choices:[{index:0,delta:{content:"已取得工具结果，当前回答截断"},finish_reason:"length"}]})}\n\ndata: [DONE]\n\n`);return;}
      sendChatCompletion(response,reply);return;
    }
    if(write)sendChatCompletion(response,"正在记录。",[{index:0,id:"explicit-remember",type:"function",function:{name:"memory_write",arguments:JSON.stringify({action:"add",kind:"MEMORY",content:"连接测试应关注耗时",quote:"测试模型连接耗时",...(options.historical?{sourceId:targetId}:{}),expectedVersion:remember?0:99})}}]);
    else if(search)sendChatCompletion(response,"",[{index:0,id:"feedback-probe",type:"function",function:{name:"memory_search",arguments:JSON.stringify({query,limit:1})}}]);
    else sendChatCompletion(response,reply);
  },async()=>({embedding:{env:{KEY:"feedback-fixture"},configs:[{id:"feedback",displayName:"Feedback",baseUrl:remote.baseUrl,model:"feedback",apiKeyEnv:"KEY"}]}}));
  const wait=async(minimum:number)=>{const deadline=Date.now()+5000;while(((await f.app.controlSnapshot("probe")).embedding.progress.learned??0)<minimum&&Date.now()<deadline)await delay(15);assert.ok(((await f.app.controlSnapshot("probe")).embedding.progress.learned??0)>=minimum);};
  const probe=async(id:string)=>{
    search=true;await f.app.receive({conversationId:`probe-${id}`,inputId:id,text:"主动核对资料"});await f.app.waitForIdle();search=false;
    const hits=JSON.parse(result).results.filter((item:{lane:string})=>item.lane==="completion");
    assert.ok(hits.length,"the tool exposes a graph completion beyond its direct lane");
    return hits.map((item:{score:number;members:Array<{inputId:string}>})=>({score:item.score,inputs:item.members.filter(member=>member.inputId.startsWith("history-")).map(member=>member.inputId)}));
  };
  try{
    for(const [index,turn] of history.entries()){
      reply=turn.assistant_text;write=index===(options.historical?7:4);
      await f.app.receive({conversationId:turn.session_key,inputId:`history-${index}`,text:turn.user_text});await f.app.waitForIdle();await wait(index+1-(options.incomplete&&index>=(options.historical?7:4)?1:0));
    }
    write=false;
    if(remember)assert.match(receipt,/"id":"memory:/,"the real memory tool succeeded");else assert.match(receipt,/version conflict/);
    const score=await probe("before-reopen");
    await f.app.receive({conversationId:history[4]!.session_key,inputId:"history-4",text:history[4]!.user_text});await f.app.waitForIdle();
    await f.reopen();
    const reopened=await probe("after-reopen");
    return {score,reopened};
  }finally{await f.close();await remote.close();}
}

test("successful explicit remembering changes subsequent graph recall while failed writes do not reinforce, including reopen",{timeout:40000},async()=>{
  const baseline=await scenario(false),remembered=await scenario(true);
  assert.notDeepEqual(remembered.score,baseline.score,"successful remember must reach graph learning rather than only the resident profile");
  assert.deepEqual(remembered.reopened,remembered.score,"reopen and duplicate receipt do not amplify the real feedback effect");
  assert.deepEqual(baseline.reopened,baseline.score,"failed tool evidence remains unreinforced after reopen");
});

test("explicit remembering resolves a historical source through its closed experience",{timeout:40000},async()=>{
  const baseline=await scenario(false,{historical:true}),remembered=await scenario(true,{historical:true});
  assert.notDeepEqual(remembered.score,baseline.score,"the historical original maps to its earlier graph node");
  assert.deepEqual(remembered.reopened,remembered.score,"historical mapping remains stable after reconciliation");
});

test("successful remember followed by a truncated answer cannot reinforce an incomplete experience",{timeout:40000},async()=>{
  const failed=await scenario(false,{historical:true,incomplete:true}),successful=await scenario(true,{historical:true,incomplete:true});
  assert.deepEqual(successful.score,failed.score,"a tool result alone cannot close the Queue/Durable experience");
  assert.deepEqual(successful.reopened,failed.reopened,"reopening must preserve incomplete qualification");
});

test("successful explicit forgetting keeps its effect receipt and excludes targets after space rebuild and reopen",{timeout:20000},async()=>{
  const original="需要遗忘的私有行程：周五乘船去蓝湾。";
  const remote=await embeddingFixture(()=>[1,0,0]);
  let sourceId="",action:"forget"|"search"|undefined,result="";
  const f=await assistantFixture((wire,response)=>{
    sourceId ||= JSON.stringify(wire.messages).match(/input=private-original sourceId=(source:[a-f0-9]{64})/)?.[1]??"";
    if(wire.messages.at(-1)?.role==="tool"){result=toolText(wire);sendChatCompletion(response,"已核对。");return;}
    if(action)sendChatCompletion(response,"",[{index:0,id:`explicit-${action}`,type:"function",function:{name:action==="forget"?"memory_forget":"memory_search",arguments:JSON.stringify(action==="forget"?{id:sourceId,expectedVersion:0}:{query:original})}}]);
    else sendChatCompletion(response,"行程原文已收到。");
  },async()=>({embedding:{env:{KEY:"forget-feedback"},configs:["first","second"].map(id=>({id,displayName:id,baseUrl:remote.baseUrl,model:id,apiKeyEnv:"KEY"}))}}));
  try{
    await f.app.receive({conversationId:"private",inputId:"private-original",text:original});await f.app.waitForIdle();
    assert.ok(sourceId);
    action="forget";await f.app.receive({conversationId:"forgetter",inputId:"forget-original",text:"忘掉先前的私有行程。"});await f.app.waitForIdle();
    const receipt=JSON.parse(result);
    assert.equal(receipt.count,1);assert.ok(!result.includes(sourceId),"model-facing effect receipts retain the forgotten-source boundary");
    action="search";
    for(const [index,space] of ["second","first"].entries()){
      await f.app.control("selector",{type:"embedding_model",id:space,operationId:`forget-space-${index}`});await f.reopen();
      await f.app.receive({conversationId:`search-${index}`,inputId:`search-${index}`,text:"核对现有记忆。"});await f.app.waitForIdle();
      assert.ok(!result.includes(original),"successful forget remains effective through an old or rebuilt graph");
    }
  }finally{await f.close();await remote.close();}
});
