import { randomUUID, createHash } from 'node:crypto';
import { resolve, sep, dirname, basename, join } from 'node:path';
import { realpathSync, statSync } from 'node:fs';
import { PersonalStore } from './store.js';
import type { ActionSpec, ActionRecord, Attempt, Decision, Delivery, Dialogue, PersonalInput, PersonalResponse, Plan, Task, TaskExecutor, WorkToolContext, PermissionGrant, DelegationSpec, WorkEvent, ContinuationOutcome } from './types.js';
import { recallIdentity } from './memory-context.js';
import { requestIdentity } from './request-identity.js';
import type { AgreementChange, WorkingAgreement } from './types.js';

export interface PersonalHostOptions { store: PersonalStore; dialogue: Dialogue; executor: TaskExecutor; maxConcurrent?: number; maxDurationMs?: number; maxTokens?: number; maxAttempts?: number; maxDialogueAttempts?: number; maxRootCalls?: number; maxGlobalCalls?: number; maxGlobalTokens?: number; maxRework?: number; recoveryPollMs?: number; now?: () => number; acceptContinuation?(task: Task, result: import('./types.js').TaskResult): Promise<import('./types.js').TaskResult>; interruptDialogue?(): Promise<void>; handleDecision?(input: PersonalInput, decision: Decision): Promise<PersonalResponse> }
function physicalResource(path: string): string {
  const absolute = resolve(path);
  try { const real = realpathSync.native(absolute); return process.platform === 'win32' ? real.toLowerCase() : real; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; const parent = dirname(absolute); if (parent === absolute) throw error; return join(physicalResource(parent), basename(absolute)); }
}
function checkoutResource(path: string): string | undefined {
  let directory = path;
  while (true) {
    try { const marker = statSync(join(directory, '.git')); if (marker.isDirectory() || marker.isFile()) return directory; }
    catch (error) { if (!['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error; }
    const parent = dirname(directory); if (parent === directory) return; directory = parent;
  }
}
export class PersonalHost {
  readonly store: PersonalStore;
  private readonly listeners = new Set<(delivery: Delivery) => void>();
  private readonly previewListeners = new Set<(preview: import('./types.js').ReplyPreview) => void>();
  private readonly active = new Map<string, { abort: AbortController; promise: Promise<void> }>();
  private readonly conversations = new Map<string, Promise<unknown>>();
  private readonly appliedRevisions = new Map<string, number>();
  private readonly modelWork = new Map<string, string>();
  private readonly continuations = new Map<string, { abort: AbortController; promise: Promise<void>; taskId: string }>();
  private closing = false;
  private preserveOnClose = true;
  private readonly now: () => number;
  constructor(private readonly options: PersonalHostOptions) { this.store = options.store; this.now = options.now ?? Date.now; for (const value of [options.maxConcurrent, options.maxDurationMs, options.maxTokens, options.maxAttempts, options.maxDialogueAttempts, options.maxRootCalls, options.maxGlobalCalls, options.maxGlobalTokens, options.maxRework]) if (value !== undefined && (!Number.isSafeInteger(value) || value < 1)) throw new Error('工作预算必须是有限正整数'); }
  getTask(id: string) { return this.store.getTask(id); }
  listTasks(conversationId?: string) { return this.store.listTasks(conversationId); }
  private workForSession(sessionId: string) { return this.modelWork.get(sessionId) ?? this.listTasks().find(task => !task.direct && (task.sessionId === sessionId || sessionId.startsWith(`verify:${task.id}:`)))?.id; }
  reserveSessionModelCall(sessionId: string) { this.reserveModelCall(this.workForSession(sessionId)); }
  assertRecallBudget(sessionId: string) {
    const taskId = this.workForSession(sessionId); const task = taskId ? this.getTask(taskId) : undefined;
    const rootId = task?.rootTaskId ?? task?.id;
    for (const id of [`global:${new Date(this.now()).toISOString().slice(0, 10)}`, ...(rootId ? [`root:${rootId}`] : [])]) {
      const budget = this.store.getBudget(id); const global = id.startsWith('global:');
      if (budget && (budget.calls >= (global ? this.options.maxGlobalCalls ?? 500 : this.options.maxRootCalls ?? 100) || budget.tokens >= (global ? this.options.maxGlobalTokens ?? 2_000_000 : this.options.maxTokens ?? 500_000))) throw new Error('工作预算已耗尽，未开始新的自动召回');
    }
  }
  accountSessionModelUsage(sessionId: string, usage: import('./types.js').Usage) { this.accountModelUsage(this.workForSession(sessionId), usage); }
  reserveModelCall(taskId?: string) { this.updateBudget(taskId, 1, 0); }
  accountModelUsage(taskId: string | undefined, usage: import('./types.js').Usage) { this.updateBudget(taskId, 0, (usage.input ?? 0) + (usage.output ?? 0), usage.costKnown === true, usage.cost); }
  private updateBudget(taskId: string | undefined, calls: number, tokens: number, costKnown = false, cost?: number) {
    const task = taskId ? this.getTask(taskId) : undefined; const rootId = task?.rootTaskId ?? task?.id;
    const ids = [`global:${new Date(this.now()).toISOString().slice(0, 10)}`, ...(rootId ? [`root:${rootId}`] : [])];
    try { this.store.transaction(() => {
      for (const id of ids) {
        const budget = this.store.getBudget(id) ?? { id, calls: 0, tokens: 0, rework: 0, costKnown: true };
        const global = id.startsWith('global:'); const callLimit = global ? this.options.maxGlobalCalls ?? 500 : this.options.maxRootCalls ?? 100;
        const tokenLimit = global ? this.options.maxGlobalTokens ?? 2_000_000 : this.options.maxTokens ?? 500_000;
        if (budget.calls + calls > callLimit || budget.tokens >= tokenLimit && calls) throw new Error('工作调用或 token 预算耗尽，暂停等待用户决定');
        budget.calls += calls; budget.tokens += tokens; if (!calls) { budget.costKnown &&= costKnown; if (cost !== undefined && Number.isFinite(cost) && cost >= 0) budget.cost = (budget.cost ?? 0) + cost; } this.store.putBudget(budget);
      }
    }); } catch (error) { if (rootId) { const root = this.getTask(rootId)!; root.status = 'waiting'; root.error = String(error); this.store.putTask(root); const id = `budget-pause:${rootId}:${ids[0]}`; if (!this.delivery(id)) { const delivery: Delivery = { id, taskId: rootId, conversationId: root.conversationId, actorId: root.actorId, text: '工作调用或 token 预算耗尽，已保留已有材料并暂停；需要调整预算或改小目标后继续。', status: 'pending', createdAt: this.now() }; this.store.putDelivery(delivery); queueMicrotask(() => this.notify(delivery)); } } throw error; }
  }
  /** Direct work shares the main Session, but owns a separate durable workspace. */
  workContext(input: PersonalInput, taskId?: string, eventId?: string): WorkToolContext {
    taskId ??= input.replyTaskId;
    let task = taskId ? this.getTask(taskId) : this.listTasks(input.conversationId).find(t => t.direct && t.originInputId === input.inputId && t.actorId === input.actorId && !t.cancelRequested && !t.contextExcluded);
    if (!task) {
      if (taskId) throw new Error('工作不存在');
      task = this.createTask(input, { kind: 'start', goal: input.text });
      task.direct = true; task.originInputId = input.inputId; task.originInput = input; task.status = 'waiting'; task.sessionId = this.store.conversationSession(input.conversationId);
      task.permission = { mode: 'restricted', readRoots: [task.cwd!], writeRoots: [task.cwd!], network: false,
        expiresAt: this.now() + 86_400_000, revision: task.revision, sourceInputId: input.inputId };
      this.store.putTask(task);
    }
    const id = task.id;
    if (task.direct) this.modelWork.set(task.sessionId, id);
    const current = () => {
      const latest = this.getTask(id);
      if (!latest || latest.actorId !== input.actorId || latest.conversationId !== input.conversationId || latest.cancelRequested || latest.contextExcluded || ['completed', 'cancelled', 'failed'].includes(latest.status)) throw new Error('工作已结束、取消或身份无效');
      return latest;
    };
    return { task, eventId, current, requestAction: action => { current(); return this.requestAction(id, action); },
      agreements: () => this.agreements(id), proposeAgreement: change => { if (eventId || task!.workKind === 'delegation') throw new Error('后台材料或帮手不能保存用户约定，请由用户明确表达并确认'); return this.proposeAgreement(input, change); },
      requestContext: (callId, query) => {
        const child = current(); const parent = child.parentTaskId ? this.getTask(child.parentTaskId) : undefined;
        if (!parent || parent.cancelRequested || parent.contextExcluded || child.workKind !== 'delegation' || !query.trim() || query.length > 2000) throw new Error('背景请求必须属于有效子委派且说明具体需要');
        const requestId = `context_request:${child.id}:${callId}`; const priorRequest = this.store.listWorkEvents().find(value => value.id === requestId);
        if (priorRequest && priorRequest.query !== query) throw new Error('同一背景请求标识不能更换查询');
        const event = this.store.enqueueWorkEvent({ id: requestId, kind: 'context_request', conversationId: child.conversationId, taskId: child.id, parentTaskId: parent.id, rootTaskId: child.rootTaskId ?? parent.id, attemptId: callId, revision: parent.revision, createdAt: this.now(), state: 'pending', query });
        child.contextRequestId = event.id; this.store.putTask(child); queueMicrotask(() => this.scheduleContinuations()); return event;
      },
      proposePermission: grant => { current(); return this.requestAction(id, { kind: 'permission-grant', target: id, parameters: { grant, proposedInputId: input.inputId }, content: `确认一次工作权限；可信 Shell 继承 Host 本机权限，不能强制禁止删除文件或外发；受控删除和发送另需明确授权：${JSON.stringify(grant)}` }); },
      dispatch: async <T>(callId: string, action: ActionSpec, execute: () => Promise<T>): Promise<T> => {
        const latest = current(); const dispatchId = `${id}:${eventId ?? input.inputId}:${callId}`;
        const proposed = { id: dispatchId, taskId: id, eventId, revision: latest.revision, action, status: 'dispatching' as const, startedAt: this.now() };
        const existing = this.store.getActionDispatch(dispatchId);
        if (existing) this.store.reserveActionDispatch(proposed);
        if (existing?.status === 'succeeded' && existing.evidence !== undefined) return JSON.parse(existing.evidence) as T;
        if (this.store.listActionDispatches().some(record => record.taskId === id && ['dispatching', 'unknown'].includes(record.status))) throw new Error('该工作已有未核实派发；暂停所有后续副作用，不能通过新 callId 重做');
        if (!existing && this.conflicts(latest)) throw new Error('工作资源被其他执行占用；动作尚未派发');
        const reserved = this.store.reserveActionDispatch(proposed);
        if (!reserved.created) {
          if (reserved.record.status === 'succeeded' && reserved.record.evidence !== undefined) return JSON.parse(reserved.record.evidence) as T;
          throw new Error('该动作已有派发记录；不能自动重复副作用，需核对已有结果');
        }
        latest.resourceHeld = true; this.store.putTask(latest);
        try { const result = await execute(); this.store.finishActionDispatch(dispatchId, 'succeeded', JSON.stringify(result ?? null)); const fresh = current(); fresh.resourceHeld = !fresh.direct || this.store.listActionDispatches().some(record => record.taskId === id && ['dispatching', 'unknown'].includes(record.status)); this.store.putTask(fresh); this.pump(); return result; }
        catch (error) { this.store.finishActionDispatch(dispatchId, 'unknown', String(error)); throw error; }
      }, send: text => this.publishNotification(current(), text, id), delegate: (callId, spec) => this.delegateWork(id, spec, callId), reserveModelCall: () => this.reserveModelCall(id), accountModelUsage: usage => this.accountModelUsage(id, usage),
      materialActions: () => this.store.listActionDispatches().filter(action => action.taskId === id || this.getTask(action.taskId)?.rootTaskId === id),
      controlChild: async (callId, childId, operation, text) => {
        const parent = current(); const child = this.getTask(childId); if (!child || child.parentTaskId !== parent.id || child.actorId !== parent.actorId || child.conversationId !== parent.conversationId) throw new Error('只能操作当前父工作的直属帮手');
        if (operation === 'cancel') return this.cancelWork(childId); if (operation === 'query') return { text: JSON.stringify(child), taskId: childId };
        if (!text?.trim() || child.cancelRequested || !['queued', 'running', 'waiting'].includes(child.status)) throw new Error('帮手已结束或补充要求为空');
        const operationId = `work-control:${id}:${eventId ?? input.inputId}:${callId}`; if (!child.requirementInputs?.includes(operationId)) { (child.requirementInputs ??= []).push(operationId); child.requirements.push(text); child.revision++; child.parentRevision = parent.revision; if (child.permission) child.permission.revision = child.revision; this.store.putTask(child); if (child.status === 'running') await this.options.executor.steer?.(child.id, text); }
        return { text: '相关帮手补充要求已保存，执行者需确认应用；已有影响未撤销。', taskId: childId };
      },
    };
  }
  delegateWork(parentId: string, spec: DelegationSpec, callId: string): Task {
    const task = this.store.transaction(() => {
      const parent = this.getTask(parentId);
      if (!parent || parent.cancelRequested || parent.contextExcluded || ['completed', 'cancelled', 'failed'].includes(parent.status)) throw new Error('父工作已结束或取消');
      if (this.store.listActionDispatches().some(record => record.taskId === parentId && ['dispatching', 'unknown'].includes(record.status))) throw new Error('父工作存在未核实动作，不能另开帮手重复执行');
      const id = `delegation:${createHash('sha256').update(JSON.stringify([parentId, callId])).digest('hex')}`;
      // Selection time is Host metadata; the selected original spans and rules
      // remain part of the request identity and must still match on replay.
      const identity = requestIdentity([parent.revision, { ...spec, contextPacket: spec.contextPacket ? { ...spec.contextPacket, at: undefined } : undefined }]);
      const existing = this.getTask(id); if (existing) { if (existing.delegationIdentity !== identity) throw new Error('委派请求身份冲突；旧记录缺少可核对身份时需人工核对，不能推断为当前要求。'); return existing; }
      const previousWork = spec.reworkOf ? this.getTask(spec.reworkOf) : this.listTasks().find(child => child.parentTaskId === parent.id && child.goal.trim() === spec.goal.trim() && child.purpose === spec.purpose && ['completed', 'partial', 'failed', 'cancelled'].includes(child.status));
      if (spec.reworkOf && (!previousWork || previousWork.parentTaskId !== parent.id)) throw new Error('返工必须关联该父工作的帮手');
      if (previousWork) {
        const budgetId = `root:${parent.rootTaskId ?? parent.id}`; const budget = this.store.getBudget(budgetId) ?? { id: budgetId, calls: 0, tokens: 0, rework: 0, costKnown: false };
        if (budget.rework >= (this.options.maxRework ?? 3)) throw new Error('返工预算耗尽，保留已有材料并暂停');
        budget.rework++; this.store.putBudget(budget);
      }
      if (!spec.goal.trim() || !['research', 'organization', 'coding'].includes(spec.purpose) || (spec.background?.length ?? 0) > 16_000) throw new Error('委派目标、成果类型或背景预算无效');
      const child = this.createTask({ conversationId: parent.conversationId, actorId: parent.actorId, inputId: parent.originInputId ?? id, text: spec.goal },
        { kind: 'start', goal: spec.goal, cwd: spec.cwd ?? parent.cwd, resources: spec.resources, executor: spec.purpose === 'coding' ? 'herdr' : 'local', deadline: parent.deadline }, id);
      child.workKind = 'delegation'; child.parentTaskId = parent.id; child.rootTaskId = parent.rootTaskId ?? parent.id;
      child.delegationIdentity = identity;
      child.purpose = spec.purpose; child.parentRevision = parent.revision; child.background = spec.background;
      if (spec.contextPacket) {
        if (spec.contextPacket.source !== 'parent_selected' || Buffer.byteLength(JSON.stringify(spec.contextPacket)) > 16000 || spec.contextPacket.agreementIds.some(id => !this.agreements(parent.id).some(rule => rule.id === id))) throw new Error('子背景或必要约定范围无效');
        child.contextPacket = spec.contextPacket;
      }
      if (parent.permission) {
      const grant = spec.permission ?? { ...parent.permission, mode: 'restricted' as const, readRoots: parent.permission.readRoots.filter(root => { const cwd = physicalResource(child.cwd!); const base = physicalResource(root); return cwd === base || cwd.startsWith(base + sep); }).length ? [child.cwd!] : [], writeRoots: parent.permission.writeRoots.filter(root => { const cwd = physicalResource(child.cwd!); const base = physicalResource(root); return cwd === base || cwd.startsWith(base + sep); }).length ? [child.cwd!] : [], network: false, deleteOriginal: false, externalSend: false };
        const within = (path: string, roots: string[]) => roots.some(root => { const actual = physicalResource(path); const base = physicalResource(root); return actual === base || actual.startsWith(base + sep); });
        if (grant.expiresAt > parent.permission.expiresAt || grant.network && !parent.permission.network || grant.mode === 'trusted' && parent.permission.mode !== 'trusted' || grant.readRoots.some(path => !within(path, parent.permission!.readRoots)) || grant.writeRoots.some(path => !within(path, parent.permission!.writeRoots)) || grant.deleteOriginal && !parent.permission.deleteOriginal || grant.externalSend && !parent.permission.externalSend) throw new Error('子委派权限不能扩大父工作授权');
        child.permission = { ...grant, readRoots: grant.readRoots.map(physicalResource), writeRoots: grant.writeRoots.map(physicalResource), revision: 0 };
        child.resources = [...new Set([...child.resources, ...child.permission.readRoots, ...child.permission.writeRoots].flatMap(path => [path, ...(checkoutResource(path) ? [checkoutResource(path)!] : [])]))];
      }
      parent.purpose ??= spec.purpose; parent.status = 'waiting'; parent.resourceHeld = this.store.listActionDispatches().some(action => action.taskId === parent.id && ['dispatching', 'unknown'].includes(action.status)); this.store.putTask(parent); this.store.putTask(child); return child;
    });
    queueMicrotask(() => this.pump()); return task;
  }
  private scheduleContinuations() {
    if (this.closing || !this.options.dialogue.resume) return;
    for (const event of this.store.listWorkEvents()) {
      if (event.state !== 'pending' || this.conversations.has(event.conversationId) || this.continuations.has(event.conversationId)) continue;
      const abort = new AbortController(); const promise = Promise.resolve().then(() => this.consumeWorkEvent(event, abort.signal)).finally(() => { this.continuations.delete(event.conversationId); this.scheduleContinuations(); });
      this.continuations.set(event.conversationId, { abort, promise, taskId: event.parentTaskId }); this.conversations.set(event.conversationId, promise);
      void promise.finally(() => { if (this.conversations.get(event.conversationId) === promise) this.conversations.delete(event.conversationId); this.scheduleContinuations(); }).catch(() => {});
    }
  }
  private async consumeWorkEvent(original: WorkEvent, signal: AbortSignal) {
    const task = this.getTask(original.parentTaskId); if (!task) return;
    if (task.cancelRequested || task.contextExcluded || ['completed', 'cancelled', 'failed'].includes(task.status)) { this.store.transitionWorkEvent(original.id, 'pending', 'blocked', '整体工作已结束'); return; }
    if (this.store.listActionDispatches(original.id).some(record => ['dispatching', 'unknown'].includes(record.status))) { this.store.transitionWorkEvent(original.id, 'pending', 'unknown', '动作尚未核实'); return; }
    const event = this.store.claimWorkEvent(original.id); if (!event) return;
    try {
      this.modelWork.set(task.sessionId, task.id);
      const input = task.originInput ?? { conversationId: task.conversationId, actorId: task.actorId, inputId: task.originInputId ?? task.id, text: task.goal };
      const outcome = await this.options.dialogue.resume!(event, { task: this.getTask(task.id)!, sessionId: task.sessionId, tasks: this.listTasks(task.conversationId), signal,
        work: () => this.workContext(input, task.id, event.id), onInjection: receipt => { this.store.recordWorkEventInjection(event.id, receipt); } });
      if (outcome.result?.verified && this.options.acceptContinuation) outcome.result = await this.options.acceptContinuation(this.getTask(task.id)!, outcome.result);
      this.commitContinuation(event, outcome);
    } catch (error) { this.store.transitionWorkEvent(event.id, 'processing', 'unknown', String(error)); const latest = this.getTask(task.id)!; if (!latest.cancelRequested) { latest.status = 'waiting'; latest.error = `后台续接需核实：${String(error)}`; this.store.putTask(latest); } }
    finally { this.modelWork.delete(task.sessionId); }
  }
  private commitContinuation(event: WorkEvent, outcome: ContinuationOutcome) {
    let delivery: Delivery | undefined;
    this.store.transaction(() => {
      const latest = this.getTask(event.parentTaskId)!;
      if (latest.cancelRequested || latest.contextExcluded || ['completed', 'cancelled', 'failed'].includes(latest.status)) { this.store.transitionWorkEvent(event.id, 'processing', 'blocked', '整体工作已结束或取消'); return; }
      // A Session receipt proves the model finished its turn, not that earlier
      // effects belonging to this root or its helpers were reconciled.
      const rootId = latest.rootTaskId ?? latest.id;
      const uncertain = this.store.listActionDispatches().filter(action => ['dispatching', 'unknown'].includes(action.status) && (action.taskId === rootId || this.getTask(action.taskId)?.rootTaskId === rootId));
      if (uncertain.length) {
        if (outcome.result) latest.result = { ...outcome.result, producedRevision: outcome.reviewedRevision, verified: false, partial: true };
        latest.status = 'waiting'; latest.error = '工作或相关帮手存在未核实动作；已保留部分材料，等待核对，不能宣布整体完成。'; latest.updatedAt = this.now();
        latest.resourceHeld ||= uncertain.some(action => action.taskId === latest.id); this.store.putTask(latest);
        this.store.transitionWorkEvent(event.id, 'processing', 'unknown', latest.error); return;
      }
      const consumed = this.store.completeWorkEvent(event.id, outcome.completion);
      if (consumed.state !== 'consumed' || latest.cancelRequested || latest.contextExcluded || ['completed', 'cancelled'].includes(latest.status)) return;
      if (event.kind === 'context_request') {
        const child = this.getTask(event.taskId)!;
        if (!outcome.contextResponse || outcome.reviewedRevision !== latest.revision) { child.error = '背景请求尚未得到本体按最新要求选择的材料'; child.status = 'waiting'; this.store.putTask(child); return; }
        if (outcome.contextResponse.source !== 'parent_selected' || Buffer.byteLength(JSON.stringify(outcome.contextResponse)) > 16000 || outcome.contextResponse.agreementIds.some(id => !this.agreements(latest.id).some(rule => rule.id === id))) throw new Error('子背景响应范围无效');
        child.contextPacket = outcome.contextResponse; delete child.contextRequestId;
        if (!this.active.has(child.id) && !child.resourceHeld) child.status = 'queued';
        this.store.putTask(child); queueMicrotask(() => this.pump()); return;
      }
      const stale = latest.revision !== outcome.reviewedRevision;
      if (outcome.result) { latest.result = { ...outcome.result, producedRevision: outcome.reviewedRevision }; if (stale) latest.result.verified = false; }
      const occupiedChild = this.listTasks().some(child => child.rootTaskId === latest.id && child.id !== latest.id && (child.resourceHeld || ['queued', 'running', 'stopping'].includes(child.status)));
      latest.status = !stale && !occupiedChild && outcome.outcome === 'completed' && outcome.result?.verified && !outcome.result.partial ? 'completed' : 'waiting';
      latest.error = stale ? '要求已变化，保留材料并等待最新要求复查。' : outcome.outcome === 'blocked' ? outcome.text ?? '工作受阻' : undefined;
      latest.updatedAt = this.now(); latest.resourceHeld = this.store.listActionDispatches().some(record => record.taskId === latest.id && ['dispatching', 'unknown'].includes(record.status)); this.store.putTask(latest);
      if (!stale && (latest.status === 'completed' || ['blocked', 'needs_decision'].includes(outcome.outcome))) {
        const id = `work-notification:${event.id}`; delivery = this.delivery(id);
        if (!delivery) { delivery = { id, conversationId: latest.conversationId, actorId: latest.actorId, taskId: latest.id, text: outcome.text ?? latest.result?.text ?? latest.error!, artifacts: latest.result?.artifacts, artifactDigests: latest.result?.artifactDigests, status: 'pending', createdAt: this.now() };
          if (latest.status === 'completed' && latest.originInput && latest.originInput.origin !== 'plan') delivery.learning = { id, input: latest.originInput.text, answer: delivery.text, originInputId: latest.originInput.inputId, inputAt: latest.originInput.receivedAt, recallId: recallIdentity(latest.originInput) };
          this.store.putDelivery(delivery); }
      }
    });
    if (delivery) this.notify(delivery);
  }
  async cancelWork(taskId: string): Promise<PersonalResponse> {
    const target = this.getTask(taskId); if (!target) return { text: '请明确要停止的工作。' };
    const selected = new Set([target.id]); let changed = true;
    while (changed) { changed = false; for (const task of this.listTasks()) if (task.parentTaskId && selected.has(task.parentTaskId) && !selected.has(task.id)) { selected.add(task.id); changed = true; } }
    this.store.transaction(() => {
      for (const id of selected) { const task = this.getTask(id)!; task.cancelRequested = true; if (['queued', 'running', 'waiting', 'stopping'].includes(task.status)) task.status = task.resourceHeld || this.active.has(id) ? 'stopping' : 'cancelled'; this.store.putTask(task); }
      for (const event of this.store.listWorkEvents()) if (selected.has(event.taskId) || selected.has(event.parentTaskId)) this.store.transitionWorkEvent(event.id, event.state, 'blocked', '用户已停止工作');
    });
    const continuing = this.continuations.get(target.conversationId); if (continuing && selected.has(continuing.taskId)) continuing.abort.abort(new Error('工作已停止'));
    for (const id of selected) {
      const active = this.active.get(id); if (active) { active.abort.abort(); continue; }
      const task = this.getTask(id)!; if (!task.resourceHeld) continue;
      const identity = this.store.listAttempts(id).at(-1)?.identity;
      const stopped = identity && this.options.executor.cancel ? await this.options.executor.cancel(identity).catch(() => false) : false;
      const latest = this.getTask(id)!; latest.status = stopped ? 'cancelled' : 'stopping'; latest.resourceHeld = !stopped; latest.error = stopped ? undefined : '执行者停止状态未知，需要核实；已有影响未撤销。'; this.store.putTask(latest);
    }
    const latestTarget = this.getTask(target.id)!; if (latestTarget.direct && this.listTasks().some(child => selected.has(child.id) && child.id !== latestTarget.id && (child.resourceHeld || this.active.has(child.id)))) { latestTarget.status = 'stopping'; latestTarget.error = '部分帮手终止状态尚未确认，正在停止；已有影响未撤销。'; this.store.putTask(latestTarget); }
    this.pump(); return { text: '停止意图已保存；正在核实帮手终止状态，已有影响未撤销。', taskId };
  }
  subscribe(listener: (delivery: Delivery) => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  subscribePreviews(listener: (preview: import('./types.js').ReplyPreview) => void) { this.previewListeners.add(listener); return () => { this.previewListeners.delete(listener); }; }
  private preview(preview: import('./types.js').ReplyPreview) { for (const listener of this.previewListeners) { try { listener(preview); } catch { /* A transient preview cannot fail durable work. */ } } }
  delivery(id: string) { return this.store.getDelivery(id); }
  pendingDeliveries(conversationId?: string) { return this.store.listDeliveries(conversationId).filter(d => d.status === 'pending'); }
  beginDelivery(id: string) {
    return this.store.transaction(() => { const d = this.delivery(id); if (!d || !['pending', 'rejected'].includes(d.status)) return false; d.status = 'sending'; this.store.putDelivery(d); return true; });
  }
  recordDelivery(id: string, status: 'sent' | 'rejected' | 'unknown', providerMessageId?: string) {
    const d = this.delivery(id); if (!d) throw new Error('Unknown delivery');
    d.status = status; if (providerMessageId) d.providerMessageId = providerMessageId; this.store.putDelivery(d);
  }
  resolveReply(conversationId: string, providerMessageId: string) { return this.store.listDeliveries(conversationId).find(d => d.providerMessageId === providerMessageId)?.taskId; }
  submit(input: PersonalInput): Promise<PersonalResponse> {
    if (this.closing) return Promise.reject(new Error('Host closing'));
    const inputKey = JSON.stringify([input.conversationId, input.actorId, input.inputId]);
    input = this.store.acceptInput(inputKey, { ...input, receivedAt: input.receivedAt ?? this.now() });
    const prior = this.conversations.get(input.conversationId) ?? Promise.resolve();
    const current = prior.catch(() => {}).then(async () => {
      const key = JSON.stringify([input.conversationId, input.actorId, input.inputId]);
      const previous = this.store.getInput(key); if (previous) return previous;
      if (this.store.inputAttempts(key) >= (this.options.maxDialogueAttempts ?? 3)) throw new Error('输入处理尝试次数已达上限；输入已保存，请检查故障后发送新消息。');
      this.store.beginInput(key);
      this.modelWork.delete(this.store.conversationSession(input.conversationId));
      const replyId = randomUUID();
      const onText = input.origin === 'plan' ? undefined : (text: string) => this.preview({ conversationId: input.conversationId, replyId, text });
      const decision = await this.options.dialogue.decide(input, { onText, tasks: this.listTasks(input.conversationId).filter(task => task.actorId === input.actorId && !task.contextExcluded), sessionId: this.store.conversationSession(input.conversationId), work: () => this.workContext(input), plans: this.store.listPlans<Plan>().filter(p => p.conversationId === input.conversationId && p.actorId === input.actorId && !p.contextExcluded), actions: this.store.listActions().filter(a => { const task = this.getTask(a.taskId); return task?.conversationId === input.conversationId && task.actorId === input.actorId && !task.contextExcluded; }) }).catch(error => { this.store.inputFailure(key, String(error)); throw error; }).finally(() => { if (onText) this.preview({ conversationId: input.conversationId, replyId }); });
      if (this.closing) throw new Error('Host shutdown; accepted input retained');
      if (decision.kind === 'start') return this.enqueueTask(input, decision);
      if (decision.kind === 'complete') {
        const task = this.getTask(decision.taskId); if (!task || task.actorId !== input.actorId || task.conversationId !== input.conversationId) throw new Error('整体完成工作身份不符');
        const event = this.store.enqueueWorkEvent({ id: `direct_completion:${task.id}:${input.inputId}`, kind: 'direct_completion', taskId: task.id, parentTaskId: task.id, rootTaskId: task.rootTaskId ?? task.id, attemptId: input.inputId, conversationId: task.conversationId, revision: decision.outcome.reviewedRevision, createdAt: this.now(), state: 'pending' });
        if (event.state !== 'consumed') { this.store.claimWorkEvent(event.id); this.store.recordWorkEventInjection(event.id, decision.injection); if (decision.outcome.result?.verified && this.options.acceptContinuation) decision.outcome.result = await this.options.acceptContinuation(this.getTask(task.id)!, decision.outcome.result); this.commitContinuation(event, decision.outcome); }
        const delivery = this.delivery(`work-notification:${event.id}`); const response = { text: delivery?.text ?? '成果已保存，等待最新要求复查。', taskId: task.id, deliveryId: delivery?.id }; this.store.putInput(key, response); return response;
      }
      const response = await this.apply(input, decision);
      this.store.transaction(() => {
        const existing = response.deliveryId ? this.delivery(response.deliveryId) : undefined;
        if (existing && (existing.conversationId !== input.conversationId || existing.actorId !== input.actorId)) throw new Error('Delivery ownership mismatch');
        const delivery = existing ?? this.makeDelivery(input, response.text, response.taskId);
        if (decision.kind === 'reply' && input.origin !== 'plan') { delivery.learning = { id: delivery.id, input: input.text, answer: response.text, recallId: recallIdentity(input), originInputId: input.inputId, inputAt: input.receivedAt }; this.store.putDelivery(delivery); }
        response.deliveryId = delivery.id; this.store.putInput(key, response);
      });
      this.notify(this.delivery(response.deliveryId!)!); this.pump(); return response;
    });
    this.conversations.set(input.conversationId, current);
    void current.finally(() => { if (this.conversations.get(input.conversationId) === current) { this.conversations.delete(input.conversationId); this.modelWork.delete(this.store.conversationSession(input.conversationId)); } this.scheduleContinuations(); }).catch(() => {});
    return current;
  }
  async startTask(input: PersonalInput, decision: Extract<Decision, { kind: 'start' }>): Promise<PersonalResponse> {
    return this.enqueueTask(input, decision);
  }
  enqueueTask(input: PersonalInput, decision: Extract<Decision, { kind: 'start' }>): PersonalResponse {
    const key = JSON.stringify([input.conversationId, input.actorId, input.inputId]);
    const response = this.store.transaction(() => {
      const previous = this.store.getInput(key); if (previous) return previous;
      const task = this.options.dialogue.resume ? this.workContext(input).task : this.createTask(input, decision);
      if (this.options.dialogue.resume) {
        task.goal = decision.goal; let authorized = true;
        if (decision.cwd) { const cwd = physicalResource(decision.cwd); authorized = task.permission!.readRoots.some(root => cwd === physicalResource(root) || cwd.startsWith(physicalResource(root) + sep)) && task.permission!.writeRoots.some(root => cwd === physicalResource(root) || cwd.startsWith(physicalResource(root) + sep)); if (authorized) task.cwd = cwd;
          else { task.error = '目标目录尚未授权；需确认具体工作范围后委派。'; this.store.putTask(task); void this.requestAction(task.id, { kind: 'permission-grant', target: task.id, parameters: { grant: { ...task.permission!, readRoots: [cwd], writeRoots: [cwd] }, proposedInputId: input.inputId, delegation: { goal: decision.goal, purpose: decision.executor === 'herdr' ? 'coding' : 'research', cwd, resources: decision.resources } }, content: `确认工作读写目录 ${cwd}；未授权前不会执行。` }); }
        }
        this.store.putTask(task); if (authorized) this.delegateWork(task.id, { goal: decision.goal, purpose: decision.executor === 'herdr' ? 'coding' : 'research', cwd: decision.cwd, resources: decision.resources }, `start:${input.inputId}`);
      }
      const response = { text: `已接收任务：${task.goal}`, taskId: task.id, deliveryId: '' };
      response.deliveryId = this.makeDelivery(input, response.text, task.id).id; this.store.putInput(key, response); return response;
    });
    queueMicrotask(() => { const delivery = this.delivery(response.deliveryId!); if (!this.closing && delivery) { this.notify(delivery); this.pump(); } }); return response;
  }
  private createTask(input: PersonalInput, decision: Extract<Decision, { kind: 'start' }>, id: string = randomUUID()): Task {
    const cwd = physicalResource(decision.cwd ?? join(this.store.directory, 'workspaces', id));
    const paths = [ ...(decision.resources ?? []), cwd ].map(physicalResource);
    const explicitProjectPaths = [ ...(decision.resources ?? []), ...(decision.cwd ? [cwd] : []) ].map(physicalResource);
    // Generated per-task workspaces have their own scope. They do not inherit
    // the repository that happens to contain the Host's data directory.
    const projects = explicitProjectPaths.flatMap(path => { const checkout = checkoutResource(path); return checkout ? [checkout] : []; });
    const task: Task = { id, conversationId: input.conversationId, actorId: input.actorId, goal: decision.goal,
      resources: [...new Set([...paths, ...projects])],
      executor: decision.executor ?? 'local', cwd, sessionId: randomUUID(), status: 'queued', createdAt: this.now(), updatedAt: this.now(), requirements: [], revision: 0, resourceHeld: false, deadline: decision.deadline };
    task.permission = { mode: 'restricted', readRoots: [cwd], writeRoots: [cwd], network: false, expiresAt: this.now() + 86_400_000, revision: 0, sourceInputId: input.inputId };
    this.store.putTask(task); return task;
  }
  private async apply(input: PersonalInput, decision: Decision): Promise<PersonalResponse> {
    if (decision.kind === 'complete') throw new Error('整体完成必须经过持久事件结算');
    if (decision.kind === 'reply') return { text: decision.text };
    if (decision.kind === 'start') { const task = this.createTask(input, decision); return { text: `已接收任务：${task.goal}`, taskId: task.id }; }
    if (decision.kind === 'authorize') return this.authorizeAction(input, decision.actionId, decision.approved);
    if (decision.kind === 'schedule' || decision.kind === 'plan' || decision.kind === 'redeliver') return this.options.handleDecision?.(input, decision) ?? { text: '当前没有配置该操作。' };
    const id = input.replyTaskId ?? decision.taskId;
    const task = id ? this.getTask(id) : undefined;
    if (!task || task.conversationId !== input.conversationId || task.actorId !== input.actorId) return { text: '请明确要操作哪个任务。' };
    if (task.contextExcluded && decision.kind !== 'cancel') return { text: '该任务上下文因遗忘已排除。历史责任仍保留；请用新的输入重新说明可使用的目标。', taskId: task.id };
    if (decision.kind === 'query') return { text: `${task.goal}\n状态：${task.status}${task.result ? '\n' + task.result.text : ''}${task.error ? '\n' + task.error : ''}`, taskId: task.id };
    if (decision.kind === 'cancel') {
      if (this.options.dialogue.resume) return this.cancelWork(task.id);
      if (!['queued', 'running', 'waiting', 'stopping'].includes(task.status)) return { text: `任务已结束：${task.status}`, taskId: task.id };
      task.cancelRequested = true;
      if (task.status === 'queued' || task.status === 'waiting' && !task.resourceHeld && !this.active.has(task.id)) { task.status = 'cancelled'; task.resourceHeld = false; this.store.putTask(task); this.pump(); return { text: '任务已停止，已有影响未撤销。', taskId: task.id }; }
      task.status = 'stopping'; this.store.putTask(task); this.active.get(task.id)?.abort.abort();
      if (!this.active.has(task.id)) {
        const identity = this.store.listAttempts(task.id).at(-1)?.identity;
        if (identity && this.options.executor.cancel) void this.options.executor.cancel(identity).then(stopped => {
          const current = this.getTask(task.id)!; current.status = stopped ? 'cancelled' : 'waiting'; current.resourceHeld = !stopped; current.error = stopped ? undefined : '执行者停止状态未知，需要核实。'; this.store.putTask(current); this.publishNotification(current, stopped ? '任务已停止，已有影响未撤销。' : current.error!, current.id); this.pump();
        }).catch(() => {});
      }
      return { text: '正在停止任务，已有影响未撤销。', taskId: task.id };
    }
    const requirement = decision.text ?? input.text;
    if (!['queued', 'running', 'waiting'].includes(task.status)) return { text: '该任务已结束，请创建新任务。', taskId: task.id };
    const requirementInput = JSON.stringify([input.conversationId, input.actorId, input.inputId]);
    if (task.requirementInputs?.includes(requirementInput)) return { text: '补充要求已接收；不会重复改向。执行状态可查询。', taskId: task.id };
    (task.requirementInputs ??= []).push(requirementInput);
    task.requirements.push(requirement); task.revision++; if (task.permission) task.permission.revision = task.revision; task.updatedAt = this.now(); this.store.putTask(task);
    if (task.direct && this.options.dialogue.resume) { this.store.enqueueWorkEvent({ id: `requirements_changed:${task.id}:${task.revision}`, kind: 'requirements_changed', taskId: task.id, parentTaskId: task.id, rootTaskId: task.rootTaskId ?? task.id, attemptId: requirementInput, conversationId: task.conversationId, revision: task.revision, createdAt: this.now(), state: 'pending' }); return { text: '补充要求已保存，本体将在当前回复后复查相关子目标；已有影响未撤销。', taskId: task.id }; }
    const applied = task.status === 'running' ? await this.options.executor.steer?.(task.id, requirement) ?? false : true;
    if (applied) this.appliedRevisions.set(task.id, task.revision);
    return { text: applied ? '补充要求已应用；已有影响未撤销。' : '已接收补充要求，执行者尚未确认应用。', taskId: task.id };
  }
  async requestAction(taskId: string, action: ActionSpec): Promise<boolean> {
    const task = this.getTask(taskId); if (!task || task.contextExcluded || !['running', 'waiting'].includes(task.status)) return false;
    const fingerprint = createHash('sha256').update(JSON.stringify([task.id, task.revision, action.kind, action.target, action.parameters, action.content])).digest('hex');
    const existing = this.store.listActions(taskId).find(a => a.fingerprint === fingerprint);
    if (existing) {
      if (existing.status !== 'approved') return false;
      // Claim dispatch durably before the external effect. A crash after this boundary
      // is uncertain; it must never turn the same approval into another dispatch.
      existing.status = 'consumed'; this.store.putAction(existing); return true;
    }
    const record: ActionRecord = { id: randomUUID(), taskId, revision: task.revision, fingerprint, action, status: 'pending', createdAt: this.now() };
    if (action.kind === 'permission-grant' && typeof action.parameters.proposedInputId === 'string') record.proposedInputId = action.parameters.proposedInputId;
    let delivery!: Delivery;
    this.store.transaction(() => { this.store.putAction(record); delivery = this.makeDelivery(task, `需要确认外部动作 ${record.id}：${action.kind}\n对象：${action.target}\n参数：${JSON.stringify(action.parameters)}\n${action.content}`, task.id); });
    this.notify(delivery); return false;
  }
  agreements(taskId: string) {
    const task = this.getTask(taskId); if (!task || task.contextExcluded) return [];
    return this.store.listAgreements().filter(rule => rule.actorId === task.actorId && rule.state === 'active' && (task.workKind !== 'delegation' || task.contextPacket?.agreementIds.includes(rule.id)) && (rule.scope.kind === 'global' || rule.scope.kind === 'work' && rule.scope.id === (task.rootTaskId ?? task.id) || rule.scope.kind === 'project' && rule.scope.id === physicalResource(task.cwd!)));
  }
  applicableAgreements(input: PersonalInput) {
    const task = input.replyTaskId ? this.getTask(input.replyTaskId) : this.listTasks(input.conversationId).find(task => task.direct && task.actorId === input.actorId && task.originInputId === input.inputId && !task.contextExcluded);
    if (task && task.conversationId === input.conversationId && task.actorId === input.actorId) return this.agreements(task.id);
    return this.store.listAgreements().filter(rule => rule.actorId === input.actorId && rule.state === 'active' && rule.scope.kind === 'global');
  }
  proposeAgreement(input: PersonalInput, change: AgreementChange): PersonalResponse {
    if (input.origin || !['save', 'edit', 'revoke'].includes(change.operation)) throw new Error('工作约定只接受真实用户输入的明确操作');
    const task = this.workContext(input).current(); const existing = change.id ? this.store.listAgreements().find(rule => rule.id === change.id && rule.actorId === input.actorId && this.agreements(task.id).some(value => value.id === rule.id)) : undefined;
    if (change.operation !== 'save' && !existing) throw new Error('约定不存在、已撤销或不属于当前作用域');
    const scope = change.scope ?? existing?.scope ?? { kind: 'work' as const, id: task.rootTaskId ?? task.id };
    if (scope.kind === 'work' && scope.id !== (task.rootTaskId ?? task.id) || scope.kind === 'project' && scope.id !== physicalResource(task.cwd!) || !['work', 'project', 'global'].includes(scope.kind)) throw new Error('约定作用域不明确或不属于当前工作，请明确范围');
    const content = change.content ?? existing?.content ?? ''; if (!content.trim() || content.length > 4000) throw new Error('约定内容必须明确且不超过4000字符');
    const parameters = { ...change, content, scope, expectedRevision: existing?.revision, proposedInputId: input.inputId, sourceText: input.text };
    const proposalKey = createHash('sha256').update(JSON.stringify([input.conversationId, input.actorId, input.inputId, parameters])).digest('hex');
    const priorProposal = this.store.getAction(`agreement-proposal:${proposalKey}`);
    if (priorProposal) return { text: `${priorProposal.action.content}\n如同意，请明确回复：确认动作 ${priorProposal.id}`, taskId: priorProposal.taskId };
    const action = { kind: 'working-agreement', target: existing?.id ?? `agreement:${proposalKey}`, parameters, content: `工作约定内容：${content}\n范围：${JSON.stringify(scope)}\n操作：${change.operation}。约定不会增加执行权限。` };
    const record: ActionRecord = { id: `agreement-proposal:${proposalKey}`, taskId: task.id, revision: task.revision, fingerprint: createHash('sha256').update(JSON.stringify(action)).digest('hex'), action, status: 'pending', createdAt: this.now(), proposedInputId: input.inputId };
    const text = `${action.content}\n如同意，请明确回复：确认动作 ${record.id}`;
    this.store.transaction(() => { this.store.putAction(record); this.makeDelivery(task, text, task.id); });
    return { text, taskId: task.id };
  }
  authorizeAction(input: PersonalInput, actionId: string, approved: boolean): PersonalResponse {
    return this.store.transaction(() => {
    const record = this.store.getAction(actionId); const task = record ? this.getTask(record.taskId) : undefined;
    if (!record || !task || task.contextExcluded || task.actorId !== input.actorId || task.conversationId !== input.conversationId || record.revision !== task.revision || record.status !== 'pending') return { text: '确认已失效或不属于此对话，请核对具体动作。' };
    if (task.cancelRequested || record.proposedInputId === input.inputId) return { text: '权限提案必须等待用户后续明确确认，已取消工作不能扩大权限。' };
    if (record.action.kind === 'working-agreement') {
      if (input.origin || approved && input.text.trim() !== `确认动作 ${record.id}` || !approved && input.text.trim() !== `拒绝动作 ${record.id}`) return { text: `请按所展示的内容和范围明确回复：确认动作 ${record.id}，或拒绝动作 ${record.id}` };
      if (!approved) { record.status = 'denied'; this.store.putAction(record); return { text: '已拒绝保存此工作约定。', taskId: task.id }; }
      const change = record.action.parameters as unknown as AgreementChange & { content: string; expectedRevision?: number };
      const prior = this.store.listAgreements().find(rule => rule.id === record.action.target);
      if (prior && (prior.actorId !== input.actorId || !this.agreements(task.id).some(rule => rule.id === prior.id) || prior.revision !== change.expectedRevision)) return { text: '约定已变化，请重新查看并确认。' };
      const agreement: WorkingAgreement = { id: record.action.target, actorId: input.actorId, conversationId: input.conversationId, content: change.content, scope: change.scope!, revision: (prior?.revision ?? 0) + 1, state: change.operation === 'revoke' ? 'revoked' : 'active', sourceInputId: record.proposedInputId!, confirmedInputId: input.inputId, at: this.now(), history: [...(prior?.history ?? []), ...(prior ? [{ content: prior.content, scope: prior.scope, revision: prior.revision, state: prior.state, confirmedInputId: prior.confirmedInputId }] : [])] };
      this.store.putAgreement(agreement); record.status = 'consumed'; this.store.putAction(record);
      return { text: `${agreement.state === 'revoked' ? '已撤销' : '已保存'}工作约定：${agreement.content}\n范围：${JSON.stringify(agreement.scope)}；不会增加执行权限。`, taskId: task.id };
    }
    record.status = approved ? 'approved' : 'denied'; this.store.putAction(record);
    if (approved && record.action.kind === 'permission-grant') {
      const grant = record.action.parameters.grant as Omit<PermissionGrant, 'revision' | 'sourceInputId'>;
      if (!grant || !['restricted', 'trusted'].includes(grant.mode) || !Array.isArray(grant.readRoots) || !Array.isArray(grant.writeRoots) || ![...grant.readRoots, ...grant.writeRoots].every(path => typeof path === 'string') || typeof grant.network !== 'boolean' || !Number.isFinite(grant.expiresAt) || grant.expiresAt <= this.now()) throw new Error('权限范围无效或已过期');
      task.permission = { ...grant, readRoots: grant.readRoots.map(physicalResource), writeRoots: grant.writeRoots.map(physicalResource), revision: task.revision, sourceInputId: input.inputId };
      task.resources = [...new Set([...task.resources, ...task.permission.readRoots, ...task.permission.writeRoots].flatMap(path => [path, ...(checkoutResource(path) ? [checkoutResource(path)!] : [])]))];
      record.status = 'consumed'; this.store.putAction(record); this.store.putTask(task);
      if (record.action.parameters.delegation) this.delegateWork(task.id, record.action.parameters.delegation as DelegationSpec, `authorized-start:${record.id}`);
    }
    if (approved && !task.direct && task.status === 'waiting' && !task.cancelRequested && !task.resourceHeld && !this.active.has(task.id) && this.store.listAttempts(task.id).length < (this.options.maxAttempts ?? 3)) { task.status = 'queued'; this.store.putTask(task); }
    return { text: approved ? '已确认此项具体动作；目标或参数变化需要重新确认。' : '已拒绝此项动作。', taskId: task.id };
    });
  }
  private makeDelivery(input: Pick<PersonalInput, 'conversationId' | 'actorId'>, text: string, taskId?: string, artifacts?: string[]): Delivery {
    const delivery: Delivery = { id: randomUUID(), conversationId: input.conversationId, actorId: input.actorId, text, taskId, artifacts,
      artifactDigests: taskId ? this.getTask(taskId)?.result?.artifactDigests : undefined, status: 'pending', createdAt: this.now() };
    this.store.putDelivery(delivery); return delivery;
  }
  private notify(delivery: Delivery) { for (const listener of this.listeners) { try { listener(delivery); } catch { /* persisted pending delivery remains recoverable */ } } }
  publishNotification(input: Pick<PersonalInput, 'conversationId' | 'actorId'>, text: string, taskId?: string, artifacts?: string[]) {
    const delivery = this.makeDelivery(input, text, taskId, artifacts); queueMicrotask(() => { const saved = this.delivery(delivery.id); if (saved && !this.closing) this.notify(saved); }); return delivery;
  }
  private conflicts(task: Task) {
    const holders = this.listTasks().filter(other => other.id !== task.id && (this.active.has(other.id) || other.resourceHeld || ['running', 'stopping'].includes(other.status)));
    return holders.some(other => task.resources.some(a => other.resources.some(b => a === b || a.startsWith(b + sep) || b.startsWith(a + sep))));
  }
  private pump() {
    if (this.closing) return;
    for (const root of this.listTasks().filter(task => task.direct && task.cancelRequested)) { const uncertain = root.resourceHeld || this.listTasks().some(child => child.rootTaskId === root.id && child.id !== root.id && (child.resourceHeld || ['running', 'stopping'].includes(child.status))); const status = uncertain ? 'stopping' : 'cancelled'; if (root.status !== status) { root.status = status; root.error = uncertain ? '部分执行终止尚未确认，正在停止；已有影响未撤销。' : undefined; this.store.putTask(root); } }
    for (const task of this.listTasks()) {
      const occupied = this.listTasks().filter(t => !t.direct && (this.active.has(t.id) || t.resourceHeld || ['running', 'stopping'].includes(t.status))).length;
      if (occupied >= (this.options.maxConcurrent ?? 2)) break;
      if (task.direct || this.active.has(task.id) || task.status !== 'queued' || this.conflicts(task)) continue;
      if (task.contextExcluded) continue;
      if (task.deadline !== undefined && this.now() >= task.deadline) { task.status = 'waiting'; task.error = '任务期限已过，不会执行。'; this.store.putTask(task); this.publishNotification(task, task.error, task.id); continue; }
      const abort = new AbortController();
      const promise = Promise.resolve().then(() => this.execute(task, abort)).finally(() => { this.active.delete(task.id); this.pump(); });
      this.active.set(task.id, { abort, promise });
    }
  }
  private async execute(task: Task, abort: AbortController) {
    task = this.getTask(task.id)!;
    if (task.status !== 'queued' || abort.signal.aborted) return;
    const attempt: Attempt = { id: randomUUID(), taskId: task.id, sessionId: task.sessionId, status: 'running', startedAt: this.now(), startedRevision: task.revision, presentedRevision: task.revision };
    if (this.store.listAttempts(task.id).length >= (this.options.maxAttempts ?? 3)) { task.status = 'waiting'; task.error = '执行尝试次数预算耗尽'; task.resourceHeld = false; this.store.putTask(task); return; }
    task.status = 'running'; task.error = undefined; task.resourceHeld = true; this.store.transaction(() => { this.store.putTask(task); this.store.putAttempt(attempt); });
    this.appliedRevisions.set(task.id, task.revision);
    const timer = setTimeout(() => abort.abort(new Error('执行时间预算耗尽')), Math.max(1, Math.min(this.options.maxDurationMs ?? 30 * 60_000, task.deadline === undefined ? Infinity : task.deadline - this.now())));
    timer.unref();
    let cancellation: Promise<boolean> | undefined;
    const preservingShutdown = () => this.closing && this.preserveOnClose && abort.signal.reason instanceof Error && abort.signal.reason.message === 'Host shutdown';
    const requestCancel = () => {
      if (preservingShutdown()) return;
      if (!cancellation && attempt.identity && this.options.executor.cancel) cancellation = this.options.executor.cancel(attempt.identity).catch(() => false);
    };
    abort.signal.addEventListener('abort', requestCancel, { once: true });
    try {
      if (task.executor === 'herdr') { this.reserveModelCall(task.id); this.accountModelUsage(task.id, { costKnown: false }); }
      const result = await this.options.executor.execute({ task, attempt, signal: abort.signal,
        onIdentity: identity => { attempt.identity = identity; this.store.putAttempt(attempt); if (abort.signal.aborted) requestCancel(); },
        onUsage: usage => { attempt.usage = usage; this.store.putAttempt(attempt); if ((usage.input ?? 0) + (usage.output ?? 0) > (this.options.maxTokens ?? 500_000)) abort.abort(new Error('执行用量预算耗尽')); },
        onRequirementApplied: revision => { const current = this.getTask(task.id); if (current && Number.isInteger(revision) && revision >= (attempt.presentedRevision ?? 0) && revision <= current.revision) { attempt.presentedRevision = revision; this.store.putAttempt(attempt); this.appliedRevisions.set(task.id, revision); } },
        requestAction: action => this.requestAction(task.id, action) });
      task = this.getTask(task.id)!; result.producedRevision = attempt.presentedRevision; task.result = result;
      if (abort.signal.aborted) task.status = abort.signal.reason instanceof Error && /预算/.test(abort.signal.reason.message) ? 'waiting' : 'cancelled';
      else if (task.revision > (this.appliedRevisions.get(task.id) ?? 0)) { task.status = 'partial'; result.verified = false; }
      else task.status = result.verified && !result.partial ? 'completed' : 'partial';
      task.resourceHeld = false;
    } catch (error) {
      task = this.getTask(task.id)!; task.error = String(error); task.status = abort.signal.aborted ? abort.signal.reason instanceof Error && /预算/.test(abort.signal.reason.message) ? 'waiting' : 'cancelled' : 'failed';
      if (error instanceof Error && error.name === 'ExecutorAttentionError') task.status = 'waiting';
      if (error instanceof Error && error.name === 'ExecutorContextError') { task.status = task.contextRequestId ? 'waiting' : 'queued'; task.resourceHeld = false; this.store.transaction(() => { this.store.putTask(task); attempt.status = 'waiting'; attempt.finishedAt = this.now(); this.store.putAttempt(attempt); }); return; }
      if (error instanceof Error && error.name === 'ExecutorBudgetError') { task.status = 'waiting'; task.error = '执行预算耗尽，保留已有成果。'; }
      if (abort.signal.reason instanceof Error && /预算/.test(abort.signal.reason.message)) task.error = abort.signal.reason.message;
      if (error instanceof Error && error.name === 'ExecutorAttentionError' && this.store.listActions(task.id).some(a => a.status === 'approved' && a.revision === task.revision)) task.status = 'queued';
      if (attempt.identity && this.options.executor.inspect && task.status === 'failed' && !abort.signal.aborted) {
        const evidence = await this.options.executor.inspect(attempt.identity).catch(() => ({ state: 'unknown' as const }));
        task = { ...this.getTask(task.id)!, status: task.status, error: task.error, result: task.result, resourceHeld: task.resourceHeld };
        if (evidence.state === 'resumable') { task.resourceHeld = false; task.status = this.store.listAttempts(task.id).length < (this.options.maxAttempts ?? 3) ? 'queued' : 'waiting'; }
        else if (evidence.state === 'stopped') task.resourceHeld = false;
      }
      if (error instanceof Error && error.name === 'ExecutorAttentionError' && attempt.identity?.kind === 'pi') task.resourceHeld = false;
      if (!attempt.identity) task.resourceHeld = false;
      if (task.status === 'waiting' && attempt.identity?.kind === 'pi' && this.options.executor.inspect && !task.cancelRequested) {
        const evidence = await this.options.executor.inspect(attempt.identity).catch(() => ({ state: 'unknown' as const }));
        task = { ...this.getTask(task.id)!, status: task.status, error: task.error, result: task.result, resourceHeld: task.resourceHeld };
        if (['resumable', 'stopped', 'completed'].includes(evidence.state)) task.resourceHeld = false;
      }
      if (attempt.identity && this.options.executor.cancel && task.status === 'failed') requestCancel();
    } finally {
      clearTimeout(timer);
      abort.signal.removeEventListener('abort', requestCancel);
      if (!preservingShutdown() && (abort.signal.aborted || cancellation) && attempt.identity && this.options.executor.cancel) {
        requestCancel(); const stopped = await cancellation;
        const latest = this.getTask(task.id)!; task = { ...latest, result: task.result, error: task.error, status: task.status };
        task.resourceHeld = !stopped;
        if (!stopped) { task.status = task.workKind === 'delegation' && task.cancelRequested ? 'stopping' : 'waiting'; task.error = '执行者停止状态未知，需要核实；不会自动重试。'; }
      }
      task.updatedAt = this.now(); attempt.status = task.status; attempt.finishedAt = this.now();
      if (this.getTask(task.id)?.contextExcluded) { task.contextExcluded = true; task.cancelRequested = true; this.store.transaction(() => { this.store.putTask(task); this.store.putAttempt(attempt); }); return; }
      if (preservingShutdown()) {
        task.status = attempt.identity?.kind === 'herdr' ? 'running' : 'waiting'; attempt.status = task.status;
        task.error = 'Host 已关闭；重新启动后先核对执行状态与已有成果。';
        this.store.transaction(() => { this.store.putTask(task); this.store.putAttempt(attempt); }); return;
      }
      let delivery!: Delivery;
      if (task.workKind === 'delegation' && task.parentTaskId) { task.result ??= { text: task.error ?? '帮手停止，已有影响保留', verified: false, partial: true, producedRevision: attempt.presentedRevision }; this.store.settleDelegationResult(task, attempt); this.scheduleContinuations(); return; }
      this.store.transaction(() => { this.store.putTask(task); this.store.putAttempt(attempt); delivery = this.makeDelivery(task, `${task.goal}\n状态：${task.status}\n${task.result?.text ?? task.error ?? '任务停止；已有影响未撤销。'}`, task.id, task.result?.artifacts); if (task.result && task.originInput && task.originInput.origin !== 'plan' && ['completed', 'partial'].includes(task.status)) { delivery.learning = { id: delivery.id, input: task.originInput.text, answer: task.result.text, originInputId: task.originInput.inputId, inputAt: task.originInput.receivedAt, recallId: recallIdentity(task.originInput) }; this.store.putDelivery(delivery); } });
      this.notify(delivery);
    }
  }
  /** Reconcile actual executor state before considering any new execution. */
  async recover() {
    for (const delivery of this.store.listDeliveries()) if (delivery.status === 'sending') { delivery.status = 'unknown'; this.store.putDelivery(delivery); }
    if (this.options.dialogue.inspectContinuation) for (const event of this.store.listWorkEvents()) {
      if (!['processing', 'unknown'].includes(event.state)) continue;
      const parent = this.getTask(event.parentTaskId); if (!parent || parent.cancelRequested || parent.contextExcluded || ['completed', 'cancelled'].includes(parent.status)) { this.store.transitionWorkEvent(event.id, event.state, 'blocked', '整体工作已结束或取消'); continue; }
      const evidence = await this.options.dialogue.inspectContinuation(event, parent.sessionId).catch(() => ({ state: 'unknown' as const }));
      const latestParent = this.getTask(parent.id); if (!latestParent || latestParent.cancelRequested || latestParent.contextExcluded || ['completed', 'cancelled'].includes(latestParent.status)) { this.store.transitionWorkEvent(event.id, event.state, 'blocked', '核对期间整体已结束'); continue; }
      const uncertain = this.store.listActionDispatches(event.id).some(action => ['dispatching', 'unknown'].includes(action.status));
      if (evidence.state === 'completed' && evidence.injection && evidence.outcome && !uncertain) {
        if (evidence.outcome.result?.verified && this.options.acceptContinuation) evidence.outcome.result = await this.options.acceptContinuation(this.getTask(parent.id)!, evidence.outcome.result);
        this.store.transitionWorkEvent(event.id, event.state, 'processing'); this.store.recordWorkEventInjection(event.id, evidence.injection); this.commitContinuation(event, evidence.outcome);
      } else if (evidence.state === 'absent' && !uncertain && !event.injection) this.store.transitionWorkEvent(event.id, event.state, 'pending');
      else if (evidence.state === 'injected' && evidence.injection && !uncertain) {
        this.store.transitionWorkEvent(event.id, event.state, 'processing'); this.store.recordWorkEventInjection(event.id, evidence.injection); this.store.transitionWorkEvent(event.id, 'processing', 'pending');
      } else this.store.transitionWorkEvent(event.id, event.state, 'unknown', 'Session 或动作尚未核实，不自动重做');
    }
    for (let task of this.listTasks()) {
      if (task.direct) continue;
      if (!['running', 'stopping', 'waiting'].includes(task.status) || this.active.has(task.id)) continue;
      const attempt = this.store.listAttempts(task.id).at(-1);
      if (task.contextExcluded) { task.status = task.resourceHeld ? 'waiting' : 'cancelled'; this.store.putTask(task); continue; }
      const evidence = attempt?.identity && this.options.executor.inspect ? await this.options.executor.inspect(attempt.identity).catch(() => ({ state: 'unknown' as const })) : { state: 'unknown' as const };
      task = this.getTask(task.id)!;
      if (task.cancelRequested || task.status === 'stopping') {
        const stopped = evidence.state === 'stopped' || evidence.state === 'resumable' || attempt?.identity && this.options.executor.cancel && await this.options.executor.cancel(attempt.identity).catch(() => false);
        task = this.getTask(task.id)!; task.status = stopped ? 'cancelled' : task.workKind === 'delegation' ? 'stopping' : 'waiting'; task.resourceHeld = !stopped; task.cancelRequested = true;
        task.error = stopped ? undefined : '执行者停止状态未知，需要核实；不会自动继续。';
      } else if (evidence.state === 'completed' && evidence.result) {
        evidence.result.producedRevision ??= attempt?.presentedRevision;
        const latest = this.getTask(task.id)!; if (latest.cancelRequested || latest.contextExcluded) continue;
        task = latest; task.result = evidence.result; if (evidence.result.producedRevision !== task.revision) evidence.result.verified = false;
        task.status = evidence.result.verified && !evidence.result.partial ? 'completed' : 'partial';
        task.resourceHeld = false;
        if (task.workKind === 'delegation' && attempt) { this.store.settleDelegationResult(task, { ...attempt, status: task.status, finishedAt: this.now() }); continue; }
        let delivery!: Delivery;
        this.store.transaction(() => { this.store.putTask(task); if (attempt) { attempt.status = task.status; this.store.putAttempt(attempt); } delivery = this.makeDelivery(task, `${task.goal}\n状态：${task.status}\n${evidence.result!.text}`, task.id, evidence.result!.artifacts); }); this.notify(delivery);
      } else if (evidence.state === 'resumable') {
        task.resourceHeld = false;
        if (task.contextRequestId) { task.status = 'waiting'; task.error = '等待本体选择补充背景'; this.store.putTask(task); continue; }
        const pending = this.store.listActions(task.id).some(a => a.revision === task.revision && ['pending', 'denied', 'consumed'].includes(a.status));
        if (!pending && !task.error?.includes('预算') && this.store.listAttempts(task.id).length < (this.options.maxAttempts ?? 3)) { task.status = 'queued'; task.error = undefined; }
        else { task.status = 'waiting'; task.error = pending ? '具体动作需要确认或核实，保持等待。' : '执行尝试次数预算耗尽'; }
      } else if (evidence.state === 'stopped') { task.status = 'waiting'; task.resourceHeld = false; task.error = '执行者已停止；检查已有成果后才能续做。'; }
      else if (evidence.state === 'unknown') { task.status = 'waiting'; task.resourceHeld = Boolean(attempt?.identity); task.error = '执行状态未知，需要核实；不会重复启动。'; }
      else if (evidence.state === 'running' && attempt?.identity) { task.status = 'running'; task.resourceHeld = true; this.attach(task, attempt); }
      // A live executor retains its task and resource reservation; no new prompt is sent.
      task.updatedAt = this.now(); this.store.putTask(task);
      if (attempt && task.status !== 'running') { attempt.status = task.status; this.store.putAttempt(attempt); }
    }
    for (const input of this.store.pendingInputs()) {
      const key = JSON.stringify([input.conversationId, input.actorId, input.inputId]);
      if (this.store.inputAttempts(key) >= (this.options.maxDialogueAttempts ?? 3)) continue;
      await this.submit(input).catch(() => {});
    }
    this.pump(); this.scheduleContinuations();
  }
  async excludeConversationContext(conversationId: string) {
    const tasks = this.listTasks(conversationId);
    this.store.transaction(() => {
      for (const task of tasks) { task.contextExcluded = true; task.cancelRequested = true; if (['queued', 'running', 'stopping', 'waiting'].includes(task.status)) task.status = task.resourceHeld ? 'stopping' : 'cancelled'; this.store.putTask(task); }
      for (const plan of this.store.listPlans<Plan>().filter(p => p.conversationId === conversationId)) { plan.contextExcluded = true; if (!['completed', 'cancelled'].includes(plan.status)) plan.status = 'paused'; this.store.putPlan(plan); }
      for (const delivery of this.store.listDeliveries(conversationId)) { delete delivery.learning; if (['pending', 'rejected'].includes(delivery.status)) delivery.status = 'rejected'; this.store.putDelivery(delivery); }
      for (const input of this.store.pendingInputs().filter(i => i.conversationId === conversationId && !i.text.trim().startsWith('/forget '))) {
        // Preserve the accepted record for diagnostics, while preventing an old
        // unresolved goal from reentering a fresh Session after forget.
        const key = JSON.stringify([input.conversationId, input.actorId, input.inputId]);
        this.store.putInput(key, { text: '该输入上下文已排除；请重新说明可使用的要求。' });
      }
    });
    for (const task of tasks) {
      this.active.get(task.id)?.abort.abort(new Error('Conversation memory forgotten'));
      if (task.resourceHeld && !this.active.has(task.id)) {
        const identity = this.store.listAttempts(task.id).at(-1)?.identity;
        const stopped = identity && this.options.executor.cancel ? await this.options.executor.cancel(identity).catch(() => false) : false;
        const current = this.getTask(task.id)!; current.status = stopped ? 'cancelled' : 'waiting'; current.resourceHeld = !stopped; this.store.putTask(current);
      }
    }
    this.publishNotification({ conversationId, actorId: tasks[0]?.actorId ?? conversationId }, '已排除该对话的相关任务和计划上下文；已有责任保留，活动执行正在停止核实。请重新说明后续可使用的要求。');
  }
  private attach(task: Task, attempt: Attempt) {
    const abort = new AbortController();
    const promise = (async () => {
      let evidence: Awaited<ReturnType<NonNullable<TaskExecutor['inspect']>>> = { state: 'running' };
      while (!abort.signal.aborted && this.now() - attempt.startedAt < (this.options.maxDurationMs ?? 30 * 60_000)) {
        await new Promise<void>(resolve => {
          const finish = () => { clearTimeout(timer); abort.signal.removeEventListener('abort', finish); resolve(); };
          const timer = setTimeout(finish, this.options.recoveryPollMs ?? 1000); abort.signal.addEventListener('abort', finish, { once: true });
        });
        if (abort.signal.aborted) break;
        evidence = await this.options.executor.inspect!(attempt.identity!).catch(() => ({ state: 'unknown' as const }));
        if (evidence.state !== 'running') break;
      }
      const current = this.getTask(task.id)!;
      const preservingShutdown = this.closing && this.preserveOnClose && abort.signal.reason instanceof Error && abort.signal.reason.message === 'Host shutdown';
      if (preservingShutdown) {
        current.status = 'running'; current.resourceHeld = true; attempt.status = 'running';
        this.store.transaction(() => { this.store.putTask(current); this.store.putAttempt(attempt); }); return;
      }
      if (abort.signal.aborted || evidence.state === 'running') {
        const stopped = this.options.executor.cancel ? await this.options.executor.cancel(attempt.identity!).catch(() => false) : false;
        current.resourceHeld = !stopped;
        current.status = stopped && current.status === 'stopping' ? 'cancelled' : 'waiting';
        current.error = stopped ? '执行者已停止；已有影响未撤销。' : '执行者状态未确认；不会重复启动。';
      } else if (evidence.state === 'completed' && evidence.result) {
        evidence.result.producedRevision ??= attempt.presentedRevision;
        current.result = evidence.result; if (current.cancelRequested || current.contextExcluded || evidence.result.producedRevision !== current.revision) evidence.result.verified = false;
        current.status = current.cancelRequested ? 'cancelled' : evidence.result.verified && !evidence.result.partial ? 'completed' : 'partial';
        current.resourceHeld = false;
      } else { current.status = evidence.state === 'stopped' && current.status === 'stopping' ? 'cancelled' : 'waiting'; current.resourceHeld = evidence.state === 'unknown'; current.error = '恢复执行状态需人工核实。'; }
      current.updatedAt = this.now(); attempt.status = current.status; attempt.finishedAt = this.now();
      if (current.contextExcluded) { this.store.transaction(() => { this.store.putTask(current); this.store.putAttempt(attempt); }); return; }
      if (this.closing && this.preserveOnClose && abort.signal.reason instanceof Error && abort.signal.reason.message === 'Host shutdown') {
        current.status = 'running'; attempt.status = 'running';
        this.store.transaction(() => { this.store.putTask(current); this.store.putAttempt(attempt); }); return;
      }
      let delivery!: Delivery;
      if (current.workKind === 'delegation') { current.result ??= { text: current.error ?? '帮手状态需核实', verified: false, partial: true, producedRevision: attempt.presentedRevision }; this.store.settleDelegationResult(current, attempt); this.scheduleContinuations(); return; }
      this.store.transaction(() => { this.store.putTask(current); this.store.putAttempt(attempt); delivery = this.makeDelivery(current, `${current.goal}\n状态：${current.status}\n${current.result?.text ?? current.error}`, current.id, current.result?.artifacts); });
      this.notify(delivery);
    })().finally(() => { this.active.delete(task.id); this.pump(); });
    this.active.set(task.id, { abort, promise });
  }
  async waitForIdle() { this.pump(); this.scheduleContinuations(); while (this.active.size || this.continuations.size || this.conversations.size) { await Promise.allSettled([...this.active.values()].map(x => x.promise).concat([...this.continuations.values()].map(x => x.promise), [...this.conversations.values()].map(p => p.then(() => {})))); this.scheduleContinuations(); } }
  async close(options: { preserveTasks?: boolean } = {}) { this.preserveOnClose = options.preserveTasks ?? true; this.closing = true; for (const entry of this.active.values()) entry.abort.abort(new Error('Host shutdown')); for (const entry of this.continuations.values()) entry.abort.abort(new Error('Host shutdown')); await this.options.interruptDialogue?.(); await Promise.allSettled([...this.conversations.values()]); await this.waitForIdle(); this.store.close(); }
}
