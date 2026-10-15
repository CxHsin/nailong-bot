import { join } from "node:path";
import { readFile, writeFile } from "node:fs/promises";
import { createQueuedAssistant } from "../../src/assistant/queued-service.js";

const [directory, phase] = process.argv.slice(2) as [string,string];
let backgroundStarted!:()=>void;
const backgroundReady=new Promise<void>((done)=>{backgroundStarted=done;});
const halt = async (point: string, detail?: unknown) => {
  if (phase !== point) return;
  process.send?.({ point, detail });
  await new Promise<void>(() => {});
};
const service = await createQueuedAssistant({dataDir: directory,startPaused:true,executor:{
  async execute(batch, context) {
    if(phase==="preempt-receipt"){
      context.recordSubmission("7");backgroundStarted();
      await new Promise<void>(()=>{});
    }
    await halt("claimed", batch);
    context.recordSubmission("42");
    await halt("submitted", batch);
    const path = join(directory,"confirmed-effect.json");
    let saved: {requestKey:string;count:number} | undefined;
    try {saved=JSON.parse(await readFile(path,"utf8"));} catch(error){if((error as NodeJS.ErrnoException).code!=="ENOENT")throw error;}
    if(!saved){saved={requestKey:batch.requestKey,count:1};await writeFile(path,JSON.stringify(saved));}
    await halt("effect",batch);
    return {status:"completed"};
  },
}});
if(phase==="preempt-receipt"){
  await service.receive({conversationId:"one",inputId:"background",source:"cron",priority:0,text:"old date"});
  service.start();await backgroundReady;
  await service.receive({conversationId:"one",inputId:"direct",text:"new date"});
  await halt("preempt-receipt");
}
await service.receive({conversationId:"one",inputId:"a",source:"telegram",text:"first",images:[{type:"image",mimeType:"image/png",data:"aGVsbG8="}]});
await service.receive({conversationId:"one",inputId:"b",source:"telegram",text:"second"});
await halt("received");
service.start();
await service.waitForIdle();
await service.close();
