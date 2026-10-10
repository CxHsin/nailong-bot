import assert from "node:assert/strict";
import test from "node:test";
import { createTelegramProviderFixture as fixture, sendChatCompletion as output, checkWrites as guard } from "./fixtures/telegram-provider.js";
import { join } from "node:path";
import { readFile, access } from "node:fs/promises";
import type { RuntimeLog, StoredEvent } from "../src/runtime/runtime-types.js";

test("SQLite commits actual tool facts before the next Provider request", async (t) => {
  let log: RuntimeLog | undefined; const observed: StoredEvent[][] = [];
  const { f, dir } = await fixture(t, async (res, wire, dataDir) => {
    observed.push(await log!.read());
    output(res, wire.length === 1 ? "checking file" : "checked", wire.length === 1 ? [{ index: 0, id: "read-one", type: "function", function: { name: "read", arguments: JSON.stringify({ path: join(dataDir, "prompt.md") }) } }] : undefined);
  });
  log = f.rootLog; await f.send("read prompt");
  assert.equal(observed.length, 2);
  assert.ok(observed[0]!.some((e) => e.type === "model_step_started"));
  for (const type of ["model_message", "tool_call", "text_finalized", "tool_dispatch", "tool_result", "model_step_completed"]) assert.ok(observed[1]!.some((e) => e.type === type), `${type} must precede Provider continuation`);
  assert.ok(f.sent.includes("checked"));
  assert.ok(f.drafts.some((e) => e.text.includes("checking file")));
  const events = await f.rootLog.read();
  assert.deepEqual(events.map((e) => e.sequence), events.map((_, i) => i + 1));
  await access(join(dir, "runtime-v2.sqlite"));
  await assert.rejects(readFile(join(dir, "events.jsonl")), { code: "ENOENT" });
});

test("settled progress remains in actual context after durable tool dispatch failure", async (t) => {
  let fail = true;
  const { f, wire } = await fixture(t, (res, requests, dir) => output(res, requests.length === 1 ? "checking before dispatch" : "continued", requests.length === 1 ? [{ index: 0, id: "blocked-read", type: "function", function: { name: "read", arguments: JSON.stringify({ path: join(dir, "prompt.md") }) } }] : undefined), {
    wrapLog: (log) => guard(log, (e) => { if (fail && e.type === "tool_dispatch") throw new Error("dispatch commit failed"); }),
  });
  await f.send("first");
  assert.equal(wire.length, 1);
  assert.ok((await f.rootLog.read()).some((e) => e.type === "text_finalized" && e.text === "checking before dispatch"));
  assert.ok(!(await f.rootLog.read()).some((e) => e.type === "tool_dispatch" || e.type === "tool_result" && !e.isError));
  fail = false; await f.send("continue");
  assert.match(JSON.stringify(wire[1]), /checking before dispatch/);
  assert.ok(f.sent.includes("continued"));
});

for (const fault of ["model_step_started", "text_finalized", "tool_dispatch"] as const) {
  test(`SQLite ${fault} commit failure prevents unrecorded model or file work`, async (t) => {
    let rejected = 0;
    const { f, wire, dir } = await fixture(t, (res, _requests, dataDir) => output(res, "write file", [{ index: 0, id: "blocked-write", type: "function", function: { name: "write", arguments: JSON.stringify({ path: join(dataDir, "unwritten.txt"), content: "unsafe" }) } }]), {
      wrapLog: (log) => guard(log, (e) => { if (e.type === fault) { rejected++; throw new Error("commit failed"); } }),
    });
    await f.send("write file");
    assert.ok(rejected > 0); assert.equal(wire.length, fault === "model_step_started" ? 0 : 1);
    await assert.rejects(access(join(dir, "unwritten.txt")), { code: "ENOENT" });
    assert.ok((await f.rootLog.read()).some((e) => e.type === "run_failed"));
    assert.ok(!(await f.rootLog.read()).some((e) => e.type === fault));
    assert.ok(f.sent.some((text) => text.includes("处理失败")));
  });
}
