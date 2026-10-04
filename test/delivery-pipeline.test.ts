import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createDeliveryFactStore, reduceRunDelivery } from "../src/runtime/delivery-pipeline.js";
import { createRuntimeLog } from "../src/runtime/runtime-log.js";

test("Run and Delivery facts remain separate and idempotent across recovery", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "delivery-facts-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const log = createRuntimeLog(dir);
  const delivery = createDeliveryFactStore(log);
  await delivery.recordAttempt({ resultId: "result-1", channel: "cli", target: "stdout", idempotencyKey: "result-1:cli" });
  await delivery.recordOutcome("result-1", "cli", "unknown", { error: "timeout" });
  await delivery.recordAttempt({ resultId: "result-1", channel: "cli", target: "stdout", idempotencyKey: "result-1:cli" });
  const state = reduceRunDelivery(await log.read(), "run-1", "result-1");
  assert.equal(state.delivery.get("result-1:cli")?.outcome, "unknown");
  assert.equal(state.resultReusable, true);
  assert.equal((await log.read()).filter((event) => event.type === "delivery_attempt").length, 1);
});
