import { randomUUID, createHash } from 'node:crypto';
import { resolve, sep, dirname, basename, join } from 'node:path';
import { realpathSync, statSync } from 'node:fs';
import { PersonalStore } from './store.js';
import type { ActionSpec, ActionRecord, Attempt, Decision, Delivery, Dialogue, PersonalInput, PersonalResponse, Plan, Task, TaskExecutor } from './types.js';

export interface PersonalHostOptions { store: PersonalStore; dialogue: Dialogue; executor: TaskExecutor; maxConcurrent?: number; maxDurationMs?: number; maxTokens?: number; maxAttempts?: number; maxDialogueAttempts?: number; recoveryPollMs?: number; now?: () => number; interruptDialogue?(): Promise<void>; handleDecision?(input: PersonalInput, decision: Decision): Promise<PersonalResponse> }
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
  private readonly active = new Map<string, { abort: AbortController; promise: Promise<void> }>();
  private readonly conversations = new Map<string, Promise<unknown>>();
  private readonly appliedRevisions = new Map<string, number>();
  private closing = false;
  private preserveOnClose = true;
  private readonly now: () => number;
  constructor(private readonly options: PersonalHostOptions) { this.store = options.store; this.now = options.now ?? Date.now; }
  getTask(id: string) { return this.store.getTask(id); }
  listTasks(conversationId?: string) { return this.store.listTasks(conversationId); }
  subscribe(listener: (delivery: Delivery) => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
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
    input = this.store.acceptInput(inputKey, input);
    const prior = this.conversations.get(input.conversationId) ?? Promise.resolve();
    const current = prior.catch(() => {}).then(async () => {
      const key = JSON.stringify([input.conversationId, input.actorId, input.inputId]);
      const previous = this.store.getInput(key); if (previous) return previous;
      if (this.store.inputAttempts(key) >= (this.options.maxDialogueAttempts ?? 3)) throw new Error('输入处理尝试次数已达上限；输入已保存，请检查故障后发送新消息。');
      this.store.beginInput(key);
      const decision = await this.options.dialogue.decide(input, { tasks: this.listTasks(input.conversationId).filter(task => task.actorId === input.actorId && !task.contextExcluded), sessionId: this.store.conversationSession(input.conversationId), plans: this.store.listPlans<Plan>().filter(p => p.conversationId === input.conversationId && p.actorId === input.actorId && !p.contextExcluded), actions: this.store.listActions().filter(a => { const task = this.getTask(a.taskId); return task?.conversationId === input.conversationId && task.actorId === input.actorId && !task.contextExcluded; }) }).catch(error => { this.store.inputFailure(key, String(error)); throw error; });
      if (this.closing) throw new Error('Host shutdown; accepted input retained');
      if (decision.kind === 'start') return this.enqueueTask(input, decision);
      const response = await this.apply(input, decision);
      this.store.transaction(() => {
        const existing = response.deliveryId ? this.delivery(response.deliveryId) : undefined;
        if (existing && (existing.conversationId !== input.conversationId || existing.actorId !== input.actorId)) throw new Error('Delivery ownership mismatch');
        const delivery = existing ?? this.makeDelivery(input, response.text, response.taskId);
        if (decision.kind === 'reply') { delivery.learning = { id: delivery.id, input: input.text, answer: response.text }; this.store.putDelivery(delivery); }
        response.deliveryId = delivery.id; this.store.putInput(key, response);
      });
      this.notify(this.delivery(response.deliveryId!)!); this.pump(); return response;
    });
    this.conversations.set(input.conversationId, current);
    void current.finally(() => { if (this.conversations.get(input.conversationId) === current) this.conversations.delete(input.conversationId); }).catch(() => {});
    return current;
  }
  async startTask(input: PersonalInput, decision: Extract<Decision, { kind: 'start' }>): Promise<PersonalResponse> {
    return this.enqueueTask(input, decision);
  }
  enqueueTask(input: PersonalInput, decision: Extract<Decision, { kind: 'start' }>): PersonalResponse {
    const key = JSON.stringify([input.conversationId, input.actorId, input.inputId]);
    const response = this.store.transaction(() => {
      const previous = this.store.getInput(key); if (previous) return previous;
      const task = this.createTask(input, decision); const response = { text: `已接收任务：${task.goal}`, taskId: task.id, deliveryId: '' };
      response.deliveryId = this.makeDelivery(input, response.text, task.id).id; this.store.putInput(key, response); return response;
    });
    queueMicrotask(() => { const delivery = this.delivery(response.deliveryId!); if (!this.closing && delivery) { this.notify(delivery); this.pump(); } }); return response;
  }
  private createTask(input: PersonalInput, decision: Extract<Decision, { kind: 'start' }>): Task {
    const id = randomUUID(); const cwd = physicalResource(decision.cwd ?? join(this.store.directory, 'workspaces', id));
    const paths = [ ...(decision.resources ?? []), cwd ].map(physicalResource);
    const explicitProjectPaths = [ ...(decision.resources ?? []), ...(decision.cwd ? [cwd] : []) ].map(physicalResource);
    // Generated per-task workspaces have their own scope. They do not inherit
    // the repository that happens to contain the Host's data directory.
    const projects = explicitProjectPaths.flatMap(path => { const checkout = checkoutResource(path); return checkout ? [checkout] : []; });
    const task: Task = { id, conversationId: input.conversationId, actorId: input.actorId, goal: decision.goal,
      resources: [...new Set([...paths, ...projects])],
      executor: decision.executor ?? 'local', cwd, sessionId: randomUUID(), status: 'queued', createdAt: this.now(), updatedAt: this.now(), requirements: [], revision: 0, resourceHeld: false, deadline: decision.deadline };
    this.store.putTask(task); return task;
  }
  private async apply(input: PersonalInput, decision: Decision): Promise<PersonalResponse> {
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
    task.requirements.push(requirement); task.revision++; task.updatedAt = this.now(); this.store.putTask(task);
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
    let delivery!: Delivery;
    this.store.transaction(() => { this.store.putAction(record); delivery = this.makeDelivery(task, `需要确认外部动作 ${record.id}：${action.kind}\n对象：${action.target}\n参数：${JSON.stringify(action.parameters)}\n${action.content}`, task.id); });
    this.notify(delivery); return false;
  }
  authorizeAction(input: PersonalInput, actionId: string, approved: boolean): PersonalResponse {
    const record = this.store.getAction(actionId); const task = record ? this.getTask(record.taskId) : undefined;
    if (!record || !task || task.contextExcluded || task.actorId !== input.actorId || task.conversationId !== input.conversationId || record.revision !== task.revision || record.status !== 'pending') return { text: '确认已失效或不属于此对话，请核对具体动作。' };
    record.status = approved ? 'approved' : 'denied'; this.store.putAction(record);
    if (approved && task.status === 'waiting' && !task.cancelRequested && !task.resourceHeld && !this.active.has(task.id) && this.store.listAttempts(task.id).length < (this.options.maxAttempts ?? 3)) { task.status = 'queued'; this.store.putTask(task); }
    return { text: approved ? '已确认此项具体动作；目标或参数变化需要重新确认。' : '已拒绝此项动作。', taskId: task.id };
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
    for (const task of this.listTasks()) {
      const occupied = this.listTasks().filter(t => this.active.has(t.id) || ['running', 'stopping'].includes(t.status)).length;
      if (occupied >= (this.options.maxConcurrent ?? 2)) break;
      if (task.status !== 'queued' || this.conflicts(task)) continue;
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
      if (error instanceof Error && error.name === 'ExecutorBudgetError') { task.status = 'waiting'; task.error = '执行预算耗尽，保留已有成果。'; }
      if (abort.signal.reason instanceof Error && /预算/.test(abort.signal.reason.message)) task.error = abort.signal.reason.message;
      if (error instanceof Error && error.name === 'ExecutorAttentionError' && this.store.listActions(task.id).some(a => a.status === 'approved' && a.revision === task.revision)) task.status = 'queued';
      if (attempt.identity && this.options.executor.inspect && task.status === 'failed' && !abort.signal.aborted) {
        const evidence = await this.options.executor.inspect(attempt.identity).catch(() => ({ state: 'unknown' as const }));
        if (evidence.state === 'resumable') { task.resourceHeld = false; task.status = this.store.listAttempts(task.id).length < (this.options.maxAttempts ?? 3) ? 'queued' : 'waiting'; }
        else if (evidence.state === 'stopped') task.resourceHeld = false;
      }
      if (error instanceof Error && error.name === 'ExecutorAttentionError' && attempt.identity?.kind === 'pi') task.resourceHeld = false;
      if (!attempt.identity) task.resourceHeld = false;
      if (task.status === 'waiting' && attempt.identity?.kind === 'pi' && this.options.executor.inspect && !task.cancelRequested) {
        const evidence = await this.options.executor.inspect(attempt.identity).catch(() => ({ state: 'unknown' as const }));
        if (['resumable', 'stopped', 'completed'].includes(evidence.state)) task.resourceHeld = false;
      }
      if (attempt.identity && this.options.executor.cancel && task.status === 'failed') requestCancel();
    } finally {
      clearTimeout(timer);
      abort.signal.removeEventListener('abort', requestCancel);
      if (!preservingShutdown() && (abort.signal.aborted || cancellation) && attempt.identity && this.options.executor.cancel) {
        requestCancel(); const stopped = await cancellation;
        task.resourceHeld = !stopped;
        if (!stopped) { task.status = 'waiting'; task.error = '执行者停止状态未知，需要核实；不会自动重试。'; }
      }
      task.updatedAt = this.now(); attempt.status = task.status; attempt.finishedAt = this.now();
      if (this.getTask(task.id)?.contextExcluded) { task.contextExcluded = true; task.cancelRequested = true; this.store.transaction(() => { this.store.putTask(task); this.store.putAttempt(attempt); }); return; }
      if (preservingShutdown()) {
        task.status = attempt.identity?.kind === 'herdr' ? 'running' : 'waiting'; attempt.status = task.status;
        task.error = 'Host 已关闭；重新启动后先核对执行状态与已有成果。';
        this.store.transaction(() => { this.store.putTask(task); this.store.putAttempt(attempt); }); return;
      }
      let delivery!: Delivery;
      this.store.transaction(() => { this.store.putTask(task); this.store.putAttempt(attempt); delivery = this.makeDelivery(task, `${task.goal}\n状态：${task.status}\n${task.result?.text ?? task.error ?? '任务停止；已有影响未撤销。'}`, task.id, task.result?.artifacts); if (task.result && ['completed', 'partial'].includes(task.status)) { delivery.learning = { id: delivery.id, input: task.goal, answer: task.result.text }; this.store.putDelivery(delivery); } });
      this.notify(delivery);
    }
  }
  /** Reconcile actual executor state before considering any new execution. */
  async recover() {
    for (const delivery of this.store.listDeliveries()) if (delivery.status === 'sending') { delivery.status = 'unknown'; this.store.putDelivery(delivery); }
    for (const task of this.listTasks()) {
      if (!['running', 'stopping', 'waiting'].includes(task.status) || this.active.has(task.id)) continue;
      const attempt = this.store.listAttempts(task.id).at(-1);
      if (task.contextExcluded) { task.status = task.resourceHeld ? 'waiting' : 'cancelled'; this.store.putTask(task); continue; }
      const evidence = attempt?.identity && this.options.executor.inspect ? await this.options.executor.inspect(attempt.identity).catch(() => ({ state: 'unknown' as const })) : { state: 'unknown' as const };
      if (task.cancelRequested || task.status === 'stopping') {
        const stopped = evidence.state === 'stopped' || evidence.state === 'resumable' || attempt?.identity && this.options.executor.cancel && await this.options.executor.cancel(attempt.identity).catch(() => false);
        task.status = stopped ? 'cancelled' : 'waiting'; task.resourceHeld = !stopped; task.cancelRequested = true;
        task.error = stopped ? undefined : '执行者停止状态未知，需要核实；不会自动继续。';
      } else if (evidence.state === 'completed' && evidence.result) {
        evidence.result.producedRevision ??= attempt?.presentedRevision;
        task.result = evidence.result; task.status = evidence.result.verified && !evidence.result.partial ? 'completed' : 'partial';
        task.resourceHeld = false;
        let delivery!: Delivery;
        this.store.transaction(() => { this.store.putTask(task); if (attempt) { attempt.status = task.status; this.store.putAttempt(attempt); } delivery = this.makeDelivery(task, `${task.goal}\n状态：${task.status}\n${evidence.result!.text}`, task.id, evidence.result!.artifacts); }); this.notify(delivery);
      } else if (evidence.state === 'resumable') {
        task.resourceHeld = false;
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
    this.pump();
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
        current.result = evidence.result; current.status = evidence.result.verified && !evidence.result.partial ? 'completed' : 'partial';
        current.resourceHeld = false;
      } else { current.status = evidence.state === 'stopped' && current.status === 'stopping' ? 'cancelled' : 'waiting'; current.resourceHeld = evidence.state === 'unknown'; current.error = '恢复执行状态需人工核实。'; }
      current.updatedAt = this.now(); attempt.status = current.status; attempt.finishedAt = this.now();
      if (current.contextExcluded) { this.store.transaction(() => { this.store.putTask(current); this.store.putAttempt(attempt); }); return; }
      if (this.closing && this.preserveOnClose && abort.signal.reason instanceof Error && abort.signal.reason.message === 'Host shutdown') {
        current.status = 'running'; attempt.status = 'running';
        this.store.transaction(() => { this.store.putTask(current); this.store.putAttempt(attempt); }); return;
      }
      let delivery!: Delivery;
      this.store.transaction(() => { this.store.putTask(current); this.store.putAttempt(attempt); delivery = this.makeDelivery(current, `${current.goal}\n状态：${current.status}\n${current.result?.text ?? current.error}`, current.id, current.result?.artifacts); });
      this.notify(delivery);
    })().finally(() => { this.active.delete(task.id); this.pump(); });
    this.active.set(task.id, { abort, promise });
  }
  async waitForIdle() { while (this.active.size) await Promise.all([...this.active.values()].map(x => x.promise)); }
  async close(options: { preserveTasks?: boolean } = {}) { this.preserveOnClose = options.preserveTasks ?? true; this.closing = true; for (const entry of this.active.values()) entry.abort.abort(new Error('Host shutdown')); await this.options.interruptDialogue?.(); await Promise.allSettled([...this.conversations.values()]); await this.waitForIdle(); this.store.close(); }
}
