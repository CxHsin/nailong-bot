import { agentCommand } from "../../application/commands.js";
import { consumeNativeProgress } from "./native-progress.js";
import { toolDisplayName } from "../../runtime/tool-display.js";
import type { HostEvent, RunHandle } from "../../host/host.js";
import type { DeliveryContent, ContentTransport } from "../../runtime/content-delivery.js";

export type TelegramHostTransport = ContentTransport & {
  nativeStream?: boolean;
  draft?: (draftId: number, text: string, chatId: number, signal?: AbortSignal) => Promise<void>;
  send: (text: string, chatId: number) => Promise<number>;
  sendSticker?: (category: string, chatId: number) => Promise<number>;
  sendAnimation?: (animation: string, caption: string, chatId: number) => Promise<number>;
  sendProgress?: (text: string, chatId: number, source: "execution" | "progress-model") => Promise<number>;
};

/** Ephemeral segment drafts and a separate serial queue for immutable formal content. */
export function createTelegramHostProjection(options: TelegramHostTransport & {
  chatId: number;
  recordProgress?: (event: HostEvent, fact: Record<string, unknown>) => Promise<void>;
  progressTimeoutMs?: number;
  draftIntervalMs?: number;
  draftTimeoutMs?: number;
  onDelivered?: (event: HostEvent, messageId: number) => Promise<void>;
  deliver?: (event: HostEvent, content: DeliveryContent, signal?: AbortSignal) => Promise<{ complete: boolean; messageId?: number }>;
}) {
  let nextDraftId = 1;
  return {
    async consume(handle: RunHandle) {
      const original = handle;
      handle = { ...original, events: async function* () {
        for await (const event of original.events()) {
          if (event.type !== "input_receipt" && event.type !== "control_completed") { yield event; continue; }
          if (!event.text) continue;
          try {
            if (options.deliver) await options.deliver(event, { id: event.receiptId!, text: event.text, kind: "final", source: "execution" });
            else await options.send(event.text, options.chatId);
          } catch { /* Receipt delivery does not alter execution. */ }
        }
      } };
      if (options.nativeStream) return consumeNativeProgress(handle, options, async (event) => {
        if (event.type === "run_succeeded" && event.result?.stickerCategory && options.sendSticker) {
          const [id] = await Promise.all([options.sendSticker(String(event.result.stickerCategory), options.chatId),
            ...(event.result.stickerText && event.result.text ? [options.send(String(event.result.text), options.chatId)] : [])]);
          await options.onDelivered?.(event, id);
        } else if (event.type === "run_succeeded" && event.result?.animation && options.sendAnimation) {
          const id = await options.sendAnimation(String(event.result.animation), String(event.result.text ?? ""), options.chatId);
          await options.onDelivered?.(event, id);
        } else if (event.type === "run_succeeded" && event.result?.text) {
          const content: DeliveryContent = { id: String(event.result.finalSegmentId ?? event.result.resultId ?? event.runId), text: String(event.result.finalText ?? event.result.text), kind: "final", source: "execution" };
          const delivery = options.deliver ? await options.deliver(event, content) : { complete: true, messageId: await options.send(content.text, options.chatId) };
          if (delivery.complete && delivery.messageId !== undefined) await options.onDelivered?.(event, delivery.messageId);
        } else if (event.type === "run_failed" || event.type === "run_cancelled") await options.send(event.type === "run_failed" ? "这条消息处理失败，请稍后重试。" : "这条消息已取消。", options.chatId);
      });
      let draftId = nextDraftId++;
      let draftSegment: string | undefined;
      let current: { segmentId: string; text: string } | undefined;
      let tool = "";
      let latest = "";
      let published = "";
      let publishedAt = 0;
      let finished = false;
      let control = false;
      const statusLines = new Map<string, { text: string; startedAt: number; active: boolean }>();
      let actionView = false;
      const actionText = () => [...statusLines.values()].slice(-5).map((action) => {
        const seconds = Math.floor((Date.now() - action.startedAt) / 5000) * 5;
        return `${action.text}${action.active && seconds >= 5 ? `（已等待 ${seconds} 秒）` : ""}`;
      }).join("\n\n");
      const renderActions = () => [current && current.segmentId !== "runtime-status" ? current.text : "", actionText()].filter(Boolean).join("\n\n");
      const action = (id: string, text: string, active: boolean) => {
        if (active) for (const [key, previous] of statusLines) if (key !== id) previous.active = false;
        const prior = statusLines.get(id);
        if (active && prior && !prior.active) statusLines.delete(id);
        statusLines.set(id, { text, active, startedAt: prior?.active && active ? prior.startedAt : Date.now() });
        if (statusLines.size > 5) statusLines.delete(statusLines.keys().next().value!);
        if ((!current || current.segmentId === "runtime-status") && draftSegment !== "runtime-status") { draftSegment = "runtime-status"; draftId = nextDraftId++; published = ""; }
        actionView = true;
        tool = "";
        latest = renderActions();
        if (!current || current.segmentId === "runtime-status") current = { segmentId: "runtime-status", text: actionText() };
      };
      let unavailable = false;
      let sending = false;
      let pending = Promise.resolve();
      let formal = Promise.resolve();
      // Coalesce snapshots independently of execution and keep long-running drafts alive.
      const timer = setInterval(() => {
        if (actionView) latest = renderActions();
        if (!options.draft || control || finished || unavailable || sending || !latest ||
          latest === published && Date.now() - publishedAt < 15_000) return;
        const text = latest;
        const snapshotDraftId = draftId;
        sending = true;
        pending = new Promise<void>((resolve) => {
          const controller = new AbortController();
          const deadline = setTimeout(() => {
            unavailable = true;
            controller.abort();
            resolve(); // Also bound transports that ignore cancellation.
          }, options.draftTimeoutMs ?? 3_000);
          void Promise.resolve().then(() => options.draft!(snapshotDraftId, text, options.chatId, controller.signal)).then(() => {
            if (!controller.signal.aborted) {
              published = text;
              publishedAt = Date.now();
            }
          }).catch(() => {
            // Draft API/content/rate-limit failures must never prevent the final reply.
            unavailable = true;
          }).finally(() => {
            clearTimeout(deadline);
            resolve();
          });
        }).finally(() => { sending = false; });
      }, options.draftIntervalMs ?? 250);
      timer.unref();
      try {
        for await (const event of handle.events()) {
          if (finished) continue;
          if (event.type === "run_submitted") control = !!event.parts?.length && event.parts.every((part) => part.type === "text") &&
            !!agentCommand(event.parts.map((part) => part.type === "text" ? part.text : "").join("\n"));
          if (event.type === "run_started" && !control) latest = "处理中";
          if (event.type === "progress") {
            const progress = event.progress;
            if (!progress) latest = event.text ?? latest; // Legacy Host envelope compatibility.
            else {
              if (progress.type === "text") {
                if (progress.kind === "status") {
                  action(progress.segmentId, progress.text, progress.actionState === "started");
                  continue;
                }
                actionView = statusLines.size > 0;
                for (const previous of statusLines.values()) previous.active = false;
                if (draftSegment !== progress.segmentId) {
                  draftSegment = progress.segmentId;
                  draftId = nextDraftId++;
                  published = "";
                }
                current = { segmentId: progress.segmentId, text: progress.text };
                tool = "";
                if (progress.finalized && progress.formal) {
                  actionView = false;
                  latest = "";
                  const draftBarrier = pending;
                  formal = formal.then(async () => {
                    await draftBarrier;
                    try {
                      if (options.deliver) await options.deliver(event, { id: progress.segmentId, text: progress.text, kind: "progress", source: progress.source });
                      else if (options.sendProgress) await options.sendProgress(progress.text, options.chatId, progress.source ?? "execution");
                      else await options.send(progress.text, options.chatId);
                    } catch { /* A failed progress delivery must not prevent the final answer. */ }
                  });
                  current = undefined;
                }
              } else if (progress.type === "discard") {
                if (current?.segmentId === progress.segmentId) current = undefined;
              } else {
                if (progress.callId) {
                  const verb = { started: "正在执行", completed: "已完成", failed: "调用失败", blocked: "调用被阻止" }[progress.state];
                  action(`tool:${progress.callId}`, `${verb}：${toolDisplayName(progress.name)}`, progress.state === "started");
                  continue;
                }
                actionView = false;
                const verb = { started: "正在调用", completed: "已完成", failed: "调用失败", blocked: "调用被阻止" }[progress.state];
                tool = `${verb}：${toolDisplayName(progress.name)}`;
              }
              latest = (actionView ? renderActions() : [current?.text, tool].filter(Boolean).join("\n\n")) || "处理中";
            }
          }
          if (["run_succeeded", "run_failed", "run_cancelled"].includes(event.type)) {
            finished = true;
            clearInterval(timer);
            await pending;
            await formal;
            if (event.type === "run_succeeded" && event.result?.stickerCategory && options.sendSticker) {
              // Independent API requests: don't make the sticker wait for the text round trip.
              const [messageId] = await Promise.all([
                options.sendSticker(String(event.result.stickerCategory), options.chatId),
                ...(event.result.stickerText && event.result.text ? [options.send(String(event.result.text), options.chatId)] : []),
              ]);
              await options.onDelivered?.(event, messageId);
            } else if (event.type === "run_succeeded" && event.result?.animation && options.sendAnimation) {
              const messageId = await options.sendAnimation(String(event.result.animation), String(event.result.text ?? ""), options.chatId);
              await options.onDelivered?.(event, messageId);
            } else if (event.type === "run_succeeded" && event.result?.text) {
              const delivery = options.deliver ? await options.deliver(event, { id: String(event.result.finalSegmentId ?? event.result.resultId ?? event.runId),
                text: String(event.result.text), kind: "final", source: "execution" }) : { complete: true, messageId: await options.send(String(event.result.text), options.chatId) };
              if (delivery.complete && delivery.messageId !== undefined) await options.onDelivered?.(event, delivery.messageId);
            } else if (event.type === "run_failed") {
              await options.send("哎呀，奶龙的脑瓜子嗡嗡的！这条消息处理失败，请稍后重试。", options.chatId);
            } else if (event.type === "run_cancelled") {
              await options.send("这条消息已取消。", options.chatId);
            }
          }
        }
        return await handle.done;
      } finally {
        finished = true;
        clearInterval(timer);
        await pending;
      }
    },
  };
}
