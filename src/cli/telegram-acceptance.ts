import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import type { HostEvent, RunHandle } from "../host/host.js";
import type { RunProgress } from "../runtime/progress.js";
import { createTelegramHostProjection, type TelegramHostTransport, telegramEnvironment } from "../channel/telegram/index.js";
import { planTelegramMarkdown } from "../telegram/telegram-markdown.js";
import type { BuildIdentity } from "../runtime/build-identity.js";

export const acceptanceScenario = {
  status: "Telegram 展示验收：正在准备固定测试上下文……",
  finding: "**展示验收进展**：已收到固定测试资料，接下来核对 Markdown 和长文本分页。",
  finalText: "# Telegram 流式展示验收\n\n**加粗**、*斜体*、`行内代码`、[链接](https://core.telegram.org/bots/api)。\n\n" +
    "> 引用应在草稿与正式消息中保持一致。\n\n| 项目 | 预期 |\n| --- | --- |\n| 流式正文 | 持续追加 |\n| 保存排版 | 与草稿一致 |\n\n" +
    "1. 长代码块分页：\n   ```text\n" + Array.from({ length: 95 }, (_, index) => `   ${index + 1}: 固定测试行，用于核对长内容分页后代码块和列表缩进是否保持。\n`).join("") +
    "   ```\n\n验收结束标记：全文应保存，最后一页包含这一行。",
};

export function acceptanceOptions(args: string[], env: Record<string, string | undefined>) {
  if (args.length === 1 && args[0] === "--help") return { mode: "help" as const };
  if (!args.length) return { mode: "preview" as const };
  if (args.length !== 3 || args[0] !== "--send" || args[1] !== "--chat-id" || !/^[1-9]\d*$/.test(args[2]!)) throw new Error("参数无效");
  const telegram = telegramEnvironment(env, () => {});
  const chatId = Number(args[2]);
  if (!Number.isSafeInteger(chatId) || chatId !== telegram.ownerId) throw new Error("目标必须是已配置 owner 的私聊");
  return { mode: "send" as const, chatId, token: telegram.token };
}

function acceptanceRun(chatId: number, wait: (ms: number) => Promise<unknown>): RunHandle {
  const runId = randomUUID(); let sequence = 0;
  const event = (type: HostEvent["type"], progress?: RunProgress): HostEvent => ({ type, schemaVersion: 1, runId,
    conversationId: `telegram:private:${chatId}`, sequence: ++sequence, at: new Date().toISOString(),
    ...(progress ? { progress } : {}), ...(type === "run_succeeded" ? { result: { text: acceptanceScenario.finalText } } : {}) });
  let complete!: (event: HostEvent) => void;
  const done = new Promise<HostEvent>((resolve) => { complete = resolve; });
  const text = (segmentId: string, kind: "progress" | "final", value: string, finalized: boolean) => event("progress", {
    type: "text", segmentId, kind, text: value, finalized, formal: finalized && kind === "progress", source: "execution",
    phase: kind === "progress" ? "commentary" : "final_answer", phaseSource: "native",
  });
  return { runId, conversationId: `telegram:private:${chatId}`, done, cancel: async () => false,
    async *events() {
      yield event("run_started");
      yield event("progress", { type: "text", segmentId: "prep", kind: "status", text: acceptanceScenario.status, finalized: true, actionState: "started" });
      await wait(700);
      yield event("progress", { type: "text", segmentId: "prep", kind: "status", text: "固定测试上下文已准备好。", finalized: true, actionState: "completed" });
      await wait(500);
      for (const [id, kind, value] of [["finding", "progress", acceptanceScenario.finding], ["final", "final", acceptanceScenario.finalText]] as const) {
        const characters = Array.from(value); let length = 0;
        while (length < characters.length) {
          // Keep the beginning readable; accelerate only the long pagination fixture.
          length = Math.min(characters.length, length + (length < 180 ? 8 : 500));
          yield text(id, kind, characters.slice(0, length).join(""), false); await wait(300);
        }
        yield text(id, kind, value, true); await wait(500);
      }
      const terminal = event("run_succeeded"); yield terminal; complete(terminal);
    } };
}

/** API receipts prove transport acceptance; visual animation/rendering remains a human check. */
export async function runTelegramAcceptance(transport: TelegramHostTransport, chatId: number, identity: BuildIdentity,
  wait: (ms: number) => Promise<unknown> = delay, draftIntervalMs = 250) {
  const receipts: Array<Record<string, unknown>> = [];
  const sent: Array<{ characters: number; messageId: number }> = [];
  const drafts: Array<{ draftId: number; segment: string; characters: number }> = [];
  let draftCalls = 0; let draftSuccesses = 0; let formalFailures = 0;
  const run = acceptanceRun(chatId, wait);
  const sendPage = async (page: string, target: number, signal?: AbortSignal) => {
    try {
      const id = await (transport.sendPage ?? transport.send)(page, target, signal);
      sent.push({ characters: page.length, messageId: id }); return id;
    } catch (error) { formalFailures++; throw error; }
  };
  let completed = false;
  try { await createTelegramHostProjection({ ...transport, chatId, sendPage, draftIntervalMs,
    send: async (value, target) => {
      let first: number | undefined;
      for (const page of planTelegramMarkdown(value)) { const id = await sendPage(page, target); first ??= id; }
      if (first === undefined) throw new Error("验收内容为空"); return first;
    },
    draft: async (id, value, target, signal) => {
      draftCalls++; await transport.draft!(id, value, target, signal); draftSuccesses++;
      drafts.push({ draftId: id, segment: acceptanceScenario.finding.startsWith(value) ? "finding" :
        acceptanceScenario.finalText.startsWith(value) ? "final" : "status", characters: value.length });
    },
    recordProgress: async (_event, fact) => { receipts.push(fact); },
  }).consume(run); completed = true; }
  catch { /* Return partial receipts; never expose the transport's token URL or error text. */ }
  const appended = (segment: string) => {
    const entries = drafts.filter((draft) => draft.segment === segment);
    return entries.some((entry, index) => entries.slice(index + 1).some((later) => later.draftId === entry.draftId && later.characters > entry.characters));
  };
  return { runId: run.runId, identity, expectedFinalPages: planTelegramMarkdown(acceptanceScenario.finalText).length,
    draftCalls, draftSuccesses, drafts, sent, receipts, apiAcceptance: completed && appended("finding") && appended("final") && formalFailures === 0 &&
      sent.length === planTelegramMarkdown(acceptanceScenario.finalText).length + 2 ? "passed" : "incomplete",
    visualAcceptance: "pending" };
}
