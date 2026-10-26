import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createAssistant } from "../src/assistant/runtime.js";
import { join } from "node:path";
import { Type } from "typebox";
import { assistantFixture, type Wire } from "./fixtures/assistant.js";
import { sendChatCompletion } from "./fixtures/chat-completion.js";

function deferred() { let resolve!: () => void; const promise = new Promise<void>((done) => {resolve=done;}); return {promise,resolve}; }

test("failed queue startup releases the service lock so corrected data can start in the same process", async () => {
  const directory = await mkdtemp(join(tmpdir(), "nailong-startup-failure-"));
  const dataDir = join(directory, "fresh");
  await mkdir(dataDir);
  const queueFile = join(dataDir, "queue.sqlite");
  await mkdir(queueFile);
  const options = { cwd: directory, dataDir,
    modelConfiguration: { defaultModel: "local", models: [{ alias: "local", api: "openai-completions" as const, model: "local", apiKey: "test", baseUrl: "http://127.0.0.1:1" }] } };
  let app: Awaited<ReturnType<typeof createAssistant>> | undefined;
  try {
    await assert.rejects(createAssistant(options), /unable to open database file/);
    await rm(queueFile, { recursive: true });
    app = await createAssistant(options);
    const replies: string[] = [];
    app.subscribe((output) => { if (output.type === "text") replies.push(output.text); });
    await app.receive({ conversationId: "one", inputId: "help", text: "/help" });
    await app.waitForIdle();
    assert.match(replies.join("\n"), /\/reset/);
  } finally { await app?.close(); await rm(directory, { recursive: true, force: true }); }
});

test("failed Magpie queue startup releases dependencies so the same directory can reopen", async () => {
  const directory = await mkdtemp(join(tmpdir(), "nailong-magpie-startup-failure-"));
  const dataDir = join(directory, "fresh");
  const configPath = join(directory, "magpie.json");
  await mkdir(dataDir);
  await writeFile(configPath, "{}");
  const queueFile = join(dataDir, "queue.sqlite");
  await mkdir(queueFile);
  const options = { cwd: directory, dataDir, magpie: { configPath } };
  let app: Awaited<ReturnType<typeof createAssistant>> | undefined;
  try {
    await assert.rejects(createAssistant(options), /unable to open database file/);
    await rm(queueFile, { recursive: true });
    app = await createAssistant(options);
    const snapshot = await app.controlSnapshot("one");
    assert.equal(snapshot.connected, false);
    assert.equal(snapshot.status, "waiting_model");
    await app.close();
    app = await createAssistant(options);
    assert.equal((await app.controlSnapshot("one")).selectedModel, undefined);
  } finally { await app?.close(); await rm(directory, { recursive: true, force: true }); }
});

test("historical model injection retains its control snapshot and rejects Magpie settings operations", async () => {
  const requests: Array<Wire & { model: string }> = [];
  const f = await assistantFixture((wire, response) => {
    requests.push(wire as typeof requests[number]);
    sendChatCompletion(response, "legacy request complete");
  });
  try {
    const snapshot = await f.app.controlSnapshot("legacy");
    assert.equal(snapshot.selectedModel, "local");
    assert.deepEqual(snapshot.catalog.map(model => [model.id, model.displayName]), [["local", "local"]]);
    assert.equal(snapshot.connected, true);
    assert.equal(snapshot.pending, false);
    for (const action of [
      { type: "model", model: "local" }, { type: "thinking", level: "high" },
      { type: "favorite", model: "local", enabled: true }, { type: "draft", enabled: false },
    ] as const) await assert.rejects(f.app.control("legacy", action), /旧主模型配置已退役/);
    assert.equal(requests.length, 0);
    await f.app.receive({ conversationId: "legacy", inputId: "work", text: "LEGACY_GOAL" });
    await f.app.waitForIdle();
    assert.deepEqual(requests.map(request => request.model), ["local"]);
  } finally { await f.close(); }
});

test("closing during settings propagation waits, preserves queued FIFO and releases dependencies for reopening", { timeout: 60_000 }, async t => {
  const entered = deferred(), release = deferred();
  const requests: Wire[] = [];
  const f = await assistantFixture((wire, response) => {
    requests.push(wire);
    sendChatCompletion(response, "restored FIFO complete");
  }, async () => ({ reportFailure() {} }), {
    catalog: [{ id: "model/A", reasoning: false }], selectedModel: null, primaryConversationId: "primary",
  });
  const originalFetch = globalThis.fetch;
  let fetchMock: ReturnType<typeof t.mock.method<typeof globalThis, "fetch">> | undefined;
  try {
    await f.app.receive({ conversationId: "primary", inputId: "first", text: "FIRST_SAVED_GOAL" });
    await f.app.receive({ conversationId: "primary", inputId: "second", text: "SECOND_SAVED_GOAL" });
    await f.app.waitForIdle();
    fetchMock = t.mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url === `${f.baseUrl}/models`) { entered.resolve(); await release.promise; }
      return originalFetch(input, init);
    });
    await f.writeMagpie({ model: "magpie/model/A" });
    const query = f.app.controlSnapshot("primary", { refresh: true }).then(() => {}, () => {});
    await entered.promise;
    let closed = false;
    const closing = f.app.close().then(() => { closed = true; });
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(closed, false, "close cannot release dependencies while the settings read is held");
    assert.equal(requests.length, 0);
    release.resolve();
    await closing;
    await query;
    assert.equal(requests.length, 0, "finishing settings during close must not wake saved work");
    fetchMock.mock.restore();
    await f.reopen();
    await f.app.waitForIdle();
    assert.equal(requests.length, 1);
    const messages = JSON.stringify(requests[0]!.messages);
    assert.ok(messages.indexOf("FIRST_SAVED_GOAL") >= 0);
    assert.ok(messages.indexOf("FIRST_SAVED_GOAL") < messages.indexOf("SECOND_SAVED_GOAL"));
  } finally { release.resolve(); fetchMock?.mock.restore(); await f.close(); }
});

test("priority preemption preserves the background generation retry budget", { timeout: 60_000 }, async () => {
  let background = 0; let direct = 0; let injected = false;
  const f = await assistantFixture((wire, response) => {
    if (JSON.stringify(wire.messages.at(-1)).includes("priority-user")) { direct++; sendChatCompletion(response, "user handled"); }
    else { background++; response.writeHead(503); response.end("temporarily unavailable"); }
  });
  f.app.subscribe(async (output) => {
    if (!injected && output.type === "text" && output.text.includes("有限重试")) {
      injected = true;
      await f.app.receive({ conversationId: "one", inputId: "user", text: "priority-user" });
    }
  });
  try {
    await f.app.receive({ conversationId: "one", inputId: "background", source: "cron", text: "original background request" });
    await f.app.waitForIdle();
    assert.equal(direct, 1); assert.equal(background, 4);
    await f.reopen(); await f.app.waitForIdle(); assert.equal(background, 4);
    await f.app.resume("one"); await f.app.waitForIdle(); assert.equal(background, 8, "explicit user resume starts a new finite budget");
  } finally { await f.close(); }
});

function waitForText(f: Awaited<ReturnType<typeof assistantFixture>>, text: string) {
  return new Promise<void>((resolve,reject)=>{
    const timer=setTimeout(()=>{unsubscribe();reject(new Error(`No output: ${text}`));},5000);
    const unsubscribe=f.app.subscribe((output)=>{if(output.type==="text"&&output.text===text){clearTimeout(timer);unsubscribe();resolve();}});
  });
}

async function helperFixture(options:{crossRead?:boolean}={}) {
  let directory="";let status="working";let results=0;let reads=0;
  const reading=deferred();const releaseRead=deferred();const inputs:string[]=[];
  const f=await assistantFixture((wire,response)=>{
    const last=JSON.stringify(wire.messages.at(-1));inputs.push(JSON.stringify(wire.messages));
    if(last.includes("herdr_result")){results++;sendChatCompletion(response,"checked helper result");}
    else if(last.includes("watch coder"))sendChatCompletion(response,"",[{index:0,id:"watch",type:"function",function:{name:"herdr_watch",arguments:JSON.stringify({session:"fixture",agent:"coder",paneId:"w1:p1",workspaceId:"w1",cwd:directory,promptPath:join(directory,"prompt.txt")})}}]);
    else sendChatCompletion(response,"ordinary reply");
  },async(cwd)=>{directory=cwd;await writeFile(join(cwd,"prompt.txt"),"inspect result.txt");return {pollMs:10,herdr:{async run(_session,args){
    if(args[1]==="read"){reads++;reading.resolve();if(options.crossRead)await releaseRead.promise;return "helper artifact, inspect result.txt";}
    return JSON.stringify({result:{agent:{name:"coder",pane_id:"w1:p1",workspace_id:"w1",cwd,agent_status:status,state_change_seq:status==="working"?1:2}}});
  }}};});
  return {...f,get app(){return f.app;},get results(){return results;},get reads(){return reads;},inputs,reading,releaseRead,done(){status="done";}};
}

test("helper result acknowledgement survives reset and reopening without reading it again",{ timeout: 60_000 },async()=>{
  const f=await helperFixture();
  try{
    await f.app.receive({conversationId:"one",inputId:"1",text:"watch coder OLD_ONLY"});await f.app.waitForIdle();
    const result=waitForText(f,"checked helper result");f.done();await result;await f.app.waitForIdle();
    await f.app.receive({conversationId:"one",inputId:"2",text:"/reset"});await f.app.waitForIdle();await f.reopen();
    await f.app.receive({conversationId:"one",inputId:"3",text:"new conversation content"});await f.app.waitForIdle();
    assert.equal(f.results,1);assert.equal(f.reads,1);assert.doesNotMatch(f.inputs.at(-1)!,/OLD_ONLY/);
  }finally{f.releaseRead.resolve();await f.close();}
});

test("a helper read crossing reset returns internal material to the new context once",{ timeout: 60_000 },async()=>{
  const f=await helperFixture({crossRead:true});
  try{
    await f.app.receive({conversationId:"one",inputId:"1",text:"watch coder OLD_ONLY"});await f.app.waitForIdle();
    f.done();await f.reading.promise;
    await f.app.receive({conversationId:"one",inputId:"2",text:"/reset"});await f.app.waitForIdle();
    const result=waitForText(f,"checked helper result");f.releaseRead.resolve();await result;await f.app.waitForIdle();
    assert.equal(f.results,1);assert.doesNotMatch(f.inputs.at(-1)!,/OLD_ONLY/);
  }finally{f.releaseRead.resolve();await f.close();}
});

test("a running helper survives service restart and does not block ordinary discussion",{ timeout: 60_000 },async()=>{
  const f=await helperFixture();
  try{
    await f.app.receive({conversationId:"one",inputId:"1",text:"watch coder"});await f.app.waitForIdle();
    await f.app.receive({conversationId:"one",inputId:"2",text:"unrelated discussion"});await f.app.waitForIdle();
    assert.equal(f.results,0);assert.equal(f.outputs.filter((out)=>out.type==="text"&&out.text==="ordinary reply").length,2);
    await f.reopen();const result=waitForText(f,"checked helper result");f.done();await result;await f.app.waitForIdle();
    assert.equal(f.results,1);assert.equal(f.reads,1);
    assert.equal(f.outputs.filter((out)=>out.type==="text"&&out.text.includes("helper artifact")).length,0);
  }finally{f.releaseRead.resolve();await f.close();}
});

test("assistant writes a real artifact and deduplicates source identity after reopening",{ timeout: 60_000 },async()=>{
  let writes=0;const inputs:string[]=[];
  const f=await assistantFixture((wire,response)=>{
    const last=wire.messages.at(-1)!;inputs.push(JSON.stringify(wire.messages));
    assert.ok(wire.tools.some((tool)=>tool.function.name==="write"));
    assert.ok(!wire.tools.some((tool)=>tool.function.name==="complete_work"));
    if(last.role==="user"&&JSON.stringify(last.content).includes("remember lotus")){
      writes++;sendChatCompletion(response,"",[{index:0,id:"write",type:"function",function:{name:"write",arguments:'{"path":"note.txt","content":"lotus"}'}}]);
    }else sendChatCompletion(response,"lotus saved");
  });
  try{
    const input={conversationId:"one",inputId:"1",text:"remember lotus"};
    await f.app.receive(input);await f.app.waitForIdle();assert.equal(await readFile(join(f.directory,"note.txt"),"utf8"),"lotus");
    await f.reopen();await f.app.receive(input);await f.app.receive({conversationId:"one",inputId:"2",text:"what name?"});await f.app.waitForIdle();
    assert.equal(writes,1);assert.match(inputs.at(-1)!,/remember lotus/);
    assert.deepEqual(f.outputs.filter((out)=>out.type==="text").map((out)=>out.text),["lotus saved","lotus saved"]);
  }finally{await f.close();}
});

test("project instructions, skills and configured tools load and tool errors return to the model",{ timeout: 60_000 },async()=>{
  const seen:string[]=[];
  const f=await assistantFixture((wire,response)=>{
    seen.push(JSON.stringify(wire.messages));
    if(wire.messages.at(-1)!.role!=="tool")sendChatCompletion(response,"",[{index:0,id:"failure",type:"function",function:{name:"fixture_failure",arguments:"{}"}}]);
    else sendChatCompletion(response,"explained failure");
  },async(directory)=>{
    await mkdir(join(directory,".pi","skills","fixture"),{recursive:true});
    await writeFile(join(directory,".pi","skills","fixture","SKILL.md"),"---\nname: fixture\ndescription: FIXTURE_SKILL_DISCOVERY\n---\nUse for fixture work.");
    await writeFile(join(directory,"AGENTS.md"),"FIXTURE_PROJECT_RULE");
    return {tools:[{name:"fixture_failure",label:"failure",description:"fixture",parameters:Type.Object({}),async execute(){throw new Error("fixture tool failed");}}]};
  });
  try{
    await f.app.receive({conversationId:"one",inputId:"1",text:"try fixture"});await f.app.waitForIdle();
    assert.match(seen[0]!,/FIXTURE_SKILL_DISCOVERY/);assert.match(seen[0]!,/FIXTURE_PROJECT_RULE/);assert.match(seen.at(-1)!,/fixture tool failed/);
    const lastOutput=f.outputs.at(-1);
    assert.equal(lastOutput?.type==="text"&&lastOutput.text,"explained failure");
  }finally{await f.close();}
});
