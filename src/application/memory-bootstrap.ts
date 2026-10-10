import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { Api, Context, Model } from "@mariozechner/pi-ai";
import { memoryNodes, memoryExclusions, memoryQualification } from "../runtime/memory-facts.js";
import { sourceDigest } from "../runtime/event-digest.js";
import type { RuntimeLog } from "../runtime/runtime-types.js";
import { createMemoryProjection } from "../memory/projection.js";
import type { createEmbeddingClient } from "../memory/embedding.js";
import { memoryGraph } from "../memory/graph.js";
import { MEMORY_ALGORITHM, learningSignal, memoryDynamics, type MemoryDynamics } from "../memory/dynamics.js";
import { recallConfig, type RecallConfig } from "../memory/recall.js";
import { historicalMemoryContext } from "./historical-memory-context.js";
import { estimateInput, modelInputBudget } from "../context/input-budget.js";
import { composeMemory, memoryBudget, type MemoryBudget } from "./memory-context.js";
import { persistMemoryLearning } from "./memory-learning.js";
import { MEMORY_INITIALIZATION_DIR } from "../memory/cache.js";

export function createMemoryBootstrap(options: { dataDir: string; model: Model<Api>; embedding?: ReturnType<typeof createEmbeddingClient>;
  dynamics?: Partial<MemoryDynamics>; recall?: Partial<RecallConfig>; budget?: MemoryBudget; ratio?: number; ratios?: Record<string, number> }) {
  const workers = new Map<RuntimeLog, Promise<void>>(); let stopped = false;
  const controller = new AbortController();
  const pause = (ms: number) => new Promise<void>((resolve) => {
    const finish = () => { clearTimeout(timer); controller.signal.removeEventListener("abort", finish); resolve(); };
    const timer = setTimeout(finish, ms); controller.signal.addEventListener("abort", finish, { once: true });
    if (stopped) finish();
  });
  async function run(log: RuntimeLog, userId: number, beforeRequest?: string, context: Context = { messages: [] }) {
    const all = await log.read();
    const cutoff = beforeRequest ? all.findIndex((event) => event.requestId === beforeRequest && event.role === "user") : all.length;
    const inputBudget = modelInputBudget(options.model, options.ratio, options.ratios).budget;
    const configDigest = sourceDigest({ version: "causal-settlement-v2", model: `${options.model.provider}/${options.model.id}`, embedding: options.embedding?.identity,
      dynamics: memoryDynamics(options.dynamics), recall: recallConfig(options.recall), inputBudget, budget: memoryBudget(inputBudget, options.budget) });
    const namespaceBinding = (events: Awaited<ReturnType<RuntimeLog["read"]>>, simulationId: unknown) =>
      events.findLast((event) => event.type === "memory_bootstrap_namespace" && event.simulationId === simulationId);
    let start = all.findLast((event) => event.type === "memory_bootstrap_started" && event.userId === userId && event.algorithm === MEMORY_ALGORITHM && event.configDigest === configDigest &&
      (!options.embedding?.dimension() || !namespaceBinding(all, event.simulationId) || namespaceBinding(all, event.simulationId)!.embedding === options.embedding.namespace()));
    if (!start) {
      const previousStart = all.find((event) => event.type === "memory_bootstrap_started" && event.userId === userId);
      const through = previousStart ? Number(previousStart.through) : cutoff < 0 ? all.length : cutoff;
      await log.append({ type: "memory_bootstrap_started", userId, algorithm: MEMORY_ALGORITHM, simulationId: randomUUID(), through,
        configDigest, supersedesSimulationId: previousStart?.simulationId,
        prefixDigest: sourceDigest(all.slice(0, through)), inputBudget, budget: memoryBudget(inputBudget, options.budget),
        model: `${options.model.provider}/${options.model.id}`, embedding: options.embedding?.identity, exclusionDigest: sourceDigest([...memoryExclusions(all)]),
        context: { systemPrompt: context.systemPrompt, tools: context.tools }, contextMode: "bounded-original-replay" });
      start = (await log.read()).findLast((event) => event.type === "memory_bootstrap_started" && event.userId === userId)!;
    }
    const source = all.slice(0, Number(start.through));
    if (sourceDigest(source) !== start.prefixDigest) throw new Error("历史记忆源前缀不一致");
    const simulationId = String(start.simulationId);
    const bindNamespace = async () => {
      if (!options.embedding?.dimension()) return true;
      const events = await log.read();
      const bound = namespaceBinding(events, simulationId);
      if (bound) return bound.embedding === options.embedding.namespace();
      await log.append({ type: "memory_bootstrap_namespace", userId, simulationId, embedding: options.embedding.namespace(), dimension: options.embedding.dimension() });
      return true;
    };
    const previous = all.findLast((event) => event.type === "memory_bootstrap_progress" && event.simulationId === simulationId);
    let cursor = Number(previous?.cursor ?? -1);
    const order = (node: ReturnType<typeof memoryNodes>[number]) => memoryQualification(source, node)?.position ?? node.messages[0]?.availableSequence ?? -1;
    const historical = memoryNodes(source, userId).sort((left, right) => order(left) - order(right));
    while (!stopped) {
      if (!await bindNamespace()) return run(log, userId, beforeRequest, context);
      const live = await log.read();
      const excluded = memoryExclusions(live);
      const current = historical.find((node) => order(node) > cursor);
      if (!current) {
        if (!live.some((event) => event.type === "memory_bootstrap_completed" && event.simulationId === simulationId))
          await log.append({ type: "memory_bootstrap_completed", userId, simulationId, algorithm: MEMORY_ALGORITHM, through: start.through });
        return;
      }
      const position = current.messages[0]!.availableSequence!;
      const qualification = memoryQualification(source, current);
      const alreadyLearned = live.some((event) => event.type === "memory_learned" && event.requestId === current.id);
      if (!excluded.has(current.id) && qualification && !alreadyLearned) {
        const at = Date.parse(current.at);
        const controls = live.filter((event) => ["memory_initialized", "memory_learned", "memory_excluded"].includes(event.type) &&
          (event.type === "memory_excluded" || Date.parse(String(event.settledAt ?? event.at)) <= at));
        const before = [...source.slice(0, position), ...controls];
        const required = memoryNodes([...source.slice(0, qualification.position + 1), ...live.filter((event) => event.type === "memory_excluded")], userId);
        if (options.embedding) {
          options.embedding.enqueue(required.filter((node) => !excluded.has(node.id)).flatMap((node) => node.messages.map((message) => ({ text: message.text,
            eligible: async () => !memoryExclusions(await log.read()).has(node.id) }))));
          if (required.some((node) => !excluded.has(node.id) && node.messages.some((message) => message.text && !options.embedding!.cached(message.text)))) {
            await pause(100); continue;
          }
        }
        const historicalLog: RuntimeLog = { ...log, read: async () => before };
        const projection = createMemoryProjection({ log: historicalLog, dataDir: join(options.dataDir, MEMORY_INITIALIZATION_DIR), userId,
          embedding: options.embedding, dynamics: options.dynamics, recall: options.recall, now: () => at });
        const candidates = await projection.search(current.messages[0]!.text, 72, current.id);
        if (!await bindNamespace()) return run(log, userId, beforeRequest, context);
        const replaySource = [...source.slice(0, position + 1), ...controls];
        if (!current.requestId) replaySource[position] = { ...replaySource[position]!, requestId: current.id };
        const replay = await historicalMemoryContext(log, replaySource, current.id, options.model);
        let units = replay.units.slice();
        const skeleton = start.context as Pick<Context, "systemPrompt" | "tools">;
        const makeContext = (): Context => ({ ...skeleton, messages: units.flatMap((unit) => unit.messages) });
        while (estimateInput(makeContext()) > Number(start.inputBudget) - Number(start.budget)) {
          const oldest = units.find((unit) => unit.requestId !== current.id);
          if (!oldest) break;
          units = units.filter((unit) => unit.requestId !== oldest.requestId);
        }
        const shown = composeMemory(makeContext(), units.flatMap((unit) => unit.sourceIds ?? []), candidates, Number(start.budget), current.messages[0]!.text);
        if (estimateInput(shown.context) > Number(start.inputBudget)) throw new Error("历史模拟上下文超过预算");
        const activated = candidates.slice(0, 8).filter((candidate) => shown.shown.some((reference) => reference.nodeId === candidate.node.id))
          .map((candidate) => ({ nodeId: candidate.node.id, score: candidate.score, signal: learningSignal(candidate.score),
            shown: shown.shown.filter((reference) => reference.nodeId === candidate.node.id) })).filter((item) => item.signal > 0);
        const settledAt = qualification.settledAt;
        const initializer = memoryGraph([...source.slice(0, qualification.position + 1), ...controls], userId, (text) => options.embedding?.cached(text), memoryDynamics(options.dynamics))
          .initializations.find((item) => item.nodeId === current.id)!;
        await persistMemoryLearning(log, { type: "memory_learned", origin: "historical", requestId: current.id, userId, algorithm: MEMORY_ALGORITHM,
          simulationId, snapshotId: `${simulationId}:${current.id}`, settledAt, queryAt: current.at, activated,
          candidates: candidates.map((candidate) => ({ nodeId: candidate.node.id, score: candidate.score, sources: candidate.sources })),
          budget: start.budget, tokens: shown.tokens, shown: shown.shown, contextMode: start.contextMode, dynamics: memoryDynamics(options.dynamics),
          deliveredSources: qualification.deliveredSources }, [initializer, ...candidates.filter((candidate) => activated.some((item) => item.nodeId === candidate.node.id))
            .flatMap((candidate) => candidate.initialization ? [candidate.initialization] : [])]);
      }
      cursor = order(current);
      await log.append({ type: "memory_bootstrap_progress", userId, simulationId, algorithm: MEMORY_ALGORITHM, cursor, through: start.through,
        model: `${options.model.provider}/${options.model.id}`, embedding: options.embedding?.namespace(), exclusionDigest: sourceDigest([...excluded]) });
      await pause(10);
    }
  }
  return { start(log: RuntimeLog, userId: number, beforeRequest?: string, context?: Context): Promise<void> {
    const previous = workers.get(log); if (previous) return previous;
    const work = run(log, userId, beforeRequest, context).catch(async () => {
      await log.append({ type: "memory_degraded", userId, reason: "bootstrap_unavailable" }).catch(() => undefined);
    }).finally(() => { workers.delete(log); });
    workers.set(log, work); return work;
  }, async close() { stopped = true; controller.abort(); await Promise.allSettled(workers.values()); } };
}
