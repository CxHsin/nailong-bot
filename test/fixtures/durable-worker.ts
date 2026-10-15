import { appendFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { Type } from "typebox";
import { createDurableExecutor } from "../../src/assistant/durable-executor.js";

const [directory, baseUrl, mode] = process.argv.slice(2);
if (!directory || !baseUrl || !mode) throw new Error("worker arguments missing");
const executor = await createDurableExecutor({ cwd: directory, dataDir: join(directory, "new-executions"),
  modelConfiguration: { defaultModel: "local", models: [{ alias: "local", api: "openai-completions", model: "local", apiKey: "test", baseUrl }] },
  tools: [{ name: "create_effect", label: "effect", description: "Create an external effect", parameters: Type.Object({}),
    async execute() {
      if (mode !== "not_applied") await appendFile(join(directory, "effects.txt"), "one-effect\n");
      process.send?.({ type: "effect-boundary" });
      await new Promise<void>(() => { setInterval(() => {}, 1000); });
      return { content: [{ type: "text", text: "confirmed" }], details: {} };
    } }, { name: "second_effect", label: "second", description: "A subsequent external effect", parameters: Type.Object({}),
      async execute() { await appendFile(join(directory, "second-effect.txt"), "second\n"); return { content: [{ type: "text", text: "second-confirmed" }], details: {} }; } }],
});
await executor.execute({ id: "crash-batch", requestKey: "crash-batch", conversationId: "one",
  events: [{ inputId: "original", conversationId: "one", text: "create effect" }] },
  { emit(output) { process.send?.({ type: "output", output }); }, async recordSubmission(id) {
    process.send?.({ type: mode === "admission" ? "admission" : "submission", id });
    if (mode === "admission") await new Promise<void>(() => { setInterval(() => {}, 1000); });
  } });
await executor.close();
