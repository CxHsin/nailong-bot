import type { RuntimeLog } from "./runtime-types.js";
import { createHash, randomUUID } from "node:crypto";
import { DeliveryRejected } from "../application/app-types.js";

/** Startup records facts only. It never executes a model, tool or transport. */
export async function recordInterruptedRuns(log: RuntimeLog): Promise<number> {
  const events = await log.read();
  const started = events.filter((event) => ["run_submitted", "run_started", "request_started"].includes(event.type) || event.type === "control_received" && event.phase === "steer");
  const ids = [...new Set(started.map((event) => String(event.runId ?? event.requestId)))];
  let count = 0;
  for (const id of ids) {
    const own = events.filter((event) => event.runId === id || event.requestId === id);
    if (own.some((event) => ["control_completed", "run_succeeded", "run_failed", "run_cancelled", "request_completed", "request_failed", "request_interrupted"].includes(event.type))) continue;
    const identity = { runId: id, requestId: id, conversationId: own.find((event) => typeof event.conversationId === "string")?.conversationId };
    const facts = [{ type: "request_interrupted", ...identity, reason: "process_restart" }, { type: "run_cancelled", ...identity, reason: "process_restart" }];
    if (log.appendBatch) await log.appendBatch(facts); else for (const event of facts) await log.append(event);
    count++;
  }
  return count;
}

/** Recovery notices are control delivery, never task execution or answer redelivery. */
export async function notifyRecovery(log: RuntimeLog, channel: "cli" | "telegram", send: (text: string, id: string) => Promise<void>) {
  const events = await log.read();
  const pending = events.filter((event) => event.type === "request_interrupted" && event.reason === "process_restart");
  const covered = new Set(events.filter((event) => event.type === "recovery_notice_succeeded" || event.type === "recovery_notice_unknown").flatMap((event) => Array.isArray(event.inputIds) ? event.inputIds as string[] : []));
  // A crash between transport and its result leaves delivery unknown, even if
  // later recovery items produce a different aggregate notice identity.
  for (const attempt of events.filter((event) => event.type === "recovery_notice_attempt")) {
    if (!events.some((event) => event.attemptId === attempt.attemptId && ["recovery_notice_succeeded", "recovery_notice_failed", "recovery_notice_unknown"].includes(event.type)))
      for (const inputId of Array.isArray(attempt.inputIds) ? attempt.inputIds : []) covered.add(String(inputId));
  }
  const inputIds = [...new Set(pending.map((event) => String(event.runId ?? event.requestId)))].filter((id) => !covered.has(id));
  if (!inputIds.length) return;
  const id = `recovery:${createHash("sha256").update(JSON.stringify(inputIds)).digest("hex")}`;
  const previous = events.filter((event) => event.noticeId === id);
  if (previous.some((event) => event.type === "recovery_notice_attempt" && !previous.some((result) => result.attemptId === event.attemptId && ["recovery_notice_succeeded", "recovery_notice_failed"].includes(result.type)))) return;
  const text = `重启恢复：${inputIds.length} 项运行或待处理输入已中断，不会自动执行。请按需重新提交；已完成操作仍保留。`;
  for (let attempt = previous.filter((event) => event.type === "recovery_notice_attempt").length; attempt < 3; attempt++) {
    const identity = { noticeId: id, attemptId: randomUUID(), inputIds, channel, contextPolicy: "exclude" };
    await log.append({ type: "recovery_notice_attempt", ...identity });
    try { await send(text, id); }
    catch (error) {
      const failure = error as { error_code?: number; parameters?: { retry_after?: number }; retryAfterMs?: number };
      const rejected = error instanceof DeliveryRejected || typeof failure.error_code === "number" && failure.error_code >= 400 && failure.error_code < 500;
      await log.append({ type: rejected ? "recovery_notice_failed" : "recovery_notice_unknown", ...identity });
      if (!rejected) return;
      const delay = failure.retryAfterMs ?? (failure.parameters?.retry_after ?? 0) * 1000;
      if (delay > 0 && attempt < 2) await new Promise<void>((resolve) => setTimeout(resolve, delay));
      continue;
    }
    await log.append({ type: "recovery_notice_succeeded", ...identity }); return;
  }
}
