import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRuntimeEventLog } from "../src/runtime/event-log.js";
import { appendRuntimeFact, appendRuntimeFacts, settledTextFact, runResultFact } from "../src/runtime/facts.js";

test("typed settlement and Run result reads preserve original records and leave historical/unknown data raw", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "runtime-facts-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const log = await createRuntimeEventLog(dir);
  await appendRuntimeFacts(log, [
    { type: "text_finalized", requestId: "run", textSegmentId: "segment", contentKind: "final", text: "answer" },
    { type: "run_succeeded", runId: "run", conversationId: "conversation", result: { resultId: "result", text: "answer" } },
  ]);
  await log.append({ type: "future_event", arbitrary: { kept: true } });
  // The existing raw schema accepts these old message records without request identities.
  await log.append({ type: "message", role: "assistant", text: "old answer" });
  const events = await log.read();
  const settled = settledTextFact(events[0]!);
  const result = runResultFact(events[1]!);
  assert.equal(settled?.text, "answer");
  assert.equal(result?.result.resultId, "result");
  assert.equal(settled, events[0]);
  assert.equal(result, events[1]);
  assert.equal(settledTextFact(events[2]!), undefined);
  assert.equal(runResultFact(events[3]!), undefined);
  assert.deepEqual(events[2]!.arbitrary, { kept: true });
  assert.equal(events[3]!.requestId, undefined);
  // A runtime failure still rolls back the entire typed batch through the original storage transaction.
  await assert.rejects(appendRuntimeFacts(log, [
    { type: "request_started", requestId: "other" },
    { type: "text_finalized", requestId: "other", textSegmentId: "invalid", contentKind: "final", text: "" },
  ]), /内容/);
  assert.equal((await log.read()).some((event) => event.requestId === "other"), false);
  await appendRuntimeFact(log, { type: "request_started", requestId: "other" });
  assert.equal((await log.read()).at(-1)?.requestId, "other");
});
