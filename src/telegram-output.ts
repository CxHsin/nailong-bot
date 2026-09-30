import { randomUUID, createHash } from "node:crypto";
import type { RuntimeLog, StoredEvent } from "./runtime-log.js";
import type { TelegramTransport } from "./telegram-projection.js";
import { planTelegramText, previewTelegramText, TELEGRAM_PRESENTATION_VERSION } from "./telegram-layout.js";

export function createTelegramOutput(options: { log: RuntimeLog; chatId: number } & TelegramTransport) {
  let stopped = false;
  let retryAt = 0;
  let error: unknown;
  const tasks = new Map<string, Promise<void>>();
  const retries = new Map<string, ReturnType<typeof setTimeout>>();
  function schedule(id: string, deadline: number) {
    if (retries.has(id)) return;
    const timer = setTimeout(() => {
      retries.delete(id);
      void reconcile(id).then(async (delivered) => {
        if (!delivered) return;
        const { snapshot } = await state(id);
        if (snapshot?.requestId) await acknowledge(snapshot.requestId);
      }).catch((failure: unknown) => { error = failure; });
    }, Math.min(2_147_483_647, Math.max(10, deadline - Date.now())));
    timer.unref();
    retries.set(id, timer);
  }
  let serial = Promise.resolve();
  const lock = <T>(work: () => Promise<T>): Promise<T> => {
    const next = serial.then(work);
    serial = next.then(() => {}, () => {});
    return next;
  };
  async function state(id: string) {
    const events = await options.log.read();
    const firstSnapshot = events.find((event) => event.type === "text_snapshot" && event.textSegmentId === id);
    const snapshot = events.findLast((event) => event.type === "text_snapshot" && event.textSegmentId === id);
    const final = events.findLast((event) => event.type === "text_finalized" && event.textSegmentId === id);
    const pages = events.filter((event) => event.type === "telegram_page" && event.textSegmentId === id);
    const deliveries = events.filter((event) => event.type.startsWith("telegram_delivery_") && event.textSegmentId === id);
    const prefix = events.findLast((event) => event.type === "text_validated_prefix" && event.textSegmentId === id);
    const discarded = events.some((event) => event.type === "text_discarded" && event.textSegmentId === id);
    const planFinal = events.findLast((event) => event.type === "telegram_plan_finalized" && event.textSegmentId === id);
    return { snapshot, firstSnapshot, final, pages, deliveries, prefix, discarded, planFinal };
  }
  async function requestDelivered(requestId: string) {
    const events = await options.log.read();
    const finals = events.filter((event) => event.type === "text_finalized" && event.requestId === requestId &&
      event.protocolVersion === "json-text-v2" && ["result", "final"].includes(String(event.contentKind)));
    if (!finals.some((event) => event.contentKind === "final")) return false;
    for (const final of finals) {
      const { pages, deliveries, planFinal, discarded } = await state(String(final.textSegmentId));
      if (discarded || !planFinal || planFinal.parts !== pages.length || !pages.length || !pages.every((page) =>
        deliveries.some((event) => event.type === "telegram_delivery_succeeded" && event.partIndex === page.partIndex))) return false;
    }
    return true;
  }
  async function acknowledge(requestId: string) {
    if (!await requestDelivered(requestId)) return;
    const events = await options.log.read();
    if (events.some((event) => event.type === "delivery_succeeded" && event.requestId === requestId)) return;
    const final = events.findLast((event) => event.type === "text_finalized" && event.requestId === requestId && event.contentKind === "final");
    if (!final) return;
    if (!events.some((event) => event.type === "answer_generated" && event.requestId === requestId))
      await options.log.append({ type: "answer_generated", requestId, text: final.text });
    await options.log.append({ type: "delivery_succeeded", requestId, textSegmentId: final.textSegmentId, source: "retry" });
  }
  async function sendPage(page: StoredEvent, deliveries: StoredEvent[]): Promise<boolean> {
    const history = deliveries.filter((event) => event.partIndex === page.partIndex);
    if (history.some((event) => event.type === "telegram_delivery_succeeded")) return true;
    const attempt = history.findLast((event) => event.type === "telegram_delivery_attempt");
    const outcome = attempt && history.findLast((event) => event.attemptId === attempt.attemptId &&
      event.type !== "telegram_delivery_attempt");
    if (attempt && (!outcome || outcome.type === "telegram_delivery_unknown")) return false;
    if (typeof outcome?.retryAt === "number") retryAt = Math.max(retryAt, outcome.retryAt);
    if (Date.now() < retryAt) schedule(String(page.textSegmentId), retryAt);
    if (history.filter((event) => event.type === "telegram_delivery_attempt").length >= 3 || Date.now() < retryAt) return false;
    const identity = { requestId: page.requestId, textSegmentId: page.textSegmentId as string,
      partIndex: page.partIndex, snapshotEventId: page.snapshotEventId, attemptId: randomUUID(),
      presentationVersion: TELEGRAM_PRESENTATION_VERSION, action: "send", text: page.text };
    await options.log.append({ type: "telegram_delivery_attempt", ...identity });
    let messageId: number;
    try { messageId = await options.send(String(page.html), options.chatId, "HTML"); }
    catch (failure) {
      const retry = options.retryAfter?.(failure);
      if (retry !== undefined) retryAt = Date.now() + retry;
      await options.log.append({ type: options.isRejected?.(failure) ? "telegram_delivery_failed" : "telegram_delivery_unknown",
        ...identity, error: String(failure), ...(retry !== undefined ? { retryAt } : {}) });
      if (options.isRejected?.(failure) && history.filter((event) => event.type === "telegram_delivery_attempt").length < 2)
        schedule(String(page.textSegmentId), retryAt > Date.now() ? retryAt : Date.now() + 250);
      return false;
    }
    // If this commit fails the durable attempt becomes unknown; never send it again.
    await options.log.append({ type: "telegram_delivery_succeeded", ...identity, telegramMessageId: messageId });
    return true;
  }
  async function reconcile(id: string): Promise<boolean> {
    return lock(async () => {
      let { snapshot, final, pages, deliveries, prefix, planFinal, discarded } = await state(id);
      if (!snapshot || snapshot.contentKind === "status") return true;
      if (discarded) {
        const timer = retries.get(id);
        if (timer) clearTimeout(timer);
        retries.delete(id);
        return false;
      }
      if (snapshot.contentKind === "notice" && snapshot.requestId && await requestDelivered(snapshot.requestId)) return true;
      const pending = retries.get(id);
      if (pending && Date.now() >= retryAt) { clearTimeout(pending); retries.delete(id); }
      if (!final && !snapshot.validatedPrefix) return false;
      const source = final?.text ?? prefix?.text ?? snapshot.text;
      const sourceHash = createHash("sha256").update(String(source)).digest("hex");
      if (planFinal && (planFinal.sourceHash !== sourceHash || planFinal.parts !== pages.length))
        throw new Error("正式消息分段计划与正文不一致");
      const computed = final ? planTelegramText(String(source)) : planTelegramText(String(source), false).slice(0, -1);
      const planned = planFinal || !final && !computed.length ? pages.map((page) => String(page.html)) : computed;
      if (pages.some((page, index) => page.html !== planned[index])) throw new Error("已提交消息的正文边界发生变化");
      if (planned.length > pages.length || final && !planFinal) {
        const identity = snapshot.eventId ?? createHash("sha256").update(id + String(snapshot.text)).digest("hex");
        const batch: Array<Omit<StoredEvent, "at">> = planned.map((html, partIndex) => ({ type: "telegram_page", requestId: snapshot.requestId,
          textSegmentId: id, presentationVersion: TELEGRAM_PRESENTATION_VERSION, partIndex,
          snapshotEventId: identity, text: html, html, contentKind: snapshot.contentKind })).slice(pages.length);
        if (final && !planFinal) batch.push({ type: "telegram_plan_finalized", requestId: snapshot.requestId,
          textSegmentId: id, presentationVersion: TELEGRAM_PRESENTATION_VERSION, sourceHash, parts: planned.length });
        if (options.log.appendBatch) await options.log.appendBatch(batch);
        else for (const page of batch) await options.log.append(page);
        ({ pages, deliveries } = await state(id));
      }
      for (const page of pages) {
        if (!await sendPage(page, deliveries)) {
          if (Date.now() < retryAt && retryAt - Date.now() <= 1500) {
            await new Promise((resolve) => setTimeout(resolve, Math.max(0, retryAt - Date.now())));
            deliveries = (await state(id)).deliveries;
            if (await sendPage(page, deliveries)) continue;
          }
          return false;
        }
      }
      return pages.length > 0;
    });
  }
  async function preview(id: string) {
    const { snapshot, firstSnapshot, final } = await state(id);
    if (!snapshot || stopped) return false;
    if (final && final.contentKind !== "status") { return reconcile(id); }
    if (snapshot.validatedPrefix && snapshot.contentKind !== "status" && !await reconcile(id)) return false;
    if (!options.draft || Date.now() < retryAt) return false;
    const latest = await state(id);
    const previews = previewTelegramText(String(snapshot.text));
    const rendered = previews[latest.pages.length];
    if (!rendered) return true;
    const draftId = Number(firstSnapshot?.sequence) || parseInt(createHash("sha256").update(id).digest("hex").slice(0, 7), 16) || 1;
    try { await options.draft(draftId, rendered, options.chatId, "HTML"); return true; }
    catch (failure) {
      const retry = options.retryAfter?.(failure);
      if (retry !== undefined) retryAt = Date.now() + retry;
      return false;
    }
  }
  return {
    reconcile,
    async stream(id: string) {
      if (tasks.has(id)) return;
      const run = async () => {
        let previous = "";
        while (!stopped) {
          const { snapshot, final, discarded } = await state(id);
          if (discarded) return;
          if (snapshot && (previous !== snapshot.text || Date.now() >= retryAt && previous === "")) {
            if (await preview(id)) previous = String(snapshot.text);
          }
          if (final) {
            if (final.contentKind === "status") await preview(id);
            else await reconcile(id);
            return;
          }
          await new Promise((resolve) => setTimeout(resolve, 150));
        }
      };
      const task = run().catch((failure: unknown) => { error = failure; }).finally(() => tasks.delete(id));
      tasks.set(id, task);
    },
    async finish() {
      stopped = true;
      await Promise.all(tasks.values());
      if (error) throw error;
    },
    async stop() { stopped = true; await Promise.all(tasks.values()); },
    resume() { stopped = false; error = undefined; },
    interrupt() {},
    requestDelivered,
    async finalDelivered(id: string) {
      const { final, pages, deliveries, planFinal } = await state(id);
      return final?.contentKind === "final" && planFinal?.parts === pages.length && pages.length > 0 && pages.every((page) =>
        deliveries.some((event) => event.type === "telegram_delivery_succeeded" && event.partIndex === page.partIndex));
    },
  };
}
