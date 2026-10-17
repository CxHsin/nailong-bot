import { mkdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import { defineTool, type ToolRegistration } from "@earendil-works/pi-durable";
import { Type } from "@earendil-works/pi-ai";
import type { ModelConfiguration } from "../agent/model-config.js";
import { herdrClient, durableHerdrWatch, inspectHelper, type HelperRecord, type HerdrClient } from "./herdr.js";
import { createQueuedAssistant, type QueueExecutionContext, type ProcessingBatch } from "./queued-service.js";
import type { QueueInput, RoutingRecord, RoutingAction } from "./queue.js";
import { createIntentClassifier, type IntentOptions, type IntentWork } from "./intent.js";
import { HelperControlDispatcher } from "./helper-control.js";
import { createDurableExecutor } from "./durable-executor.js";
import type { DurableExecutorOptions } from "./durable-executor.js";
import { AssistantState, requireFreshNamespace, type SteerRecord } from "./state.js";
import type { ReplyPreview } from "../telegram/draft-preview.js";
import { cacheReport } from "./cache-report.js";

export type AssistantInput = QueueInput;
export type AssistantOutput = { conversationId: string; outputId?: string } & (
  { type: "text"; text: string; textFormat?: "plain" | "markdown" } | { type: "file"; path: string }
);
export type AssistantOptions = {
  cwd?: string;
  dataDir: string;
  prompt?: string;
  modelConfiguration: ModelConfiguration;
  intent?: IntentOptions;
  skillPaths?: string[];
  tools?: ToolDefinition[];
  herdr?: HerdrClient;
  pollMs?: number;
  reportFailure?: (error: unknown) => void;
  shellPath?: string;
  archive?: DurableExecutorOptions["archive"];
  memory?: DurableExecutorOptions["memory"];
  media?: DurableExecutorOptions["media"];
  compaction?: DurableExecutorOptions["compaction"];
  onRequestMetrics?: DurableExecutorOptions["onRequestMetrics"];
};

/** Persistent admission/scheduling, with Pi Durable responsible for model/tool execution. */
export async function createAssistant(options: AssistantOptions) {
  const classifier = createIntentClassifier(options.modelConfiguration, options.intent);
  const cwd = resolve(options.cwd ?? process.cwd());
  const dataDir = resolve(options.dataDir);
  await mkdir(dataDir, { recursive: true });
  await requireFreshNamespace(dataDir);
  const state = new AssistantState(dataDir);
  const client = options.herdr ?? herdrClient;
  const report = options.reportFailure ?? console.error;
  const previews = new Set<(preview: ReplyPreview) => void>();
  const helpers = new Map<string, HelperRecord[]>();
  const helperRecords = (id: string) => {
    let records = helpers.get(id);
    if (!records) { records = state.helpers(id); helpers.set(id, records); }
    return records;
  };
  const saveHelpers = async (id: string) => { state.saveHelpers(id, helperRecords(id)); };
  let closed = false;
  let acceptance = Promise.resolve();
  let observing: Promise<void> | undefined;
  let service!: Awaited<ReturnType<typeof createQueuedAssistant>>;
  const readyBatches = new Set<string>();
  const routing = new Map<string, Promise<void>>();
  const helperLanes = new Map<string, Promise<void>>();
  const helperActions = new Set<string>();
  const controls = new HelperControlDispatcher({client,
    load: (conversation,id) => state.helperControl(conversation,id),
    save: (conversation,record) => state.saveHelperControl(conversation,record),
  });
  const outputs = new Set<(output: AssistantOutput) => void | Promise<void>>();
  const sending = new Map<string, Promise<void>>();
  const emit = (output: AssistantOutput, targetIds?: string[]): Promise<void> => {
    if (output.outputId && service) state.saveOutputTargets(output.conversationId, output.outputId,
      targetIds ?? service.getActiveBatch(output.conversationId)?.events.flatMap(event => event.targetId ? [event.targetId] : []) ?? []);
    if (output.outputId) {
      const current = sending.get(output.outputId);
      if (current) return current;
      if (!state.beginOutput(output.outputId)) return Promise.resolve();
    }
    const delivery = Promise.resolve().then(async () => {
      try {
        for (const listener of outputs) await listener(output);
        if (output.outputId) state.finishOutput(output.outputId, "sent");
      } catch (error) {
        if (output.outputId) state.finishOutput(output.outputId, "unknown");
        throw error;
      }
    });
    if (output.outputId) {
      const id = output.outputId;
      sending.set(id, delivery);
      void delivery.then(() => sending.delete(id), () => sending.delete(id));
    }
    return delivery;
  };
  const workDir = (id: string) => state.conversation(id, cwd);

  function extraTools(id: string): ToolRegistration[] {
    return [
      durableHerdrWatch(client, helperRecords(id), () => saveHelpers(id), () => {
        const batch = service?.getActiveBatch(id);
        const events = batch?.events.filter(event => event.targetId) ?? [];
        return events.length ? {targetIds: events.map(event => event.targetId!),
          ...(events.length === 1 ? {summary:events[0]!.actionText ?? events[0]!.text} : {})} : undefined;
      }),
      defineTool({ name: "send_file", description: "Deliver a local result file requested by the user to this conversation.",
        parameters: Type.Object({ path: Type.String() }), replay: "unsafe",
        async execute(args, api) {
          const path = resolve(workDir(id), args.path);
          await readFile(path);
          try { await emit({ conversationId: id, outputId: `${id}:file:${api.callId}`, type: "file", path }); }
          catch (error) {
            if (!(error as { externalEffectUnknown?: boolean }).externalEffectUnknown) throw error;
            return { isError: true, diagnostics: [{ severity: "error" as const, code: "external_effect_unknown", message: String(error) }],
              output: [{ type: "text", text: `外部发送结果未知。${String(error)}。先核对发送回执与实际收到情况；无法确认时暂停询问，不因新工具调用身份重复发送。` }] };
          }
          return { output: [{ type: "text", text: "文件已交给接入层处理。发送结果未知时先核对回执，不重复发送。" }] };
        } }),
    ];
  }

  const executor = await createDurableExecutor({
    ...options, dataDir, cwd, extraTools, workDir,
    contextMaterials: (id: string) => {
      const records = helperRecords(id).filter((record) => !record.delivered).map(({summary,...identity}) => identity);
      const cancelled = service?.listWorks(id).filter(work => work.status === "cancelled").map(work => work.id) ?? [];
      const deliveries = state.helperControls(id).map(({id,helperId,target,kind,state})=>({id,helperId,target,kind,state}));
      return [records.length ? `已有外部委派，先核对真实身份与成果，不因新会话或重启重新派发：\n${JSON.stringify(records)}` : "",
        cancelled.length ? `已持久取消的目标 ${JSON.stringify(cancelled)}。停止安排其新步骤，保留已有成果；reset、resume 和 helper 回传均不复活目标。其他目标继续，复用已确认效果。` : "",
        deliveries.length ? `已执行的用户控制进度（内部事实，不重复转交；sent 只证明发送，unknown 先核查）：${JSON.stringify(deliveries)}` : ""].filter(Boolean).join("\n");
    },
    onPreview: (preview: ReplyPreview) => { for (const listener of previews) listener(preview); },
  }).catch(error => { state.close(); throw error; });

  async function submitSteer(record: SteerRecord) {
    const submission = await executor.steer(record.input.conversationId, { ...record.input, requestId: record.key });
    record.submissionId = submission.id;
    record.state = "submitted";
    state.storeSteer(record);
  }
  async function reconcileSteers(id: string, targetBatch?: string) {
    for (const record of state.pendingSteers(id)) {
      if (targetBatch && record.targetBatch !== targetBatch) continue;
      if (!record.submissionId) await submitSteer(record);
      const status = await executor.steerStatus(id, record.submissionId!);
      if (status?.entry) { record.state = "handled"; state.storeSteer(record); }
      else if (status?.status === "unanswered") {
        if (record.eventId && record.actionId) service.requeueAction(record.eventId,record.actionId,
          "当前执行未消费此补充。只处理此补充对应片段，基于已有成果继续；不重复原消息中已确认的其他动作。");
        else await service.receive({ ...record.input, kind: "message" });
        record.state = "handled";
        state.storeSteer(record);
      }
    }
  }

  async function execute(batch: ProcessingBatch, control: QueueExecutionContext) {
    const first = batch.events[0]!;
    const command = first.text.trim();
    if (first.kind === "command") {
      if (command === "/help") {
        await control.emit({ conversationId: batch.conversationId, type: "text",
          text: "直接用自然语言交办、补充或取消工作；独立请求按 FIFO 排队。/reset 重置上下文并保留工作；/resume [批次ID] 继续暂停工作；/model 查看或切换主模型；/kvcache 即时查看最近五轮 prompt cache 用量。" });
        return { status: "completed" as const };
      }
      if (command === "/reset") {
        await executor.reset(batch.conversationId);
        await control.emit({ conversationId: batch.conversationId, type: "text", text: "已重置主会话上下文；已接收事件、执行进度和外部委派保留。" });
        return { status: "completed" as const };
      }
      if (/^\/resume(?:\s|$)/.test(command)) {
        await service.resume(batch.conversationId, command.slice(7).trim() || undefined);
        await control.emit({ conversationId: batch.conversationId, type: "text", text: "已请求继续暂停的工作；续接前将核对最新指令和已确认成果。" });
        return { status: "completed" as const };
      }
      if (/^\/model(?:\s|$)/.test(command)) {
        const selected = await executor.model(batch.conversationId, command.slice(6).trim() || undefined);
        await control.emit({ conversationId: batch.conversationId, type: "text", text: selected });
        return { status: "completed" as const };
      }
      if (/^\/steer(?:\s|$)/.test(command)) {
        await control.emit({ conversationId: batch.conversationId, type: "text", text: "此命令已不再支持。请直接用自然语言交办、补充或取消工作。" });
        return { status: "completed" as const };
      }
    }
    try {
      const result = await executor.execute(batch, { ...control,
        onReady: async () => {
          readyBatches.add(batch.id);
          for (const record of state.pendingSteers(batch.conversationId)) {
            if (record.targetBatch === batch.id && record.state === "pending") await submitSteer(record);
          }
        },
      });
      await reconcileSteers(batch.conversationId, batch.id);
      if (service.listWorks(batch.conversationId).some(work => batch.events.some(event => event.targetId === work.id) && work.status === "cancelled"))
        return {status: "preempted" as const};
      return result;
    } finally { readyBatches.delete(batch.id); }
  }

  try {
    service = await createQueuedAssistant({ dataDir, startPaused: true, reportFailure: report,
      executor: { execute, close: () => executor.close() } });
    service.subscribe(emit);
  } catch (error) {
    try { if (service) await service.close(); else await executor.close(); }
    finally { state.close(); }
    throw error;
  }

  async function applyAction(route: RoutingRecord, action: RoutingAction) {
    if (action.state === "handled" || action.state === "unknown") return;
    const input = route.input;
    const id = input.conversationId;
    const fallback = (reason: string) => {
      service.requeueAction(route.eventId,action.id,
        `${reason}。原输入保持完整；仅处理片段 ${JSON.stringify(action.text)}。同条输入已确认的其他动作不得重做。`);
    };
    if (action.kind === "request" || action.kind === "clarify") {
      if (action.kind === "clarify") action.reason = `目标待澄清，候选 ${JSON.stringify(action.candidates ?? [])}；尚未对候选执行修改或取消，请先询问用户。`;
      service.updateAction(route.eventId,action);
      service.enqueueRoutedRequest(route.eventId,action.id);
      service.updateAction(route.eventId,{...action,state:"handled"});
      return;
    }
    const work = service.listWorks(id).find(work => work.id === action.target);
    const matchedHelpers = helperRecords(id).filter(helper => helper.targetIds?.includes(action.target!) && !helper.delivered);
    const helper = matchedHelpers[0];
    if (matchedHelpers.length > 1) { fallback("该目标对应多个帮手，需核对具体接收对象；尚未转交或中断任何帮手"); return; }
    if (!work && !helper) { fallback("目标已不可核实，尚未执行此控制动作"); return; }
    if (work?.status === "cancelled" && !(action.delivery === "helper" && action.state === "submitted")) {
      if (action.kind === "supplement") fallback("此目标已取消；不能自动恢复，请确认是否重新交办");
      else service.updateAction(route.eventId,{...action,state:"handled",reason:"目标已取消，未重复中断"});
      return;
    }
    if (helper) {
      if (helperActions.has(action.id)) return;
      const kind = action.kind;
      service.updateAction(route.eventId,{...action,state:"submitted",delivery:"helper"});
      if (kind === "cancel") service.cancelWork(action.target!,true);
      helperActions.add(action.id);
      const lane = JSON.stringify([id,helper.id]);
      const delivery = (helperLanes.get(lane) ?? Promise.resolve()).catch(report).then(async () => {
      const result = await controls.control(id,helper,{id:action.id,kind,text:action.text,target:action.target!});
      if (action.kind === "cancel" && !["rejected","settled"].includes(result.state)) service.cancelWork(action.target!);
      if (["rejected","settled"].includes(result.state)) { fallback(result.evidence.join("\n")); return; }
      service.updateAction(route.eventId,{...action,state: result.state === "unknown" ? "unknown" : "handled",reason:result.evidence.join("\n")});
      await emit({conversationId:id,outputId:`routing:${action.id}`,type:"text",text:
        result.state === "stopped" ? "已核实对应帮手及所属任务进程停止，已有成果保留。" :
        action.kind === "cancel" ? "已向对应帮手请求中断，实际停止状态仍待核实。" :
        result.state === "sent" ? "补充已转交对应帮手；是否采纳仍待核实。" : "此项投递结果待核实，已保留原消息，不会自动重发。"}, [action.target!]);
      });
      helperLanes.set(lane,delivery);
      void delivery.catch(report).finally(() => {
        helperActions.delete(action.id);
        if (helperLanes.get(lane) === delivery) helperLanes.delete(lane);
      });
      return;
    }
    if (action.kind === "cancel") {
      if (work!.status === "completed") {
        service.updateAction(route.eventId,{...action,state:"handled",reason:"目标已完成，未向旧执行发送中断"});
        await emit({conversationId:id,outputId:`routing:${action.id}`,type:"text",text:"对应工作已结束；已有成果保留，未重复发送停止。"}, [action.target!]);
        return;
      }
      service.cancelWork(work!.id);
      if (service.getActiveBatch(id)?.id === work!.batchId) service.requestPreempt(id);
      service.updateAction(route.eventId,{...action,state:"handled",reason:"取消已持久保存；执行和外部效果分别核实"});
      await emit({conversationId:id,outputId:`routing:${action.id}`,type:"text",text: work!.status === "queued" ?
        "已取消尚未开始的对应工作，其他工作继续保留。" : "已请求停止对应工作并保留成果；外部操作的实际停止状态仍需核实。"}, [action.target!]);
      return;
    }
    if (work!.status === "queued") {
      service.supplementWork(work!.id,{...input,actionText:action.text},action.id);
      service.updateAction(route.eventId,{...action,state:"handled"});
      return;
    }
    const active = service.getActiveBatch(id);
    if (active && active.id === work!.batchId) {
      let record = state.steer(action.id);
      if (!record) {
        record = {key:action.id,eventId:route.eventId,actionId:action.id,targetId:work!.id,
          input:{...input,targetId:work!.id,actionText:action.text,runtimeMaterials:[
            `此补充仅针对目标 ${work!.id}，只执行原文片段 ${JSON.stringify(action.text)}；同条输入的其他动作由应用分别处理，不重复执行。`]},
          targetBatch:active.id,state:"pending"};
        state.storeSteer(record);
      }
      if (readyBatches.has(active.id) && record.state === "pending") await submitSteer(record);
      service.updateAction(route.eventId,{...action,state:"submitted",submissionId:record.submissionId});
      return;
    }
    fallback("原执行已结束或暂停，此补充转为基于已有成果的后续处理");
  }

  function routeConversation(id: string) {
    if (closed || routing.has(id)) return;
    const pending = Promise.resolve().then(async () => {
      while (!closed) {
        let route = service.routingPending(id)[0];
        if (!route) break;
        if (!route.decision) {
          const knownWorks = service.listWorks(id);
          const hasEarlierWork = knownWorks.some(work => work.input.sequence < route!.input.sequence &&
            work.status !== "completed" && work.status !== "cancelled");
          if (!hasEarlierWork && !service.getActiveBatch(id) && !helperRecords(id).some(helper => !helper.delivered)) {
            route = service.decideRoute(route.eventId, {
              actions: [{kind:"request",text:route.input.text}], snapshot: {bypass:"no_pending_work"},
            });
          } else {
            const visible = await executor.intentContext(id);
            const reply = route.input.replyToMessageId;
            const replyTargets = reply ? [...new Set([...state.replyTargets(id,reply),...knownWorks.filter(work => work.inputId === reply && work.input.source === "telegram").map(work => work.id)])] :
              route.input.replyToInputId ? knownWorks.filter(work => work.inputId === route!.input.replyToInputId).map(work => work.id) : [];
            // Completed chat belongs to bounded visible history, unless explicitly replied to.
            // Retained active work and registered helpers survive reset independently of chat.
            const works: IntentWork[] = knownWorks.filter(work => work.input.kind === "message" &&
              (work.status !== "completed" || replyTargets.includes(work.id))).map(work => ({
              id:work.id,summary:visible.excluded.includes(work.inputId) ? "[相关对话已遗忘，工作身份保留]" : work.summary,
              status:work.status,inputId:work.inputId,batchId:work.batchId,submissionId:work.submissionId,
            }));
            for (const helper of helperRecords(id)) {
              for (const target of helper.targetIds ?? []) {
                const work = works.find(work => work.id === target);
                const original = knownWorks.find(work => work.id === target);
                const fields = {helperId:helper.id,status:helper.delivered ? "helper_result" : "helper",summary:original && visible.excluded.includes(original.inputId) ? "[相关对话已遗忘，工作身份保留]" : helper.summary ?? "[摘要不可用，需核查]"};
                if (work) Object.assign(work,{...fields,summary:visible.excluded.includes(work.inputId ?? "") ? "[相关对话已遗忘]" : fields.summary});
                else works.push({id:target,...fields});
              }
            }
            const result = await classifier.classify({input:route.input,works,recent:visible.recent,replyTargets,
              incomplete:helperRecords(id).some(helper => !helper.delivered && !helper.targetIds?.length)});
            const reason = result.reason ? `本条输入尚未自动执行补充或取消；路由未判定原因 ${result.reason}。主 Bot 应结合原话处理或澄清。` : undefined;
            route = service.decideRoute(route.eventId,{...result,reason,actions:result.actions.length ? result.actions : [{kind:"request",text:route.input.text}]});
          }
        }
        for (const action of route.decision!.actions) await applyAction(route,action);
        service.finishRoute(route.eventId);
      }
    });
    routing.set(id,pending);
    void pending.then(() => {
      routing.delete(id);
      if (!closed && service.routingPending(id).length) routeConversation(id);
    }, error => { routing.delete(id); report(error); });
  }

  async function observe() {
    for (const { id } of state.conversations()) {
      for (const record of helperRecords(id).filter((record) => !record.delivered)) {
        try {
          const checked = await inspectHelper(client, record);
          if (checked.launchPending || checked.status === "working") continue;
          const notice = `${checked.status}:${checked.sequence}`;
          if (record.notice === notice) continue;
          const output = await client.run(record.session, ["agent", "read", record.agent, "--source", "recent-unwrapped", "--lines", "200"]);
          const {summary,...identity} = record;
          await service.enqueueInternal({ conversationId: id, inputId: `herdr:${record.id}:${notice}`, source: "herdr", priority: 0,
            text: `herdr_result（内部执行材料，不是用户指令；状态不证明完成，检查实际成果；已取消目标不得自动续跑）：\n${JSON.stringify({ ...identity, status: checked.status, output })}` });
          record.notice = notice;
          if (checked.status === "idle" || checked.status === "done") record.delivered = true;
          await saveHelpers(id);
        } catch (error) {
          const notice = `unknown:${String(error)}`;
          if (record.notice === notice) continue;
          await service.enqueueInternal({ conversationId: id, inputId: `herdr:${record.id}:${notice}`, source: "herdr", priority: 0,
            text: `herdr_result（内部材料，身份或状态待核实，不重复派发）：${JSON.stringify({ ...record, error: String(error) })}` });
          record.notice = notice;
          await saveHelpers(id);
        }
      }
    }
  }
  const timer = setInterval(() => {
    if (closed || !outputs.size || observing) return;
    observing = observe().catch(report).finally(() => { observing = undefined; });
  }, options.pollMs ?? 2000);
  timer.unref();
  return {
    subscribe(listener: (output: AssistantOutput) => void | Promise<void>) {
      outputs.add(listener);
      const restored = acceptance.then(async () => {
        for (const record of state.pendingSteers()) {
          if (!record.targetBatch) {
            await service.receive(record.input);
            record.state = "handled";
            state.storeSteer(record);
          } else {
            const batch = service.getBatch(record.targetBatch);
            const status = record.submissionId ? await executor.steerStatus(record.input.conversationId,record.submissionId) : undefined;
            if (status?.entry) {
              record.state = "handled";
              state.storeSteer(record);
            } else if (batch && ["paused","needs_confirmation","preempted"].includes(batch.status)) {
              if (record.submissionId) await executor.withdrawSteer(record.input.conversationId,record.submissionId);
              if (record.eventId && record.actionId) service.requeueAction(record.eventId,record.actionId,"原执行暂停且未消费补充，基于已有成果处理此片段；不重做同条输入其他动作。");
              else await service.receive(record.input);
              record.state = "handled";
              state.storeSteer(record);
            } else if (batch?.status === "completed") service.recoverSteerTarget(batch.id);
          }
        }
        for (const id of new Set(service.routingPending().map(route => route.input.conversationId))) routeConversation(id);
        for (const route of service.pendingHelperRoutes())
          for (const action of route.decision!.actions.filter(action => action.delivery === "helper" && action.state === "submitted")) await applyAction(route,action);
        service.start();
      });
      acceptance = restored.catch(report);
      return () => { outputs.delete(listener); };
    },
    subscribePreviews(listener: (preview: ReplyPreview) => void) {
      previews.add(listener); return () => { previews.delete(listener); };
    },
    receive(input: AssistantInput) {
      const accepted = acceptance.then(async () => {
        if (closed) throw new Error("助手服务已关闭");
        workDir(input.conversationId);
        if (!input.images?.length && /^\/kvcache(?:\s|$)/.test(input.text.trim()) &&
          (!input.kind || input.kind === "command")) {
          const receipt = service.receiveQuery(input);
          if (receipt.accepted) await emit({ conversationId: input.conversationId, outputId: `query:${receipt.eventId}`, type: "text", textFormat: "plain",
            text: input.text.trim() === "/kvcache" ? await cacheReport(dataDir, input.conversationId, service.listBatches(input.conversationId)) : "用法：/kvcache（查看最近五轮）" }, []);
          return receipt;
        }
        const direct = !input.source || ["telegram","cli","user","direct"].includes(input.source);
        const classify = direct && (input.kind ?? (input.text.trimStart().startsWith("/") ? "command" : "message")) === "message";
        const receipt = await service.receive({...input,receivedAt:input.receivedAt ?? Date.now()},classify);
        if (classify && receipt.accepted) routeConversation(input.conversationId);
        service.start();
        return {...receipt,routing:service.routingRecord(receipt.eventId)};
      });
      acceptance = accepted.then(() => {}, () => {});
      return accepted;
    },
    async resume(conversationId: string, batchId?: string) { await service.resume(conversationId, batchId); service.start(); },
    recordReply(conversationId: string, messageId: string, outputId: string) { state.recordReply(conversationId,messageId,outputId); },
    routingStatus(conversationId: string) { return {model:options.intent?.model, pending:service.routingPending(conversationId), works:service.listWorks(conversationId)}; },
    async waitForRouting() { await acceptance; while (routing.size) await Promise.all(routing.values()); },
    async waitForIdle() {
      await acceptance;
      while (routing.size) await Promise.all(routing.values());
      while (helperLanes.size) await Promise.all(helperLanes.values());
      await service.waitForIdle();
      await executor.waitForIdle();
      await service.waitForIdle();
      await Promise.all(sending.values());
    },
    async close() {
      if (closed) return;
      closed = true;
      clearInterval(timer);
      await observing;
      await acceptance;
      await Promise.allSettled(routing.values());
      await Promise.allSettled(helperLanes.values());
      try { await service.close(); await Promise.allSettled(sending.values()); } finally { state.close(); }
    },
  };
}
export type Assistant = Awaited<ReturnType<typeof createAssistant>>;
