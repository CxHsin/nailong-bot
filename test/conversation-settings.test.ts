import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createConversationSettings } from "../src/assistant/conversation-settings.js";
import { createMagpieControl } from "../src/assistant/magpie.js";
import type { DurableExecutor } from "../src/assistant/durable-executor.js";

function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
const turn = () => new Promise<void>(resolve => setImmediate(resolve));

// The spec permits delaying this existing Durable capability without changing Assistant's API.
// Magpie's HTTP, configuration file and SQLite persistence remain real.
async function settingsFixture(configureModel: DurableExecutor["configureModel"]) {
  const directory = await mkdtemp(join(tmpdir(), "nailong-settings-"));
  const dataDir = join(directory, "fresh");
  const configPath = join(directory, "magpie.json");
  let generations = 0;
  const server = createServer((request, response) => {
    if (request.method !== "GET" || request.url !== "/v1/models") {
      generations++;
      response.writeHead(500).end("Settings must not generate model requests");
      return;
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ data: [{ id: "model/A", reasoning: false }, { id: "model/B", reasoning: false }] }));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing fixture address");
  await writeFile(configPath, JSON.stringify({ baseUrl: `http://127.0.0.1:${address.port}/v1`, apiKey: "test", model: "magpie/model/A" }));
  const magpie = await createMagpieControl({ dataDir, configPath, primaryConversationId: "primary" });
  try {
    await magpie.selectModel("other", "model/B");
    await magpie.selectModel("late", "model/B");
  } finally { magpie.close(); }
  const ready: string[] = [];
  const failures: unknown[] = [];
  const settings = await createConversationSettings({
    dataDir, magpie: { configPath, primaryConversationId: "primary" },
    conversations: () => [{ id: "primary" }, { id: "other" }],
    onRunnable: id => ready.push(id), reportFailure: error => failures.push(error),
  });
  settings.attachExecutor({ configureModel });
  return {
    settings, ready, failures, get generations() { return generations; },
    async close() {
      settings.stop();
      await settings.drain();
      settings.close();
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
      await rm(directory, { recursive: true, force: true });
    },
  };
}

test("a query waits for other Conversations and for settings work added while it waits", { timeout: 10000 }, async () => {
  const otherEntered = gate(), releaseOther = gate(), lateEntered = gate(), releaseLate = gate();
  const f = await settingsFixture(async id => {
    if (id === "other") { otherEntered.resolve(); await releaseOther.promise; }
    if (id === "late") { lateEntered.resolve(); await releaseLate.promise; }
  });
  try {
    const other = f.settings.synchronize("other");
    await otherEntered.promise;
    let returned = false;
    const query = f.settings.query("primary").then(snapshot => { returned = true; return snapshot; });
    await turn();
    assert.equal(returned, false);
    const late = f.settings.synchronize("late");
    await lateEntered.promise;
    releaseOther.resolve();
    await other;
    await turn();
    assert.equal(returned, false, "finishing the original tasks cannot finish the query while new configuration is held");
    releaseLate.resolve();
    await late;
    assert.equal((await query).selectedModel, "model/A");
    assert.equal(f.settings.canRun("other"), true);
    assert.equal(f.settings.canRun("late"), true);
    assert.equal(f.generations, 0);
  } finally { releaseOther.resolve(); releaseLate.resolve(); await f.close(); }
});

test("a rejected global propagation rejects its waiting query, reports the failure and permits later queries", { timeout: 10000 }, async () => {
  const entered = gate(), release = gate();
  const failure = new Error("controlled Durable configuration failure");
  let failOther = true;
  const f = await settingsFixture(async id => {
    if (id === "other" && failOther) { entered.resolve(); await release.promise; throw failure; }
  });
  try {
    const rejected = assert.rejects(f.settings.query("primary", true), error => error === failure);
    await entered.promise;
    await turn();
    release.resolve();
    await rejected;
    assert.ok(f.failures.includes(failure), "the automatic propagation retains the existing reportFailure path");
    assert.equal(f.settings.canRun("other"), false);
    assert.equal(f.generations, 0);
    assert.equal((await f.settings.query("primary")).selectedModel, "model/A", "a completed historical failure does not poison later queries");
    failOther = false;
    await f.settings.synchronize("other");
    assert.equal((await f.settings.query("primary")).selectedModel, "model/A");
    assert.equal(f.settings.canRun("other"), true);
  } finally { release.resolve(); await f.close(); }
});

test("restored Conversations become runnable only after their saved model configuration completes", { timeout: 10000 }, async () => {
  const primaryEntered = gate(), releasePrimary = gate(), otherEntered = gate(), releaseOther = gate();
  const configured: Array<[string, string | undefined]> = [];
  const f = await settingsFixture(async (id, prepared) => {
    if (id === "primary") { primaryEntered.resolve(); await releasePrimary.promise; }
    if (id === "other") { otherEntered.resolve(); await releaseOther.promise; }
    configured.push([id, prepared?.model.model]);
  });
  try {
    assert.deepEqual(configured, [], "initial Magpie observations precede executor attachment");
    assert.deepEqual(f.ready, []);
    let restored = false;
    const restoration = f.settings.synchronizeRegistered().then(() => { restored = true; });
    await primaryEntered.promise;
    assert.equal(f.settings.canRun("primary"), false);
    assert.equal(restored, false);
    assert.equal(f.ready.length, 0);
    releasePrimary.resolve();
    await otherEntered.promise;
    assert.deepEqual(configured, [["primary", "model/A"]]);
    assert.deepEqual(f.ready, ["primary"]);
    assert.equal(f.settings.canRun("other"), false);
    assert.equal(restored, false);
    releaseOther.resolve();
    await restoration;
    assert.deepEqual(configured, [["primary", "model/A"], ["other", "model/B"]]);
    assert.deepEqual(f.ready, ["primary", "other"]);
    assert.equal(f.settings.canRun("other"), true);
  } finally { releasePrimary.resolve(); releaseOther.resolve(); await f.close(); }
});

test("draining survives a rejection and includes configuration added during the drain", { timeout: 10000 }, async () => {
  const entered = gate(), release = gate(), lateEntered = gate(), releaseLate = gate();
  const failure = new Error("configuration failed while draining");
  const f = await settingsFixture(async id => {
    if (id === "primary") { entered.resolve(); await release.promise; throw failure; }
    if (id === "late") { lateEntered.resolve(); await releaseLate.promise; }
  });
  try {
    const rejected = assert.rejects(f.settings.synchronize("primary"), error => error === failure);
    await entered.promise;
    let drained = false;
    const drain = f.settings.drain().then(() => { drained = true; });
    const late = f.settings.synchronize("late");
    await lateEntered.promise;
    release.resolve();
    await rejected;
    await turn();
    assert.equal(drained, false, "drain must include work added after its initial wait began");
    releaseLate.resolve();
    await late;
    await drain;
    assert.equal(f.settings.canRun("late"), true);
  } finally { release.resolve(); releaseLate.resolve(); await f.close(); }
});

test("waiting for idle retains a single wait for current settings work", { timeout: 10000 }, async () => {
  const entered = gate(), release = gate(), lateEntered = gate(), releaseLate = gate();
  const f = await settingsFixture(async id => {
    if (id === "primary") { entered.resolve(); await release.promise; }
    if (id === "late") { lateEntered.resolve(); await releaseLate.promise; }
  });
  try {
    const current = f.settings.synchronize("primary");
    await entered.promise;
    const idle = f.settings.waitForIdle();
    let lateFinished = false;
    const late = f.settings.synchronize("late").then(() => { lateFinished = true; });
    await lateEntered.promise;
    release.resolve();
    await current;
    await idle;
    assert.equal(lateFinished, false, "waitForIdle keeps the existing current-task snapshot rather than a drain loop");
    assert.equal(f.settings.canRun("late"), false);
    releaseLate.resolve();
    await late;
    assert.equal(f.settings.canRun("late"), true);
  } finally { release.resolve(); releaseLate.resolve(); await f.close(); }
});

test("stopping coordination suppresses wakeups and drains queued and newly added rejections", { timeout: 10000 }, async () => {
  const entered = gate(), release = gate();
  const configured: string[] = [];
  const f = await settingsFixture(async id => {
    entered.resolve();
    await release.promise;
    configured.push(id);
  });
  try {
    const current = f.settings.synchronize("primary");
    await entered.promise;
    const queued = assert.rejects(f.settings.synchronize("primary"), /控制服务不可用/);
    f.settings.stop();
    let drained = false;
    const drain = f.settings.drain().then(() => { drained = true; });
    const added = assert.rejects(f.settings.synchronize("other"), /控制服务不可用/);
    await added;
    await turn();
    assert.equal(drained, false);
    release.resolve();
    await current;
    await queued;
    await drain;
    assert.deepEqual(configured, ["primary"], "work queued after stopping never reaches Durable configuration");
    assert.equal(f.ready.length, 0, "finishing configuration while stopped cannot wake routing or the queue");
    await assert.rejects(f.settings.query("late"), /控制服务不可用/);
  } finally { release.resolve(); await f.close(); }
});
