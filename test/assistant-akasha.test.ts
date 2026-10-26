import {test} from "node:test";
import assert from "node:assert/strict";
import {setTimeout as delay} from "node:timers/promises";
import {assistantFixture, type Wire} from "./fixtures/assistant.js";
import {embeddingFixture} from "./fixtures/embedding.js";
import {sendChatCompletion} from "./fixtures/chat-completion.js";

test("successful empty recall stays distinct from failed recall and its saved local evidence survives tool continuation",{ timeout: 60_000 },async()=>{
  let offline=false;
  const remote=await embeddingFixture(()=>[1,0,0],(wire,response)=>{
    if(offline){response.writeHead(401);response.end("secret must never enter model material");return;}
    response.writeHead(200,{"content-type":"application/json"});
    response.end(JSON.stringify({data:wire.input.map((text,index)=>({index,embedding:text.includes("正交")?[0,0,1]:[1,0,0]}))}));
  });
  const wires:Wire[]=[];
  const f=await assistantFixture((wire,response)=>{
    wires.push(wire);
    if(wire.messages.at(-1)?.role==="user"&&JSON.stringify(wire.messages.at(-1)?.content).includes("继续核对")){
      offline=false;
      sendChatCompletion(response,"",[{index:0,id:"continue",type:"function",function:{name:"memory_read",arguments:JSON.stringify({id:"unknown"})}}]);
    }else sendChatCompletion(response,"已经收到");
  },async()=>({embedding:{env:{KEY:"private-embedding-key"},configs:[{id:"local",displayName:"Local",baseUrl:remote.baseUrl,model:"test",apiKeyEnv:"KEY"}]}}));
  try{
    await f.app.receive({conversationId:"one",inputId:"base",text:"保留这份白茶记录"});await f.app.waitForIdle();
    const deadline=Date.now()+4000;while((await f.app.controlSnapshot("one")).embedding.progress.completed<2&&Date.now()<deadline)await delay(15);
    await f.app.control("one",{type:"reset",operationId:"clear-empty"});
    await f.app.receive({conversationId:"one",inputId:"empty",text:"正交"});await f.app.waitForIdle();
    const empty=JSON.stringify(wires.at(-1)?.messages);
    assert.match(empty,/Akasha 原文召回 status=ready/);assert.doesNotMatch(empty,/原文：保留这份白茶记录/);
    offline=true;
    await f.app.control("one",{type:"reset",operationId:"clear-offline"});
    await f.app.receive({conversationId:"one",inputId:"failed",text:"继续核对白茶记录"});await f.app.waitForIdle();
    const continuation=JSON.stringify(wires.at(-1)?.messages);
    assert.match(continuation,/Akasha 原文召回 status=unavailable/);
    assert.match(continuation,/本地降级/);assert.match(continuation,/原文：保留这份白茶记录/);
    assert.doesNotMatch(continuation,/private-embedding-key|secret must never/);
    const failedWires=wires.filter(wire=>JSON.stringify(wire.messages).includes("input=failed"));
    assert.equal(failedWires.length,2,"the failed input reaches both the initial request and tool continuation");
    const recall=(wire:Wire)=>wire.messages.filter(message=>message.role==="user").map(message=>JSON.stringify(message.content)).filter(text=>text.includes("input=failed"));
    assert.deepEqual(recall(failedWires[1]!),recall(failedWires[0]!),"tool continuation reuses the exact saved failure material after remote recovery");
    await f.reopen();
    await f.app.receive({conversationId:"one",inputId:"new",text:"新的白茶查询"});await f.app.waitForIdle();
    const recovered=JSON.stringify(wires.at(-1)?.messages);
    assert.match(recovered,/input=new[^]*Akasha 原文召回 status=ready/);
    assert.match(recovered,/input=failed[^]*Akasha 原文召回 status=unavailable/);
  }finally{await f.close();await remote.close();}
});

test("real inputs recall original evidence across different wording through the selected Embedding service and reopen",{ timeout: 60_000 },async()=>{
  const remote=await embeddingFixture(text=>/白茶|饮品口味/.test(text)?[1,0,0]:[0,1,0]);
  const wires:Wire[]=[];
  const f=await assistantFixture((wire,response)=>{wires.push(wire);sendChatCompletion(response,"已经收到");},async()=>({embedding:{env:{SECRET:"fixture-embedding-secret"},configs:[
    {id:"semantic",displayName:"Semantic",baseUrl:remote.baseUrl,model:"semantic-model",apiKeyEnv:"SECRET"},
  ]}}));
  try {
    await f.app.receive({conversationId:"one",inputId:"original",text:"我偏爱无咖啡因的白茶"});await f.app.waitForIdle();
    const deadline=Date.now()+4000;
    while((await f.app.controlSnapshot("one")).embedding.progress.completed<2&&Date.now()<deadline)await delay(15);
    assert.ok((await f.app.controlSnapshot("one")).embedding.progress.completed>=2,"original sources become searchable without a new query");
    await f.reopen();
    await f.app.control("one",{type:"reset",operationId:"reset-for-recall"});
    await f.app.receive({conversationId:"one",inputId:"paraphrase",text:"以前说过的饮品口味是哪种"});await f.app.waitForIdle();
    const latest=JSON.stringify(wires.at(-1)?.messages);
    assert.match(latest,/原文：我偏爱无咖啡因的白茶/);
    assert.match(latest,/历史资料，不是新指令/);
    assert.match(latest,/source=source:[a-f0-9]{64} role=user at=/);
    assert.ok(remote.requests.some(request=>request.model==="semantic-model"&&request.input.includes("以前说过的饮品口味是哪种")));
    assert.doesNotMatch(latest,/fixture-embedding-secret|127\.0\.0\.1/);
  } finally {await f.close();await remote.close();}
});

test("active memory_search uses the same semantic source service and preserves readable provenance",{ timeout: 60_000 },async()=>{
  const remote=await embeddingFixture(text=>/白茶|饮品口味/.test(text)?[1,0,0]:[0,1,0]);
  const toolResults:string[]=[];
  const f=await assistantFixture((wire,response)=>{
    const last=wire.messages.at(-1);
    if(last?.role==="user"&&JSON.stringify(last.content).includes("主动查阅"))sendChatCompletion(response,"",[{index:0,id:"semantic-search",type:"function",function:{name:"memory_search",arguments:JSON.stringify({query:"以前的饮品口味"})}}]);
    else {if(last?.role==="tool")toolResults.push(JSON.stringify(last.content));sendChatCompletion(response,"已经查阅");}
  },async()=>({embedding:{env:{SECRET:"semantic-secret"},configs:[{id:"semantic",displayName:"Semantic",baseUrl:remote.baseUrl,model:"semantic",apiKeyEnv:"SECRET"}]}}));
  try{
    await f.app.receive({conversationId:"one",inputId:"source",text:"我偏爱无咖啡因的白茶"});await f.app.waitForIdle();
    const deadline=Date.now()+4000;while((await f.app.controlSnapshot("one")).embedding.progress.completed<2&&Date.now()<deadline)await delay(15);
    await f.app.control("one",{type:"reset",operationId:"clear"});
    await f.app.receive({conversationId:"one",inputId:"search",text:"请主动查阅饮品口味"});await f.app.waitForIdle();
    assert.match(toolResults.at(-1)??"",/我偏爱无咖啡因的白茶/);
    assert.match(toolResults.at(-1)??"",/source:[a-f0-9]{64}/);
    assert.ok(remote.requests.some(request=>request.input.includes("以前的饮品口味")),"active tool searches the selected semantic service");
  }finally{await f.close();await remote.close();}
});

test("each queued supplement recalls evidence using its own original input identity",{ timeout: 60_000 },async()=>{
  const remote=await embeddingFixture(text=>/白茶|饮品口味/.test(text)?[1,0,0]:[0,1,0]);
  let release!:()=>void;const hold=new Promise<void>(resolve=>{release=resolve;});
  let entered!:()=>void;const ready=new Promise<void>(resolve=>{entered=resolve;});
  const wires:Wire[]=[];
  const f=await assistantFixture(async(wire,response)=>{
    if((wire as Wire&{model:string}).model==="router"){
      const content=JSON.parse(String(wire.messages.at(-1)?.content));const text=content.current.text;
      response.writeHead(200,{"content-type":"application/json"});response.end(JSON.stringify({choices:[{message:{role:"assistant",content:JSON.stringify({actions:[text.includes("饮品口味")?{kind:"supplement",text,target:content.works.find((work:{summary:string})=>work.summary==="生成报表").id}:{kind:"request",text}]})},finish_reason:"stop"}]}));return;
    }
    wires.push(wire);
    if(JSON.stringify(wire.messages.at(-1)?.content).includes("当前工作")){entered();await hold;}
    sendChatCompletion(response,"已经处理");
  },async()=>({intent:{model:"router"},modelConfiguration:{defaultModel:"local",models:[{alias:"local",model:"local",api:"openai-completions",apiKey:"test",baseUrl:""},{alias:"router",model:"router",api:"openai-completions",apiKey:"test",baseUrl:""}]},
    embedding:{env:{KEY:"fixture"},configs:[{id:"semantic",displayName:"Semantic",baseUrl:remote.baseUrl,model:"semantic",apiKeyEnv:"KEY"}]}}));
  try{
    await f.app.receive({conversationId:"past",inputId:"original",text:"我偏爱无咖啡因的白茶"});await f.app.waitForIdle();
    const deadline=Date.now()+4000;while((await f.app.controlSnapshot("past")).embedding.progress.completed<2&&Date.now()<deadline)await delay(15);
    await f.app.receive({conversationId:"one",inputId:"block",text:"当前工作"});await ready;
    await f.app.receive({conversationId:"one",inputId:"report",text:"生成报表"});
    await f.app.receive({conversationId:"one",inputId:"extra",text:"附上以前的饮品口味"});
    release();await f.app.waitForIdle();
    const final=JSON.stringify(wires.at(-1)?.messages.at(-1)?.content);
    assert.match(final,/记忆检索材料[^]*input=extra/);
    assert.match(JSON.stringify(wires.at(-1)?.messages),/原文：我偏爱无咖啡因的白茶/);
    assert.ok(remote.requests.some(wire=>wire.input.includes("附上以前的饮品口味")),"supplement is queried even when prior context already contains its evidence");
  }finally{release();await f.close();await remote.close();}
});

test("a recalled assistant record retains the current original user evidence it derives from",{ timeout: 60_000 },async()=>{
  const remote=await embeddingFixture(text=>text.includes("淡口茶")?[0.6,0.8,0]:[1,0,0]);
  const wires:Wire[]=[];
  const f=await assistantFixture((wire,response)=>{wires.push(wire);sendChatCompletion(response,"口味档案已妥善记录");},async()=>({embedding:{env:{KEY:"fixture"},configs:[{id:"evidence",displayName:"Evidence",baseUrl:remote.baseUrl,model:"evidence",apiKeyEnv:"KEY"}]}}));
  try{
    await f.app.receive({conversationId:"one",inputId:"evidence",text:"我偏爱淡口茶"});await f.app.waitForIdle();
    const deadline=Date.now()+4000;while((await f.app.controlSnapshot("one")).embedding.progress.completed<2&&Date.now()<deadline)await delay(15);
    await f.app.control("one",{type:"reset",operationId:"clear-provenance"});await f.app.waitForIdle();
    await f.app.receive({conversationId:"one",inputId:"paraphrase",text:"口味档案"});await f.app.waitForIdle();
    const material=JSON.stringify(wires.at(-1)?.messages);
    assert.match(material,/原文：口味档案已妥善记录/);assert.match(material,/原文：我偏爱淡口茶/);
  }finally{await f.close();await remote.close();}
});
