import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { capabilityEnvironment } from '../agent/capability-config.js';
import { createAgentModels } from '../agent/agent-models.js';
import { modelEnvironment } from '../agent/model-config.js';
import { PersonalStore } from './store.js';
import { PersonalHost } from './host.js';
import { createPersonalPi } from './pi.js';
import { createPersonalMemory } from './memory.js';
import { PersonalPlans } from './plans.js';
import { VerificationChecks, type VerificationOptions } from './verification.js';
import { requirePermission, permissionError, permissionSnapshot, assertPermissionSnapshot, matchesExecutionBackend, type ExecutionBackend } from './permissions.js';
import { loadExecutionBackends } from './execution-backends.js';
import { freezeArtifacts } from './artifacts.js';
import { inspectMaterial } from './acceptance.js';
import { migratePersonalHistory, readHistoricalSource } from './migration.js';
import type { Delivery, Dialogue, TaskExecutor, Task, Usage } from './types.js';

function positive(env: NodeJS.ProcessEnv, name: string, fallback: number) {
  const value = env[name] ? Number(env[name]) : fallback;
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} 必须为正整数`);
  return value;
}
function retries(env: NodeJS.ProcessEnv) { const value = env.AGENT_MODEL_MAX_RETRIES === undefined ? 2 : Number(env.AGENT_MODEL_MAX_RETRIES); if (!Number.isSafeInteger(value) || value < 0) throw new Error('AGENT_MODEL_MAX_RETRIES 必须为有限非负整数'); return value; }

/** One production assembly shared by Telegram and CLI. No legacy replay executor. */
export interface PersonalRuntimeDependencies {
  executionBackends?: ExecutionBackend[];
  verificationBackend?: Pick<ExecutionBackend, 'verified' | 'identity' | 'capabilities' | 'supports'> & { runCommand: NonNullable<VerificationOptions['runCommand']> };
}
export async function createPersonalRuntime(env: NodeJS.ProcessEnv = process.env, dependencies: PersonalRuntimeDependencies = {}) {
  const dataDir = resolve(env.AGENT_DATA_DIR?.trim() || 'data');
  const promptFile = resolve(env.AGENT_PROMPT_FILE?.trim() || 'system-prompt.md');
  const capabilities = await capabilityEnvironment(env);
  const modelConfiguration = modelEnvironment(env);
  const models = createAgentModels({ modelConfiguration });
  const backendRegistry = await loadExecutionBackends(env);
  const executionBackends = dependencies.executionBackends ?? backendRegistry.backends;
  const store = new PersonalStore(dataDir);
  let pi: Awaited<ReturnType<typeof createPersonalPi>> | undefined;
  let memory: ReturnType<typeof createPersonalMemory> | undefined;
  let host!: PersonalHost;
  try {
    await migratePersonalHistory(store, models.defaultProfile.model);
    const historical = await readHistoricalSource(dataDir);
    memory = createPersonalMemory({ dataDir, historical: { read: async () => historical.events },
      embedding: env.EMBEDDING_BASE_URL && env.EMBEDDING_MODEL && env.EMBEDDING_API_KEY ? {
        baseUrl: env.EMBEDDING_BASE_URL, model: env.EMBEDDING_MODEL, apiKey: env.EMBEDDING_API_KEY,
        timeoutMs: positive(env, 'EMBEDDING_TIMEOUT_MS', 3000),
        beforeRequest: () => { host.reserveModelCall(); host.accountModelUsage(undefined, { costKnown: false }); },
      } : undefined,
      dynamics: env.MEMORY_DYNAMICS ? JSON.parse(env.MEMORY_DYNAMICS) : undefined,
      recall: env.MEMORY_RECALL ? JSON.parse(env.MEMORY_RECALL) : undefined,
      invalidateSessions: async conversationId => {
        if (host) await host.excludeConversationContext(conversationId);
        await pi?.reset(store.conversationSession(conversationId), 'forget');
        for (const task of store.listTasks(conversationId)) await pi?.reset(task.sessionId, 'forget');
      },
    });
    pi = await createPersonalPi({ ...capabilities, dataDir, promptFile, modelConfiguration, memory, executionBackends,
      taskForIdentity: identity => store.getTask(String(identity.taskId)),
      workContext: (task, originId) => host.workContext({ conversationId: task.conversationId, actorId: task.actorId, inputId: originId, text: task.goal }, task.id),
      reserveModelCall: sessionId => host.reserveSessionModelCall(sessionId),
      beforeRecall: sessionId => host.assertRecallBudget(sessionId),
      agreementsForInput: input => host.applicableAgreements(input),
      accountModelUsage: (sessionId, usage) => host.accountSessionModelUsage(sessionId, usage),
      tinyfishKey: env.TINYFISH_API_KEY?.trim(), shellPath: env.AGENT_SHELL_PATH?.trim(),
      limits: { timeoutMs: positive(env, 'AGENT_MODEL_TIMEOUT_MS', 120_000),
        maxTurns: positive(env, 'AGENT_MAX_TURNS', 40), maxTokens: positive(env, 'AGENT_MAX_TOKENS', 500_000), maxRetries: retries(env) } });
    const agent = pi;
    const materialActions = (task: Task) => store.listActionDispatches().filter(action => action.taskId === task.id || store.getTask(action.taskId)?.rootTaskId === (task.rootTaskId ?? task.id));
    let plans!: PersonalPlans;
    const checks = new VerificationChecks(env.AGENT_VERIFICATION_CHECKS ? JSON.parse(env.AGENT_VERIFICATION_CHECKS) : [],
      { timeoutMs: positive(env, 'AGENT_CHECK_TIMEOUT_MS', 120_000),
        async runCommand(task, command, context) {
          const current = host.getTask(task.id) ?? task; const grant = requirePermission(current);
          const matches = (current: Task) => matchesExecutionBackend(current, dependencies.verificationBackend);
          if (grant.mode !== 'trusted' && !await matches(current)) throw permissionError('独立检查没有匹配当前工作权限和身份的已验证命令后端；未派发');
          const work = host.workContext({ conversationId: task.conversationId, actorId: task.actorId, inputId: `verification:${task.revision}`, text: task.goal }, task.id);
          const callId = `check:${JSON.stringify(command)}`;
          return work.dispatch(callId, { kind: 'verification-command', target: task.cwd!, parameters: { command: command.command, args: command.args }, content: '已配置的独立检查，在明确授予的可信本机权限内运行' }, async () => {
            const latest = work.current(); const latestGrant = requirePermission(latest);
            if (latestGrant.mode === 'restricted') { const snapshot = permissionSnapshot(latest); if (!await matches(latest)) throw permissionError('独立检查权限范围或后端身份改变；未派发'); const actual = work.current(); assertPermissionSnapshot(actual, snapshot); return dependencies.verificationBackend!.runCommand(actual, command, context); }
            const trusted = new VerificationChecks([command], { preauthorized: true, timeoutMs: positive(env, 'AGENT_CHECK_TIMEOUT_MS', 120_000) });
            return (await trusted.run(latest, context))[0]!;
          });
        } });
    async function verifyCurrent(task: Task, evidence: Parameters<typeof agent.verify>[1], signal?: AbortSignal, onUsage?: (usage: Usage) => void) {
      const current = host.getTask(task.id) ?? task;
      if (current.contextExcluded) return { text: '相关来源已排除，旧任务不会继续验收或执行。', verified: false, partial: true };
      const checkEvidence = await checks.run(current, { signal });
      const result = await agent.verify(current, evidence, signal, checkEvidence, onUsage);
      result.checks = checkEvidence.map(check => ({ command: JSON.stringify([check.command, ...check.args]), status: check.status, revision: check.revision }));
      if (current.purpose === 'coding' && (!result.checks.length || result.checks.some(check => check.status !== 'passed'))) { result.verified = false; result.partial = true; result.text += '\n编码成果缺少通过的实际测试检查凭据。'; }
      if ((host.getTask(task.id)?.revision ?? current.revision) !== current.revision)
        return { text: '验收期间要求发生变化，需按最新要求重新验收。', verified: false, partial: true };
      return current.workKind === 'delegation' ? inspectMaterial(current, result, dataDir, materialActions(current)) : freezeArtifacts(dataDir, current, result);
    }
    const local: TaskExecutor = { ...agent.executor,
      async execute(request) {
        let execution: Usage = {};
        const result = await agent.executor.execute({ ...request, onUsage: usage => { execution = usage; request.onUsage(usage); } });
        if (request.task.workKind === 'delegation' && request.task.purpose !== 'coding') return inspectMaterial(request.task, result, dataDir, materialActions(request.task));
        return verifyCurrent(request.task, result, request.signal, usage => request.onUsage({
          input: (execution.input ?? 0) + (usage.input ?? 0), output: (execution.output ?? 0) + (usage.output ?? 0), costKnown: false }));
      },
      async inspect(identity) {
        const state = await agent.executor.inspect?.(identity) ?? { state: 'unknown' as const };
        const task = store.getTask(String(identity.taskId));
        if (state.state !== 'completed' || !state.result || !task) return state;
        if (task.workKind === 'delegation' && task.purpose !== 'coding') return { state: 'completed', result: await inspectMaterial(task, state.result, dataDir, materialActions(task)) };
        return { state: 'completed', result: await verifyCurrent(task, state.result) };
      } };
    const select = (kind: string) => kind === 'herdr' ? undefined : local;
    const executor: TaskExecutor = {
      execute: request => {
        const selected = select(request.task.executor);
        if (!selected) { const error = new Error('固定 herdr 执行入口已退役；旧任务保留现场，需人工查询实际状态。'); error.name = 'ExecutorAttentionError'; throw error; }
        return selected.execute(request);
      },
      steer: async (id, text) => select(host.getTask(id)?.executor ?? 'local')?.steer?.(id, text) ?? false,
      cancel: async identity => select(identity.kind === 'herdr' ? 'herdr' : 'local')?.cancel?.(identity) ?? false,
      inspect: async identity => select(identity.kind === 'herdr' ? 'herdr' : 'local')?.inspect?.(identity) ?? { state: 'unknown' },
    };
    const dialogue: Dialogue = { resume: agent.dialogue.resume, inspectContinuation: agent.dialogue.inspectContinuation, async decide(input, context) {
      const text = input.text.trim();
      if (text === '/help') return { kind: 'reply', text: '直接说明目标、查询进度、补充要求或停止任务。支持 /reset、/forget 节点引用、/memory 关键词；定时或周期计划请说明时间、时区和错过时的处理方式。' };
      if (text === '/reset') { await agent.reset(context.sessionId); return { kind: 'reply', text: '主对话上下文已重置，历史、长期记忆和任务记录保留。' }; }
      if (text.startsWith('/forget ')) {
        await memory!.forget(input.conversationId, text.slice(8).trim());
        return { kind: 'reply', text: '已排除指定来源并作废此对话的旧上下文；相关旧任务停止、计划暂停，原始记录保留。停止状态未知的执行仍需核实。' };
      }
      if (text.startsWith('/memory ')) return { kind: 'reply', text: JSON.stringify(await memory!.search(input.conversationId, text.slice(8).trim())) };
      if (text === '/model') return { kind: 'reply', text: `默认模型：${agent.defaultModel}\n${agent.models.map(model => `${model.alias}: ${model.name}`).join('\n')}` };
      if (text.startsWith('/model ')) { await agent.selectModel(context.sessionId, text.slice(7).trim()); return { kind: 'reply', text: `已切换主对话模型：${text.slice(7).trim()}` }; }
      return agent.dialogue.decide(input, context);
    } };
    host = new PersonalHost({ store, dialogue, executor, maxConcurrent: positive(env, 'AGENT_MAX_CONCURRENT', 2),
      acceptContinuation: async (task, result) => freezeArtifacts(dataDir, task, await inspectMaterial(task, result, dataDir, materialActions(task))),
      maxDurationMs: positive(env, 'AGENT_TASK_TIMEOUT_MS', 30 * 60_000),
      maxTokens: positive(env, 'AGENT_MAX_TOKENS', 500_000),
      maxRootCalls: positive(env, 'AGENT_ROOT_MAX_CALLS', 100), maxGlobalCalls: positive(env, 'AGENT_DAILY_MAX_CALLS', 500), maxGlobalTokens: positive(env, 'AGENT_DAILY_MAX_TOKENS', 2_000_000), maxRework: positive(env, 'AGENT_MAX_REWORK', 3),
      maxAttempts: positive(env, 'AGENT_MAX_ATTEMPTS', 3), maxDialogueAttempts: positive(env, 'AGENT_MAX_DIALOGUE_ATTEMPTS', 3),
      interruptDialogue: () => agent.close(),
      handleDecision: (input, decision) => plans.handle(input, decision) });
    plans = new PersonalPlans(host);
    await host.recover();
    return { host, plans, pi: agent, memory, dataDir, backendDiagnostics: backendRegistry.diagnostics,
      openLocalConversation(options: { actorId: string; cwd?: string; conversationId?: string; mode?: 'trusted' | 'restricted' }) {
        const cwd = resolve(options.cwd ?? process.cwd());
        const conversationId = options.conversationId ?? `cli:${options.actorId}:${createHash('sha256').update(process.platform === 'win32' ? cwd.toLowerCase() : cwd).digest('hex').slice(0, 24)}`;
        const existing = store.conversationWorkspace(conversationId);
        if (existing && existing.actorId !== options.actorId) throw new Error('本地会话属于另一个用户');
        const historical = store.listTasks(conversationId).find(task => task.actorId === options.actorId && task.cwd);
        const workspace = existing ?? { actorId: options.actorId, cwd: historical?.cwd ?? cwd, mode: historical ? historical.permission?.mode ?? 'restricted' : options.mode ?? 'trusted', modeSource: 'local-interactive' as const };
        // Explicit launch choices affect new work only; historical Task grants remain unchanged.
        if (options.mode) workspace.mode = options.mode;
        store.putConversationWorkspace(conversationId, workspace);
        return conversationId;
      },
      async onDelivered(delivery: Delivery) {
        if (delivery.parentId || !delivery.learning || delivery.status !== 'sent') return;
        if (delivery.taskId && host.getTask(delivery.taskId)?.contextExcluded) return;
        await memory!.recordDeliveredTurn({ id: delivery.learning.id, actorId: delivery.conversationId,
          userText: delivery.learning.input, assistantText: delivery.learning.answer, providerMessageId: delivery.providerMessageId, recallId: delivery.learning.recallId, originInputId: delivery.learning.originInputId, inputAt: delivery.learning.inputAt });
      },
      async close() { await host.close({ preserveTasks: true }); await agent.close(); await memory!.close(); },
    };
  } catch (error) { await pi?.close(); await memory?.close(); store.close(); throw error; }
}
