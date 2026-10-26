import {test} from "node:test";
import assert from "node:assert/strict";
import {setTimeout as delay} from "node:timers/promises";
import {assistantFixture} from "./fixtures/assistant.js";
import {embeddingFixture} from "./fixtures/embedding.js";
import {sendChatCompletion} from "./fixtures/chat-completion.js";
import {Type} from "typebox";

function deferred(){let resolve!:()=>void;const promise=new Promise<void>(done=>{resolve=done;});return {promise,resolve};}

test("a committed completed conversation learns once and preserves its learned progress after reopen", { timeout: 60_000 }, async()=>{
  const remote=await embeddingFixture(()=>[1,0,0]);
  const f=await assistantFixture((_wire,response)=>sendChatCompletion(response,"我会保留这段经历。"),async()=>({embedding:{env:{SECRET:"learning-fixture"},configs:[
    {id:"learning",displayName:"Learning",baseUrl:remote.baseUrl,model:"learning",apiKeyEnv:"SECRET"},
  ]}}));
  const learned=async()=>Number((await f.app.controlSnapshot("one")).embedding.progress.learned??0);
  const waitForLearning=async()=>{const deadline=Date.now()+3000;while(await learned()<1&&Date.now()<deadline)await delay(20);};
  try{
    await f.app.receive({conversationId:"one",inputId:"original",text:"我曾在月桥喝过白茶。"});await f.app.waitForIdle();
    await waitForLearning();assert.equal(await learned(),1,"a genuinely completed processing turn becomes one learned experience");
    await f.app.receive({conversationId:"one",inputId:"original",text:"我曾在月桥喝过白茶。"});await f.app.waitForIdle();
    assert.equal(await learned(),1,"duplicate receipt must not amplify learning");
    await f.reopen();await waitForLearning();assert.equal(await learned(),1,"recovery reuses the committed learning identity");
  }finally{await f.close();await remote.close();}
});

test("tool continuation text is not learned before its committed final response", { timeout: 60_000 }, async()=>{
  const remote=await embeddingFixture(()=>[1,0,0]);
  const entered=deferred(),release=deferred();
  const f=await assistantFixture((wire,response)=>{
    if(wire.messages.at(-1)?.role==="tool")sendChatCompletion(response,"已根据真实工具结果回答。");
    else sendChatCompletion(response,"这只是工具前的处理说明。",[{index:0,id:"learning-hold",type:"function",function:{name:"learning_hold",arguments:"{}"}}]);
  },async()=>({embedding:{env:{SECRET:"learning-tool"},configs:[{id:"learning",displayName:"Learning",baseUrl:remote.baseUrl,model:"learning",apiKeyEnv:"SECRET"}]},
    tools:[{name:"learning_hold",label:"Controlled learning boundary",description:"Wait for controlled external result",parameters:Type.Object({}),async execute(){entered.resolve();await release.promise;return {content:[{type:"text" as const,text:"controlled result"}],details:{}};}}]}));
  try{
    await f.app.receive({conversationId:"one",inputId:"tool-work",text:"请查询这次旅行的真实记录。"});await entered.promise;
    assert.equal((await f.app.controlSnapshot("one")).embedding.progress.learned??0,0,"toolUse text is searchable original material, not a completed experience");
    release.resolve();await f.app.waitForIdle();
    const deadline=Date.now()+3000;while(((await f.app.controlSnapshot("one")).embedding.progress.learned??0)<1&&Date.now()<deadline)await delay(20);
    assert.equal((await f.app.controlSnapshot("one")).embedding.progress.learned,1,"the final answer closes the experience once");
  }finally{release.resolve();await f.close();await remote.close();}
});

test("truncated and paused responses remain searchable originals without being learned as closed dialogue", { timeout: 60_000 }, async()=>{
  const remote=await embeddingFixture(()=>[1,0,0]);
  const f=await assistantFixture((wire,response)=>{
    if(JSON.stringify(wire.messages.at(-1)?.content).includes("暂停资料")){
      response.writeHead(401,{"content-type":"application/json"});response.end(JSON.stringify({error:{message:"controlled authentication failure"}}));
    }else{
      response.writeHead(200,{"content-type":"text/event-stream"});
      response.end(`data: ${JSON.stringify({choices:[{index:0,delta:{content:"尚未完整回答的截断文字"},finish_reason:"length"}]})}\n\ndata: [DONE]\n\n`);
    }
  },async()=>({embedding:{env:{SECRET:"learning-incomplete"},configs:[{id:"learning",displayName:"Learning",baseUrl:remote.baseUrl,model:"learning",apiKeyEnv:"SECRET"}]},reportFailure(){}}));
  try{
    await f.app.receive({conversationId:"one",inputId:"truncated",text:"截断资料仍然是有效原文。"});await f.app.waitForIdle();
    await f.app.receive({conversationId:"two",inputId:"paused",text:"暂停资料仍然是有效原文。"});await f.app.waitForIdle();
    const deadline=Date.now()+3000;while((await f.app.controlSnapshot("one")).embedding.progress.completed<3&&Date.now()<deadline)await delay(20);
    const snapshot=await f.app.controlSnapshot("one");
    assert.ok(snapshot.embedding.progress.completed>=3,"valid input and truncated assistant sources are indexed despite lacking a closed learning sample");
    assert.equal(snapshot.embedding.progress.learned??0,0);
    assert.equal((await f.app.controlSnapshot("two")).status,"paused");
    await f.reopen();await f.app.waitForIdle();
    assert.equal((await f.app.controlSnapshot("one")).embedding.progress.learned??0,0,"historical reconciliation must preserve incomplete qualification after restart");
  }finally{await f.close();await remote.close();}
});

test("a FIFO batch keeps multiple original input identities in one closed experience", { timeout: 60_000 }, async()=>{
  const remote=await embeddingFixture(()=>[1,0,0]);
  const entered=deferred(),release=deferred();const wires:string[]=[];
  const f=await assistantFixture(async(wire,response)=>{
    wires.push(JSON.stringify(wire.messages));
    if(wires.length===1){entered.resolve();await release.promise;}
    sendChatCompletion(response,"本批次的输入已一并回答。");
  },async()=>({embedding:{env:{SECRET:"learning-batch"},configs:[{id:"learning",displayName:"Learning",baseUrl:remote.baseUrl,model:"learning",apiKeyEnv:"SECRET"}]}}));
  try{
    await f.app.receive({conversationId:"one",inputId:"first",text:"先处理当前事项。"});await entered.promise;
    await f.app.receive({conversationId:"one",inputId:"second",text:"第二项原始输入。"});
    await f.app.receive({conversationId:"one",inputId:"third",text:"第三项原始输入。"});await f.app.waitForRouting();
    release.resolve();await f.app.waitForIdle();
    assert.equal(wires.length,2,"queued ordinary inputs share the next real model processing turn");
    assert.match(wires[1]!,/identity=\\"second\\"/);assert.match(wires[1]!,/identity=\\"third\\"/);
    const deadline=Date.now()+3000;while(((await f.app.controlSnapshot("one")).embedding.progress.learned??0)<2&&Date.now()<deadline)await delay(20);
    assert.equal((await f.app.controlSnapshot("one")).embedding.progress.learned,2,"three original inputs with two real final answers create two experiences");
    await f.reopen();await f.app.waitForIdle();
    assert.equal((await f.app.controlSnapshot("one")).embedding.progress.learned,2,"reconciliation does not split or relearn the shared answer");
  }finally{release.resolve();await f.close();await remote.close();}
});

test("enabling embedding after reopen learns retained completed dialogue without a new query", { timeout: 60_000 }, async()=>{
  const remote=await embeddingFixture(()=>[1,0,0]);
  let modelRequests=0;
  const f=await assistantFixture((_wire,response)=>{modelRequests++;sendChatCompletion(response,"这次已完成的对话将保留原始关联。");});
  try{
    await f.app.receive({conversationId:"one",inputId:"historical",text:"旧日我曾在海边见过一座红灯塔。"});await f.app.waitForIdle();
    assert.equal((await f.app.controlSnapshot("one")).embedding.progress.learned??0,0);
    f.options.embedding={env:{SECRET:"learning-history"},configs:[{id:"learning",displayName:"Learning",baseUrl:remote.baseUrl,model:"learning",apiKeyEnv:"SECRET"}]};
    await f.reopen();
    const deadline=Date.now()+3000;while(((await f.app.controlSnapshot("one")).embedding.progress.learned??0)<1&&Date.now()<deadline)await delay(20);
    assert.equal((await f.app.controlSnapshot("one")).embedding.progress.learned,1,"startup reconciles the real retained Queue and Durable answer association");
    assert.equal(modelRequests,1,"backlog learning never replays the completed model request");
    await f.reopen();await f.app.waitForIdle();
    assert.equal((await f.app.controlSnapshot("one")).embedding.progress.learned,1,"the recovered historical sample is idempotent across another restart");
    assert.equal(modelRequests,1);
  }finally{await f.close();await remote.close();}
});

test("busy supplements sharing the committed answer learn once across duplicate receipt and reopen", { timeout: 60_000 }, async()=>{
  const remote=await embeddingFixture(()=>[1,0,0]);
  const entered=deferred(),release=deferred();const wires:string[]=[];
  const f=await assistantFixture((wire,response)=>{
    if((wire as typeof wire&{model:string}).model==="router"){
      const context=JSON.parse(String(wire.messages.at(-1)!.content));
      const target=context.works.find((work:{status:string})=>work.status==="running");
      response.writeHead(200,{"content-type":"application/json"});
      response.end(JSON.stringify({choices:[{message:{role:"assistant",content:JSON.stringify({actions:[{kind:"supplement",text:context.current.text,target:target.id}]})},finish_reason:"stop"}]}));return;
    }
    wires.push(JSON.stringify(wire.messages));
    if(wires.length===1)sendChatCompletion(response,"",[{index:0,id:"learning-steer-hold",type:"function",function:{name:"learning_hold",arguments:"{}"}}]);
    else sendChatCompletion(response,"当前事项与补充输入已一起回答。");
  },async()=>({embedding:{env:{SECRET:"learning-steer"},configs:[{id:"learning",displayName:"Learning",baseUrl:remote.baseUrl,model:"learning",apiKeyEnv:"SECRET"}]},
    intent:{model:"router"},modelConfiguration:{defaultModel:"local",models:[{alias:"local",model:"local",api:"openai-completions",apiKey:"test",baseUrl:""},{alias:"router",model:"router",api:"openai-completions",apiKey:"test",baseUrl:""}]},
    tools:[{name:"learning_hold",label:"Hold learning boundary",description:"Wait for external evidence",parameters:Type.Object({}),async execute(){entered.resolve();await release.promise;return {content:[{type:"text" as const,text:"controlled result"}],details:{}};}}]}));
  try{
    await f.app.receive({conversationId:"one",inputId:"initial",text:"生成这次旅行的总结。"});await entered.promise;
    await f.app.receive({conversationId:"one",inputId:"extra-one",text:"补充：保留海边灯塔。"});
    await f.app.receive({conversationId:"one",inputId:"extra-two",text:"补充：加上红茶的口味。"});
    await f.app.receive({conversationId:"one",inputId:"extra-one",text:"补充：保留海边灯塔。"});await f.app.waitForRouting();
    assert.equal((await f.app.controlSnapshot("one")).embedding.progress.learned??0,0);
    release.resolve();await f.app.waitForIdle();
    assert.equal(wires.length,2);assert.match(wires[1]!,/extra-one/);assert.match(wires[1]!,/extra-two/);
    const deadline=Date.now()+3000;while(((await f.app.controlSnapshot("one")).embedding.progress.learned??0)<1&&Date.now()<deadline)await delay(20);
    assert.equal((await f.app.controlSnapshot("one")).embedding.progress.learned,1,"the final answer shared by the main submission and both steers is one experience");
    await f.reopen();await f.app.waitForIdle();
    assert.equal((await f.app.controlSnapshot("one")).embedding.progress.learned,1,"retained steer receipts cannot amplify the shared answer during recovery");
  }finally{release.resolve();await f.close();await remote.close();}
});

test("stopping a live processing turn excludes its late response from learning after restart", { timeout: 60_000 }, async()=>{
  const remote=await embeddingFixture(()=>[1,0,0]);
  const entered=deferred(),release=deferred();
  const f=await assistantFixture(async(_wire,response)=>{entered.resolve();await release.promise;sendChatCompletion(response,"这是暂停后才返回的回答。");},async()=>({
    embedding:{env:{SECRET:"learning-stop"},configs:[{id:"learning",displayName:"Learning",baseUrl:remote.baseUrl,model:"learning",apiKeyEnv:"SECRET"}]},reportFailure(){},
  }));
  try{
    await f.app.receive({conversationId:"one",inputId:"stopped-work",text:"这项工作稍后暂停。"});await entered.promise;
    await f.app.control("one",{type:"stop",operationId:"learning-stop"});release.resolve();await f.app.waitForIdle();
    assert.equal((await f.app.controlSnapshot("one")).status,"paused");
    assert.equal((await f.app.controlSnapshot("one")).embedding.progress.learned??0,0);
    await f.reopen();await f.app.waitForIdle();
    assert.equal((await f.app.controlSnapshot("one")).status,"paused");
    assert.equal((await f.app.controlSnapshot("one")).embedding.progress.learned??0,0,"Queue final pause remains authoritative even if a provider returned late");
  }finally{release.resolve();await f.close();await remote.close();}
});
