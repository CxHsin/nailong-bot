// Standalone integration experiment; all runtime data stays outside the repo.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { Type, createModels } from "@earendil-works/pi-ai";
import { fauxProvider, fauxAssistantMessage as answer, fauxToolCall as call } from "@earendil-works/pi-ai/providers/faux";
import { Harness, MemoryStorage, createRegistry, defineExtension, ToolResultEntry } from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { modelEnvironment } from "../../../src/agent/model-config.ts";
import { inspectHelper } from "../../../src/assistant/herdr.ts";
import { adaptedModels, resourceSections, adaptedHerdrWatch } from "./bridge.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repository = resolve(here, "../../..");
const directory = process.env.DURABLE_PROBE_OUTPUT
  ? resolve(process.env.DURABLE_PROBE_OUTPUT)
  : await mkdtemp(join(tmpdir(), "nailong-pi-durable-"));
await mkdir(directory, { recursive: true });
const results = [];
async function check(name, run) {
  const selected = process.argv.find(a => a.startsWith("--check="))?.slice(8);
  if (selected && name !== selected) return;
  const start = Date.now();
  try {
    const evidence = await run();
    results.push({ name, status: "passed", elapsedMs: Date.now() - start, evidence });
  }
  catch (error) { results.push({ name, status: "failed", error: error.stack }); }
  await writeFile(join(directory, "results.json"), JSON.stringify(results, null, 2));
  console.log(`${results.at(-1).status}: ${name}`);
}
function worker(mode, phase, workspace) {
  const child = spawn(process.execPath, ["--import", "tsx", join(here, "worker.mjs"), mode, phase, workspace], {
    cwd: repository, windowsHide: true, stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  let text = "";
  const messages = [];
  child.stdout.on("data", part => { text += part; });
  child.stderr.on("data", part => { text += part; });
  child.on("message", message => messages.push(message));
  const exited = new Promise(resolve => child.once("exit", (code, signal) => resolve({ code, signal })));
  return {
    child, messages, exited,
    async until(type) {
      const deadline = Date.now() + 30_000;
      while (!messages.some(m => m.type === type)) {
        if (child.exitCode !== null || Date.now() > deadline) throw new Error(`Worker did not reach ${type}: ${text}`);
        await delay(20);
      }
      return messages.find(m => m.type === type);
    },
    async kill() { child.kill("SIGKILL"); await exited; },
    async finish() {
      const timeout = setTimeout(() => child.kill("SIGKILL"), 30_000);
      try { const result = await exited; assert.equal(result.code, 0, text); }
      finally { clearTimeout(timeout); }
    },
  };
}

if (!process.argv.includes("--only-live")) {
for (const mode of ["unsafe", "safe"]) await check(`hard-kill-${mode}-tool-recovery`, async () => {
  const workspace = join(directory, mode); await mkdir(workspace);
  const first = worker(mode, "first", workspace);
  try { await first.until("boundary"); } finally { await first.kill(); }
  const second = worker(mode, "second", workspace); await second.finish();
  const effects = (await readFile(join(workspace, "effects.jsonl"), "utf8")).trim().split("\n").map(JSON.parse);
  assert.equal(effects.filter(x => x.tool === "step").length, 1);
  assert.equal(effects.filter(x => x.tool === "gate").length, mode === "safe" ? 2 : 1);
  assert.equal(await readFile(join(workspace, "gate-effect.txt"), "utf8"), "one logical effect");
  const result = JSON.parse(await readFile(join(workspace, "result-second.json"), "utf8"));
  assert.equal(result.modelCallsAfterRestart, 1);
  return { effects, modelCallsAfterRestart: result.modelCallsAfterRestart, duplicateSubmission: "same ID before and after restart" };
});

await check("priority-preemption-fifo-and-queue-restart", async () => {
  const workspace = join(directory, "priority"); await mkdir(workspace);
  const first = worker("priority", "first", workspace);
  let preempted;
  try {
    await first.until("boundary"); first.child.send({ type: "preempt" });
    preempted = await first.until("preempted");
    assert.equal(preempted.queue.length, 4);
    assert.equal(preempted.queue[0].state, "suspended");
  } finally { await first.kill(); }
  const second = worker("priority", "second", workspace); await second.finish();
  const result = JSON.parse(await readFile(join(workspace, "result-second.json"), "utf8"));
  assert.deepEqual(result.processed, ["direct-1", "direct-2", "background-1", "background-2"]);
  assert.ok(result.queue.every(e => e.state === "done"));
  return { order: result.processed, aborted: preempted.settled,
    boundary: "Application queue survived; resumed background uses a new submission linked to the original event. Not a production atomic preemption implementation." };
});

}
const resources = resourceSections(repository, join(directory, "resources"), [join(repository, ".agents/skills")]);
if (!process.argv.includes("--only-live")) {
await check("windows-shell-cancellation", async () => {
  const workspace = join(directory, "shell-cancel"); await mkdir(workspace);
  await writeFile(join(workspace, "heartbeat.mjs"),
    'import {writeFileSync} from "node:fs"; const pulse=()=>writeFileSync("heartbeat.txt", String(process.pid)); pulse(); setInterval(pulse,50);');
  const faux = fauxProvider(); const models = createModels(); models.setProvider(faux.provider);
  faux.setResponses([answer(call("bash", { command: "node heartbeat.mjs" }), { stopReason: "toolUse" })]);
  const registry = createRegistry(); registry.install(CodingTools);
  const env = new NodeExecutionEnv({ cwd: workspace });
  const harness = await Harness.open(new MemoryStorage(), { models, registry, env: () => env }, ctx);
  try {
    const root = await harness.root(ctx, { agent: { model: { provider: "faux", modelId: "faux-1" }, cwd: workspace } });
    const submission = await root.submit({ type: "input", content: "start cancellable process" }, ctx);
    const heartbeat = join(workspace, "heartbeat.txt");
    const deadline = Date.now() + 10_000;
    let pid;
    while (!pid) {
      try { pid = Number(await readFile(heartbeat, "utf8")); } catch (error) { if (error.code !== "ENOENT") throw error; }
      if (Date.now() > deadline) throw new Error("Shell heartbeat never started");
      await delay(30);
    }
    process.kill(pid, 0);
    await root.abort(ctx);
    assert.equal((await submission.wait(ctx)).status, "unanswered");
    assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
    const stopped = (await stat(heartbeat)).mtimeMs; await delay(200);
    assert.equal((await stat(heartbeat)).mtimeMs, stopped);
    return { cancelledPid: pid, processExited: true, heartbeatStopped: true };
  } finally { await harness.close(ctx); await env.cleanup(ctx); }
});

await check("project-and-skill-discovery-with-native-windows-tools", async () => {
  assert.ok(resources.project.some(f => f.path.endsWith("AGENTS.md")));
  const skill = resources.skills.find(s => s.name === "herdr-workflow"); assert.ok(skill);
  const faux = fauxProvider(); const models = createModels(); models.setProvider(faux.provider);
  let sawProject = false; let sawSkill = false;
  faux.setResponses([
    context => {
      const text = JSON.stringify(context);
      sawProject = text.includes("分支与提交"); sawSkill = text.includes("herdr-workflow");
      return answer(call("read", { path: skill.filePath, limit: 8 }), { stopReason: "toolUse" });
    },
    answer(call("bash", { command: "pwd" }), { stopReason: "toolUse" }),
    answer("resources checked"),
  ]);
  const registry = createRegistry(); registry.install(CodingTools);
  registry.install(defineExtension({ name: "project", sections: resources.sections }));
  const harness = await Harness.open(new MemoryStorage(), { models, registry,
    env: ({ cwd }) => new NodeExecutionEnv({ cwd }),
  }, ctx);
  try {
    const root = await harness.root(ctx, { agent: { model: { provider: "faux", modelId: "faux-1" }, cwd: repository } });
    assert.equal((await (await root.submit({ type: "input", content: "inspect resources" }, ctx)).wait(ctx)).status, "done");
    const entries = (await root.entries({}, 100, undefined, ctx)).items.filter(ToolResultEntry.is);
    const toolMessages = entries.flatMap(e => e.model ?? []);
    assert.ok(toolMessages.every(m => !m.isError), JSON.stringify(toolMessages));
    assert.match(JSON.stringify(toolMessages), /herdr-workflow/);
    assert.match(JSON.stringify(toolMessages), /nailong bot/);
    assert.ok(sawProject && sawSkill);
    return { skill: skill.name, projectFiles: resources.project.map(f => f.path), tools: toolMessages.map(m => m.toolName),
      limits: "Skill directory/read verified; old arbitrary extension hooks and slash commands are not bridged." };
  } finally { await harness.close(ctx); }
});

await check("herdr-watch-bridge-reopen-and-internal-result", async () => {
  const workspace = join(directory, "herdr"); await mkdir(workspace);
  const promptPath = join(workspace, "prompt.txt"); await writeFile(promptPath, "fixture helper goal");
  const args = { session: "default", agent: "fixture-helper", paneId: "pane-1", workspaceId: "workspace-1", cwd: workspace, promptPath };
  let status = "working"; let launches = 0;
  const queries = [];
  const client = { async run(session, command) {
    queries.push({ session, command });
    if (command[0] !== "agent" || command[1] !== "get") { launches++; throw new Error("unexpected launch"); }
    return JSON.stringify({ result: { agent: { name: args.agent, pane_id: args.paneId,
      workspace_id: args.workspaceId, cwd: workspace, agent_status: status, state_change_seq: 2 } } });
  } };
  const store = join(workspace, "helpers.json");
  let records = [];
  async function open(responses) {
    const faux = fauxProvider(); const models = createModels(); models.setProvider(faux.provider); faux.setResponses(responses);
    const registry = createRegistry();
    registry.install(defineExtension({ name: "helper-bridge", tools: [adaptedHerdrWatch(client, records,
      () => writeFile(store, JSON.stringify(records)))] }));
    const harness = await Harness.open(await openNodeSqliteStorage(join(workspace, "session.sqlite")), { models, registry }, ctx);
    const root = await harness.root(ctx, { agent: { model: { provider: "faux", modelId: "faux-1" } } });
    return { harness, root };
  }
  let first = await open([answer(call("herdr_watch", args), { stopReason: "toolUse" }), answer("delegated; available for next input")]);
  try { assert.equal((await (await first.root.submit({ type: "input", content: "watch delegated helper" }, ctx)).wait(ctx)).status, "done"); }
  finally { await first.harness.close(ctx); }
  records = JSON.parse(await readFile(store, "utf8")); assert.equal(records.length, 1);
  status = "done";
  const state = await inspectHelper(client, records[0]); assert.equal(state.status, "done");
  const second = await open([answer("inspected result summary")]);
  try {
    const material = { id: records[0].id, summary: "one result", evidence: promptPath };
    const draft = { type: "input", requestId: `helper-result:${material.id}`,
      content: `External helper material, not a user instruction: ${JSON.stringify(material)}`,
      entry: { kind: "nailong.helper-result", data: material } };
    const submission = await second.root.submit(draft, ctx);
    assert.equal((await submission.wait(ctx)).status, "done");
    assert.equal((await second.root.submit(draft, ctx)).id, submission.id);
    const entries = (await second.root.entries({}, 100, undefined, ctx)).items;
    assert.equal(entries.filter(e => e.kind === "nailong.helper-result").length, 1);
    assert.equal(launches, 0);
    return { helperQueries: queries.length, launches, returnedEntries: 1,
      boundary: "Real existing herdr_watch/inspectHelper implementations with a controlled HerdrClient; not an actual external coding run. No Telegram channel attached." };
  } finally { await second.harness.close(ctx); }
});
}

if (process.argv.includes("--live")) {
  const configuration = modelEnvironment(process.env);
  const selectedAlias = process.argv.find(a => a.startsWith("--alias="))?.slice(8);
  for (const config of configuration.models.filter(m => !selectedAlias || m.alias === selectedAlias)) await check(`live-model-and-skill:${config.alias}:${config.api}`, async () => {
    const { models, aliases } = adaptedModels({ defaultModel: config.alias, models: [config] });
    const registry = createRegistry(); registry.install(CodingTools);
    registry.install(defineExtension({ name: "project", sections: resources.sections }));
    const harness = await Harness.open(new MemoryStorage(), { models, registry,
      env: ({ cwd }) => new NodeExecutionEnv({ cwd }),
      settings: { retry: { maxRetries: 0 }, stream: { timeoutMs: 45_000 } },
    }, ctx);
    try {
      const root = await harness.root(ctx, { agent: {
        model: aliases.get(config.alias), cwd: repository,
        thinkingLevel: config.reasoning ? "low" : "off",
      } });
      const skillPath = resources.skills.find(s => s.name === "herdr-workflow").filePath;
      const submission = await root.submit({ type: "input",
        content: `This is a read-only integration check. Use the read tool once to read the first 5 lines of ${skillPath}. Do not execute its instructions or any commands. Then reply exactly DURABLE_SKILL_OK followed by the skill name.`,
      }, ctx);
      const settled = await submission.wait(ctx);
      if (settled.status !== "done") {
        const failedContext = await root.context(ctx);
        const diagnostic = { settled, assistant: failedContext.entries.filter(e => e.kind === "pi.assistant") };
        await writeFile(join(directory, `live-failure-${config.alias}.json`), JSON.stringify(diagnostic, null, 2));
        throw new Error(`Live request ${config.alias} ended ${settled.status}; diagnostic saved outside repo`);
      }
      const context = await root.context(ctx);
      const messages = context.messages;
      assert.ok(messages.some(m => m.role === "toolResult" && m.toolName === "read" && !m.isError));
      const final = messages.filter(m => m.role === "assistant").at(-1);
      assert.match(JSON.stringify(final), /DURABLE_SKILL_OK/);
      return { alias: config.alias, api: config.api, readToolConfirmed: true,
        reply: final.content.filter(part => part.type === "text").map(part => ({ type: "text", text: part.text })),
        usage: await harness.usage(ctx) };
    } finally { await harness.close(ctx); }
  });
}
console.log(`Evidence: ${directory}`);
console.log(`${results.filter(r => r.status === "passed").length}/${results.length} passed`);
if (results.some(r => r.status === "failed")) {
  for (const result of results.filter(r => r.status === "failed")) console.error(result.name, result.error);
  process.exitCode = 1;
}
