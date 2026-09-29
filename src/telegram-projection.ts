import { randomUUID } from "node:crypto";
import type { RuntimeLog } from "./runtime-log.js";
import { projectTelegramSegment } from "./runtime-projections.js";
import { formatMarkdownForTelegram } from "./telegram-format.js";

export type TelegramTransport = {
  send(text: string, chatId: number, parseMode?: "HTML"): Promise<number>;
  edit(messageId: number, text: string, chatId: number, parseMode?: "HTML"): Promise<void>;
  draft?(draftId: number, text: string, chatId: number, parseMode?: "HTML"): Promise<void>;
  isRejected?: (error: unknown) => boolean;
  retryAfter?: (error: unknown) => number | undefined;
};

export function splitTelegramText(text: string): string[] {
  const parts: string[] = [];
  let current = "";
  for (const point of text) {
    if (current.length + point.length > 4000) {
      parts.push(current);
      current = "";
    }
    current += point;
  }
  if (current) parts.push(current);
  return parts;
}

export function createTelegramProjection(options: { log: RuntimeLog; chatId: number } & TelegramTransport) {
  const updateIntervalMs = 500;
  const charactersPerUpdate = 10; // 20 visible characters/second without a backlog.
  const backlogLimit = 60;
  const finishGraceMs = 3000;
  const animations = new Map<string, Promise<void>>();
  let completeImmediately = false;
  let stopAnimations = false;
  let animationError: unknown;
  let finishingAt: number | undefined;
  let retryNotBefore = 0;
  const characters = new Intl.Segmenter("zh", { granularity: "grapheme" });
  const points = (text: string) => Array.from(characters.segment(text), (part) => part.segment);
  const hasVisibleContent = (rendered: string) => !!rendered.replace(/<[^>]+>/g, "").trim();
  async function state(textSegmentId: string) {
    return projectTelegramSegment(await options.log.read(), textSegmentId);
  }

  return {
    async reconcile(textSegmentId: string, visibleText?: string): Promise<boolean> {
      const { snapshots, deliveries } = await state(textSegmentId);
      const snapshot = snapshots.at(-1);
      if (!snapshot) return false;
      if (Date.now() < retryNotBefore) return false;
      const parts = splitTelegramText(visibleText ?? snapshot.text);
      let delivered = true;
      for (const [partIndex, text] of parts.entries()) {
        const attempts = deliveries.filter((event) => event.partIndex === partIndex &&
          event.type === "telegram_delivery_attempt");
        const successful = deliveries.filter((event) => event.partIndex === partIndex &&
          event.type === "telegram_delivery_succeeded");
        const latestSuccess = successful.at(-1);
        if (latestSuccess?.text === text) continue;
        // A first send without a returned message ID cannot be reconciled safely.
        // Its attempt remains a durable barrier even after a known rejection.
        if (!latestSuccess && attempts.some((event) => event.action === "send")) {
          delivered = false;
          continue;
        }
        const messageId = latestSuccess?.telegramMessageId;
        const rendered = formatMarkdownForTelegram(text);
        // An empty Markdown prefix must not create an unretryable first-send barrier.
        if (!hasVisibleContent(rendered)) {
          delivered = false;
          continue;
        }
        const action = messageId === undefined ? "send" : "edit";
        const attemptId = randomUUID();
        const identity = { requestId: snapshot.requestId, textSegmentId, partIndex,
          snapshotEventId: snapshot.eventId, attemptId, chatId: options.chatId };
        await options.log.append({ type: "telegram_delivery_attempt", ...identity, action, text });
        let telegramMessageId: number;
        try {
          telegramMessageId = action === "send"
            ? await options.send(rendered, options.chatId, "HTML")
            : (await options.edit(messageId!, rendered, options.chatId, "HTML"), messageId!);
        } catch (error) {
          const retryAfter = options.retryAfter?.(error);
          if (retryAfter !== undefined && Number.isFinite(retryAfter) && retryAfter > 0) {
            retryNotBefore = Date.now() + retryAfter;
          }
          await options.log.append({ type: options.isRejected?.(error) ?
            "telegram_delivery_failed" : "telegram_delivery_unknown", ...identity,
            action, error: String(error), ...(messageId === undefined ? {} : { telegramMessageId: messageId }) });
          delivered = false;
          break;
        }
        await options.log.append({ type: "telegram_delivery_succeeded", ...identity,
          action, text, telegramMessageId });
      }
      return delivered;
    },
    stream(textSegmentId: string): Promise<void> {
      if (animations.has(textSegmentId)) return Promise.resolve();
      if (options.draft) {
        const run = async () => {
          let drafted = "";
          while (true) {
            const { snapshots, final } = await state(textSegmentId);
            const first = snapshots[0];
            const latest = snapshots.at(-1);
            const target = latest?.text ?? "";
            if (first && target && Date.now() >= retryNotBefore) {
              const preview = splitTelegramText(target)[0] ?? "";
              const rendered = formatMarkdownForTelegram(preview);
              if (hasVisibleContent(rendered) && rendered !== drafted) {
                try {
                  await options.draft!(first.sequence, rendered, options.chatId, "HTML");
                  drafted = rendered;
                } catch (error) {
                  const retryAfter = options.retryAfter?.(error);
                  if (retryAfter !== undefined && Number.isFinite(retryAfter) && retryAfter > 0) {
                    retryNotBefore = Date.now() + retryAfter;
                  }
                }
              }
            }
            if (final) {
              await this.reconcile(textSegmentId);
              return;
            }
            if (stopAnimations || finishingAt !== undefined) return;
            await new Promise((resolve) => setTimeout(resolve, 200));
          }
        };
        const task = run().catch((error: unknown) => { animationError = error; })
          .finally(() => animations.delete(textSegmentId));
        animations.set(textSegmentId, task);
        return Promise.resolve();
      }
      const run = async () => {
        const initial = await state(textSegmentId);
        let visible = splitTelegramText(initial.snapshots.at(-1)?.text ?? "").map((_part, partIndex) =>
          initial.deliveries.findLast((event) => event.type === "telegram_delivery_succeeded" &&
            event.partIndex === partIndex)?.text ?? "").join("");
        let finalizedAt: number | undefined;
        while (true) {
          const { snapshots, final, deliveries } = await state(textSegmentId);
          const target = snapshots.at(-1)?.text ?? "";
          if (final && finalizedAt === undefined) finalizedAt = Date.parse(final.at);
          const endsAt = finalizedAt ?? finishingAt;
          if (!target && (endsAt !== undefined || stopAnimations)) return;
          if (target) {
            const targetPoints = points(target);
            const current = points(visible).length;
            const deadline = endsAt !== undefined && Date.now() - endsAt >= finishGraceMs;
            const jump = completeImmediately || deadline || !target.startsWith(visible);
            const backlog = targetPoints.length - current;
            const step = visible ? (backlog > backlogLimit
              ? Math.max(charactersPerUpdate, Math.ceil(backlog / (finishGraceMs / updateIntervalMs)))
              : charactersPerUpdate) : 12;
            let count = Math.min(targetPoints.length, current + step);
            let next = jump ? target : targetPoints.slice(0, count).join("");
            while (!visible && count < targetPoints.length && !hasVisibleContent(formatMarkdownForTelegram(next))) {
              count = Math.min(targetPoints.length, count + charactersPerUpdate);
              next = targetPoints.slice(0, count).join("");
            }
            let delivered = true;
            const attempted = Date.now() >= retryNotBefore;
            if (next !== visible) {
              delivered = await this.reconcile(textSegmentId, next);
              if (delivered) visible = next;
            }
            if (endsAt !== undefined && visible === target) return;
            if (stopAnimations) return;
            const blockedSend = deliveries.some((event) => event.type === "telegram_delivery_attempt" &&
              event.action === "send" && !deliveries.some((result) => result.type === "telegram_delivery_succeeded" &&
                result.partIndex === event.partIndex));
            if (!delivered && blockedSend) return;
            if (deadline && !delivered && (attempted ||
              (endsAt !== undefined && retryNotBefore > endsAt + finishGraceMs))) return;
            if (!delivered) {
              await new Promise((resolve) => setTimeout(resolve, 1000));
              continue;
            }
          }
          await new Promise((resolve) => setTimeout(resolve, updateIntervalMs));
        }
      };
      const task = run().catch((error: unknown) => { animationError = error; })
        .finally(() => animations.delete(textSegmentId));
      animations.set(textSegmentId, task);
      return Promise.resolve();
    },
    async finish(): Promise<void> {
      finishingAt = Date.now();
      await Promise.all(animations.values());
      if (animationError) throw animationError;
    },
    interrupt(): void {
      completeImmediately = true;
    },
    async stop(): Promise<void> {
      completeImmediately = true;
      stopAnimations = true;
      await Promise.all(animations.values());
    },
    resume(): void {
      completeImmediately = false;
      stopAnimations = false;
      finishingAt = undefined;
      animationError = undefined;
    },
    async finalDelivered(textSegmentId: string): Promise<boolean> {
      const { snapshots, final, deliveries } = await state(textSegmentId);
      if (final?.contentKind !== "final") return false;
      const text = snapshots.at(-1)?.text;
      if (text === undefined || text !== final.text) return false;
      const parts = splitTelegramText(text);
      return parts.length > 0 && parts.every((part, partIndex) =>
        deliveries.findLast((event) => event.partIndex === partIndex &&
          event.type === "telegram_delivery_succeeded")?.text === part);
    },
  };
}
