import { estimateInput, modelInputBudget } from "./input-budget.js";
import { summaryInput, summarySource, validateSummary } from "./history-summary.js";
import { createHash } from "node:crypto";
import type { Api, Context, Message, Model } from "@mariozechner/pi-ai";
import type { RuntimeLog } from "../runtime/runtime-types.js";
import { replayEvents, type Replay, type ReplayUnit } from "./projection.js";
import { sourceDigest } from "../runtime/event-digest.js";
import { createCheckpointStore, type Checkpoint } from "./checkpoint.js";

function checkpointMessage(c: Checkpoint): Message {
  return { role: "user", timestamp: 0, content: `历史摘要（有损投影，精确事实请核查原始日志；覆盖 ${c.through} 个事件）：\n${c.summary}` };
}
function contextMessages(replay: Replay, checkpoint?: Checkpoint): Message[] {
  const suffix = replay.units.filter((u) => u.through > (checkpoint?.through ?? 0)).flatMap((u) => u.messages);
  if (checkpoint && !suffix.includes(replay.current)) {
    const currentInput = replay.units.find((unit) => unit.messages.includes(replay.current));
    suffix.unshift(...(currentInput?.messages ?? [replay.current]));
  }
  return checkpoint ? [checkpointMessage(checkpoint), ...suffix] : suffix;
}
type Summarize = (context: Context, maxTokens: number) => Promise<string>;
export function createContextProjection(options: { log: RuntimeLog; dataDir: string; requestId: string;
  conversationId?: string; structured?: boolean; ratio?: number; ratios?: Record<string, number>; summarize: Summarize }) {
  const store = createCheckpointStore(options.dataDir, "structured-text-v1", options.conversationId);
  return {
    async project(model: Model<Api>, context: Context, force = false, reserveTokens = 0): Promise<{ context: Context; maxTokens: number; sourceIds: string[] }> {
      const resolved = modelInputBudget(model, options.ratio, options.ratios);
      const ratio = resolved.ratio;
      const budget = resolved.budget - reserveTokens;
      const replayStarted = performance.now();
      const replay = await replayEvents(options.log, options.requestId, model, options.structured ?? true);
      const replayMs = performance.now() - replayStarted;
      const processPeakRssBytes = process.resourceUsage().maxRSS * 1024;
      let checkpoint = await store.load(replay.boundary, replay.events);
      const messagesWithFeedback = (checkpoint?: Checkpoint) => contextMessages(replay, checkpoint);
      const compose = () => ({ ...context, messages: messagesWithFeedback(checkpoint) });
      let projected = compose();
      const recentIds = [...new Set(replay.units.map((u) => u.requestId).filter((id) => id !== options.requestId))].slice(-3);
      // A safe cut is after a whole ended request, or a settled earlier step of the current request.
      const candidates = replay.units.filter((unit, index, units) => {
        if (!unit.safe || units.slice(0, index).some((u) => !u.safe) || unit.through <= (checkpoint?.through ?? 0)) return false;
        const next = units[index + 1];
        const wholeRequest = unit.requestId !== options.requestId && next?.requestId !== unit.requestId;
        const currentStep = unit.messages.some((m) => m.role === "toolResult") &&
          next?.requestId === unit.requestId;
        return wholeRequest || currentStep;
      });
      const preferred = candidates.filter((c) => !recentIds.includes(c.requestId) && c.requestId !== options.requestId);
      const ordered = [...preferred, ...candidates.filter((c) => !preferred.includes(c))];
      let forcedOnce = false;
      for (const candidate of ordered) {
        if (estimateInput(projected) <= budget && (!force || forcedOnce)) break;
        if (candidate.through <= (checkpoint?.through ?? 0)) continue;
        const fold = replay.units.filter((u) => u.through > (checkpoint?.through ?? 0) && u.through <= candidate.through);
        const history = fold.flatMap((u) => u.summaryMessages ?? u.messages);
        try {
          let input = summaryInput(checkpoint?.summary, history);
          if (estimateInput(input) > budget) {
            for (const message of history) {
              if (message.role !== "toolResult") continue;
              const call = history.find((item) => item.role === "assistant" &&
                item.content.some((part) => part.type === "toolCall" && part.id === message.toolCallId));
              if (!call) throw new Error("历史摘要无法配对工具调用与结果");
              const unit = fold.find((item) => (item.summaryMessages ?? item.messages).includes(message));
              const sourceEventIndex = replay.events.findIndex((event) => event.type === "tool_result" &&
                event.requestId === unit?.requestId && event.toolCallId === message.toolCallId);
              if (sourceEventIndex < 0) throw new Error("历史摘要缺少结果事件身份");
              if (message.content.some((part) => part.type !== "text")) {
                throw new Error("非文本工具结果无法安全分段摘要");
              }
              const original = JSON.stringify(message.content);
              const resultHash = createHash("sha256").update(original).digest("hex");
              let position = 0;
              let rolling = checkpoint?.summary;
              let part = 0;
              while (position < original.length) {
                let low = 0;
                let high = Math.min(original.length - position, 12000);
                const makeChunk = (length: number) => summaryInput(rolling, [call, { ...message, content: [
                  { type: "text", text: JSON.stringify({ toolCallId: message.toolCallId,
                    sourceEventIndex, sourceEventDigest: sourceDigest(replay.events[sourceEventIndex]),
                    part: part + 1, start: Buffer.byteLength(original.slice(0, position)),
                    end: Buffer.byteLength(original.slice(0, position + length)), resultHash,
                    text: original.slice(position, position + length) }) },
                ] }]);
                while (low < high) {
                  const middle = Math.ceil((low + high) / 2);
                  if (estimateInput(makeChunk(middle)) <= budget) low = middle;
                  else high = middle - 1;
                }
                if (!low) throw new Error("历史摘要最小片段超过预算");
                if (position + low < original.length && /[\uD800-\uDBFF]/.test(original[position + low - 1]!)) low--;
                if (!low) throw new Error("历史摘要最小片段超过预算");
                const chunk = makeChunk(low);
                rolling = await options.summarize(chunk, Math.max(1, Math.min(8192, model.maxTokens,
                  model.contextWindow - estimateInput(chunk))));
                validateSummary(rolling, summarySource(chunk), estimateInput(chunk));
                position += low;
                part++;
              }
              message.content = [{ type: "text", text: `工具结果已按原文分 ${part} 片摘要；toolCallId=${message.toolCallId}；SHA-256=${resultHash}；摘要：${rolling}` }];
              input = summaryInput(checkpoint?.summary, history);
              if (estimateInput(input) <= budget) break;
            }
            if (estimateInput(input) > budget) throw new Error("历史摘要输入中的完整步骤超过预算");
          }
          const summary = await options.summarize(input, Math.max(1, Math.min(8192, model.maxTokens,
            model.contextWindow - estimateInput(input))));
          validateSummary(summary, summarySource(input), estimateInput(input));
          const value = { boundary: replay.boundary, through: candidate.through,
            sourceDigest: sourceDigest(replay.events.slice(0, candidate.through)), summary,
            lastEventDigest: sourceDigest(replay.events[candidate.through - 1]),
            summaryStrategy: "structured-text-v1" as const,
            previousId: checkpoint?.id, model: `${model.provider}/${model.id}`, ratio };
          const preview: Checkpoint = { ...value, version: 2, id: "candidate", createdAt: "" };
          if (estimateInput({ ...context, messages: messagesWithFeedback(preview) }) >= estimateInput(projected)) {
            throw new Error("历史摘要没有缩小上下文");
          }
          checkpoint = await store.save(value);
          projected = compose();
          forcedOnce = true;
        } catch (error) {
          await options.log.append({ type: "projection_failed", requestId: options.requestId,
            reason: "checkpoint_failed", error: String(error) });
          if (estimateInput(projected) > budget || force) throw error;
          break;
        }
      }
      const estimatedTokens = estimateInput(projected);
      if (estimatedTokens > budget || (force && !forcedOnce)) throw new Error("上下文超过预算且没有可压缩的完整历史");
      await options.log.append({ type: "context_projected", requestId: options.requestId, estimatedTokens, budget,
        checkpointId: checkpoint?.id, diagnostics: replay.diagnostics,
        logBytes: await options.log.bytes(), replayMs, processPeakRssBytes });
      return { context: projected, maxTokens: Math.max(1, Math.min(model.maxTokens, model.contextWindow - estimatedTokens)),
        sourceIds: replay.units.filter((u) => u.through > (checkpoint?.through ?? 0)).flatMap((u) => u.sourceIds ?? []) };
    },
  };
}
