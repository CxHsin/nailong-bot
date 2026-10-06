import type { HostEvent, RunHandle } from "../../host/host.js";
import type { TelegramHostTransport } from "./projection.js";
import { toolDisplayName } from "../../runtime/tool-display.js";

/** Visible commentary only. Never collects Provider thinking events. */
export async function consumeProgressJournal(handle: RunHandle, options: TelegramHostTransport & {
  chatId: number; progressIntervalMs?: number; progressTimeoutMs?: number;
  recordProgress?: (event: HostEvent, fact: Record<string, unknown>) => Promise<void>;
}, finish: (event: HostEvent) => Promise<void>) {
  const entries = new Map<string, { text: string; active: boolean; started: number }>();
  const pages: Array<{ id: number; text: string }> = [];
  let control = false; let ended = false; let disabled = false; let busy = false;
  let pending = Promise.resolve(); let lastAttempt = -Infinity; let lastEvent: HostEvent | undefined;
  const record = async (fact: Record<string, unknown>) => { if (lastEvent) await options.recordProgress?.(lastEvent, fact); };
  const render = () => [...entries.values()].map((entry) => {
    const seconds = Math.floor((Date.now() - entry.started) / 5000) * 5;
    return entry.text + (entry.active && seconds >= 5 ? `（已等待 ${seconds} 秒）` : "");
  }).filter(Boolean).join("\n\n");
  const update = (id: string, text: string, active = false) => {
    const prior = entries.get(id);
    if (active) for (const [key, item] of entries) if (key !== id) item.active = false;
    entries.set(id, { text, active, started: prior?.active && active ? prior.started : Date.now() });
  };
  const flush = async () => {
    if (disabled || control || !entries.size) return;
    const text = render();
    const planned = options.plan!({ id: `${handle.runId}:journal`, text, kind: "progress", source: "execution" });
    for (let index = 0; index < planned.length; index++) {
      if (disabled) return;
      const html = planned[index]!;
      if (pages[index]?.text === html) continue;
      if (pages[index]) {
        await options.editPage!(pages[index]!.id, html, options.chatId);
        pages[index]!.text = html;
        await record({ state: "edited", page: index, messageId: pages[index]!.id });
      } else {
        await record({ state: "sending", page: index });
        if (disabled) return;
        const id = await options.sendPage!(html, options.chatId);
        pages.push({ id, text: html });
        await record({ state: "sent", page: index, messageId: id });
      }
    }
    // A discarded preview can shrink the page count. Withdraw its text without resending.
    for (let index = planned.length; index < pages.length; index++) {
      if (disabled) return;
      const text = "<blockquote expandable>此段未采用。</blockquote>";
      if (pages[index]!.text === text) continue;
      await options.editPage!(pages[index]!.id, text, options.chatId); pages[index]!.text = text;
    }
  };
  const schedule = (force = false) => {
    if (busy || disabled || !force && Date.now() - lastAttempt < (options.progressIntervalMs ?? 1000)) return;
    lastAttempt = Date.now(); busy = true;
    pending = new Promise<void>((resolve) => {
      const timeout = setTimeout(() => { disabled = true; void record({ state: "failed_or_unknown", reason: "timeout" }).catch(() => {}); resolve(); }, options.progressTimeoutMs ?? 3000);
      void flush().catch(async () => { disabled = true; await record({ state: "failed_or_unknown" }).catch(() => {}); })
        .finally(() => { clearTimeout(timeout); resolve(); });
    }).finally(() => { busy = false; });
  };
  const timer = setInterval(() => { if (!ended) schedule(); }, 250); timer.unref();
  try {
    for await (const event of handle.events()) {
      lastEvent = event;
      if (ended) continue;
      if (event.type === "run_submitted") control = !!event.parts?.length && event.parts.every((part) => part.type === "text") &&
        event.parts.map((part) => part.type === "text" ? part.text : "").join("\n").trim().startsWith("/");
      const progress = event.progress;
      if (event.type === "progress" && progress) {
        if (progress.type === "discard") entries.delete(progress.segmentId);
        else if (progress.type === "text" && progress.kind !== "final") {
          update(progress.segmentId, progress.text, progress.actionState === "started");
          if (progress.kind !== "status") for (const entry of entries.values()) entry.active = false;
        } else if (progress.type === "tool") {
          const verb = { started: "正在执行", completed: "已完成", failed: "执行失败", blocked: "执行被阻止" }[progress.state];
          update(`tool:${progress.callId ?? progress.name}`, `${verb}：${toolDisplayName(progress.name)}`, progress.state === "started");
        }
        schedule();
      }
      if (["run_succeeded", "run_failed", "run_cancelled"].includes(event.type)) {
        ended = true; clearInterval(timer);
        for (const entry of entries.values()) entry.active = false;
        if (entries.size) update("terminal", event.type === "run_succeeded" ? "已完成" : event.type === "run_cancelled" ? "已取消" : "本轮处理失败");
        await pending; schedule(true); await pending;
        await finish(event);
      }
    }
    return await handle.done;
  } finally { ended = true; clearInterval(timer); await pending; }
}
