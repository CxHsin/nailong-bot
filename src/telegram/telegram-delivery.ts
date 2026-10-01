import type { RuntimeLog } from "../runtime/runtime-types.js";
import type { createTelegramProjection } from "./telegram-projection.js";
import { projectRequestState } from "../application/runtime-projections.js";
import { projectRecoverableTelegram } from "./telegram-events.js";

export function createDeliveryLifecycle(log: RuntimeLog, telegram?: ReturnType<typeof createTelegramProjection>) {
  async function notice(requestId: string, text: string) {
    if (!telegram) return;
    const textSegmentId = `${requestId}:output-notice`;
    if (!(await log.read()).some((event) => event.textSegmentId === textSegmentId)) {
      const events = [{ type: "text_snapshot", requestId, textSegmentId, protocolVersion: "json-text-v2",
        contentKind: "notice", text }, { type: "text_finalized", requestId, textSegmentId,
        protocolVersion: "json-text-v2", contentKind: "notice", text }];
      if (log.appendBatch) await log.appendBatch(events);
      else for (const event of events) await log.append(event);
    }
    await telegram.reconcile(textSegmentId);
  }
  async function isNewOutput(requestId: string) {
    return (await log.read()).some((event) => event.type === "text_snapshot" &&
      event.requestId === requestId && event.protocolVersion === "json-text-v2");
  }

  async function recover(): Promise<void> {
      const events = await log.read();
      const open = projectRequestState(events).open;
      for (const requestId of open) await log.append({ type: "request_interrupted", requestId });
      if (telegram) {
        const { segments } = projectRecoverableTelegram(events);
        for (const segment of segments) {
          const snapshot = events.findLast((event) => event.type === "text_snapshot" && event.textSegmentId === segment);
          // V2 recovery never sends old body content; only durable notices may retry known failures.
          const knownFailure = events.some((event) => event.type === "telegram_delivery_failed" && event.textSegmentId === segment);
          if (snapshot?.protocolVersion !== "json-text-v2" || snapshot.contentKind === "notice" || knownFailure) await telegram.reconcile(segment);
        }
        const unfinished = new Set(events.filter((event) => event.type === "text_snapshot" &&
          event.protocolVersion === "json-text-v2" && event.contentKind !== "notice" && event.requestId &&
          !projectRequestState(events).delivered.has(event.requestId)).map((event) => event.requestId!));
        for (const requestId of unfinished) {
          const final = events.findLast((event) => event.type === "text_finalized" && event.requestId === requestId && event.contentKind === "final");
          if (!await telegram.requestDelivered(requestId) || !final || !await telegram.finalDelivered(String(final.textSegmentId))) {
            await notice(requestId, "这次回复可能不完整：处理曾中断。已发送内容保留；你可以要求继续或重新发送。");
          }
        }
        const current = await log.read();
        for (const event of projectRecoverableTelegram(current).finals) {
          if (!await telegram.finalDelivered(String(event.textSegmentId)) || !await telegram.requestDelivered(event.requestId!) ||
            projectRequestState(current).delivered.has(event.requestId!)) continue;
          if (!current.some((item) => item.type === "answer_generated" && item.requestId === event.requestId)) {
            await log.append({ type: "answer_generated", requestId: event.requestId, text: event.text });
          }
          await log.append({ type: "delivery_succeeded", requestId: event.requestId,
            textSegmentId: event.textSegmentId });
        }
      }
  }
  return { notice, isNewOutput, recover };
}
