import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { Response as ApiResponse } from "node-fetch";
import { telegramFixture } from "./fixtures/telegram.js";
import { sendChatCompletion } from "./fixtures/chat-completion.js";

const conversation = "telegram:private:42";
const update = (id: number, text: string, actor = 42) => ({ update_id: id, message: {
  message_id: id, date: 0, chat: {id: actor, type: "private" as const, first_name: "owner"},
  from: {id: actor, is_bot: false, first_name: "owner"}, text,
} });

test("satiety decays offline, direct feeding is durable and duplicate updates do not feed twice", async () => {
  let now = Date.UTC(2026, 9, 19); let requests = 0;
  const f = await telegramFixture((_wire, response) => {requests++; sendChatCompletion(response, "done");}, undefined, undefined,
    async () => ({now: () => now}));
  try {
    assert.deepEqual((await f.app.controlSnapshot(conversation)).satiety, {value:100,label:"饱饱的"});
    now += 24 * 60 * 60 * 1000;
    assert.deepEqual((await f.app.controlSnapshot(conversation)).satiety, {value:50,label:"有点馋"});
    await f.bot.handleUpdate(update(1,"/feed",43));
    await f.bot.handleUpdate(update(2,"/feed")); await f.flush();
    assert.equal((await f.app.controlSnapshot(conversation)).satiety.value,75);
    await f.reopen(); await f.bot.handleUpdate(update(2,"/feed")); await f.flush();
    assert.equal((await f.app.controlSnapshot(conversation)).satiety.value,75);
    assert.equal(requests,0);
    now += 48 * 60 * 60 * 1000;
    assert.deepEqual((await f.app.controlSnapshot(conversation)).satiety,{value:0,label:"肚子空空"});
  } finally { await f.close(); }
});

test("natural feeding uses the current input identity once and historical feeding cannot authorize a new action", async () => {
  let now = Date.UTC(2026,9,19); let stage = 0;
  const f = await telegramFixture((_wire,response) => {
    stage++;
    if (stage === 1 || stage === 2 || stage === 4) sendChatCompletion(response,"",[{index:0,id:`feed-${stage}`,type:"function",function:{
      name:"persona_feed",arguments:JSON.stringify({inputId:"10",request:"奶龙，喂你吃一个包子"}),
    }}]);
    else sendChatCompletion(response,"正式结果：完成。");
  },undefined,undefined,async () => ({now:()=>now}));
  try {
    await f.app.controlSnapshot(conversation); now += 48*60*60*1000;
    await f.bot.handleUpdate(update(10,"奶龙，喂你吃一个包子")); await f.flush();
    assert.equal((await f.app.controlSnapshot(conversation)).satiety.value,25);
    await f.bot.handleUpdate(update(11,"分析文章中的引语：奶龙，喂你吃一个包子")); await f.flush();
    assert.equal((await f.app.controlSnapshot(conversation)).satiety.value,25);
    assert.equal(f.sent.filter(item=>item.method === "sendRichMessage").length,2);
    assert.equal(stage,5);
  } finally {await f.close();}
});


const sticker = {file_id:"file-nailong",file_unique_id:"unique-nailong",type:"regular" as const,width:512,height:512,is_animated:true,is_video:false,emoji:"🦖",set_name:"NailongSet"};
const call = (name:string,args:object,id:string) => [{index:0,id,type:"function",function:{name,arguments:JSON.stringify(args)}}];

test("reply targets reach the main model as reference material without authorizing the quoted request", async () => {
  let stage=0;const wires:string[]=[];let now=Date.UTC(2026,9,19);
  const f=await telegramFixture((wire,response)=>{
    wires.push(JSON.stringify(wire));stage++;
    if(stage===1) sendChatCompletion(response,"",call("persona_feed",{inputId:"98765",request:"喂你一个包子"},"quoted-feeding"));
    else if(stage===2) sendChatCompletion(response,"",call("telegram_expression",{kind:"reaction",inputId:"401",messageId:98765,emoji:"👍",explicit:true,request:"给我回复的消息点个赞"},"reply-reaction"));
    else sendChatCompletion(response,"已给指定消息回应。");
  },undefined,undefined,async()=>({now:()=>now}));
  try {
    await f.app.controlSnapshot(conversation);now+=48*60*60*1000;
    const current=update(401,"给我回复的消息点个赞");
    await f.bot.handleUpdate({...current,message:{...current.message,reply_to_message:{...update(98765,"喂你一个包子").message,reply_to_message:undefined}}});await f.flush();
    assert.match(wires[0]!,/replyToMessageId[^0-9]+98765/);
    assert.match(wires[0]!,/喂你一个包子/);
    assert.equal((await f.app.controlSnapshot(conversation)).satiety.value,0);
    assert.match(wires[1]!,/互动需要本轮用户原话/);
    const reactions=f.sent.filter(item=>item.method === "setMessageReaction");
    assert.equal(reactions.length,1);
    assert.equal(JSON.parse(String(reactions[0]!.body)).message_id,98765);
  } finally {await f.close();}
});

test("active work supplements authorize feeding only within their batch and survive restart without replay", async () => {
  let now=Date.UTC(2026,9,19), stage=0;
  let entered!:()=>void, release!:()=>void, fed!:()=>void, resumeResponse!:()=>void;
  const started=new Promise<void>(resolve=>{entered=resolve;});
  const held=new Promise<void>(resolve=>{release=resolve;});
  const feedingResult=new Promise<void>(resolve=>{fed=resolve;});
  const pausedResponse=new Promise<void>(resolve=>{resumeResponse=resolve;});
  const request="继续做这项工作，顺便喂你一个包子";
  const wires:string[]=[];
  const f=await telegramFixture(async(wire,response)=>{
    if((wire as {model?:string}).model === "router") {
      const snapshot=JSON.parse(String(wire.messages.at(-1)!.content));
      response.writeHead(200,{"content-type":"application/json"});
      response.end(JSON.stringify({choices:[{message:{role:"assistant",content:JSON.stringify({actions:[{kind:"supplement",text:request,target:snapshot.works.find((work:{status:string})=>work.status==="running").id}]})},finish_reason:"stop"}]}));
      return;
    }
    wires.push(JSON.stringify(wire));stage++;
    if(stage===1) {entered();await held;sendChatCompletion(response,"",call("telegram_stickers",{action:"list"},"continue"));}
    else if(stage===2 || stage===4 || stage===6) sendChatCompletion(response,"",call("persona_feed",{inputId:"502",request},`feed-supplement-${stage}`));
    else if(stage===3) {fed();await pausedResponse;sendChatCompletion(response,"暂停前的结果。");}
    else sendChatCompletion(response,"正式结果已交付。");
  },undefined,undefined,async()=>({now:()=>now,intent:{model:"router"},modelConfiguration:{defaultModel:"local",models:[
    {alias:"local",model:"local",api:"openai-completions",baseUrl:"",apiKey:"test"},
    {alias:"router",model:"router",api:"openai-completions",baseUrl:"",apiKey:"test"},
  ]}}));
  try {
    await f.app.controlSnapshot(conversation);now+=48*60*60*1000;
    await f.bot.handleUpdate(update(501,"开始这项工作"));await started;
    const supplement=update(502,request);
    await f.bot.handleUpdate({...supplement,message:{...supplement.message,reply_to_message:{...update(98766,"ACTIVE_REPLY_REFERENCE").message,reply_to_message:undefined}}});await f.app.waitForRouting();
    release();await feedingResult;
    assert.equal((await f.app.controlSnapshot(conversation)).satiety.value,25);
    assert.match(wires[1]!,/继续做这项工作，顺便喂你一个包子/);
    assert.match(wires[1]!,/replyToMessageId[^0-9]+98766/);
    assert.match(wires[1]!,/ACTIVE_REPLY_REFERENCE/);
    await f.app.control(conversation,{type:"stop",operationId:"pause-after-feed"});
    resumeResponse();await f.flush();await f.reopen();
    await f.app.control(conversation,{type:"resume",operationId:"resume-fed-work"});await f.flush();
    assert.equal((await f.app.controlSnapshot(conversation)).satiety.value,25);
    assert.match(wires[4]!,/accepted[^a-z]+false/);
    assert.doesNotMatch(wires[4]!,/互动需要本轮用户原话/);
    await f.reopen();await f.bot.handleUpdate(update(502,request));await f.flush();
    assert.equal(stage,5);
    await f.bot.handleUpdate(update(503,"检查刚才的结果"));await f.flush();
    assert.equal((await f.app.controlSnapshot(conversation)).satiety.value,25);
    assert.match(wires.at(-1)!,/互动需要本轮用户原话/);
  } finally {release();resumeResponse();await f.close();}
});

test("only explicit collection of a referenced sticker creates a reusable deduplicated library across restart", async () => {
  let stage = 0; const wires: string[] = [];
  const f = await telegramFixture((wire,response) => {
    wires.push(JSON.stringify(wire)); stage++;
    if (stage === 1) sendChatCompletion(response,"",call("telegram_stickers",{action:"list"},"list-empty"));
    else if (stage === 3 || stage === 4) sendChatCompletion(response,"",call("telegram_stickers",{action:"collect",inputId:"21",request:"收录这个，叫它开心奶龙",reference:"reply",description:"开心奶龙"},`collect-${stage}`));
    else if (stage === 6) sendChatCompletion(response,"",call("telegram_stickers",{action:"list"},"list-saved"));
    else sendChatCompletion(response,"素材结果已核对。");
  });
  try {
    const raw = update(20,"");
    await f.bot.handleUpdate({...raw,message:{...raw.message,text:undefined,sticker}}); await f.flush();
    assert.match(wires[0]!,/unique-nailong/);
    assert.match(wires[1]!,/stickerLibrary[^]*\[\]/);
    const collect = update(21,"收录这个，叫它开心奶龙");
    await f.bot.handleUpdate({...collect,message:{...collect.message,reply_to_message:{...raw.message,text:undefined,sticker,reply_to_message:undefined}}}); await f.flush();
    await f.reopen(); await f.bot.handleUpdate(update(22,"查看已收录的素材")); await f.flush();
    const last = wires.at(-1)!;
    assert.match(last,/开心奶龙/);
    const result = JSON.parse(last).messages.filter((m:{role:string})=>m.role === "tool").at(-1);
    const text = typeof result.content === "string" ? result.content : JSON.stringify(result.content);
    const library = JSON.parse(text).stickerLibrary;
    assert.equal(library.length,1); assert.equal(library[0].id,"unique-nailong");
    assert.equal(f.sent.filter(item=>item.method === "sendSticker").length,0);
  } finally {await f.close();}
});


test("quiet mode blocks proactive media while explicit requests use authorized native sticker and reaction targets", async () => {
  let stage=0;
  const explicit="发一个开心奶龙贴纸，再给我点个👍";
  const f = await telegramFixture((_wire,response) => {
    stage++;
    if(stage===1) sendChatCompletion(response,"",call("telegram_stickers",{action:"collect",inputId:"31",request:"收录这个",reference:"reply"},"collect"));
    else if(stage===3) sendChatCompletion(response,"",call("telegram_expression",{kind:"sticker",inputId:"32",stickerId:"unique-nailong",explicit:false},"proactive"));
    else if(stage===5) sendChatCompletion(response,"",call("telegram_expression",{kind:"sticker",inputId:"33",stickerId:"unique-nailong",explicit:true,request:explicit},"sticker"));
    else if(stage===6) sendChatCompletion(response,"",call("telegram_expression",{kind:"reaction",inputId:"33",messageId:33,emoji:"👍",explicit:true,request:explicit},"reaction"));
    else if(stage===8) sendChatCompletion(response,"",call("telegram_expression",{kind:"reaction",inputId:"34",messageId:999,emoji:"👍",explicit:true,request:"给那条消息点个👍"},"wrong-target"));
    else sendChatCompletion(response,"正式结果完整交付。");
  });
  try {
    const raw=update(30,"");const collect=update(31,"收录这个");
    await f.bot.handleUpdate({...collect,message:{...collect.message,reply_to_message:{...raw.message,text:undefined,sticker,reply_to_message:undefined}}}); await f.flush();
    await f.app.control(conversation,{type:"expression",frequency:"quiet",operationId:"quiet"}); await f.reopen();
    assert.equal((await f.app.controlSnapshot(conversation)).expressionFrequency,"quiet");
    await f.bot.handleUpdate(update(32,"检查结果"));await f.flush();
    assert.equal(f.sent.filter(item=>item.method==="sendSticker").length,0);
    await f.bot.handleUpdate(update(33,explicit));await f.flush();
    const sends=f.sent.filter(item=>item.method==="sendSticker");assert.equal(sends.length,1);
    assert.equal(JSON.parse(String(sends[0]!.body)).chat_id,42);
    assert.equal(JSON.parse(String(sends[0]!.body)).sticker,"file-nailong");
    await f.bot.handleUpdate(update(34,"给那条消息点个👍"));await f.flush();
    const reactions=f.sent.filter(item=>item.method==="setMessageReaction"); assert.equal(reactions.length,1);
    assert.deepEqual(JSON.parse(String(reactions[0]!.body)),{chat_id:42,message_id:33,reaction:[{type:"emoji",emoji:"👍"}]});
    assert.equal(f.sent.filter(item=>item.method==="sendRichMessage").length,4);
  } finally {await f.close();}
});

test("feeding precision, clock rollback, reset and independent conversations preserve the same state", async () => {
  let now = Date.UTC(2026,9,19);
  const f = await telegramFixture((_wire,response)=>sendChatCompletion(response,"done"),undefined,undefined,async()=>({now:()=>now}));
  try {
    const start=now; await f.app.controlSnapshot(conversation);
    now += 16*60*60*1000;
    const boundary=await f.app.controlSnapshot(conversation);
    assert.equal(boundary.satiety.label,"饱饱的");
    now += 1;
    assert.equal((await f.app.controlSnapshot(conversation)).satiety.label,"有点馋");
    now=start+32*60*60*1000;
    assert.equal((await f.app.controlSnapshot(conversation)).satiety.label,"有点馋");
    now += 1;
    const before=(await f.app.controlSnapshot(conversation)).satiety;
    assert.equal(before.label,"肚子空空");
    for(let i=0;i<10;i++) assert.equal((await f.app.controlSnapshot(conversation)).satiety.value,before.value);
    now=start;
    assert.equal((await f.app.controlSnapshot(conversation)).satiety.value,before.value);
    await f.app.control(conversation,{type:"feed",operationId:"food"});
    assert.equal((await f.app.controlSnapshot(conversation)).satiety.value,before.value+25);
    await f.app.control(conversation,{type:"reset",operationId:"reset"});await f.flush();
    await f.reopen(); await f.app.control(conversation,{type:"feed",operationId:"food"});
    assert.equal((await f.app.controlSnapshot(conversation)).satiety.value,before.value+25);
    assert.equal((await f.app.controlSnapshot("telegram:private:43")).satiety.value,100);
    await f.app.control(conversation,{type:"expression",frequency:"quiet",operationId:"old-setting"});
    await f.app.control(conversation,{type:"expression",frequency:"lively",operationId:"new-setting"});
    await f.app.control(conversation,{type:"expression",frequency:"quiet",operationId:"old-setting"});
    assert.equal((await f.app.controlSnapshot(conversation)).expressionFrequency,"lively");
  } finally {await f.close();}
});

test("explicit sticker sets are fetched through Telegram and only collected assets can be sent", async () => {
  let stage=0;
  const f=await telegramFixture((_wire,response)=>{
    stage++;
    if(stage===1) sendChatCompletion(response,"",call("telegram_stickers",{action:"collect",inputId:"40",request:"收录贴纸包 NailongSet",reference:"set",setName:"NailongSet",description:"奶龙包"},"set"));
    else if(stage===2) sendChatCompletion(response,"",call("telegram_expression",{kind:"sticker",inputId:"40",stickerId:"unique-nailong",explicit:false},"send-collected"));
    else if(stage===3) sendChatCompletion(response,"",call("telegram_expression",{kind:"sticker",inputId:"40",stickerId:"uncollected",explicit:false},"send-invented"));
    else sendChatCompletion(response,"已处理素材与正式任务。");
  },async method=>new ApiResponse(JSON.stringify({ok:true,result:method==="getStickerSet" ? {name:"NailongSet",title:"Nailong",sticker_type:"regular",stickers:[sticker]} : {message_id:100,date:0,chat:{id:42,type:"private"}}}),{headers:{"content-type":"application/json"}}));
  try {
    await f.bot.handleUpdate(update(40,"收录贴纸包 NailongSet"));await f.flush();
    const fetches=f.sent.filter(item=>item.method==="getStickerSet");assert.equal(fetches.length,1);
    assert.equal(JSON.parse(String(fetches[0]!.body)).name,"NailongSet");
    assert.equal(f.sent.filter(item=>item.method==="sendSticker").length,1);
    assert.equal(f.sent.filter(item=>item.method==="sendRichMessage").length,1);
  }finally{await f.close();}
});


for(const failure of ["unknown","rejected","limited"] as const) test(`${failure} decorative delivery retains a receipt, never repeats the action and still delivers the formal answer`,async()=>{
  let stage=0;let sends=0;
  const f=await telegramFixture((_wire,response)=>{
    stage++;
    if(stage===1) sendChatCompletion(response,"",call("telegram_stickers",{action:"collect",inputId:"50",request:"收录这个",reference:"reply"},"collect"));
    else if(stage===2 || stage===3) sendChatCompletion(response,"",call("telegram_expression",{kind:"sticker",inputId:"50",stickerId:"unique-nailong",explicit:false},`send-${stage}`));
    else if(stage===5) sendChatCompletion(response,"",call("telegram_expression",{kind:"sticker",inputId:"51",stickerId:"unique-nailong",explicit:false},"late-retry"));
    else sendChatCompletion(response,"正式结果：任务已处理，互动发送状态单独核对。");
  },async method=>{
    if(method==="sendSticker"){
      sends++;
      if(failure==="unknown")throw new Error("ECONNRESET after possible remote acceptance");
      return new ApiResponse(JSON.stringify({ok:false,error_code:failure==="limited"?429:400,description:"decorative media rejected",...(failure==="limited"?{parameters:{retry_after:10}}:{})}),{headers:{"content-type":"application/json"}});
    }
    return new ApiResponse(JSON.stringify({ok:true,result:{message_id:100,date:0,chat:{id:42,type:"private"}}}),{headers:{"content-type":"application/json"}});
  });
  try{
    const raw=update(49,"");const collect=update(50,"收录这个");
    const message={...collect,message:{...collect.message,reply_to_message:{...raw.message,text:undefined,sticker,reply_to_message:undefined}}};
    await f.bot.handleUpdate(message);await f.flush();
    assert.equal(sends,1);assert.equal((await f.app.controlSnapshot(conversation)).status,"idle");
    assert.equal(f.sent.filter(item=>item.method==="sendRichMessage").length,1);
    const receipts=await readFile(join(f.directory,"telegram-sends.jsonl"),"utf8");
    assert.match(receipts,/"kind":"sticker"/);assert.match(receipts,new RegExp(`"status":"${failure==="unknown"?"unknown":"rejected"}"`));
    assert.match(receipts,/expression:/);
    await f.reopen();await f.bot.handleUpdate(message);await f.flush();assert.equal(sends,1);
    if(failure==="unknown"){
      await f.bot.handleUpdate(update(51,"继续说明正式结果"));await f.flush();
      assert.equal(sends,1);assert.equal((await f.app.controlSnapshot(conversation)).status,"idle");
      assert.equal(f.sent.filter(item=>item.method==="sendRichMessage").length,2);
    }
  }finally{await f.close();}
});



test("reaction selection honors Telegram emoji types and the chat's actual allowed reactions",async()=>{
  let stage=0;
  const f=await telegramFixture((_wire,response)=>{
    stage++;
    if(stage===1 || stage===3 || stage===4) sendChatCompletion(response,"",call("telegram_expression",{kind:"reaction",inputId:stage===1?"60":"61",messageId:stage===1?60:61,emoji:stage===1?"🤗":stage===3?"🍕":"👍",explicit:false},`react-${stage}`));
    else sendChatCompletion(response,"正式结果已交付。");
  },async method=>new ApiResponse(JSON.stringify({ok:true,result:method==="getChat"?{id:42,type:"private",first_name:"owner",available_reactions:[{type:"emoji",emoji:"🤗"}]}:{message_id:100,date:0,chat:{id:42,type:"private"}}}),{headers:{"content-type":"application/json"}}));
  try{
    await f.bot.handleUpdate(update(60,"谢谢你"));await f.flush();
    await f.bot.handleUpdate(update(61,"继续解释结果"));await f.flush();
    const reactions=f.sent.filter(item=>item.method==="setMessageReaction");assert.equal(reactions.length,1);
    assert.deepEqual(JSON.parse(String(reactions[0]!.body)).reaction,[{type:"emoji",emoji:"🤗"}]);
    assert.equal(f.sent.filter(item=>item.method==="sendRichMessage").length,2);
  }finally{await f.close();}
});

test("direct feeding and expression settings respond during a live model request without interrupting work",async()=>{
  let now=Date.UTC(2026,9,19);let release!:()=>void;let started!:()=>void;let requests=0;
  const modelStarted=new Promise<void>(resolve=>{started=resolve;});
  const modelGate=new Promise<void>(resolve=>{release=resolve;});
  const f=await telegramFixture(async(_wire,response)=>{requests++;started();await modelGate;sendChatCompletion(response,"计算结果：42。");},undefined,undefined,async()=>({now:()=>now}));
  try{
    await f.app.controlSnapshot(conversation);now+=48*60*60*1000;
    await f.bot.handleUpdate(update(70,"计算一个结果"));await modelStarted;
    await f.bot.handleUpdate(update(71,"/feed"));
    await f.app.control(conversation,{type:"expression",frequency:"restrained",operationId:"busy-setting"});
    const snapshot=await f.app.controlSnapshot(conversation);
    assert.equal(snapshot.satiety.value,25);assert.equal(snapshot.expressionFrequency,"restrained");assert.equal(snapshot.status,"running");
    assert.equal(requests,1);release();await f.flush();
    assert.equal((await f.app.controlSnapshot(conversation)).status,"idle");
    assert.ok(f.sent.filter(item=>item.method==="sendRichMessage").some(item=>String(item.body).includes("42")));
    await f.app.control(conversation,{type:"expression",frequency:"natural",operationId:"natural"});
    assert.equal((await f.app.controlSnapshot(conversation)).expressionFrequency,"natural");
  }finally{release();await f.close();}
});
