import { readFile, appendFile } from "node:fs/promises";
import { join } from "node:path";
import { createAssistant, type AssistantOptions } from "../../src/assistant/runtime.js";

const [directory, phase] = process.argv.slice(2) as [string,string];
const options = JSON.parse(await readFile(join(directory,"options.json"),"utf8")) as AssistantOptions;
const app = await createAssistant(options);
process.on("message",async(message)=>{
  if((message as {type?:string}).type!=="steer")return;
  await app.receive({conversationId:"one",inputId:"supplement",source:"telegram",text:"/steer amend date Thursday"});
  process.send?.({type:"steer-admitted"});
});
app.subscribe(async (output) => {
  await appendFile(join(directory,"delivered.jsonl"),JSON.stringify(output)+"\n");
  process.send?.({type:"output",output});
  if (phase === "output") await new Promise<void>(()=>{});
});
if (phase !== "recover") await app.receive({conversationId:"one",inputId:"original",text:"write original result"});
await app.waitForIdle();
await app.close();
process.send?.({type:"done"});
process.disconnect?.();
