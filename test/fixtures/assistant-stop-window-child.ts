import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createAssistant } from "../../src/assistant/runtime.js";

const directory = process.argv[2]!;
const app = await createAssistant(JSON.parse(await readFile(join(directory,"options.json"),"utf8")));
app.subscribe(() => {});
if(process.argv[3]==="history"){
  await app.receive({conversationId:"one",inputId:"history",text:"HISTORICAL_COMPLETED_GOAL"});
  await app.waitForIdle();
}
const abort = AbortController.prototype.abort;
AbortController.prototype.abort = function(reason) {
  if (reason === "user_stop") {
    process.send?.({type:"persisted"});
    // Hold this exact crash window: queue committed, native abort not yet delivered.
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0);
  }
  abort.call(this,reason);
};
process.on("message", async () => {
  await app.receive({conversationId:"one",inputId:"stop",text:"/stop"});
});
await app.receive({conversationId:"one",inputId:"work",text:"PERSISTED_STOP_GOAL"});
