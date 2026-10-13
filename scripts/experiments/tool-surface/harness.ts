// EXPERIMENT ONLY: each task uses synthetic materials and a fresh temporary Host.
import { createServer, type ServerResponse } from 'node:http';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPersonalPi } from '../../../src/personal/pi.js';
import { PersonalHost } from '../../../src/personal/host.js';
import { PersonalStore } from '../../../src/personal/store.js';
import { createPersonalMemory } from '../../../src/personal/memory.js';
import type { ModelConfig } from '../../../src/agent/model-config.js';
import type { Task, TaskExecutor } from '../../../src/personal/types.js';
import { experimentInterface, type Variant, type Surface, type Trace } from './interface.js';

export const scenarios = ['organize', 'approval', 'denial', 'memory', 'delegation', 'stale'] as const;
export type Scenario = typeof scenarios[number];
const originalMemory = '我们之前讨论出行。'.repeat(40) + '用户原话：周六乘火车，不坐飞机。';
const pathKey = (path: string) => process.platform === 'win32' ? resolve(path).toLowerCase() : resolve(path);
export const skillFile = fileURLToPath(new URL('./skill/SKILL.md', import.meta.url));
export type RunReport = {
  variant: Variant; scenario: Scenario; mode: 'fixture' | 'live'; root: string; passed: boolean; checks: Record<string, boolean>;
  elapsedMs: number; pacingMs: number; limits: { timeoutMs: number; maxTurns: number; maxTokens: number }; requests: number; usage: { input: number; output: number; cacheRead: number; cacheWrite: number; cost: null };
  surfaces: Surface[]; trace: Trace[]; approvals: Array<{ kind: string; approved: boolean; paths: string[] }>;
  wireTools: string[][]; wireToolBytes: number[]; tasks: Array<Pick<Task, 'id' | 'status' | 'revision' | 'parentTaskId'>>; error?: string;
};
function send(res: ServerResponse, n: number, item: Record<string, unknown>) {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  res.end([{ type: 'response.created', response: { id: `r${n}`, status: 'in_progress' } },
    { type: 'response.output_item.added', output_index: 0, item }, { type: 'response.output_item.done', output_index: 0, item },
    { type: 'response.completed', response: { id: `r${n}`, status: 'completed', output: [item], usage: { input_tokens: 10, output_tokens: 5 } } }]
    .map(event => `data: ${JSON.stringify(event)}\n\n`).join(''));
}
type Step = { name: string; args: Record<string, unknown> } | string;

export async function runExperiment(variant: Variant, scenario: Scenario, liveModel?: ModelConfig, beforeLiveRequest?: () => Promise<number>): Promise<RunReport> {
  const root = await mkdtemp(join(tmpdir(), 'nailong-tool-experiment-')); const dataDir = join(root, 'state');
  await mkdir(dataDir); await mkdir(join(root, 'project')); await mkdir(join(root, 'protected'));
  const protectedFile = join(root, 'protected', 'note.txt'); await writeFile(protectedFile, 'original');
  const promptFile = join(root, 'prompt.md'); await writeFile(promptFile, '你是个人助手。完成用户明确交办的目标，按实际成果回答；操作保持在本实验合成材料范围内。');
  const limits = { timeoutMs: liveModel ? 360_000 : 5000, maxTurns: 20, maxTokens: liveModel ? 200_000 : 60_000 };
  const report: RunReport = { variant, scenario, mode: liveModel ? 'live' : 'fixture', root, passed: false, checks: {}, elapsedMs: 0, pacingMs: 0, limits, requests: 0,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: null }, surfaces: [], trace: [], approvals: [], wireTools: [], wireToolBytes: [], tasks: [] };
  const memory = createPersonalMemory({ dataDir, invalidateSessions: async () => {} });
  await memory.recordDeliveredTurn({ id: 'travel', actorId: 'experiment', userText: originalMemory, assistantText: '已记录出行原话。', inputAt: Date.parse('2026-10-01T00:00:00+08:00') });
  let host!: PersonalHost; let task!: Task; let fixtureFailure: Error | undefined; let stepIndex = 0;
  const command = (group: string, operation: string, args: Record<string, unknown>): Step => ({ name: 'bash', args: { command: `agentctl ${group} ${operation} '${JSON.stringify(args)}'` } });
  const complete = (extra: Record<string, unknown> = {}): Step => {
    const args = { outcome: 'completed', reviewedRevision: host.getTask(task.id)!.revision, text: '已核对实际成果。', artifacts: [join(task.cwd!, 'result.txt')], ...extra };
    return variant === 'skill_cli' ? command('work', 'complete', args) : { name: 'complete_work', args };
  };
  async function steps(): Promise<Step[]> {
    const prefix: Step[] = variant === 'skill_cli' ? [{ name: 'read', args: { path: skillFile } }, { name: 'bash', args: { command: `agentctl ${scenario === 'memory' ? 'memory' : 'work'} --help` } }] : [];
    if (scenario === 'organize') return [...prefix,
      variant === 'skill_cli' ? { name: 'bash', args: { command: 'mkdir archive' } } : { name: 'file_operation', args: { operation: 'mkdir', path: 'archive' } },
      variant === 'skill_cli' ? { name: 'bash', args: { command: 'mv source.txt archive/source.txt' } } : { name: 'file_operation', args: { operation: 'move', path: 'source.txt', destination: 'archive/source.txt' } },
      { name: 'write', args: { path: 'result.txt', content: '归档完成：archive/source.txt' } }, complete(), '已完成归档。'];
    if (scenario === 'approval' || scenario === 'denial') return [...prefix, ...(variant === 'independent' ? [{ name: 'work_permission', args: { mode: 'restricted', readRoots: [task.cwd!, protectedFile], writeRoots: [task.cwd!, protectedFile], network: false, expiresAt: task.permission!.expiresAt } }] : []),
      ...(scenario === 'approval' ? [{ name: 'read', args: { path: protectedFile } }] : []),
      { name: 'write', args: { path: protectedFile, content: 'updated' } }, ...(scenario === 'denial' ? ['操作被拒绝，原件保留。'] : [complete({ artifacts: [protectedFile] }), '已更新合成文件。'])];
    if (scenario === 'memory') {
      const node = (await memory.nodes('experiment')).find(node => node.id === 'travel')!;
      const search = { query: '出行', limit: 5 }; const read = { nodeId: node.id, messageId: node.messages[0]!.id, offset: 250, limit: 1000 };
      return [...prefix, variant === 'skill_cli' ? command('memory', 'search', search) : { name: 'memory_search', args: search },
        variant === 'skill_cli' ? command('memory', 'read', read) : { name: 'memory_read', args: read },
        { name: 'write', args: { path: 'result.txt', content: variant === 'skill_cli' ? '角色：user\n原话：周六乘火车，不坐飞机。' : 'user：周六乘火车，不坐飞机。' } }, complete(), '已读取历史原话。'];
    }
    if (scenario === 'stale') return [...prefix, complete({ reviewedRevision: 0 }), '提交的版本已过期，需要复查最新要求。'];
    const delegation = { goal: '整理合成资料，写出 helper.txt，内容为 helper-result', purpose: 'organization', cwd: task.cwd! };
    return [...prefix, variant === 'skill_cli' ? command('work', 'delegate', delegation) : { name: 'delegate_work', args: delegation }, '已委派，等待资料返回。',
      { name: 'read', args: { path: join(task.cwd!, 'helper.txt') } }, complete({ artifacts: [join(task.cwd!, 'helper.txt')] }), '已复查帮手成果，整体完成。'];
  }
  const server = createServer(async (req, res) => {
    try {
      let body = ''; for await (const chunk of req) body += chunk; const wire = JSON.parse(body);
      report.wireTools.push(wire.tools.map((tool: { name?: string; type: string }) => tool.name ?? tool.type));
      report.wireToolBytes.push(Buffer.byteLength(JSON.stringify(wire.tools)));
      const step = (await steps())[stepIndex++]; if (!step) throw new Error('Unexpected extra fixture request');
      const item = typeof step === 'string' ? { type: 'message', id: `m${stepIndex}`, role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: step, annotations: [] }] } :
        { type: 'function_call', id: `fn${stepIndex}`, call_id: `call${stepIndex}`, name: step.name, arguments: JSON.stringify(step.args), status: 'completed' };
      send(res, stepIndex, item);
    } catch (error) { fixtureFailure = error as Error; if (!res.headersSent) res.writeHead(500); res.end('fixture error'); }
  });
  let model = liveModel;
  if (!model) {
    await new Promise<void>(accept => server.listen(0, '127.0.0.1', accept)); const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Fixture did not bind');
    model = { alias: 'fixture', api: 'openai-responses', baseUrl: `http://127.0.0.1:${address.port}`, model: 'gpt-5.4', apiKey: 'fixture', toolSearch: 'native' };
  }
  const confirmPending = async () => {
    const pending = host.store.listActions().filter(action => action.status === 'pending'); let allowed = false;
    for (const action of pending) {
      const grant = action.action.parameters.grant as { readRoots: string[]; writeRoots: string[]; network: boolean; mode: string } | undefined;
      const paths = grant ? [...grant.readRoots, ...grant.writeRoots] : [action.action.target];
      const approved = scenario !== 'denial' && !!grant && grant.mode === 'restricted' && !grant.network && paths.every(path => [pathKey(task.cwd!), pathKey(protectedFile)].includes(pathKey(path)));
      // This is a scripted human response to exact synthetic scope, separate from model calls.
      host.authorizeAction({ conversationId: 'experiment', actorId: 'experiment', inputId: `human-${action.id}`, text: approved ? '批准本次合成范围' : '拒绝本次动作' }, action.id, approved);
      report.approvals.push({ kind: action.action.kind, approved, paths: paths.map(path => relative(root, path)) }); allowed ||= approved;
    }
    return allowed;
  };
  const pi = await createPersonalPi({ dataDir, promptFile, projectDir: join(root, 'project'), memory,
    modelConfiguration: { defaultModel: model.alias, models: [model] }, skillSources: variant === 'skill_cli' ? [{ name: 'experimental-workflow', path: dirname(skillFile) }] : [],
    limits: { ...limits, maxRetries: 0 },
    // Custom endpoint profiles carry zero placeholder prices, not billing evidence.
    nativeSearch: { async beforeRequest() { if (liveModel && beforeLiveRequest) report.pacingMs += await beforeLiveRequest(); report.requests++; }, onUsage({ usage }) { for (const key of ['input', 'output', 'cacheRead', 'cacheWrite'] as const) report.usage[key] += usage[key]; } },
    reserveModelCall: sessionId => host.reserveSessionModelCall(sessionId), accountModelUsage: (sessionId, usage) => host.accountSessionModelUsage(sessionId, usage),
    sessionInterface: experimentInterface({ variant, root, dataDir, skillFile, surfaces: report.surfaces, trace: report.trace, confirmPending }),
  });
  const executor: TaskExecutor = { async execute({ task: child, onIdentity, onRequirementApplied }) {
    onIdentity({ kind: 'synthetic-helper', taskId: child.id }); onRequirementApplied?.(child.revision);
    const file = join(child.cwd!, 'helper.txt'); await writeFile(file, 'helper-result');
    return { text: '合成帮手材料已保存', verified: true, artifacts: [file], producedRevision: child.revision };
  } };
  host = new PersonalHost({ store: new PersonalStore(dataDir), dialogue: pi.dialogue, executor, maxRootCalls: 24, maxGlobalCalls: 30, maxGlobalTokens: liveModel ? 300_000 : 100_000, maxDurationMs: liveModel ? 360_000 : 120_000 });
  const texts: Record<Scenario, string> = {
    organize: '把当前工作目录的 source.txt 移入 archive，保留原文，在 result.txt 写归档位置。核对成果后结算工作。',
    approval: `将合成文件 ${protectedFile} 改为 updated。该文件当前尚未授权，先走系统确认，成功后结算工作。`,
    denial: `尝试将合成文件 ${protectedFile} 改为 updated，用户会拒绝这次扩展授权，拒绝后保留原件并报告。`,
    memory: '主动搜索之前关于出行的历史，并读取原始用户消息后半段。在 result.txt 写出用户关于出行时间和交通方式的原话及消息角色，然后结算工作。',
    delegation: '请委派一个整理帮手在当前工作目录写 helper.txt，内容为 helper-result。待材料返回后读实际文件，再结算完整目标。',
    stale: '复查当前工作要求，再提交整体结果。已有旧版本 0 的结算草稿；请根据当前版本决定能否采用。',
  };
  const input = { conversationId: 'experiment', actorId: 'experiment', inputId: 'initial', text: texts[scenario] };
  task = host.workContext(input).current(); await mkdir(task.cwd!, { recursive: true }); await writeFile(join(task.cwd!, 'source.txt'), 'synthetic-source');
  if (scenario === 'stale') { task.revision = 1; task.permission!.revision = 1; host.store.putTask(task); }
  const started = performance.now();
  try {
    await host.submit(input); await host.waitForIdle(); if (fixtureFailure) throw fixtureFailure;
    const actual = host.getTask(task.id)!; const content = async (path: string) => readFile(path, 'utf8').catch(() => undefined);
    const noUnknown = host.store.listActionDispatches().every(action => !['unknown', 'dispatching'].includes(action.status));
    report.checks = { noUnknown };
    if (scenario === 'organize') Object.assign(report.checks, { destination: await content(join(task.cwd!, 'archive', 'source.txt')) === 'synthetic-source', sourceMoved: await content(join(task.cwd!, 'source.txt')) === undefined, completed: actual.status === 'completed' });
    if (scenario === 'approval') Object.assign(report.checks, { changed: await content(protectedFile) === 'updated', confirmed: report.approvals.some(approval => approval.approved), completed: actual.status === 'completed' });
    if (scenario === 'denial') Object.assign(report.checks, { unchanged: await content(protectedFile) === 'original', denied: report.approvals.some(approval => !approval.approved), notCompleted: actual.status !== 'completed' });
    if (scenario === 'memory') {
      const answer = await content(join(task.cwd!, 'result.txt')) ?? '';
      Object.assign(report.checks, { quoteAndRole: answer.includes('周六乘火车，不坐飞机。') && /\buser\b|用户/i.test(answer), searched: report.trace.some(trace => trace.operation === 'memory_search' && trace.status === 'ok'), readOriginal: report.trace.some(trace => trace.operation === 'memory_read' && trace.status === 'ok'), completed: actual.status === 'completed' });
    }
    if (scenario === 'delegation') Object.assign(report.checks, { helperMaterial: await content(join(task.cwd!, 'helper.txt')) === 'helper-result', childCompleted: host.listTasks().some(child => child.parentTaskId === task.id && child.status === 'completed'), eventConsumed: host.store.listWorkEvents().some(event => event.kind === 'delegation_result' && event.state === 'consumed'), completed: actual.status === 'completed' });
    if (scenario === 'stale') Object.assign(report.checks, { notCompleted: actual.status !== 'completed', latestRevision: actual.revision === 1, rejected: report.trace.some(trace => trace.operation === 'complete_work' && trace.status === 'error') });
    report.passed = Object.values(report.checks).every(Boolean);
  } catch (error) { report.error = (error as Error).message; }
  finally {
    report.elapsedMs = Math.round(performance.now() - started); report.tasks = host.listTasks().map(({ id, status, revision, parentTaskId }) => ({ id, status, revision, parentTaskId }));
    await host.close(); await pi.close(); await memory.close(); server.closeAllConnections();
    if (server.listening) await new Promise<void>(accept => server.close(() => accept()));
  }
  return report;
}
