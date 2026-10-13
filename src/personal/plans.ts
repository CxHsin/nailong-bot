import { createHash } from 'node:crypto';
import type { PersonalHost } from './host.js';
import type { Decision, PersonalInput, PersonalResponse, Plan } from './types.js';

/** Explicit plans only. Trigger consumption and Task creation share a transaction. */
export class PersonalPlans {
  constructor(private readonly host: PersonalHost, private readonly now: () => number = Date.now) {}
  list(conversationId: string) { return this.host.store.listPlans<Plan>().filter(plan => plan.conversationId === conversationId && !plan.contextExcluded); }
  async handle(input: PersonalInput, decision: Decision): Promise<PersonalResponse> {
    if (decision.kind === 'schedule') {
      const spec = decision.plan;
      if (spec.executor === 'herdr') return { text: '固定 herdr 计划入口已退役；编码委托使用项目 skill，旧计划需人工核实。' };
      try { if (typeof spec.timezone !== 'string' || !spec.timezone.trim()) throw new Error(); new Intl.DateTimeFormat('en', { timeZone: spec.timezone }).format(); }
      catch { return { text: '请明确有效时区后再创建计划。' }; }
      if (!spec.goal?.trim() || (!Number.isFinite(spec.dueAt) && !spec.afterTaskId) ||
        spec.intervalMs !== undefined && (!Number.isSafeInteger(spec.intervalMs) || spec.intervalMs < 60_000) ||
        spec.deadline !== undefined && !Number.isFinite(spec.deadline) ||
        !['skip', 'run', 'ask'].includes(spec.missed)) return { text: '计划需要明确目标、触发时间或前置任务，以及错过触发时的处理方式。' };
      if (spec.afterTaskId) {
        const prior = this.host.getTask(spec.afterTaskId);
        if (!prior || prior.contextExcluded || prior.conversationId !== input.conversationId || prior.actorId !== input.actorId)
          return { text: '请明确属于当前对话的前置任务。' };
        spec.afterTaskId = prior.rootTaskId ?? prior.id;
        if (spec.intervalMs) return { text: '任务完成后的触发不能同时设置周期。' };
      }
      if (spec.deadline !== undefined && spec.dueAt !== undefined && spec.deadline < spec.dueAt)
        return { text: '计划期限早于触发时间，请澄清。' };
      const id = `plan:${createHash('sha256').update(JSON.stringify([input.conversationId, input.actorId, input.inputId])).digest('hex')}`;
      const existing = this.host.store.getPlan<Plan>(id);
      if (existing) return { text: `已保存计划 ${existing.id}：${existing.goal}` };
      const plan: Plan = { goal: spec.goal, cwd: spec.cwd, resources: spec.resources, executor: spec.executor,
        dueAt: spec.dueAt, timezone: spec.timezone, intervalMs: spec.intervalMs, afterTaskId: spec.afterTaskId,
        deadline: spec.deadline, missed: spec.missed,
        id, conversationId: input.conversationId, actorId: input.actorId,
        status: 'active', version: 1, createdAt: this.now() };
      this.host.store.putPlan(plan);
      return { text: `已保存计划 ${plan.id}：${plan.goal}\n时区：${plan.timezone}\n${plan.dueAt !== undefined ? new Date(plan.dueAt).toISOString() : '前置任务完成后触发'}` };
    }
    if (decision.kind === 'plan') {
      if (!decision.planId && decision.action === 'query') return { text: this.list(input.conversationId).filter(p => p.actorId === input.actorId)
        .map(p => `${p.id}：${p.goal}（${p.status}）`).join('\n') || '当前没有计划。' };
      const plan = this.host.store.getPlan<Plan>(decision.planId ?? '');
      if (!plan || plan.conversationId !== input.conversationId || plan.actorId !== input.actorId) return { text: '请明确要操作的计划。' };
      if (plan.contextExcluded && decision.action !== 'cancel') return { text: '计划上下文已因遗忘排除，请以新输入说明可使用的目标。' };
      if (decision.action === 'query') return { text: `${plan.id}：${plan.goal}\n状态：${plan.status}\n时区：${plan.timezone}` };
      if (plan.executor === 'herdr' && ['resume', 'change'].includes(decision.action)) return { text: '固定 herdr 计划入口已退役；保留原记录，需人工核实。' };
      const operationInput = JSON.stringify([input.conversationId, input.actorId, input.inputId]);
      if (plan.operationInputs?.includes(operationInput)) return { text: `计划操作已保存：${plan.status}；不会重复修改。` };
      if (plan.status === 'cancelled' || plan.status === 'completed') return { text: '计划已结束，请创建新计划。' };
      if (decision.action === 'change' || decision.action === 'resume') {
        if (decision.dueAt !== undefined && !Number.isFinite(decision.dueAt) || decision.deadline !== undefined && !Number.isFinite(decision.deadline)) return { text: '请明确新的触发时间与期限。' };
        if (decision.goal !== undefined && !decision.goal.trim()) return { text: '计划目标不能为空。' };
        if (decision.intervalMs !== undefined && decision.intervalMs !== null && (!Number.isSafeInteger(decision.intervalMs) || decision.intervalMs < 60_000)) return { text: '周期至少为一分钟，请明确新的周期。' };
        if (decision.timezone !== undefined && !validTimezone(decision.timezone)) return { text: '请明确有效时区。' };
        if (decision.missed !== undefined && !['skip', 'run', 'ask'].includes(decision.missed)) return { text: '请明确错过触发时的处理方式。' };
        const due = decision.dueAt ?? plan.dueAt; const deadline = decision.deadline ?? plan.deadline;
        if (deadline !== undefined && due !== undefined && deadline < due) return { text: '计划期限早于触发时间，请澄清。' };
        if (plan.afterTaskId && decision.dueAt === undefined && decision.intervalMs) return { text: '任务依赖触发不能同时设置周期。' };
        if (decision.dueAt !== undefined) { plan.dueAt = decision.dueAt; plan.afterTaskId = undefined; }
        if (decision.deadline !== undefined) plan.deadline = decision.deadline;
        if (decision.goal !== undefined) plan.goal = decision.goal;
        if (decision.intervalMs !== undefined) plan.intervalMs = decision.intervalMs ?? undefined;
        if (decision.timezone !== undefined) plan.timezone = decision.timezone;
        if (decision.missed !== undefined) plan.missed = decision.missed;
        if (decision.action === 'resume') {
          const due = plan.dueAt ?? (plan.afterTaskId ? this.host.getTask(plan.afterTaskId)?.updatedAt : undefined);
          if (plan.deadline !== undefined && this.now() > plan.deadline || due !== undefined && this.now() - due > 60_000 && plan.missed !== 'run') return { text: '计划已错过触发或期限，请明确新的时间与期限，或明确允许期限内补做。' };
          plan.status = 'active';
        }
      } else plan.status = decision.action === 'pause' ? 'paused' : decision.action === 'cancel' ? 'cancelled' : 'active';
      (plan.operationInputs ??= []).push(operationInput);
      plan.version++; this.host.store.putPlan(plan);
      return { text: `计划已更新：${plan.status}` };
    }
    if (decision.kind === 'redeliver') {
      const task = this.host.getTask(input.replyTaskId ?? decision.taskId ?? '');
      if (!task || task.contextExcluded || task.conversationId !== input.conversationId || task.actorId !== input.actorId || !task.result) return { text: '请明确已有成果的任务。' };
      const prior = this.host.store.listDeliveries(input.conversationId).filter(d => d.taskId === task.id && !d.parentId);
      if (prior.some(d => d.status === 'unknown' || d.status === 'sending') && !decision.confirmUnknown)
        return { text: '之前交付是否送达仍不确定。请明确确认可以重复发送，任务不会重做。', taskId: task.id };
      const deliveryId = `redeliver:${createHash('sha256').update(JSON.stringify([input.conversationId, input.actorId, input.inputId])).digest('hex')}`;
      const existing = this.host.delivery(deliveryId);
      if (existing) return { text: existing.text, taskId: task.id, deliveryId: existing.id };
      const delivery = { id: deliveryId, conversationId: task.conversationId, actorId: task.actorId, taskId: task.id,
        text: task.result.text, artifacts: task.result.artifacts, artifactDigests: task.result.artifactDigests, status: 'pending' as const, createdAt: this.now() };
      this.host.store.putDelivery(delivery);
      return { text: task.result.text, taskId: task.id, deliveryId: delivery.id };
    }
    return { text: '该操作尚未接入。' };
  }
  async tick() {
    const now = this.now();
    for (const candidate of this.host.store.listPlans<Plan>()) {
      const result = this.host.store.transaction(() => {
        const plan = this.host.store.getPlan<Plan>(candidate.id)!;
        if (plan.status !== 'active' || plan.contextExcluded) return;
        if (plan.executor === 'herdr') { plan.status = 'waiting'; this.host.store.putPlan(plan); return; }
        const identified = plan.afterTaskId ? this.host.getTask(plan.afterTaskId) : undefined;
        const dependency = identified ? this.host.getTask(identified.rootTaskId ?? identified.id) : undefined;
        if (plan.afterTaskId && (dependency?.status !== 'completed' || dependency.contextExcluded)) return;
        if (plan.dueAt !== undefined && plan.dueAt > now || !plan.afterTaskId && plan.dueAt === undefined) return;
        const due = plan.dueAt ?? dependency!.updatedAt;
        if (plan.deadline !== undefined && now > plan.deadline || now - due > 60_000 && plan.missed !== 'run') {
          if (plan.missed === 'skip') {
            if (plan.intervalMs && !(plan.deadline !== undefined && now > plan.deadline)) plan.dueAt = due + (Math.floor((now - due) / plan.intervalMs) + 1) * plan.intervalMs;
            else plan.status = 'completed';
          } else {
            plan.status = 'waiting';
            this.host.store.putDelivery({ id: `plan-wait:${plan.id}:${plan.version}:${due}`, conversationId: plan.conversationId,
              actorId: plan.actorId, text: `计划 ${plan.id} 已错过触发或期限：${plan.goal}。请调整时间、恢复或取消。`,
              status: 'pending', createdAt: now });
          }
          this.host.store.putPlan(plan); return;
        }
        const trigger = `${plan.id}:${plan.version}:${due}`;
        if (plan.lastTrigger === trigger) return;
        // Synchronous enqueue participates in this same transaction; exceptions roll back consumption.
        const response = this.host.enqueueTask({ conversationId: plan.conversationId, actorId: plan.actorId,
          text: plan.goal, inputId: `plan:${trigger}`, origin: 'plan' },
        { kind: 'start', goal: plan.goal, cwd: plan.cwd, resources: plan.resources, executor: plan.executor, deadline: plan.deadline });
        plan.lastTrigger = trigger;
        if (plan.intervalMs) plan.dueAt = due + (Math.floor((now - due) / plan.intervalMs) + 1) * plan.intervalMs;
        else plan.status = 'completed';
        this.host.store.putPlan(plan); return response;
      });
      if (result) await Promise.resolve();
    }
  }
}
function validTimezone(timezone: string) {
  try { if (!timezone.trim()) return false; new Intl.DateTimeFormat('en', { timeZone: timezone }).format(); return true; } catch { return false; }
}
