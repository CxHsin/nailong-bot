import { resolve } from 'node:path';
import { capabilityEnvironment } from '../agent/capability-config.js';
import { createAgentModels } from '../agent/agent-models.js';
import { modelEnvironment } from '../agent/model-config.js';
import { PersonalStore } from './store.js';
import { PersonalHost } from './host.js';
import { createPersonalPi } from './pi.js';
import { createPersonalMemory } from './memory.js';
import { HerdrExecutor } from './herdr.js';
import { PersonalPlans } from './plans.js';
import { VerificationChecks } from './verification.js';
import { requirePermission, permissionError } from './permissions.js';
import { freezeArtifacts } from './artifacts.js';
import { migratePersonalHistory, readHistoricalSource } from './migration.js';
import type { Delivery, Dialogue, TaskExecutor, Task, Usage } from './types.js';

function positive(env: NodeJS.ProcessEnv, name: string, fallback: number) {
  const value = env[name] ? Number(env[name]) : fallback;
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} 必须为正整数`);
  return value;
}

/** One production assembly shared by Telegram and CLI. No legacy replay executor. */
export async function createPersonalRuntime(env: NodeJS.ProcessEnv = process.env) {
  const dataDir = resolve(env.AGENT_DATA_DIR?.trim() || 'data');
  const promptFile = resolve(env.AGENT_PROMPT_FILE?.trim() || 'system-prompt.md');
  const capabilities = await capabilityEnvironment(env);
  const modelConfiguration = modelEnvironment(env);
  const models = createAgentModels({ modelConfiguration });
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
      } : undefined,
      dynamics: env.MEMORY_DYNAMICS ? JSON.parse(env.MEMORY_DYNAMICS) : undefined,
      recall: env.MEMORY_RECALL ? JSON.parse(env.MEMORY_RECALL) : undefined,
      invalidateSessions: async conversationId => {
        if (host) await host.excludeConversationContext(conversationId);
        await pi?.reset(store.conversationSession(conversationId), 'forget');
        for (const task of store.listTasks(conversationId)) await pi?.reset(task.sessionId, 'forget');
      },
    });
    pi = await createPersonalPi({ ...capabilities, dataDir, promptFile, modelConfiguration, memory,
      taskForIdentity: identity => store.getTask(String(identity.taskId)),
      workContext: (task, originId) => host.workContext({ conversationId: task.conversationId, actorId: task.actorId, inputId: originId, text: task.goal }, task.id),
      tinyfishKey: env.TINYFISH_API_KEY?.trim(), shellPath: env.AGENT_SHELL_PATH?.trim(),
      limits: { timeoutMs: positive(env, 'AGENT_MODEL_TIMEOUT_MS', 120_000),
        maxTurns: positive(env, 'AGENT_MAX_TURNS', 40), maxTokens: positive(env, 'AGENT_MAX_TOKENS', 500_000) } });
    const agent = pi;
    let plans!: PersonalPlans;
    const checks = new VerificationChecks(env.AGENT_VERIFICATION_CHECKS ? JSON.parse(env.AGENT_VERIFICATION_CHECKS) : [],
      { timeoutMs: positive(env, 'AGENT_CHECK_TIMEOUT_MS', 120_000),
        async runCommand(task, command, context) {
          const current = host.getTask(task.id) ?? task; const grant = requirePermission(current);
          if (grant.mode !== 'trusted') throw permissionError('独立检查没有满足工作权限的已验证命令后端；未派发，不能绕过受限权限');
          const work = host.workContext({ conversationId: task.conversationId, actorId: task.actorId, inputId: `verification:${task.revision}`, text: task.goal }, task.id);
          const callId = `check:${JSON.stringify(command)}`;
          return work.dispatch(callId, { kind: 'verification-command', target: task.cwd!, parameters: { command: command.command, args: command.args }, content: '已配置的独立检查，在明确授予的可信本机权限内运行' }, async () => {
            const trusted = new VerificationChecks([command], { preauthorized: true, timeoutMs: positive(env, 'AGENT_CHECK_TIMEOUT_MS', 120_000) });
            return (await trusted.run(current, context))[0]!;
          });
        } });
    async function verifyCurrent(task: Task, evidence: Parameters<typeof agent.verify>[1], signal?: AbortSignal, onUsage?: (usage: Usage) => void) {
      const current = host.getTask(task.id) ?? task;
      if (current.contextExcluded) return { text: '相关来源已排除，旧任务不会继续验收或执行。', verified: false, partial: true };
      const result = await agent.verify(current, evidence, signal, await checks.run(current, { signal }), onUsage);
      if ((host.getTask(task.id)?.revision ?? current.revision) !== current.revision)
        return { text: '验收期间要求发生变化，需按最新要求重新验收。', verified: false, partial: true };
      return freezeArtifacts(dataDir, current, result);
    }
    const herdr = env.AGENT_HERDR_SESSION?.trim() ? new HerdrExecutor({ session: env.AGENT_HERDR_SESSION.trim(),
      kind: env.AGENT_HERDR_KIND === 'claude' ? 'claude' : 'codex',
      maxDurationMs: positive(env, 'AGENT_TASK_TIMEOUT_MS', 30 * 60_000),
      verify: (task, evidence) => verifyCurrent(task, evidence, evidence.signal),
      taskForIdentity: identity => host.getTask(String(identity.taskId)),
    }) : undefined;
    const local: TaskExecutor = { ...agent.executor,
      async execute(request) {
        let execution: Usage = {};
        const result = await agent.executor.execute({ ...request, onUsage: usage => { execution = usage; request.onUsage(usage); } });
        return verifyCurrent(request.task, result, request.signal, usage => request.onUsage({
          input: (execution.input ?? 0) + (usage.input ?? 0), output: (execution.output ?? 0) + (usage.output ?? 0), costKnown: false }));
      },
      async inspect(identity) {
        const state = await agent.executor.inspect?.(identity) ?? { state: 'unknown' as const };
        const task = store.getTask(String(identity.taskId));
        if (state.state !== 'completed' || !state.result || !task) return state;
        return { state: 'completed', result: await verifyCurrent(task, state.result) };
      } };
    const select = (kind: string) => kind === 'herdr' ? herdr : local;
    const executor: TaskExecutor = {
      execute: request => {
        const selected = select(request.task.executor);
        if (!selected) { const error = new Error('未配置专用 AGENT_HERDR_SESSION，开发委派等待接入。'); error.name = 'ExecutorAttentionError'; throw error; }
        return selected.execute(request);
      },
      steer: async (id, text) => select(host.getTask(id)?.executor ?? 'local')?.steer?.(id, text) ?? false,
      cancel: async identity => select(identity.kind === 'herdr' ? 'herdr' : 'local')?.cancel?.(identity) ?? false,
      inspect: async identity => select(identity.kind === 'herdr' ? 'herdr' : 'local')?.inspect?.(identity) ?? { state: 'unknown' },
    };
    const dialogue: Dialogue = { async decide(input, context) {
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
      maxDurationMs: positive(env, 'AGENT_TASK_TIMEOUT_MS', 30 * 60_000),
      maxTokens: positive(env, 'AGENT_MAX_TOKENS', 500_000),
      maxAttempts: positive(env, 'AGENT_MAX_ATTEMPTS', 3), maxDialogueAttempts: positive(env, 'AGENT_MAX_DIALOGUE_ATTEMPTS', 3),
      interruptDialogue: () => agent.close(),
      handleDecision: (input, decision) => plans.handle(input, decision) });
    plans = new PersonalPlans(host);
    await host.recover();
    return { host, plans, pi: agent, memory, dataDir,
      async onDelivered(delivery: Delivery) {
        if (delivery.parentId || !delivery.learning || delivery.status !== 'sent') return;
        if (delivery.taskId && host.getTask(delivery.taskId)?.contextExcluded) return;
        await memory!.recordDeliveredTurn({ id: delivery.learning.id, actorId: delivery.conversationId,
          userText: delivery.learning.input, assistantText: delivery.learning.answer, providerMessageId: delivery.providerMessageId });
      },
      async close() { await host.close({ preserveTasks: true }); await agent.close(); await memory!.close(); },
    };
  } catch (error) { await pi?.close(); await memory?.close(); store.close(); throw error; }
}
