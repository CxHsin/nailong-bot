import { createReplayCache } from "./replay-cache.js";
import { estimateInput, modelInputBudget } from "./input-budget.js";
import { summaryInput, summarySource, validateSummary } from "./history-summary.js";
import type { Api, Context, Message, Model } from "@mariozechner/pi-ai";
import type { RuntimeLog } from "../runtime/runtime-types.js";
import { replayEvents, type Replay } from "./projection.js";
import { sourceDigest } from "../runtime/event-digest.js";
import { createCheckpointStore, type Checkpoint } from "./checkpoint.js";

export type CompactionConfig = { trigger?: number; target?: number; recentTokens?: number; summaryTokens?: number };
export function compactionConfig(config: CompactionConfig = {}) {
  const value = { trigger: config.trigger ?? 0.7, target: config.target ?? 0.4,
    recentTokens: config.recentTokens ?? 20000, summaryTokens: config.summaryTokens ?? 4000 };
  if (!Number.isFinite(value.trigger) || !Number.isFinite(value.target) || value.target <= 0 ||
    value.target >= value.trigger || value.trigger >= 1 || !Number.isSafeInteger(value.recentTokens) || value.recentTokens < 0 ||
    !Number.isSafeInteger(value.summaryTokens) || value.summaryTokens <= 0) throw new Error("上下文压缩水位或额度无效");
  return value;
}
function checkpointMessage(c: Pick<Checkpoint, "through" | "summary">): Message {
  return { role: "user", timestamp: 0, content: `历史摘要（有损投影，精确事实请核查原始日志；覆盖 ${c.through} 个事件）：\n${c.summary}` };
}
function contextMessages(replay: Replay, requestId: string, checkpoint?: Pick<Checkpoint, "through" | "summary">): Message[] {
  const kept = replay.units.filter((unit) => unit.through > (checkpoint?.through ?? 0) ||
    unit.requestId === requestId && unit.messages.every((message) => message.role === "user"));
  return [...(checkpoint ? [checkpointMessage(checkpoint)] : []), ...kept.flatMap((unit) => unit.messages)];
}
type Summarize = (context: Context, maxTokens: number) => Promise<string>;
export function createContextProjection(options: { log: RuntimeLog; dataDir: string; requestId: string;
  cacheIdentity?: string; signal?: AbortSignal; onCheckpointValidated?: () => void; onRestoreProgress?: (checked: number, total: number) => void;
  conversationId?: string; structured?: boolean; ratio?: number; ratios?: Record<string, number>; compaction?: CompactionConfig; summarize: Summarize }) {
  const store = createCheckpointStore(options.dataDir, "structured-text-v1", options.conversationId, options.log);
  const config = compactionConfig(options.compaction);
  const caches = new Map<string, ReturnType<typeof createReplayCache>>();
  return {
    async project(model: Model<Api>, context: Context, force = false, reserveTokens = 0,
      prepare?: (context: Context, sourceIds: string[]) => Promise<Message[]>): Promise<{ context: Context; maxTokens: number; sourceIds: string[] }> {
      const resolved = modelInputBudget(model, options.ratio, options.ratios);
      const ratio = resolved.ratio;
      const budget = resolved.budget - reserveTokens;
      const trigger = Math.floor(budget * config.trigger);
      const target = Math.floor(budget * config.target);
      const replayStarted = performance.now();
      const cacheKey = sourceDigest({ conversation: options.conversationId, model, structured: options.structured ?? true, identity: options.cacheIdentity });
      let cache = caches.get(cacheKey);
      if (!cache) { cache = createReplayCache(options.dataDir, cacheKey); caches.set(cacheKey, cache); }
      const replay = options.conversationId ? await cache.replay(options.log, options.requestId, model, options.structured ?? true, options.onRestoreProgress, options.signal) :
        await replayEvents(options.log, options.requestId, model, options.structured ?? true, options.onRestoreProgress, options.signal);
      const replayMs = performance.now() - replayStarted;
      let checkpoint = await store.load(replay.boundary, replay.events);
      const keptUnits = () => replay.units.filter((u) => u.through > (checkpoint?.through ?? 0) ||
        u.requestId === options.requestId && u.messages.every((message) => message.role === "user"));
      const sourceIds = () => keptUnits().flatMap((u) => u.sourceIds ?? []);
      let supplemental: Message[] = [];
      const compose = (value: Pick<Checkpoint, "through" | "summary"> | undefined = checkpoint): Context => {
        const messages = contextMessages(replay, options.requestId, value);
        if (supplemental.length) messages.splice(Math.max(0, messages.indexOf(replay.current)), 0, ...supplemental);
        return { ...context, messages };
      };
      if (prepare) supplemental = await prepare(compose(), sourceIds());
      let projected = compose();
      const initialTokens = estimateInput(projected);
      let attempts = 0;
      let failure: string | undefined;
      let releasedTokens = 0;
      const failureKey = sourceDigest({ context: projected, budget, config, model: `${model.provider}/${model.id}`, checkpoint: checkpoint?.id });
      if (initialTokens > trigger || force) {
        const failedBefore = (await options.log.read()).some((event) => event.type === "compaction_failed" && event.failureKey === failureKey);
        if (failedBefore) failure = "same_input_failed";
        else {
          // Whole ended turns and settled tool steps are indivisible. Current user/Skill instructions stay outside summaries.
          const candidates = replay.units.filter((unit, index, units) => unit.safe &&
            !units.slice(0, index).some((earlier) => !earlier.safe) && unit.through > (checkpoint?.through ?? 0) &&
            (unit.requestId !== options.requestId && units[index + 1]?.requestId !== unit.requestId ||
              unit.messages.some((message) => message.role === "toolResult")));
          let chosen: typeof candidates[number] | undefined;
          const summaryAllowance = Math.min(config.summaryTokens, Math.max(200, Math.floor(target / 4)));
          for (const candidate of candidates) {
            const suffix = compose({ through: candidate.through, summary: "" });
            chosen = candidate;
            const tail = estimateInput({ messages: suffix.messages.slice(1) });
            if (estimateInput(suffix) + summaryAllowance <= target && tail <= config.recentTokens) break;
          }
          if (!chosen) failure = "no_safe_history";
          else {
            const currentInstructions = replay.units.filter((unit) => unit.requestId === options.requestId && unit.messages.every((message) => message.role === "user"));
            const fold = replay.units.filter((unit) => unit.through > (checkpoint?.through ?? 0) && unit.through <= chosen.through && !currentInstructions.includes(unit));
            let input = summaryInput(checkpoint?.summary, fold.flatMap((unit) => unit.messages));
            const generate = async (source: Context) => {
              if (options.signal?.aborted) throw new DOMException("历史压缩已取消", "AbortError");
              attempts++;
              const summary = await options.summarize(source, Math.max(1, Math.min(config.summaryTokens, model.maxTokens, model.contextWindow - estimateInput(source))));
              if (options.signal?.aborted) throw new DOMException("历史压缩已取消", "AbortError");
              if (estimateInput({ messages: [{ role: "user", content: summary, timestamp: 0 }] }) > config.summaryTokens) throw new Error("summary_too_large");
              validateSummary(summary, summarySource(source), estimateInput(source));
              return summary;
            };
            if (estimateInput(input) > resolved.budget) {
              // Reconstruction after invalidation can exceed one summary request.
              // Two legal batches share the same two-call limit; the first replacement
              // stays uncommitted until the complete candidate reaches the target.
              const split = candidates.filter((candidate) => candidate.through < chosen.through).findLast((candidate) => {
                const first = fold.filter((unit) => unit.through <= candidate.through).flatMap((unit) => unit.messages);
                const rest = fold.filter((unit) => unit.through > candidate.through).flatMap((unit) => unit.messages);
                return estimateInput(summaryInput(checkpoint?.summary, first)) <= resolved.budget &&
                  estimateInput(summaryInput(undefined, rest)) + config.summaryTokens <= resolved.budget;
              });
              if (!split) failure = "summary_input_too_large";
              else try {
                const first = fold.filter((unit) => unit.through <= split.through).flatMap((unit) => unit.messages);
                const intermediate = await generate(summaryInput(checkpoint?.summary, first));
                input = summaryInput(intermediate, fold.filter((unit) => unit.through > split.through).flatMap((unit) => unit.messages));
                if (estimateInput(input) > resolved.budget) failure = "summary_input_too_large";
              } catch {
                if (options.signal?.aborted) throw new DOMException("历史压缩已取消", "AbortError");
                failure = "candidate_rejected";
              }
            }
            if (!failure) while (attempts < 2) {
              try {
                const summary = await generate(input);
                const value = { boundary: replay.boundary, through: chosen.through,
                  sourceDigest: sourceDigest(replay.events.slice(0, chosen.through)), summary,
                  lastEventDigest: sourceDigest(replay.events[chosen.through - 1]),
                  summaryStrategy: "structured-text-v1" as const,
                  previousId: checkpoint?.id, model: `${model.provider}/${model.id}`, ratio };
                const preview: Checkpoint = { ...value, version: 2, id: "candidate", createdAt: "" };
                const estimate = estimateInput(compose(preview));
                if (estimate >= initialTokens) throw new Error("no_reduction");
                if (estimate > target) throw new Error("target_not_reached");
                checkpoint = await store.save(value);
                projected = compose();
                releasedTokens = initialTokens - estimate;
                options.onCheckpointValidated?.();
                failure = undefined;
                break;
              } catch {
                if (options.signal?.aborted) throw new DOMException("历史压缩已取消", "AbortError");
                failure = "candidate_rejected";
              }
            }
          }
          if (failure) await options.log.append({ type: "compaction_failed", requestId: options.requestId,
            failureKey, reason: failure, attempts, initialTokens, budget, target, contextPolicy: "exclude" });
        }
      }
      const estimatedTokens = estimateInput(projected);
      await options.log.append({ type: "context_projected", requestId: options.requestId, estimatedTokens, initialTokens, budget, trigger, target,
        compactionAttempts: attempts, releasedTokens, degraded: failure, checkpointId: checkpoint?.id,
        coverage: { originalIds: sourceIds(), summaryIds: replay.units.filter((unit) => unit.through <= (checkpoint?.through ?? 0) && !keptUnits().includes(unit)).flatMap((unit) => unit.sourceIds ?? []) },
        diagnostics: replay.diagnostics, logBytes: await options.log.bytes(), replayMs, replayProcessedEvents: replay.processedEvents,
        processPeakRssBytes: process.resourceUsage().maxRSS * 1024 });
      if (estimatedTokens > budget || (force && failure)) throw new Error("上下文超过预算且无法有效压缩；请缩小输入或选择更大模型窗口");
      return { context: projected, maxTokens: Math.max(1, Math.min(model.maxTokens, model.contextWindow - estimatedTokens)), sourceIds: sourceIds() };
    },
  };
}