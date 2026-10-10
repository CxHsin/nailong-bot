import type { HostEvent, RunHandle } from "../../host/host.js";
import type { TelegramHostTransport } from "./projection.js";
import { toolDisplayName } from "../../runtime/tool-display.js";
import type { DeliveryContent } from "../../runtime/content-delivery.js";
import { planProgressDetails, statusMarkdown } from "./status-details.js";

let nextDraftId = 1;

/** One Run draft accumulates public progress; the terminal saves one journal and a separate final answer. */
export async function consumeNativeProgress(handle: RunHandle, options: TelegramHostTransport & {
  chatId: number; draftIntervalMs?: number; draftTimeoutMs?: number; progressTimeoutMs?: number;
  recordProgress?: (event: HostEvent, fact: Record<string, unknown>) => Promise<void>;
  deliver?: (event: HostEvent, content: DeliveryContent, signal?: AbortSignal) => Promise<{ complete: boolean; messageId?: number }>;
}, finish: (event: HostEvent) => Promise<void>) {
  const journal = new Map<string, { text: string; status: boolean; active: boolean; started: number; settled: boolean }>();
  const finals = new Map<string, string>();
  let latest = ""; const draftId = nextDraftId++;
  let published = ""; let publishedAt = -Infinity; let lastAttempt = -Infinity; let retryAt = 0;
  let pending = Promise.resolve(); let busy = false; let ended = false; let control = false;
  let lastEvent: HostEvent | undefined;
  let progressDisabled = false;
  let journalPlanFailed = false;
  const record = async (fact: Record<string, unknown>) => { if (lastEvent) await options.recordProgress?.(lastEvent, fact); };
  const journalPages = (open = false, settledOnly = false) => {
    try {
      const pages = planProgressDetails([...journal.values()].filter((unit) => !settledOnly || unit.settled).map((state) => {
        const seconds = Math.floor((Date.now() - state.started) / 5000) * 5;
        const text = state.text + (state.active && seconds >= 5 ? `（已等待 ${seconds} 秒）` : "");
        return state.status ? statusMarkdown(text) : text;
      }).join("\n\n"), open);
      journalPlanFailed = false;
      return pages;
    } catch {
      // Presentation failures must not stop consuming the Run or its final answer.
      if (!journalPlanFailed) void record({ state: "failed_or_unknown", source: "journal", reason: "planning" }).catch(() => {});
      journalPlanFailed = true;
      return [];
    }
  };
  const render = () => {
    const pages = journalPages(true); const progress = pages.join("\n\n");
    const final = [...finals.values()].join("\n\n");
    const joined = [progress, final].filter(Boolean).join("\n\n");
    if (joined.length <= 32768) return joined;
    const tail = [pages.at(-1), final].filter(Boolean).join("\n\n");
    return final ? tail.length <= 32768 ? tail : final : pages.at(-1) ?? "";
  };
  const publish = (force = false) => {
    if (!options.draft || control || busy || !latest || Date.now() < retryAt || !force && Date.now() - lastAttempt < (options.draftIntervalMs ?? 250)) return;
    const text = latest; const id = draftId;
    if (text === published && Date.now() - publishedAt < 15000) return;
    busy = true; lastAttempt = Date.now();
    pending = new Promise<void>((resolve) => {
      const controller = new AbortController(); let settled = false;
      const fail = async (error?: unknown) => {
        if (settled) return; settled = true;
        const value = error as { error_code?: unknown; parameters?: { retry_after?: unknown } } | undefined;
        const seconds = value?.parameters?.retry_after;
        retryAt = Date.now() + (typeof seconds === "number" && Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : 1000);
        await record({ state: "draft_retry", reason: error ? "rejected" : "timeout",
          ...(typeof value?.error_code === "number" ? { errorCode: value.error_code } : {}) }).catch(() => {});
      };
      const timeout = setTimeout(() => {
        controller.abort(); void fail().finally(resolve);
      }, options.draftTimeoutMs ?? 3000);
      void Promise.resolve().then(() => options.draft!(id, text, options.chatId, controller.signal)).then(async () => {
        if (settled || controller.signal.aborted) return;
        settled = true; published = text; publishedAt = Date.now(); retryAt = 0;
        await record({ state: "drafted", draftId: id });
      }).catch(fail).finally(() => { clearTimeout(timeout); resolve(); });
    }).finally(() => { busy = false; });
  };
  const flushDraft = async () => { await pending; publish(true); await pending; };
  const persistProgress = async (send: (signal: AbortSignal) => Promise<void>) => {
    if (progressDisabled) return;
    const controller = new AbortController(); let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([send(controller.signal), new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => { controller.abort(); reject(new Error("progress timeout")); }, options.progressTimeoutMs ?? 3000);
      })]);
    } catch {
      progressDisabled = true; controller.abort();
      await record({ state: "failed_or_unknown", source: "progress" }).catch(() => {});
    } finally { clearTimeout(timeout); }
  };
  const persistJournal = async () => {
    if (!journal.size || control || progressDisabled) return;
    for (const unit of journal.values()) unit.active = false;
    const pages = journalPages(false, true);
    const segmentIds = [...journal].filter(([, unit]) => !unit.status && unit.settled).map(([id]) => id);
    if (!pages.length) return;
    await record({ state: "sending", source: "journal", segmentIds });
    await persistProgress(async (signal) => {
      for (const page of pages) {
        if (signal.aborted) return;
        const messageId = await (options.sendPage ?? options.send)(page, options.chatId, signal);
        if (!signal.aborted) await record({ state: "sent", source: "journal", segmentIds, messageId });
      }
    });
  };
  const timer = setInterval(() => {
    if (ended) return;
    latest = render();
    publish();
  }, options.draftIntervalMs ?? 250); timer.unref();
  try {
    for await (const event of handle.events()) {
      lastEvent = event;
      if (ended) continue;
      if (event.type === "run_submitted") control = !!event.parts?.length && event.parts.every((part) => part.type === "text") &&
        event.parts.map((part) => part.type === "text" ? part.text : "").join("\n").trim().startsWith("/");
      const progress = event.progress;
      if (event.type === "progress" && progress && !control) {
        if (progress.type === "discard") {
          await pending; journal.delete(progress.segmentId); finals.delete(progress.segmentId);
        } else if (progress.type === "tool" || progress.kind === "status") {
          const id = progress.type === "tool" ? `tool:${progress.callId ?? progress.name}` : progress.segmentId;
          const active = progress.type === "tool" ? progress.state === "started" : progress.actionState === "started";
          const text = progress.type === "tool" ? `${{ started: "正在执行", completed: "已完成", failed: "执行失败", blocked: "执行被阻止" }[progress.state]}：${toolDisplayName(progress.name)}` : progress.text;
          if (active) for (const unit of journal.values()) unit.active = false;
          const prior = journal.get(id);
          journal.set(id, { text, status: true, active, settled: true, started: prior?.active && active ? prior.started : Date.now() });
        } else {
          if (progress.kind === "final") {
            journal.delete(progress.segmentId); finals.set(progress.segmentId, progress.text);
          } else {
            finals.delete(progress.segmentId);
            journal.set(progress.segmentId, { text: progress.text, status: false, active: false, started: Date.now(), settled: progress.finalized && progress.formal === true });
          }
        }
        latest = render(); publish();
      }
      if (["run_succeeded", "run_failed", "run_cancelled"].includes(event.type)) {
        ended = true; clearInterval(timer);
        await flushDraft(); await persistJournal(); await finish(event);
      }
    }
    return await handle.done;
  } finally { ended = true; clearInterval(timer); await pending; }
}
