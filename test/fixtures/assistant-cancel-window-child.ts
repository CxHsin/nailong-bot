import { appendFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { Type } from "typebox";
import { createQueuedAssistant } from "../../src/assistant/queued-service.js";
import { createDurableExecutor, type DurableExecutorOptions } from "../../src/assistant/durable-executor.js";

const [directory,mode]=process.argv.slice(2) as [string,string];
const options=JSON.parse(await readFile(join(directory,"options.json"),"utf8")) as DurableExecutorOptions;
const durable=await createDurableExecutor({...options,tools:[{
  name:"append_result",label:"Save result",description:"Append an observable result exactly when invoked",parameters:Type.Object({file:Type.String()}),
  async execute(_id,args) {
    const file=(args as {file:string}).file;
    await appendFile(join(directory,file),"saved\n");
    return {content:[{type:"text" as const,text:`confirmed result ${file}`}],details:{}};
  },
}]});
const service=await createQueuedAssistant({dataDir:options.dataDir,startPaused:true,executor:{
  async execute(batch,context) {process.send?.({type:"batch",batch});return durable.execute(batch,context);},
  close:()=>durable.close(),
}});
process.on("message",(message)=>{
  if((message as {type?:string}).type!=="cancel")return;
  const work=service.listWorks("one").find((candidate)=>candidate.inputId==="report");
  if(!work)throw new Error("No running report target");
  service.cancelWork(work.id);
  // Intentionally stop at the public cancellation boundary before cooperative preemption.
  process.send?.({type:"cancelled"});
});
if(mode!=="recover") {
  await service.receive({conversationId:"one",inputId:"report",text:"write report.txt"});
  await service.receive({conversationId:"one",inputId:"chart",text:"write chart.txt"});
}
service.start();
await service.waitForIdle();
await service.close();
process.send?.({type:"done"});
process.disconnect?.();
