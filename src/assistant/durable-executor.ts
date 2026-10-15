import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { Harness, createRegistry, defineExtension, section, watchEvents, defineDoc, defineTool, hook, GenerationTask, ToolTask,
  type Conversation, type EntryRecord, type SubmissionId, type ToolRegistration } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { createCodingTools } from "@earendil-works/pi-durable/tools";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { formatSkillsForPrompt, loadSkills, loadProjectContextFiles, type ToolDefinition } from "@mariozechner/pi-coding-agent";
import type { ImageContent } from "@mariozechner/pi-ai";
import type { ModelConfiguration } from "../agent/model-config.js";
import { durableModels } from "./durable-models.js";
import { Type } from "typebox";

const RecoveryDoc = defineDoc({ kind: "nailong.effect-verification", version: 1, scope: "conversation", history: "latest", fork: "current",
  initial: () => ({ calls: {} as Record<string, { tool: string; state: "unresolved" | "confirmed" | "not_applied" | "unknown"; evidence: string }> }) });
const RetryBudgetDoc = defineDoc({ kind: "nailong.retry-budget", version: 1, scope: "conversation", history: "latest", fork: "current",
  initial: () => ({ work: {} as Record<string, { requestKey: string; taskId: number; base: number; used: number; finished: boolean }> }) });

export type DurableEvent = { inputId: string; conversationId: string; text: string; images?: ImageContent[]; source?: string };
export type DurableBatch = { id: string; requestKey: string; conversationId: string; events: DurableEvent[];
  submissionId?: string | number; previousSubmissionId?: string | number; resumed?: boolean; reconcile?: boolean; retryEpoch?: number };
export type DurableOutput = { conversationId: string; outputId: string; type: "text"; text: string };
export type DurableControls = { signal?: AbortSignal; emit: (output: DurableOutput) => void | Promise<void>;
  recordSubmission: (id: string) => void | Promise<void>; onReady?: () => void | Promise<void> };
export type DurableResult = { status: "completed" | "paused" | "needs_confirmation" | "preempted"; reason?: string };
export type DurableExecutorOptions = { cwd?: string; dataDir: string; prompt?: string; skillPaths?: string[];
  modelConfiguration: ModelConfiguration; tools?: ToolDefinition[]; shellPath?: string;
  extraTools?: (conversationId: string) => ToolRegistration[];
  workDir?: (conversationId: string) => string;
  contextMaterials?: (conversationId: string) => string;
  onPreview?: (preview: { conversationId: string; replyId: string; text?: string }) => void;
  reportFailure?: (error: unknown) => void };

/** Application queues select batches; this adapter only advances their durable model/tool execution. */
export async function createDurableExecutor(options: DurableExecutorOptions) {
  const cwd = resolve(options.cwd ?? process.cwd());
  const rootDirectory = resolve(options.dataDir, "executions");
  await mkdir(rootDirectory, { recursive: true });
  const catalog = durableModels(options.modelConfiguration);
  const conversations = new Map<string, Promise<{ harness: Harness; root: Conversation; rememberUncertain: (entries: readonly EntryRecord[]) => Promise<void>;
    selectWork: (batch: DurableBatch) => Promise<boolean> }>>();
  async function open(conversationId: string) {
    const cwd = resolve(options.workDir?.(conversationId) ?? options.cwd ?? process.cwd());
    const directory = join(rootDirectory, createHash("sha256").update(conversationId).digest("hex"));
    await mkdir(directory, { recursive: true });
    const registry = createRegistry();
    const coding = createCodingTools();
    registry.install({ ...coding, tools: coding.tools?.map((tool) => tool.name === "read" ? { ...tool, replay: "safe" as const } : tool) });
    const connectorTools: ToolRegistration[] = (options.tools ?? []).map((tool) => ({
      name: tool.name, description: tool.description, parameters: tool.parameters,
      prepareArguments: tool.prepareArguments, executionMode: tool.executionMode, replay: "unsafe",
      async execute(args, api, invocation) {
        // Existing MCP and web connectors use arguments, cancellation and updates, without a legacy extension host.
        const result = await tool.execute(api.callId, args, invocation.abortSignal, (update) => {
          for (const part of update.content) if (part.type === "text") api.output(part.text);
        }, undefined as never);
        return { output: result.content, details: result.details === undefined ? undefined : JSON.parse(JSON.stringify(result.details)) };
      },
    }));
    const project = loadProjectContextFiles({ cwd, agentDir: options.dataDir });
    const { skills } = loadSkills({ cwd, agentDir: options.dataDir, skillPaths: options.skillPaths ?? [], includeDefaults: true });
    let harness!: Harness;
    let root!: Conversation;
    let activeWork = "";
    let activeRequest = "";
    let retryLimit = 3;
    async function rememberUncertain(entries: readonly EntryRecord[]) {
      const uncertain = entries.flatMap((entry) => {
        const message = entry.model?.find((message) => message.role === "toolResult");
        const diagnostics = (entry.data as { diagnostics?: Array<{ code?: string; message?: string }> } | undefined)?.diagnostics;
        if (!message || !diagnostics?.some((diagnostic) => ["interrupted", "aborted", "external_effect_unknown"].includes(diagnostic.code ?? ""))) return [];
        const installed = [...(coding.tools ?? []), ...connectorTools, ...(options.extraTools?.(conversationId) ?? [])].find((tool) => tool.name === message.toolName);
        if (message.toolName === "read" || installed?.replay === "safe") return [];
        return [{ callId: message.toolCallId, tool: message.toolName, evidence: diagnostics.map((diagnostic) => diagnostic.message ?? "").join("\n") }];
      });
      if (!uncertain.length) return;
      await harness.commit(async (tx) => {
        const recovery = await tx.doc(RecoveryDoc, root.id);
        for (const call of uncertain) if (!recovery.calls[call.callId]) recovery.calls[call.callId] = { tool: call.tool, state: "unresolved", evidence: call.evidence || "Execution stopped before its external result was confirmed." };
      }, context);
    }
    const resolveEffect = defineTool({ name: "resolve_interrupted_tool", description:
      "After inspecting an interrupted external operation, record actual evidence: confirmed means adopt its completed result; not_applied allows execution; unknown pauses to ask the user. Do not infer external state merely from an interruption or an error.",
      replay: "safe", parameters: Type.Object({ callId: Type.String(), outcome: Type.Union([Type.Literal("confirmed"), Type.Literal("not_applied"), Type.Literal("unknown")]), evidence: Type.String({ minLength: 1 }) }),
      async execute(args, api, invocation) {
        await api.commit(async (tx) => {
          const recovery = await tx.doc(RecoveryDoc, api.conversationId);
          const call = recovery.calls[args.callId];
          if (!call) throw new Error("No interrupted operation with this call ID");
          call.state = args.outcome; call.evidence = args.evidence;
        }, invocation);
        return { output: [{ type: "text", text: `verification-recorded: ${args.outcome}; ${args.evidence}` }],
          ...(args.outcome === "unknown" ? { control: { terminate: true as const } } : {}) };
      },
    });
    registry.install(defineExtension({ name: "nailong", tools: [...connectorTools, ...(options.extraTools?.(conversationId) ?? []), resolveEffect], sections: [
      section("project", () => project.map((file) => `${file.path}\n${file.content}`).join("\n\n")),
      section("skills", () => formatSkillsForPrompt(skills)),
      section("delegations", () => options.contextMaterials?.(conversationId)),
      section("external-effect-verification", async () => {
        const recovery = await harness.snapshot(RecoveryDoc, root.id, context);
        const pending = Object.entries(recovery?.calls ?? {}).filter(([,call]) => ["unresolved", "unknown"].includes(call.state));
        return pending.length ? `External effects need verification. Inspect actual external state with read-only operations before continuing effects. Call resolve_interrupted_tool with evidence; when unverifiable choose unknown and ask the user. Shell and other effectful tools are blocked until resolution.\n${JSON.stringify(pending)}` : undefined;
      }),
    ], hooks: [
      hook(GenerationTask, { beforeRequest: async (request, api) => {
        const task = await harness.getTask(api.taskId, context);
        const attempt = Number((task?.state as { checkpoint?: { attempt?: number } })?.checkpoint?.attempt ?? 1);
        await harness.commit(async (tx) => {
          const budget = await tx.doc(RetryBudgetDoc, root.id);
          let work = budget.work[activeWork];
          if (!work || work.taskId !== api.taskId) {
            const base = work && work.requestKey !== activeRequest && !work.finished ? work.used : 0;
            work = { requestKey: activeRequest, taskId: api.taskId, base, used: base, finished: false };
            budget.work[activeWork] = work;
            work = budget.work[activeWork]!;
          }
          work.used = Math.max(work.used, work.base + attempt);
          retryLimit = Math.max(0, 3 - work.base);
        }, context);
        await rememberUncertain((await root.context(context)).entries);
        const recovery = await harness.snapshot(RecoveryDoc, root.id, context);
        const pending = Object.entries(recovery?.calls ?? {}).filter(([,call]) => ["unresolved", "unknown"].includes(call.state));
        if (!pending.length) return;
        return { messages: [...request.messages, { role: "user" as const, timestamp: Date.now(), content:
          `内部恢复材料，不是新用户请求。以下操作的外部效果尚未确认。先用 read 或明确 replay-safe 的查询核实，再调用 resolve_interrupted_tool；无法核实请选择 unknown 并询问用户。不得重复副作用，也不得宣称已完成。\n${JSON.stringify(pending)}` }] };
      }, afterResponse: async (message) => {
        if (!["stop", "length", "toolUse"].includes(message.stopReason)) return;
        await harness.commit(async (tx) => {
          const work = (await tx.doc(RetryBudgetDoc, root.id)).work[activeWork];
          if (work) work.finished = true;
        }, context);
      } }),
      hook(ToolTask, { beforeTool: async (call, api, invocation) => {
        await rememberUncertain((await root.context(context)).entries);
        if (call.name === "resolve_interrupted_tool" || call.name === "read") return;
        const recovery = await api.snapshot(RecoveryDoc, api.conversationId, invocation);
        if (!Object.values(recovery?.calls ?? {}).some((call) => ["unresolved", "unknown"].includes(call.state))) return;
        const agent = await root.agent(context);
        if (agent.tools.find((tool) => tool.name === call.name)?.replay === "safe") return;
        return { block: "Verify interrupted external effects with read-only tools and resolve_interrupted_tool first; use unknown to pause and ask the user." };
      } }),
    ] }));
    const environment = new NodeExecutionEnv({ cwd, shellPath: options.shellPath });
    harness = await Harness.open(await openNodeSqliteStorage(join(directory, "session.sqlite")), {
      models: catalog.models, registry, settings: { stream: { maxRetries: 0 },
        retry: { enabled: true, get maxRetries() { return retryLimit; }, baseDelayMs: 2000 }, toolExecution: "sequential",
        steeringMode: "all", followUpMode: "all" }, env: () => environment, onReport: options.reportFailure,
    }, context);
    const selected = catalog.select();
    root = await harness.root(context, { agent: { model: selected.ref,
      thinkingLevel: selected.model.reasoning ? "low" : "off", instructions: options.prompt, cwd } });
    return { harness, root, rememberUncertain,
      async selectWork(batch: DurableBatch) {
        activeWork = `${batch.id}:${batch.retryEpoch ?? 0}`;
        activeRequest = batch.requestKey;
        const work = (await harness.snapshot(RetryBudgetDoc, root.id, context))?.work[activeWork];
        retryLimit = Math.max(0, 3 - (work?.base ?? 0));
        return !work || work.finished || work.requestKey === batch.requestKey || work.used < 4;
      },
    };
  }
  function conversation(id: string) {
    let opening = conversations.get(id);
    if (!opening) { opening = open(id); conversations.set(id, opening); }
    return opening;
  }
  function content(events: DurableEvent[]) {
    return events.flatMap((event) => [{ type: "text" as const,
      text: `<event identity=${JSON.stringify(event.inputId)} source=${JSON.stringify(event.source ?? "direct")} >\n${event.text}\n</event>` },
      ...(event.images ?? [])]);
  }
  return {
    async execute(batch: DurableBatch, controls: DurableControls): Promise<DurableResult> {
      const { harness, root, rememberUncertain, selectWork } = await conversation(batch.conversationId);
      if (!await selectWork(batch)) {
        await controls.emit({ conversationId: batch.conversationId, type: "text", outputId: `${batch.id}:retry-budget-exhausted`, text: "此项工作的有限重试已耗尽，已保留进度并暂停。可明确使用 /resume 继续。" });
        return { status: "paused", reason: "retry_budget_exhausted" };
      }
      let submission = batch.submissionId === undefined ? undefined : await harness.submission(Number(batch.submissionId) as SubmissionId, context);
      const previous = await submission?.status(context);
      const stream = await watchEvents(harness, root.id, context);
      let floor = previous?.entry ?? Number.MAX_SAFE_INTEGER;
      const emitted = new Map<number, Promise<void>>();
      const replyId = `${batch.conversationId}:draft:${batch.requestKey}`;
      const parts = new Map<number, string>();
      const preview = () => options.onPreview?.({ conversationId: batch.conversationId, replyId, text: [...parts.entries()].sort(([a], [b]) => a-b).map(([,text]) => text).join("\n") });
      function output(entry: EntryRecord): Promise<void> {
        if (entry.id < floor) return Promise.resolve();
        const pending = emitted.get(entry.id);
        if (pending) return pending;
        const answer = entry.model?.find((message) => message.role === "assistant");
        if (!answer || !["stop", "length", "toolUse"].includes(answer.stopReason)) return Promise.resolve();
        const text = answer.content.filter((part) => part.type === "text").map((part) => part.text).join("\n");
        if (!text.trim()) return Promise.resolve();
        const delivery = Promise.resolve().then(() => controls.emit({ conversationId: batch.conversationId, outputId: `${batch.conversationId}:assistant:${entry.id}`, type: "text", text }));
        emitted.set(entry.id, delivery);
        return delivery;
      }
      stream.start(async (events) => {
        for (const event of events) {
          if (event.type === "message_start" && event.message.role === "assistant") parts.clear();
          if (event.type === "message_update") {
            for (const change of event.changes) {
              if (change.type === "text_start") parts.set(change.contentIndex, change.block.type === "text" ? change.block.text : "");
              if (change.type === "text_delta") parts.set(change.contentIndex, (parts.get(change.contentIndex) ?? "") + change.delta);
              if (change.type === "block" && change.block.type === "text") parts.set(change.contentIndex, change.block.text);
              if (change.type === "message") change.message.content.forEach((part,index) => { if (part.type === "text") parts.set(index, part.text); });
            }
            preview();
          }
          if (event.type === "message_end") {
            const answer = event.entry.model?.find((message) => message.role === "assistant");
            if (answer) { answer.content.forEach((part,index) => { if (part.type === "text") parts.set(index,part.text); }); preview(); }
            await output(event.entry); options.onPreview?.({ conversationId: batch.conversationId, replyId });
          }
          if (event.type === "snapshot") for (const entry of event.entries) await output(entry);
          if (event.type === "auto_retry_start") await controls.emit({ conversationId: batch.conversationId, type: "text",
            outputId: `${batch.requestKey}:retry:${event.attempt}`, text: `模型调用暂时失败，正在有限重试（${event.attempt}/3）。` });
        }
      });
      if (!submission) {
        const live = await harness.inspect(context);
        if (live.submissions.some((record) => record.status === "placed" && record.requestId !== batch.requestKey))
          await root.abort(context);
        const input = content(batch.events);
        if (batch.previousSubmissionId !== undefined) {
          const prior = await (await harness.submission(Number(batch.previousSubmissionId) as SubmissionId, context))?.status(context);
          if (prior?.entry !== undefined) {
            const relevant: EntryRecord[] = [];
            let cursor;
            let end = false;
            do {
              const history = await root.entries({ minEntryId: prior.entry, order: "ascending" }, 100, cursor, context);
              for (const entry of history.items) {
                if (entry.id > prior.entry && entry.kind === "nailong.batch") { end = true; break; }
                relevant.push(entry);
              }
              cursor = history.next;
            } while (cursor && !end);
            await rememberUncertain(relevant);
            const confirmed = relevant.flatMap((entry) => entry.model?.filter((message) => message.role === "toolResult" && !message.isError) ?? []);
            if (confirmed.length) input.unshift({ type: "text", text: `原工作已确认工具结果（恢复证据，复用已完成效果）：\n${JSON.stringify(confirmed)}` });
          }
        }
        if (batch.resumed || batch.reconcile) input.unshift({ type: "text", text:
          "续接已有工作。先结合最新用户指令核对原计划是否仍有效，继续、调整或结束；复用已经确认的模型与工具结果，不重复已完成外部操作。未知外部效果先核实，无法核实时暂停询问。" });
        submission = await root.submit({ type: "input", content: input,
        requestId: batch.requestKey, whenBusy: "reject", entry: { kind: "nailong.batch", data: { batchId: batch.id, events: batch.events.map((event) => event.inputId) } } }, context);
      }
      const admitted = await submission.status(context);
      floor = admitted.entry ?? floor;
      await controls.recordSubmission(String(submission.id));
      await controls.onReady?.();
      const abort = () => { void root.abort(context).catch(options.reportFailure ?? console.error); };
      controls.signal?.addEventListener("abort", abort, { once: true });
      if (controls.signal?.aborted) abort();
      try {
        const settled = await submission.wait(context);
        floor = settled.entry ?? floor;
        await root.waitForIdle(context);
        let cursor;
        do {
          const entries = await root.entries({ minEntryId: settled.entry, order: "ascending" }, 100, cursor, context);
          for (const entry of entries.items) await output(entry);
          cursor = entries.next;
        } while (cursor);
        const recovery = await harness.snapshot(RecoveryDoc, root.id, context);
        if (Object.values(recovery?.calls ?? {}).some((call) => ["unresolved", "unknown"].includes(call.state))) {
          await controls.emit({ conversationId: batch.conversationId, type: "text", outputId: `${batch.requestKey}:effect-confirmation`, text: "部分外部操作的结果无法确认，已保留进度并暂停。请核实结果后明确要求继续，避免重复操作。" });
          return { status: "needs_confirmation", reason: "unknown_external_effect" };
        }
        if (settled.status === "unanswered") {
          if (!controls.signal?.aborted) await controls.emit({ conversationId: batch.conversationId, type: "text", outputId: `${batch.requestKey}:paused`,
            text: "模型调用失败，有限重试后仍未完成；已保留进度并暂停。可使用 /resume 继续，其他输入仍可处理。" });
          return { status: controls.signal?.aborted ? "preempted" : "paused", reason: settled.reason };
        }
        return { status: "completed" };
      } finally { controls.signal?.removeEventListener("abort", abort); await stream.stop(); await Promise.all(emitted.values()); }
    },
    async steer(conversationId: string, input: DurableEvent & { requestId?: string }) {
      const { root } = await conversation(conversationId);
      const submission = await root.submit({ type: "input", content: content([input]), requestId: input.requestId ?? `steer:${input.source ?? "direct"}:${input.inputId}`,
        whenBusy: "steer", entry: { kind: "nailong.steer", data: { inputId: input.inputId } } }, context);
      return { ...(await submission.status(context)), id: String(submission.id), submissionId: String(submission.id) };
    },
    async steerStatus(conversationId: string, id: string | number) {
      const { harness } = await conversation(conversationId);
      return (await harness.submission(Number(id) as SubmissionId, context))?.status(context);
    },
    async withdrawSteer(conversationId: string, id: string | number) {
      const { harness, root } = await conversation(conversationId);
      return harness.abortSubmission(Number(id) as SubmissionId, context, root.id);
    },
    async reset(conversationId: string) { await (await conversation(conversationId)).root.reset(undefined, context); },
    async model(conversationId: string, alias?: string) {
      const { root } = await conversation(conversationId);
      if (alias) {
        const selected = catalog.select(alias);
        await root.configure({ model: selected.ref, thinkingLevel: selected.model.reasoning ? "low" : "off" }, context);
      }
      const agent = await root.agent(context);
      const current = catalog.available.find((entry) => entry.ref.provider === agent.model?.provider && entry.ref.modelId === agent.model?.modelId)?.alias;
      return `当前模型：${current ?? agent.model?.modelId}\n${catalog.available.map((entry) => `${entry.alias}: ${entry.model.id}`).join("\n")}`;
    },
    async inspect(conversationId: string) { return (await conversation(conversationId)).harness.inspect(context); },
    async waitForIdle(conversationId?: string) {
      if (conversationId !== undefined) await (await conversation(conversationId)).root.waitForIdle(context);
      else await Promise.all([...conversations.values()].map(async (pending) => (await pending).root.waitForIdle(context)));
    },
    async close() { for (const pending of conversations.values()) await (await pending).harness.close(context); },
  };
}
export type DurableExecutor = Awaited<ReturnType<typeof createDurableExecutor>>;
