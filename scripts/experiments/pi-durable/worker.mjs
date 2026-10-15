// Child process used for actual hard-kill/reopen experiments.
import assert from "node:assert/strict";
import { appendFile, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { Type, createModels } from "@earendil-works/pi-ai";
import { fauxProvider, fauxAssistantMessage as answer, fauxToolCall as call } from "@earendil-works/pi-ai/providers/faux";
import { Harness, createRegistry, defineExtension, defineTool } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { openQueue } from "./queue.mjs";

const [mode, phase, directory] = process.argv.slice(2);
const send = value => process.send?.(value);
const log = async value => appendFile(join(directory, "effects.jsonl"), JSON.stringify(value) + "\n");
const output = text => ({ output: [{ type: "text", text }] });
const faux = fauxProvider();
const models = createModels(); models.setProvider(faux.provider);
const registry = createRegistry();
const resultPath = join(directory, `result-${phase}.json`);
const gate = defineTool({
  name: "gate", description: "Wait at the crash boundary", parameters: Type.Object({}),
  replay: mode === "safe" ? "safe" : "unsafe",
  async execute(_args, _api, context) {
    await log({ tool: "gate", phase });
    // Replacing the same file is the safe operation; the log counts invocations.
    await writeFile(join(directory, "gate-effect.txt"), "one logical effect");
    if (phase === "first") {
      send({ type: "boundary" });
      await new Promise((resolve, reject) => {
        const timer = setInterval(() => {}, 1000);
        context.abortSignal.addEventListener("abort", () => {
          clearInterval(timer); reject(new Error("probe cancelled"));
        }, { once: true });
      });
    }
    return output("gate confirmed");
  },
});
const step = defineTool({
  name: "step", description: "A completed operation", parameters: Type.Object({}), replay: "unsafe",
  async execute() { await log({ tool: "step", phase }); return output("completed-result-42"); },
});
registry.install(defineExtension({ name: "crash-probe", tools: [step, gate] }));
const harness = await Harness.open(await openNodeSqliteStorage(join(directory, "session.sqlite")), {
  models, registry, settings: { retry: { maxRetries: 0 }, toolExecution: "sequential" },
}, ctx);
const root = await harness.root(ctx, { agent: { model: { provider: "faux", modelId: "faux-1" }, cwd: directory } });

try {
  if (mode === "priority") {
    const queue = openQueue(join(directory, "queue.sqlite"));
    try {
      if (phase === "first") {
        queue.admit("background-1", 0, "background-1");
        queue.admit("background-2", 0, "background-2");
        faux.setResponses([answer(call("gate", {}), { stopReason: "toolUse" })]);
        const event = queue.start(queue.next().id);
        const submission = await root.submit({ type: "input", content: event.body,
          requestId: `${event.id}:${event.attempt}`, whenBusy: "reject" }, ctx);
        process.on("message", async message => {
          if (message.type !== "preempt") return;
          queue.admit("direct-1", 10, "direct-1");
          queue.admit("direct-2", 10, "direct-2");
          queue.admit("direct-1", 10, "duplicate must be ignored");
          await root.abort(ctx);
          queue.state(event.id, "suspended");
          const settled = await submission.wait(ctx);
          send({ type: "preempted", queue: queue.all(), settled });
        });
        // Parent kills this process after preemption was committed.
        await new Promise(() => { setInterval(() => {}, 1000); });
      } else {
        const processed = [];
        faux.setResponses(Array.from({ length: 4 }, () => answer("handled")));
        for (let event; (event = queue.next());) {
          event = queue.start(event.id);
          const submission = await root.submit({ type: "input", content: event.body,
            requestId: `${event.id}:${event.attempt}`, whenBusy: "reject" }, ctx);
          assert.equal((await submission.wait(ctx)).status, "done");
          processed.push(event.id); queue.state(event.id, "done");
        }
        await writeFile(resultPath, JSON.stringify({ processed, queue: queue.all(), context: await root.context(ctx) }));
      }
    } finally { queue.close(); }
  } else {
    if (phase === "first") {
      faux.setResponses([
        answer(call("step", {}), { stopReason: "toolUse" }),
        answer(call("gate", {}), { stopReason: "toolUse" }),
      ]);
      const submission = await root.submit({ type: "input", content: "finish both steps", requestId: "event-1" }, ctx);
      const duplicate = await root.submit({ type: "input", content: "finish both steps", requestId: "event-1" }, ctx);
      assert.equal(duplicate.id, submission.id);
      await writeFile(join(directory, "submission.json"), JSON.stringify({ id: submission.id, conversationId: root.id }));
      await submission.wait(ctx);
    } else {
      faux.setResponses([(context) => {
        const results = context.messages.filter(m => m.role === "toolResult");
        assert.ok(results.some(m => m.toolName === "step" && JSON.stringify(m.content).includes("completed-result-42")));
        const gateResult = results.find(m => m.toolName === "gate");
        assert.ok(gateResult);
        assert.equal(gateResult.isError, mode !== "safe");
        if (mode !== "safe") assert.match(JSON.stringify(gateResult), /interrupt/i);
        return answer("recovered");
      }]);
      const saved = JSON.parse(await readFile(join(directory, "submission.json"), "utf8"));
      assert.equal(saved.conversationId, root.id);
      const submission = await harness.submission(saved.id, ctx);
      assert.equal((await submission.wait(ctx)).status, "done");
      const duplicate = await root.submit({ type: "input", content: "finish both steps", requestId: "event-1" }, ctx);
      assert.equal(duplicate.id, saved.id);
      await writeFile(resultPath, JSON.stringify({ context: await root.context(ctx), modelCallsAfterRestart: faux.state.callCount }));
    }
  }
} finally { await harness.close(ctx); }
send({ type: "done" });
process.disconnect?.();
