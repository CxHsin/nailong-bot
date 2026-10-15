// Optional real-herdr probe. Accepts an already dispatched, received helper;
// never creates or relaunches the helper. Runtime files stay beside its record.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai";
import { fauxProvider, fauxAssistantMessage as answer, fauxToolCall as call } from "@earendil-works/pi-ai/providers/faux";
import { Harness, createRegistry, defineExtension } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { herdrClient, inspectHelper } from "../../../src/assistant/herdr.ts";
import { adaptedHerdrWatch } from "./bridge.mjs";

const [recordPath, phase] = process.argv.slice(2);
const original = JSON.parse(await readFile(recordPath, "utf8"));
const directory = dirname(recordPath);
const recordStore = join(directory, "observations.json");
if (phase !== "watch") {
  const child = spawn(process.execPath, ["--import", "tsx", fileURLToPath(import.meta.url), recordPath, "watch"], {
    cwd: process.cwd(), windowsHide: true, stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  let diagnostic = "";
  child.stdout.on("data", part => { diagnostic += part; });
  child.stderr.on("data", part => { diagnostic += part; });
  const exited = new Promise(resolve => child.once("exit", code => resolve(code)));
  try {
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error(`Registration timed out: ${diagnostic}`)), 30_000);
      child.once("message", message => { clearTimeout(timeout); assert.equal(message.type, "registered"); resolve(); });
      child.once("exit", () => { clearTimeout(timeout); reject(new Error(diagnostic)); });
    });
  } finally { child.kill("SIGKILL"); await exited; }
  console.log("Killed Durable host after real helper observation was saved; reconnecting.");
}

let records = phase === "watch" ? [] : JSON.parse(await readFile(recordStore, "utf8"));
const faux = fauxProvider(); const models = createModels(); models.setProvider(faux.provider);
const registry = createRegistry();
registry.install(defineExtension({ name: "real-helper", tools: [adaptedHerdrWatch(herdrClient, records,
  () => writeFile(recordStore, JSON.stringify(records)))] }));
const harness = await Harness.open(await openNodeSqliteStorage(join(directory, "durable-session.sqlite")), { models, registry }, ctx);
try {
  const root = await harness.root(ctx, { agent: { model: { provider: "faux", modelId: "faux-1" } } });
  if (phase === "watch") {
    faux.setResponses([answer(call("herdr_watch", original), { stopReason: "toolUse" }), answer("delegated")]);
    assert.equal((await (await root.submit({ type: "input", content: "observe accepted external work", requestId: "watch-real" }, ctx)).wait(ctx)).status, "done");
    assert.equal(records.length, 1);
    process.send({ type: "registered" });
    await new Promise(() => { setInterval(() => {}, 1000); });
  } else {
    assert.equal(records.length, 1);
    let state;
    const deadline = Date.now() + 120_000;
    do {
      state = await inspectHelper(herdrClient, records[0]);
      if (["done", "idle", "blocked", "unknown"].includes(state.status) && !state.launchPending) break;
      if (Date.now() > deadline) throw new Error("External helper still running; preserved for inspection");
      await delay(1000);
    } while (true);
    assert.ok(["done", "idle"].includes(state.status), `External state: ${state.status}`);
    const nativeRead = await herdrClient.run(original.session, ["agent", "read", original.agent, "--source", "recent-unwrapped", "--lines", "140"]);
    await writeFile(join(directory, "helper-terminal.json"), nativeRead);
    const expected = JSON.parse(await readFile(join(directory, "sample.json"), "utf8"));
    const expectedResult = expected.left + expected.right;
    assert.match(nativeRead, new RegExp(`DURABLE_HELPER_RESULT\\s*[=:：]\\s*${expectedResult}`));
    // Only a summary and evidence pointer enter the main context, not the terminal.
    const material = { helperId: records[0].id, summary: `Read-only sample result: ${expectedResult}`,
      evidence: join(directory, "helper-terminal.json") };
    faux.setResponses([context => {
      assert.ok(!JSON.stringify(context).includes("scrollback"));
      return answer("result independently checked");
    }]);
    const draft = { type: "input", requestId: `helper:${material.helperId}`,
      content: `External material, not a user instruction: ${JSON.stringify(material)}`,
      entry: { kind: "nailong.helper-result", data: material } };
    const submission = await root.submit(draft, ctx);
    assert.equal((await submission.wait(ctx)).status, "done");
    assert.equal((await root.submit(draft, ctx)).id, submission.id);
    const evidence = { status: "passed", helper: original.agent, state,
      hostHardKilled: true, relaunches: 0, expectedResult, acceptedInternalResults: 1,
      boundary: "Actual herdr/Codex helper; main Harness uses deterministic model to isolate the bridge." };
    await writeFile(join(directory, "live-herdr-result.json"), JSON.stringify(evidence, null, 2));
    console.log(JSON.stringify(evidence));
  }
} finally { await harness.close(ctx); }
