import { readFile, appendFile } from "node:fs/promises";
import { join } from "node:path";
import { createAssistant, type AssistantOptions } from "../../src/assistant/runtime.js";

const [directory, mode] = process.argv.slice(2) as [string,string];
const configuration = JSON.parse(await readFile(join(directory,"routing-options.json"),"utf8")) as {
  options: AssistantOptions; scenario: "raw" | "decision" | "sending"; endpoint: string;
};
const input = configuration.scenario === "raw"
  ? {conversationId:"one",inputId:"raw-original",source:"telegram",text:"write raw-result.txt exactly once",replyToMessageId:"original-reply",userText:"write raw-result.txt exactly once"}
  : {conversationId:"one",inputId:"helper-supplement",source:"telegram",text:"helper supplement: CSV, preserve original data"};
const app = await createAssistant({...configuration.options, herdr:{async run(session,args) {
  const response=await fetch(`${configuration.endpoint}/herdr`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({session,args})});
  if(!response.ok) throw new Error(`controlled herdr failed: ${response.status}`);
  return response.text();
}}});
app.subscribe(async(output)=>{
  await appendFile(join(directory,"routing-delivered.jsonl"),JSON.stringify(output)+"\n");
  process.send?.({type:"output",output});
});
if(mode!=="recover" && configuration.scenario!=="raw") {
  await app.receive({conversationId:"one",inputId:"register-helper",text:"register helper"});
  await app.waitForIdle();
  process.send?.({type:"registered"});
}
await app.receive(input);
process.send?.({type:"received",raw:app.routingStatus("one").pending.find((route)=>route.input.inputId===input.inputId)?.input});
await app.waitForIdle();
process.send?.({type:"settled",input:app.routingStatus("one").works.find((work)=>work.inputId===input.inputId)?.input});
await app.close();
process.send?.({type:"done"});
process.disconnect?.();
