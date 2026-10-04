import type { HostEvent, RunHandle } from "../../host/host.js";

export type TelegramHostTransport = {
  draft?: (draftId: number, text: string, chatId: number, signal?: AbortSignal) => Promise<void>;
  send: (text: string, chatId: number) => Promise<number>;
};

/** One best-effort live draft per Run; only the terminal message confirms delivery. */
export function createTelegramHostProjection(options: TelegramHostTransport & {
  chatId: number;
  draftIntervalMs?: number;
  draftTimeoutMs?: number;
  onDelivered?: (event: HostEvent, messageId: number) => Promise<void>;
}) {
  let nextDraftId = 1;
  return {
    async consume(handle: RunHandle) {
      const draftId = nextDraftId++;
      let current: { segmentId: string; text: string } | undefined;
      let tool = "";
      let latest = "";
      let published = "";
      let publishedAt = 0;
      let finished = false;
      let unavailable = false;
      let sending = false;
      let pending = Promise.resolve();
      // Coalesce snapshots independently of execution and keep long-running drafts alive.
      const timer = setInterval(() => {
        if (!options.draft || finished || unavailable || sending || !latest ||
          latest === published && Date.now() - publishedAt < 15_000) return;
        const text = latest;
        sending = true;
        pending = new Promise<void>((resolve) => {
          const controller = new AbortController();
          const deadline = setTimeout(() => {
            unavailable = true;
            controller.abort();
            resolve(); // Also bound transports that ignore cancellation.
          }, options.draftTimeoutMs ?? 3_000);
          void Promise.resolve().then(() => options.draft!(draftId, text, options.chatId, controller.signal)).then(() => {
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
      }, options.draftIntervalMs ?? 750);
      timer.unref();
      try {
        for await (const event of handle.events()) {
          if (finished) continue;
          if (event.type === "run_started") latest = "处理中";
          if (event.type === "progress") {
            const progress = event.progress;
            if (!progress) latest = event.text ?? latest; // Legacy Host envelope compatibility.
            else {
              if (progress.type === "text") {
                current = { segmentId: progress.segmentId, text: progress.text };
                tool = "";
              } else if (progress.type === "discard") {
                if (current?.segmentId === progress.segmentId) current = undefined;
              } else {
                const verb = { started: "正在调用", completed: "已完成", failed: "调用失败", blocked: "调用被阻止" }[progress.state];
                tool = `${verb}：${progress.name}`;
              }
              latest = [current?.text, tool].filter(Boolean).join("\n\n") || "处理中";
            }
          }
          if (["run_succeeded", "run_failed", "run_cancelled"].includes(event.type)) {
            finished = true;
            clearInterval(timer);
            await pending;
            if (event.type === "run_succeeded" && event.result?.text) {
              const messageId = await options.send(String(event.result.text), options.chatId);
              await options.onDelivered?.(event, messageId);
            } else if (event.type === "run_failed") {
              await options.send("抱歉，这条消息处理失败，请稍后重试。", options.chatId);
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
