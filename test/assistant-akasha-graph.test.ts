import {test} from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {setTimeout as delay} from "node:timers/promises";
import {assistantFixture, type Wire} from "./fixtures/assistant.js";
import {embeddingFixture} from "./fixtures/embedding.js";
import {sendChatCompletion} from "./fixtures/chat-completion.js";

type HistoricalTurn = {node_id:number;session_key:string;user_text:string;assistant_text:string;user_dense:number[];assistant_dense:number[]};
const reference = JSON.parse(readFileSync(new URL("./fixtures/akasha/upstream-golden.json", import.meta.url), "utf8"));
const historical:HistoricalTurn[] = reference.cases.find((item:{name:string}) => item.name === "chinese-association-and-real-gaps").steps
  .map((step:{input:HistoricalTurn}) => step.input);
const databaseQuery = "数据库事务";
const associatedOriginal = "测试模型连接耗时";
const associatedParaphrase = "连接测试使用合成文本";
const vectorsForHistory = () => new Map(historical.flatMap(turn => [[turn.user_text,turn.user_dense], [turn.assistant_text,turn.assistant_dense]] as Array<[string,number[]]>).concat([[databaseQuery,[0,1,0]]]));
const material = (wire:Wire) => JSON.stringify(wire.messages);
const toolText = (wire:Wire) => {
  const content = wire.messages.filter(message => message.role === "tool").at(-1)?.content;
  return typeof content === "string" ? content : JSON.stringify(content);
};

async function waitForLearning(f:Awaited<ReturnType<typeof assistantFixture>>, minimum:number) {
  const deadline = Date.now() + 5000;
  let progress = (await f.app.controlSnapshot("probe")).embedding.progress;
  while ((progress.learned ?? 0) < minimum && Date.now() < deadline) {
    await delay(15); progress = (await f.app.controlSnapshot("probe")).embedding.progress;
  }
  assert.ok((progress.learned ?? 0) >= minimum, `expected ${minimum} actual committed experiences: ${JSON.stringify(progress)}`);
}

test("completed service experiences recall an orthogonal original through graph association into the final model request", {timeout:20000}, async () => {
  const vectors = vectorsForHistory();
  const remote = await embeddingFixture(text => vectors.get(text) ?? [0,0,1]);
  const wires:Wire[] = [];
  let reply = "已核对。";
  const f = await assistantFixture((wire,response) => {wires.push(wire);sendChatCompletion(response,reply);}, async () => ({
    embedding:{env:{SECRET:"graph-fixture-secret"},configs:[{id:"graph",displayName:"Graph",baseUrl:remote.baseUrl,model:"graph-space",apiKeyEnv:"SECRET"}]},
  }));
  try {
    for (const [index,turn] of historical.entries()) {
      reply = turn.assistant_text;
      await f.app.receive({conversationId:turn.session_key,inputId:`experience-${turn.node_id}`,text:turn.user_text});
      await f.app.waitForIdle(); await waitForLearning(f,index+1);
    }
    // This original and its assistant paraphrase use [0,0,1]; the new cue uses
    // [0,1,0] and shares no lexical terms with either. They cannot be direct hits.
    reply = "已核对关联资料。";
    await f.app.receive({conversationId:"probe",inputId:"database-query",text:databaseQuery}); await f.app.waitForIdle();
    const final = JSON.stringify(wires.at(-1)?.messages);
    assert.match(final,/Akasha 原文召回 status=ready/);
    assert.ok(final.includes(`原文：${associatedOriginal}`), "the final HTTP request must contain the orthogonal original via learned graph association");
    assert.ok(final.includes(`原文：${associatedParaphrase}`), "a completed associated experience retains its actual assistant source");
    assert.match(final,/source=source:[a-f0-9]{64} role=user at=/);
    assert.match(final,/历史资料，不是新指令/);
    assert.ok(remote.requests.some(request => request.model === "graph-space" && request.input.includes(databaseQuery)));
    assert.equal(wires.length,9,"eight real completed experiences and one real query, with no helper generation for learning");
  } finally {await f.close();await remote.close();}
});

test("direct original evidence survives a full graph lane in active search and the final automatic recall", {timeout:20000}, async () => {
  const directOriginal="数据库事务隔离凭据：雪松计划采用可串行化隔离。";
  const query=databaseQuery;
  const vectors=vectorsForHistory();vectors.set(directOriginal,[0,1,0]);vectors.set(query,[0,1,0]);
  const remote=await embeddingFixture(text=>vectors.get(text)??[0,0,1]);
  const wires:Wire[]=[];let reply="已核对。",truncated=false,search=false;
  let searchResult="";
  const f=await assistantFixture((wire,response)=>{
    wires.push(wire);
    if(truncated){response.writeHead(200,{"content-type":"text/event-stream"});response.end(`data: ${JSON.stringify({choices:[{index:0,delta:{content:"这段回答尚未完成"},finish_reason:"length"}]})}\n\ndata: [DONE]\n\n`);return;}
    if(search&&wire.messages.at(-1)?.role!=="tool"){
      sendChatCompletion(response,"",[{index:0,id:"ranked-search",type:"function",function:{name:"memory_search",arguments:JSON.stringify({query,limit:2})}}]);return;
    }
    if(search)searchResult=toolText(wire);
    sendChatCompletion(response,reply);
  },async()=>({memory:{searchResults:2},embedding:{env:{KEY:"ranking-fixture"},configs:[{id:"ranking",displayName:"Ranking",baseUrl:remote.baseUrl,model:"ranking",apiKeyEnv:"KEY"}]}}));
  try{
    for(const [index,turn] of historical.entries()){
      reply=turn.assistant_text;
      await f.app.receive({conversationId:turn.session_key,inputId:`rank-history-${index}`,text:turn.user_text});
      await f.app.waitForIdle();await waitForLearning(f,index+1);
    }
    // A valid raw input without a closed answer is searchable but cannot enter
    // the learned graph. Its query-specific evidence must survive graph recall.
    truncated=true;
    await f.app.receive({conversationId:"raw-record",inputId:"direct-original",text:directOriginal});await f.app.waitForIdle();
    const deadline=Date.now()+4000;while((await f.app.controlSnapshot("probe")).embedding.progress.status!=="ready"&&Date.now()<deadline)await delay(15);
    truncated=false;search=true;
    await f.app.receive({conversationId:"active-probe",inputId:"active-probe",text:"主动核查隔离凭据"});await f.app.waitForIdle();
    assert.ok(searchResult.includes(directOriginal),"the direct semantic original must not be removed by unrelated graph members");
    const result=JSON.parse(searchResult);
    assert.equal(result.returned,result.results.length);
    assert.ok(result.total>=result.returned);assert.ok(result.availableSources>result.returned);
    assert.ok(result.results.some((hit:{lane:string})=>hit.lane==="direct"));
    assert.ok(result.results.some((hit:{lane:string;members:unknown[]})=>hit.lane==="completion"&&hit.members.length>=2),"graph inputs and answers belong to one experience result");
    assert.equal(new Set(result.results.map((hit:{experienceId:string})=>hit.experienceId)).size,result.results.length,"an experience selected directly is not repeated in the completion lane");
    search=false;reply="已核对隔离凭据。";
    await f.app.receive({conversationId:"automatic-probe",inputId:"automatic-probe",text:query});await f.app.waitForIdle();
    assert.ok(material(wires.at(-1)!).includes(`原文：${directOriginal}`),"the direct original must reach the final model HTTP material");
  }finally{await f.close();await remote.close();}
});

for(const inputBytes of [8000,1800])test(`a full direct lane cannot consume the graph lane with ${inputBytes} automatic bytes`, {timeout:25000}, async()=>{
  const query="账目审计";const originals=Array.from({length:6},(_,index)=>`账目审计证据 ${index}：独立核对余额。${"有效载荷".repeat(220)}`);
  const vectors=vectorsForHistory();vectors.set(query,[0,1,0]);for(const text of originals)vectors.set(text,[0,1,0]);
  const remote=await embeddingFixture(text=>vectors.get(text)??[0,0,1]);
  const wires:Wire[]=[];let reply="已核对。",truncated=false,search=false;let searchResult="";
  const f=await assistantFixture((wire,response)=>{
    wires.push(wire);
    if(truncated){response.writeHead(200,{"content-type":"text/event-stream"});response.end(`data: ${JSON.stringify({choices:[{index:0,delta:{content:"未闭合的审计回答"},finish_reason:"length"}]})}\n\ndata: [DONE]\n\n`);return;}
    if(search&&wire.messages.at(-1)?.role!=="tool"){sendChatCompletion(response,"",[{index:0,id:"both-lanes",type:"function",function:{name:"memory_search",arguments:JSON.stringify({query,limit:2})}}]);return;}
    if(search)searchResult=toolText(wire);sendChatCompletion(response,reply);
  },async()=>({memory:{inputBytes},embedding:{env:{KEY:"full-lane-fixture"},configs:[{id:"full",displayName:"Full",baseUrl:remote.baseUrl,model:"full",apiKeyEnv:"KEY"}]}}));
  try{
    for(const [index,turn] of historical.entries()){
      reply=turn.assistant_text;await f.app.receive({conversationId:turn.session_key,inputId:`full-history-${index}`,text:turn.user_text});
      await f.app.waitForIdle();await waitForLearning(f,index+1);
    }
    truncated=true;
    for(const [index,text] of originals.entries()){await f.app.receive({conversationId:`raw-${index}`,inputId:`raw-${index}`,text});await f.app.waitForIdle();}
    const deadline=Date.now()+4000;while((await f.app.controlSnapshot("probe")).embedding.progress.status!=="ready"&&Date.now()<deadline)await delay(15);
    truncated=false;search=true;
    await f.app.receive({conversationId:"full-active",inputId:"full-active",text:"主动核查审计记录"});await f.app.waitForIdle();
    const result=JSON.parse(searchResult);
    assert.equal(result.results.filter((hit:{lane:string})=>hit.lane==="direct").length,2);
    assert.deepEqual(result.results.filter((hit:{lane:string})=>hit.lane==="direct").map((hit:{inputId:string})=>hit.inputId),["raw-1","raw-0"],"select the strongest candidates before presenting each lane newest first");
    assert.ok(result.results.some((hit:{lane:string})=>hit.lane==="completion"),"direct hits cannot consume the other lane's experience limit");
    assert.ok(result.results.length>2,"the limit counts experiences per lane, not flattened member messages");
    search=false;reply="审计核查已完成。";
    await f.app.receive({conversationId:"full-automatic",inputId:"full-automatic",text:query});await f.app.waitForIdle();
    const final=material(wires.at(-1)!);
    assert.match(final,/lane=direct[^]*原文：账目审计证据/);
    assert.match(final,/lane=completion[^]*原文：/);
    const newUser=wires.at(-1)!.messages.filter(message=>message.role==="user").at(-1)!;
    assert.ok(Buffer.byteLength(JSON.stringify(newUser.content))<10_000,"expanding experience provenance still obeys the automatic material budget");
  }finally{await f.close();await remote.close();}
});

test("a recalled batch keeps its primary evidence body ahead of its many provenance members", {timeout:20000}, async()=>{
  const answer="雪松校验主证据：对账采用双人复核。",query="雪松核对凭据";
  const remote=await embeddingFixture(text=>text===answer||text===query?[0,1,0]:[0,0,1]);
  let enter!:()=>void,release!:()=>void;
  const entered=new Promise<void>(resolve=>{enter=resolve;}),released=new Promise<void>(resolve=>{release=resolve;});
  const wires:Wire[]=[];
  const f=await assistantFixture(async(wire,response)=>{
    wires.push(wire);
    if(wires.length===1){enter();await released;sendChatCompletion(response,"前项处理完成。");}
    else sendChatCompletion(response,answer);
  },async()=>({embedding:{env:{KEY:"batch-provenance"},configs:[{id:"batch",displayName:"Batch",baseUrl:remote.baseUrl,model:"batch",apiKeyEnv:"KEY"}]}}));
  try{
    await f.app.receive({conversationId:"batch",inputId:"initial",text:"先处理前项。"});await entered;
    for(let index=0;index<20;index++)await f.app.receive({conversationId:"batch",inputId:`member-${index}`,text:`合批材料第 ${index} 项。`});
    await f.app.waitForRouting();release();await f.app.waitForIdle();await waitForLearning(f,2);
    assert.equal(wires.length,2,"twenty queued originals share one actual final answer");
    await f.app.receive({conversationId:"batch-probe",inputId:"batch-probe",text:query});await f.app.waitForIdle();
    assert.ok(material(wires.at(-1)!).includes(`原文：${answer}`),"expanding provenance cannot displace the primary evidence body");
  }finally{release();await f.close();await remote.close();}
});

test("native forgetting removes graph-associated originals and assistant derivatives from old spaces, active tools and reopen", {timeout:25000}, async () => {
  const vectors = vectorsForHistory();
  const remote = await embeddingFixture(text => vectors.get(text) ?? [0,0,1]);
  const wires:Wire[] = [], toolResults:string[] = [];
  let reply = "已核对。", originalId = "";
  let action:{name:string;args:object;id:string}|undefined;
  const f = await assistantFixture((wire,response) => {
    wires.push(wire);
    if (action && wire.messages.at(-1)?.role !== "tool") {
      sendChatCompletion(response,"",[{index:0,id:action.id,type:"function",function:{name:action.name,arguments:JSON.stringify(action.args)}}]);
    } else {
      if (wire.messages.at(-1)?.role === "tool") toolResults.push(toolText(wire));
      sendChatCompletion(response,reply);
    }
  }, async () => ({embedding:{env:{SECRET:"graph-forgetting-secret"},configs:[
    {id:"first",displayName:"First space",baseUrl:remote.baseUrl,model:"space-first",apiKeyEnv:"SECRET"},
    {id:"second",displayName:"Second space",baseUrl:remote.baseUrl,model:"space-second",apiKeyEnv:"SECRET"},
  ]}}));
  const ask = async (id:string) => {
    await f.app.receive({conversationId:`probe-${id}`,inputId:id,text:databaseQuery}); await f.app.waitForIdle();
    return material(wires.at(-1)!);
  };
  const excluded = (text:string) => {
    assert.ok(!text.includes(associatedOriginal), "forgotten original must not return through a graph, cached source or prior space");
    assert.ok(!text.includes(associatedParaphrase), "assistant paraphrases derived from the forgotten original must stay excluded");
  };
  try {
    for (const [index,turn] of historical.entries()) {
      reply = turn.assistant_text;
      await f.app.receive({conversationId:turn.session_key,inputId:`experience-${turn.node_id}`,text:turn.user_text});
      await f.app.waitForIdle(); await waitForLearning(f,index+1);
      if (turn.node_id === 4) originalId = material(wires.at(-1)!).match(/input=experience-4 sourceId=(source:[a-f0-9]{64})/)?.[1] ?? "";
    }
    assert.ok(originalId, "the actual input material exposes the stable original identity");
    reply = "已核对关联资料。";
    assert.ok((await ask("first-before")).includes(`原文：${associatedOriginal}`));
    await waitForLearning(f,9);
    await f.app.control("selector",{type:"embedding_model",id:"second",operationId:"select-second"});
    await waitForLearning(f,9);
    assert.ok((await ask("second-before")).includes(`原文：${associatedOriginal}`), "the second real space also learned the association before forgetting");
    await waitForLearning(f,10);
    assert.ok(remote.requests.some(request => request.model === "space-first"));
    assert.ok(remote.requests.some(request => request.model === "space-second"));

    reply = "已执行遗忘。";
    action = {name:"memory_forget",args:{id:originalId,expectedVersion:0},id:"forget-associated-original"};
    await f.app.receive({conversationId:"forgetter",inputId:"forget-associated",text:"忘记先前那段连接耗时经历。"}); await f.app.waitForIdle();
    assert.match(toolResults.at(-1) ?? "",/"count":1/);
    excluded(material(wires.at(-1)!));
    action = undefined;
    excluded(await ask("second-after"));
    await f.app.control("selector",{type:"embedding_model",id:"first",operationId:"return-to-first"});
    excluded(await ask("old-first-after"));
    await f.app.control("probe-old-first-after",{type:"reset",operationId:"clear-after-forget"});
    await f.reopen();
    excluded(await ask("reopened-first"));
    await f.app.control("selector",{type:"embedding_model",id:"second",operationId:"return-to-second"});
    excluded(await ask("reopened-second"));

    action = {name:"memory_search",args:{query:databaseQuery},id:"search-after-forget"};
    await f.app.receive({conversationId:"active-search",inputId:"search-after",text:"主动查找相关的数据库记录。"}); await f.app.waitForIdle();
    assert.match(toolResults.at(-1) ?? "",/forgotten sources excluded/); excluded(toolResults.at(-1) ?? "");
    action = {name:"memory_read",args:{id:originalId},id:"read-forgotten-source"};
    await f.app.receive({conversationId:"active-read",inputId:"read-after",text:"按先前来源身份核验可读取范围。"}); await f.app.waitForIdle();
    assert.match(toolResults.at(-1) ?? "",/excluded by forgetting\/correction/); excluded(toolResults.at(-1) ?? "");
    excluded(material(wires.at(-1)!));
  } finally {await f.close();await remote.close();}
});

test("forgetting a graph intermediary invalidates downstream assistant evidence while preserving independent originals and work facts", {timeout:25000}, async () => {
  const vectors = vectorsForHistory();
  const remote = await embeddingFixture(text => vectors.get(text) ?? [0,0,1]);
  const wires:Wire[] = [], toolResults:string[] = [];
  let reply = "已核对。", intermediaryId = "", independentId = "", derivativeId = "";
  let action:{name:string;args:object;id:string}|undefined;
  const f = await assistantFixture((wire,response) => {
    wires.push(wire);
    if (action && wire.messages.at(-1)?.role !== "tool") sendChatCompletion(response,"",[
      {index:0,id:action.id,type:"function",function:{name:action.name,arguments:JSON.stringify(action.args)}},
    ]);
    else {
      if (wire.messages.at(-1)?.role === "tool") toolResults.push(toolText(wire));
      sendChatCompletion(response,reply);
    }
  }, async () => ({embedding:{env:{SECRET:"intermediary-fixture"},configs:[
    {id:"intermediary",displayName:"Intermediary",baseUrl:remote.baseUrl,model:"intermediary-space",apiKeyEnv:"SECRET"},
  ]}}));
  const absent = (wire:Wire) => {
    const text = material(wire);
    assert.ok(!text.includes("开发项目使用 TypeScript 与 SQLite"), "the forgotten graph intermediary original must stay excluded");
    assert.ok(!text.includes("项目技术栈已记录"), "the intermediary's own assistant paraphrase must stay excluded");
    assert.ok(!text.includes(associatedParaphrase), "the assistant reply that used the intermediary as evidence must stay excluded");
  };
  try {
    for (const [index,turn] of historical.entries()) {
      reply = turn.assistant_text;
      await f.app.receive({conversationId:turn.session_key,inputId:`experience-${turn.node_id}`,text:turn.user_text});
      await f.app.waitForIdle(); await waitForLearning(f,index+1);
      if (turn.node_id === 2) intermediaryId = material(wires.at(-1)!).match(/input=experience-2 sourceId=(source:[a-f0-9]{64})/)?.[1] ?? "";
      if (turn.node_id === 4) independentId = material(wires.at(-1)!).match(/input=experience-4 sourceId=(source:[a-f0-9]{64})/)?.[1] ?? "";
    }
    reply = "已核对关联。";
    await f.app.receive({conversationId:"before",inputId:"before-intermediary-forget",text:databaseQuery}); await f.app.waitForIdle();
    derivativeId = material(wires.at(-1)!).match(/\[source=(source:[a-f0-9]{64}) role=assistant[^\]]+\] 原文：连接测试使用合成文本/)?.[1] ?? "";
    assert.ok(derivativeId, "graph recall supplies the actual downstream assistant source before forgetting");
    assert.ok(intermediaryId); assert.ok(independentId);
    const codingWorks = (await f.app.controlSnapshot("coding")).works;
    assert.equal(codingWorks.length,3); assert.ok(codingWorks.every(work => work.status === "completed"));
    action = {name:"memory_forget",args:{id:intermediaryId,expectedVersion:0},id:"forget-graph-intermediary"};
    reply = "已执行遗忘。";
    await f.app.receive({conversationId:"forgetter",inputId:"forget-intermediary",text:"忘记先前的项目技术栈资料。"}); await f.app.waitForIdle();
    assert.match(toolResults.at(-1) ?? "",/"count":1/); absent(wires.at(-1)!);
    action = undefined;
    await f.app.control("coding",{type:"reset",operationId:"clear-intermediary-context"}); await f.reopen();
    await f.app.receive({conversationId:"after",inputId:"after-intermediary-forget",text:databaseQuery}); await f.app.waitForIdle();
    absent(wires.at(-1)!);
    assert.deepEqual((await f.app.controlSnapshot("coding")).works.map(work => [work.id,work.status]),codingWorks.map(work => [work.id,work.status]),
      "forgetting and context reset retain the completed work facts");
    action = {name:"memory_read",args:{id:derivativeId},id:"read-invalidated-derivative"};
    await f.app.receive({conversationId:"read-derivative",inputId:"read-derivative",text:"核验关联助手来源是否仍有效。"}); await f.app.waitForIdle();
    assert.match(toolResults.at(-1) ?? "",/excluded by forgetting\/correction/); absent(wires.at(-1)!);
    action = {name:"memory_read",args:{id:independentId},id:"read-independent-user-original"};
    await f.app.receive({conversationId:"read-original",inputId:"read-original",text:"核验独立用户原始记录是否保留。"}); await f.app.waitForIdle();
    assert.ok((toolResults.at(-1) ?? "").includes(associatedOriginal), "forgetting evidence does not erase a separate valid user input");
    assert.match(toolResults.at(-1) ?? "",/"role":"user"/);
    assert.ok(!material(wires.at(-1)!).includes(associatedParaphrase));
  } finally {await f.close();await remote.close();}
});
