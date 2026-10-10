import type { HostEvent, RunHandle } from "../../host/host.js";
import type { TelegramHostTransport } from "./projection.js";
import { toolDisplayName } from "../../runtime/tool-display.js";
import type { DeliveryContent } from "../../runtime/content-delivery.js";

let nextDraftId = 1;

/** Stream public text units; settlement persists the same Markdown, never a folded card. */
export async function consumeNativeProgress(handle: RunHandle, options: TelegramHostTransport & {
  chatId: number; draftIntervalMs?: number; draftTimeoutMs?: number; progressTimeoutMs?: number;
  recordProgress?: (event: HostEvent, fact: Record<string, unknown>) => Promise<void>;
  deliver?: (event: HostEvent, content: DeliveryContent, signal?: AbortSignal) => Promise<{ complete: boolean; messageId?: number }>;
}, finish: (event: HostEvent) => Promise<void>) {
  const states = new Map<string, { text: string; active: boolean; started: number }>();
  let view = ""; let latest = ""; let draftId = nextDraftId++;
  let published = ""; let publishedAt = -Infinity; let lastAttempt = -Infinity; let retryAt = 0;
  let pending = Promise.resolve(); let busy = false; let ended = false; let control = false;
  let modelText = false; let lastEvent: HostEvent | undefined;
  let progressDisabled = false;
  const record = async (fact: Record<string, unknown>) => { if (lastEvent) await options.recordProgress?.(lastEvent, fact); };
  const renderStates = () => [...states.values()].map((state) => {
    const seconds = Math.floor((Date.now() - state.started) / 5000) * 5;
    return state.text + (state.active && seconds >= 5 ? `（已等待 ${seconds} 秒）` : "");
  }).join("\n\n");
  const setView = (id: string, text: string) => {
    if (view !== id) { view = id; draftId = nextDraftId++; published = ""; publishedAt = -Infinity; }
    latest = text;
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
  const persistStates = async () => {
    if (!states.size || control) return;
    if (progressDisabled) { states.clear(); return; }
    for (const state of states.values()) state.active = false;
    const text = renderStates();
    await record({ state: "sending", source: "status" });
    await persistProgress(async (signal) => {
      const pages = options.plan?.({ id: `${handle.runId}:status`, text, kind: "progress" }) ?? [text];
      for (const page of pages) {
        if (signal.aborted) return;
        const messageId = await (options.sendPage ?? options.send)(page, options.chatId, signal);
        if (!signal.aborted) await record({ state: "sent", source: "status", messageId });
      }
    });
    states.clear();
  };
  const timer = setInterval(() => {
    if (ended) return;
    if (!modelText && states.size) setView("status", renderStates());
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
          if (view === progress.segmentId) { await pending; latest = ""; modelText = false; }
        } else if (progress.type === "tool" || progress.kind === "status") {
          const id = progress.type === "tool" ? `tool:${progress.callId ?? progress.name}` : progress.segmentId;
          const active = progress.type === "tool" ? progress.state === "started" : progress.actionState === "started";
          const text = progress.type === "tool" ? `${{ started: "正在执行", completed: "已完成", failed: "执行失败", blocked: "执行被阻止" }[progress.state]}：${toolDisplayName(progress.name)}` : progress.text;
          if (active) for (const state of states.values()) state.active = false;
          const prior = states.get(id);
          states.set(id, { text, active, started: prior?.active && active ? prior.started : Date.now() });
          if (!modelText) { setView("status", renderStates()); publish(); }
        } else {
          if (!modelText) { await flushDraft(); await persistStates(); }
          modelText = true; setView(progress.segmentId, progress.text); publish();
          if (progress.finalized) {
            await flushDraft();
            if (progress.kind !== "final" && progress.formal) {
              await persistProgress(async (signal) => {
                if (options.deliver) {
                  const result = await options.deliver(event, { id: progress.segmentId, text: progress.text, kind: "progress", source: progress.source }, signal);
                  if (!result.complete) progressDisabled = true;
                }
                else await options.send(progress.text, options.chatId);
              });
              modelText = false; latest = "";
            }
          }
        }
      }
      if (["run_succeeded", "run_failed", "run_cancelled"].includes(event.type)) {
        ended = true; clearInterval(timer);
        await flushDraft(); await persistStates(); await finish(event);
      }
    }
    return await handle.done;
  } finally { ended = true; clearInterval(timer); await pending; }
}
