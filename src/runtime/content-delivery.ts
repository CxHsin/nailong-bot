import { randomUUID } from "node:crypto";
import type { RuntimeLog } from "./runtime-types.js";
import { DeliveryRejected } from "../application/app-types.js";
import { projectTimeline } from "./timeline.js";

export type DeliveryContent = { id: string; text: string; kind: "progress" | "final"; source?: "execution" | "progress-model"; preview?: string[] };
export type ContentTransport = {
  send: (text: string, chatId: number) => Promise<number>;
  plan?: (content: DeliveryContent) => string[];
  sendPage?: (text: string, chatId: number) => Promise<number>;
};

/** One immutable plan and durable attempt per page, with no startup side effects. */
export async function deliverContent(log: RuntimeLog, runId: string, chatId: number, content: DeliveryContent, transport: ContentTransport) {
  const facts = await log.read();
  const settled = projectTimeline(facts).find((item) => item.id === content.id && item.runId === runId);
  if (settled && settled.text !== content.text) throw new Error("交付正文与已结算事实不一致");
  if (!settled && !facts.some((event) => event.type === "run_succeeded" && event.runId === runId &&
    ((event.result as { text?: unknown } | undefined)?.text === content.text ||
      content.kind === "final" && (event.result as { finalText?: unknown } | undefined)?.finalText === content.text))) throw new Error("内容尚未持久结算");
  let pages = facts.filter((event) => event.type === "telegram_page" && event.textSegmentId === content.id);
  if (!pages.length) {
    const texts = transport.plan?.(content) ?? [content.text];
    if (!texts.length) throw new Error("交付计划为空");
    const plan = texts.map((text, partIndex) => ({ type: "telegram_page", requestId: runId,
      textSegmentId: content.id, partIndex, text, contentKind: content.kind, target: chatId }));
    const end = { type: "telegram_plan_finalized", requestId: runId, textSegmentId: content.id, parts: plan.length };
    if (log.appendBatch) await log.appendBatch([...plan, end]);
    else { for (const event of plan) await log.append(event); await log.append(end); }
    pages = (await log.read()).filter((event) => event.type === "telegram_page" && event.textSegmentId === content.id);
  }
  const committed = await log.read();
  const plan = committed.findLast((event) => event.type === "telegram_plan_finalized" && event.textSegmentId === content.id);
  if (plan?.parts !== pages.length) throw new Error("交付计划未提交完整");
  let firstMessageId: number | undefined;
  for (const page of pages) {
    const matches = () => log.read().then((events) => events.filter((event) => event.textSegmentId === content.id && event.partIndex === page.partIndex));
    const prior = await matches();
    const success = prior.find((event) => event.type === "telegram_delivery_succeeded");
    if (success) { firstMessageId ??= Number(success.telegramMessageId); continue; }
    const attempts = prior.filter((event) => event.type === "telegram_delivery_attempt");
    if (prior.some((event) => event.type === "telegram_delivery_unknown") || attempts.some((attempt) =>
      !prior.some((event) => ["telegram_delivery_failed", "telegram_delivery_succeeded"].includes(event.type) && event.attemptId === attempt.attemptId)))
      return { complete: false, outcome: "unknown" as const };
    for (let attempt = attempts.length; attempt < 3; attempt++) {
      const attemptId = randomUUID();
      const identity = { requestId: runId, textSegmentId: content.id, partIndex: page.partIndex, attemptId, target: chatId };
      await log.append({ type: "telegram_delivery_attempt", ...identity });
      let messageId: number;
      try { messageId = await (transport.sendPage ?? transport.send)(String(page.text), chatId); }
      catch (error) {
        const failure = error as { error_code?: number; parameters?: { retry_after?: number }; retryAfterMs?: number; name?: string };
        const rejected = error instanceof DeliveryRejected || typeof failure.error_code === "number" && failure.error_code >= 400 && failure.error_code < 500;
        await log.append({ type: rejected ? "telegram_delivery_failed" : "telegram_delivery_unknown", ...identity, error: String(error) });
        if (!rejected) return { complete: false, outcome: "unknown" as const };
        if (attempt === 2) return { complete: false, outcome: "failed" as const };
        const wait = failure.retryAfterMs ?? (failure.parameters?.retry_after ?? 0) * 1000;
        if (wait > 0) await new Promise<void>((resolve) => setTimeout(resolve, wait));
        continue;
      }
      // A failed commit leaves an unknown attempt; never resend a known API success.
      await log.append({ type: "telegram_delivery_succeeded", ...identity, telegramMessageId: messageId });
      firstMessageId ??= messageId;
      break;
    }
    if (!(await matches()).some((event) => event.type === "telegram_delivery_succeeded"))
      return { complete: false, outcome: "failed" as const };
  }
  return { complete: true, outcome: "succeeded" as const, messageId: firstMessageId! };
}
