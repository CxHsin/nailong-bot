import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fork } from "node:child_process";
import { fileURLToPath } from "node:url";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { createQueuedAssistant, type ProcessingBatch } from "../src/assistant/queued-service.js";

function deferred() { let resolve!: () => void; const promise = new Promise<void>((done) => { resolve = done; }); return { promise, resolve }; }

test("user stop persists before abort, survives late completion and restart, and allows independent work", async () => {
  const directory = await mkdtemp(join(tmpdir(), "nailong-user-stop-"));
  const started = deferred(), finish = deferred();
  let original = "";
  let service = await createQueuedAssistant({dataDir:directory, executor:{async execute(batch, context) {
    original = batch.id; context.recordSubmission("17"); started.resolve();
    await finish.promise;
    assert.equal(context.signal.reason, "user_stop");
    return {status:"completed"};
  }}});
  try {
    await service.receive({conversationId:"one",inputId:"work",text:"keep progress"}); await started.promise;
    assert.equal(service.stop("other"), false);
    assert.equal(service.stop("one"), true);
    assert.equal(service.getBatch(original)?.status, "paused", "decision is durable before abort finishes");
    finish.resolve(); await service.waitForIdle();
    assert.equal(service.getBatch(original)?.status, "paused", "late result cannot undo user stop");
    await service.close();
    const seen: ProcessingBatch[] = [];
    service = await createQueuedAssistant({dataDir:directory,executor:{async execute(batch) {seen.push(batch);return {status:"completed"};}}});
    service.start(); await service.waitForIdle(); assert.equal(seen.length, 0);
    await service.receive({conversationId:"one",inputId:"next",text:"independent request"}); await service.waitForIdle();
    assert.deepEqual(seen.map(batch => batch.events[0]!.inputId), ["next"]);
    await service.resume("one",original); await service.waitForIdle();
    assert.equal(seen[1]?.id, original); assert.equal(seen[1]?.previousSubmissionId, "17");
    assert.equal(seen[1]?.reconcile, true);
  } finally {finish.resolve();await service.close();await rm(directory,{recursive:true,force:true});}
});

test("resume during user stop waits for the interrupted executor before reopening its batch", async () => {
  const directory = await mkdtemp(join(tmpdir(), "nailong-stop-resume-"));
  const started = deferred(), finish = deferred(); let calls = 0;
  const service = await createQueuedAssistant({dataDir:directory,executor:{async execute() {
    if (++calls === 1) {started.resolve();await finish.promise;}
    return {status:"completed"};
  }}});
  try {
    await service.receive({conversationId:"one",inputId:"work",text:"work"}); await started.promise;
    service.stop("one");
    const resume = service.resume("one");
    assert.equal(calls,1);
    finish.resolve();await resume;await service.waitForIdle();
    assert.equal(calls,2);
    assert.equal(service.listBatches("one")[0]?.status,"completed");
  } finally {finish.resolve();await service.close();await rm(directory,{recursive:true,force:true});}
});

test("user stop keeps unknown external effects in needs_confirmation", async () => {
  const directory = await mkdtemp(join(tmpdir(), "nailong-stop-unknown-"));
  const started = deferred(), finish = deferred();
  const service = await createQueuedAssistant({dataDir:directory,executor:{async execute() {
    started.resolve();await finish.promise;
    return {status:"needs_confirmation",reason:"unknown_external_effect"};
  }}});
  try {
    await service.receive({conversationId:"one",inputId:"work",text:"work"});await started.promise;
    service.stop("one");finish.resolve();await service.waitForIdle();
    assert.equal(service.listBatches("one")[0]?.status,"needs_confirmation");
    assert.equal(service.listBatches("one")[0]?.reason,"unknown_external_effect");
  } finally {finish.resolve();await service.close();await rm(directory,{recursive:true,force:true});}
});

test("one queue data directory has only one live service owner", async () => {
  const directory = await mkdtemp(join(tmpdir(),"nailong-owner-"));
  const options={dataDir:directory,executor:{async execute(){return {status:"completed" as const};}}};
  const service=await createQueuedAssistant(options);
  try {await assert.rejects(createQueuedAssistant(options),/another|另一个/);}
  finally {await service.close();await rm(directory,{recursive:true,force:true});}
});

test("a crash after higher-priority receipt still reconciles the interrupted background work",{timeout:15000},async()=>{
  const directory=await mkdtemp(join(tmpdir(),"nailong-crash-preempt-"));
  const child=fork(fileURLToPath(new URL("./fixtures/assistant-queue-child.ts",import.meta.url)),[directory,"preempt-receipt"],
    {execArgv:["--import","tsx"],stdio:["ignore","ignore","pipe","ipc"]});
  let service:Awaited<ReturnType<typeof createQueuedAssistant>>|undefined;
  try{
    await once(child,"message");const exit=once(child,"exit");child.kill("SIGKILL");await exit;
    const seen:ProcessingBatch[]=[];
    service=await createQueuedAssistant({dataDir:directory,executor:{async execute(batch){seen.push(batch);return {status:"completed"};}}});
    service.start();await service.waitForIdle();
    assert.deepEqual(seen.map((batch)=>batch.events[0]!.inputId),["direct","background"]);
    assert.equal(seen[1]!.reconcile,true);assert.equal(seen[1]!.previousSubmissionId,"7");
  }finally{if(child.exitCode===null&&child.signalCode===null){const exit=once(child,"exit");child.kill("SIGKILL");await exit;}await service?.close();await rm(directory,{recursive:true,force:true});}
});

for (const phase of ["received","claimed","submitted","effect"]) {
  test(`force-kill after ${phase} retains accepted input and stable execution identity`, {timeout:15000}, async () => {
    const directory=await mkdtemp(join(tmpdir(),"nailong-crash-"));
    const child=fork(fileURLToPath(new URL("./fixtures/assistant-queue-child.ts",import.meta.url)),[directory,phase],
      {execArgv:["--import","tsx"],stdio:["ignore","ignore","pipe","ipc"]});
    let service: Awaited<ReturnType<typeof createQueuedAssistant>>|undefined;
    try {
      const [message]=await once(child,"message") as [{point:string;detail?:ProcessingBatch}];
      assert.equal(message.point,phase);
      const exit=once(child,"exit"); child.kill("SIGKILL"); await exit;
      const batches:ProcessingBatch[]=[];
      service=await createQueuedAssistant({dataDir:directory,executor:{async execute(batch,context){
        batches.push(batch);context.recordSubmission(batch.submissionId??"42");
        const effectPath=join(directory,"confirmed-effect.json");
        let saved:{requestKey:string;count:number}|undefined;
        try{saved=JSON.parse(await readFile(effectPath,"utf8"));}catch(error){if((error as NodeJS.ErrnoException).code!=="ENOENT")throw error;}
        if(saved?.requestKey!==batch.requestKey)await writeFile(effectPath,JSON.stringify({requestKey:batch.requestKey,count:(saved?.count??0)+1}));
        return {status:"completed"};
      }}});
      const input={conversationId:"one",inputId:"a",source:"telegram",text:"first"};
      assert.equal((await service.receive(input)).duplicate,true);
      service.start();await service.waitForIdle();
      assert.deepEqual(batches.flatMap((batch)=>batch.events.map((event)=>event.inputId)),["a","b"]);
      assert.equal(batches[0]!.events[0]!.images?.[0]?.data,"aGVsbG8=");
      if(message.detail){
        assert.equal(batches[0]!.id,message.detail.id);
        assert.equal(batches[0]!.requestKey,message.detail.requestKey);
      }
      if(phase==="submitted"||phase==="effect")assert.equal(batches[0]!.submissionId,"42");
      assert.equal(JSON.parse(await readFile(join(directory,"confirmed-effect.json"),"utf8")).count,1);
    } finally {if(child.exitCode===null && child.signalCode===null){const exit=once(child,"exit");child.kill("SIGKILL");await exit;}await service?.close();await rm(directory,{recursive:true,force:true});}
  });
}

test("paused work survives restart while later input runs, and resumes only on an explicit request", async () => {
  const directory=await mkdtemp(join(tmpdir(),"nailong-paused-"));
  const seen:string[]=[];let original="";let requestKey="";let resumed:ProcessingBatch|undefined;
  let service=await createQueuedAssistant({dataDir:directory,executor:{async execute(batch,context){
    original=batch.id;requestKey=batch.requestKey;context.recordSubmission("9");seen.push(batch.events[0]!.inputId);return {status:"paused",reason:"retry exhausted"};
  }}});
  try {
    await service.receive({conversationId:"one",inputId:"failed",text:"work"});await service.waitForIdle();await service.close();
    service=await createQueuedAssistant({dataDir:directory,executor:{async execute(batch){
      seen.push(batch.events[0]!.inputId);if(batch.events[0]!.inputId==="failed")resumed=batch;
      return {status:"completed"};
    }}});
    service.start();await service.waitForIdle();assert.deepEqual(seen,["failed"]);
    assert.deepEqual(service.listBatches("one",["paused"]).map((batch)=>batch.id),[original]);
    assert.equal(service.getBatch(original)?.status,"paused");
    await service.receive({conversationId:"one",inputId:"new",text:"another request"});await service.waitForIdle();
    assert.deepEqual(seen,["failed","new"]);
    await service.resume("one",original);await service.waitForIdle();assert.deepEqual(seen,["failed","new","failed"]);
    assert.equal(resumed?.id,original);assert.notEqual(resumed?.requestKey,requestKey);
    assert.equal(resumed?.previousSubmissionId,"9");assert.equal(resumed?.submissionId,undefined);
  } finally {await service.close();await rm(directory,{recursive:true,force:true});}
});

test("a blocked conversation does not block another conversation and ordinary equal priority input never aborts", async () => {
  const directory=await mkdtemp(join(tmpdir(),"nailong-isolation-"));const started=deferred();const finish=deferred();
  const seen:string[]=[];const outputs:string[]=[];let interrupted=false;
  const service=await createQueuedAssistant({dataDir:directory,executor:{async execute(batch,context){
    seen.push(`${batch.conversationId}:${batch.events[0]!.inputId}`);
    if(batch.events[0]!.inputId==="a"){started.resolve();context.signal.addEventListener("abort",()=>{interrupted=true;});await finish.promise;}
    await context.emit({conversationId:batch.conversationId,type:"text",text:batch.events[0]!.text});return {status:"completed"};
  }}});
  service.subscribe((output)=>{outputs.push(output.conversationId);});
  try {
    await service.receive({conversationId:"one",inputId:"a",text:"first"});await started.promise;
    await service.receive({conversationId:"one",inputId:"b",text:"second"});
    await service.receive({conversationId:"two",inputId:"c",text:"other conversation"});
    await new Promise<void>((resolve)=>setImmediate(resolve));
    assert.deepEqual(seen,["one:a","two:c"]);assert.equal(interrupted,false);
    finish.resolve();await service.waitForIdle();assert.deepEqual(seen,["one:a","two:c","one:b"]);
    assert.deepEqual(outputs,["two","one","one"]);
  } finally {finish.resolve();await service.close();await rm(directory,{recursive:true,force:true});}
});

test("helper results stay internal, deduplicate, and follow already queued direct input", async () => {
  const directory = await mkdtemp(join(tmpdir(), "nailong-internal-"));
  const started = deferred(); const finish = deferred(); const batches: ProcessingBatch[] = [];
  const service = await createQueuedAssistant({dataDir:directory,executor:{async execute(batch){
    batches.push(batch); if(batches.length===1){started.resolve();await finish.promise;} return {status:"completed"};
  }}});
  try {
    await service.receive({conversationId:"one",inputId:"a",text:"first"}); await started.promise;
    await service.enqueueInternal({conversationId:"one",inputId:"helper1",source:"herdr",text:"result"});
    assert.equal((await service.enqueueInternal({conversationId:"one",inputId:"helper1",source:"herdr",text:"result"})).duplicate,true);
    await service.receive({conversationId:"one",inputId:"b",text:"next"});
    finish.resolve(); await service.waitForIdle();
    assert.deepEqual(batches.map((batch)=>[batch.events[0]!.inputId,batch.events[0]!.kind]),[["a","message"],["b","message"],["helper1","internal"]]);
  } finally {finish.resolve();await service.close();await rm(directory,{recursive:true,force:true});}
});

test("direct input preempts background and reconciles saved progress under a new attempt identity", async () => {
  const directory = await mkdtemp(join(tmpdir(), "nailong-priority-"));
  const started = deferred(); const batches: ProcessingBatch[] = [];
  const service = await createQueuedAssistant({dataDir:directory, executor:{
    async execute(batch, context) {
      batches.push(batch);
      if (batches.length === 1) {
        context.recordSubmission("7"); started.resolve();
        await new Promise<void>((done) => context.signal.addEventListener("abort", () => done(), {once:true}));
        return {status:"preempted"};
      }
      return {status:"completed"};
    },
  }});
  try {
    await service.receive({conversationId:"one",inputId:"background",source:"cron",priority:0,text:"old date"});
    await started.promise;
    await service.receive({conversationId:"one",inputId:"user",text:"change the date"});
    await service.waitForIdle();
    assert.deepEqual(batches.map((batch) => batch.events[0]!.inputId),["background","user","background"]);
    assert.equal(batches[2]!.id,batches[0]!.id);
    assert.notEqual(batches[2]!.requestKey,batches[0]!.requestKey);
    assert.equal(batches[2]!.previousSubmissionId,"7");
    assert.equal(batches[2]!.reconcile,true);
  } finally {await service.close(); await rm(directory,{recursive:true,force:true});}
});

test("ordinary messages wait in FIFO snapshots without crossing command or source barriers", async () => {
  const directory = await mkdtemp(join(tmpdir(), "nailong-batch-"));
  const firstStarted = deferred(); const finishFirst = deferred();
  const secondStarted = deferred(); const finishSecond = deferred();
  const batches: ProcessingBatch[] = [];
  const service = await createQueuedAssistant({ dataDir: directory, executor: {
    async execute(batch) {
      batches.push(batch);
      if (batch.events[0]!.inputId === "a") { firstStarted.resolve(); await finishFirst.promise; }
      if (batch.events[0]!.inputId === "b") { secondStarted.resolve(); await finishSecond.promise; }
      return {status: "completed"};
    },
  } });
  try {
    const send = (inputId: string, text = inputId, source = "telegram") => service.receive({conversationId:"one", inputId, text, source, priority:100});
    await send("a"); await firstStarted.promise;
    await send("b"); await send("c");
    assert.equal(batches.length, 1);
    finishFirst.resolve(); await secondStarted.promise;
    await send("d"); await send("reset", "/reset"); await send("e"); await send("f", "f", "mail"); await send("g");
    finishSecond.resolve(); await service.waitForIdle();
    assert.deepEqual(batches.map((batch) => batch.events.map((event) => event.inputId)), [["a"],["b","c"],["d"],["reset"],["e"],["f"],["g"]]);
  } finally { finishFirst.resolve(); finishSecond.resolve(); await service.close(); await rm(directory,{recursive:true,force:true}); }
});

test("recovered work waits for subscribers and an explicit service start", async () => {
  const directory = await mkdtemp(join(tmpdir(), "nailong-start-"));
  let service = await createQueuedAssistant({dataDir:directory,startPaused:true,executor:{async execute(){throw new Error("must not run");}}});
  try {
    await service.receive({conversationId:"one",inputId:"a",text:"recover me"});
    await service.close();
    service = await createQueuedAssistant({dataDir:directory,executor:{async execute(batch, context){await context.emit({conversationId:batch.conversationId,type:"text",text:"recovered"});return {status:"completed"};}}});
    const outputs: string[] = [];
    service.subscribe((output) => { if(output.type === "text") outputs.push(output.text); });
    service.start(); await service.waitForIdle();
    assert.deepEqual(outputs,["recovered"]);
  } finally { await service.close(); await rm(directory,{recursive:true,force:true}); }
});

test("received inputs survive reopening with original identity, images and source deduplication", async () => {
  const directory = await mkdtemp(join(tmpdir(), "nailong-queue-"));
  const seen: ProcessingBatch[] = [];
  const options = { dataDir: directory, startPaused: true, executor: {
    async execute(batch: ProcessingBatch) { seen.push(batch); return { status: "completed" as const }; },
  } };
  let service = await createQueuedAssistant(options);
  try {
    const input = { conversationId: "one", inputId: "m1", source: "telegram", text: "same",
      images: [{ type: "image" as const, data: "aGVsbG8=", mimeType: "image/png" }] };
    assert.equal((await service.receive(input)).accepted, true);
    await service.close();
    service = await createQueuedAssistant({ ...options, startPaused: false });
    assert.equal((await service.receive(input)).duplicate, true);
    await service.receive({ ...input, inputId: "m2" });
    await service.waitForIdle();
    assert.deepEqual(seen.flatMap((batch) => batch.events).map((event) => [event.inputId, event.text, event.images]),
      [["m1", "same", input.images], ["m2", "same", input.images]]);
  } finally { await service.close(); await rm(directory, { recursive: true, force: true }); }
});
