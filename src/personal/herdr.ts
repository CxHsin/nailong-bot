import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { ExecutorIdentity, Task, TaskExecution, TaskExecutor, TaskResult } from './types.js';
import { processTree, waitForTermination } from './process-control.js';

export interface HerdrEvidence {
  identity: ExecutorIdentity; output: string; revision: number; signal?: AbortSignal;
}
export interface HerdrOptions {
  /** Explicit server selection: never operate on the UI-focused default session. */
  session: string;
  kind?: 'codex' | 'claude';
  maxDurationMs?: number; pollMs?: number;
  /** System boundary used by acceptance to substitute the socket/CLI. */
  cli?: (args: string[], signal?: AbortSignal) => Promise<unknown>;
  /** Host-owned acceptance: actual artifacts and checks, not terminal claims. */
  verify?: (task: Task, evidence: HerdrEvidence) => Promise<TaskResult>;
  /** Direct persisted Task lookup for post-restart acceptance of existing work. */
  taskForIdentity?: (identity: ExecutorIdentity) => Task | undefined;
  /** Required for Claude: a deployment-verified, enforceable launch policy. */
  claudePolicy?: { args: string[]; verified: boolean };
  /** Closing a pane alone does not prove all external processes have stopped. */
  confirmStopped?: (identity: ExecutorIdentity) => Promise<boolean>;
}
type RecordValue = Record<string, unknown>;
function object(value: unknown): RecordValue {
  if (!value || typeof value !== 'object') throw new Error('Invalid herdr response');
  return value as RecordValue;
}
function result(value: unknown): RecordValue {
  const response = object(value);
  if (response.error) throw new Error(`herdr: ${JSON.stringify(response.error)}`);
  return object(response.result);
}
function string(value: unknown): string {
  if (typeof value !== 'string' || !value) throw new Error('Missing herdr identity');
  return value;
}
function samePath(a: unknown, b: unknown) {
  return typeof a === 'string' && typeof b === 'string' && resolve(a).toLowerCase() === resolve(b).toLowerCase();
}

/** A task-specific terminal executor. Task completion remains a Host decision. */
export class HerdrExecutor implements TaskExecutor {
  private readonly cli: NonNullable<HerdrOptions['cli']>;
  private readonly activeTasks = new Map<string, Task>();
  constructor(private readonly options: HerdrOptions) {
    if (!/^[a-zA-Z0-9_-]+$/.test(options.session)) throw new Error('Explicit named herdr session required');
    this.cli = options.cli ?? ((args, signal) => new Promise((accept, reject) => {
      execFile('herdr', ['--session', options.session, ...args], {
        signal, timeout: 35_000, maxBuffer: 1024 * 1024, windowsHide: true,
      }, (error, stdout, stderr) => {
        if (error) { reject(new Error(`herdr command failed: ${stderr || error.message}`)); return; }
        if (args[0] === 'agent' && args[1] === 'read') { accept({ result: { text: stdout } }); return; }
        try { accept(JSON.parse(stdout)); } catch { reject(new Error('herdr returned invalid JSON')); }
      });
    }));
  }
  async execute(request: TaskExecution): Promise<TaskResult> {
    const { attempt, signal, onIdentity } = request;
    request.onUsage({ costKnown: false });
    let task = { ...request.task, requirements: [...request.task.requirements] };
    if (!task.cwd) throw new Error('herdr delegation requires an explicit working directory');
    const kind = this.options.kind ?? 'codex';
    if (kind === 'claude' && !this.options.claudePolicy?.verified) throw new Error('Claude execution policy is not verified; delegation requires configuration');
    const name = `nl-${createHash('sha256').update(attempt.id).digest('hex').slice(0, 20)}`;
    let identity: ExecutorIdentity = {
      kind: 'herdr', session: this.options.session, taskId: task.id, attemptId: attempt.id,
      cwd: resolve(task.cwd), agentName: name, agentKind: kind, revision: task.revision,
      goalHash: createHash('sha256').update(JSON.stringify([task.goal, task.requirements])).digest('hex'),
      phase: 'creating',
    };
    // Persist intention before even creating an external workspace. If its outcome
    // becomes unknown, recovery must ask instead of blindly creating another one.
    onIdentity(identity);
    const environment = !this.options.cli && process.env.PATH ? ['--env', `PATH=${process.env.PATH}`] : [];
    const created = result(await this.cli(['workspace', 'create', '--cwd', task.cwd, '--label', name, '--no-focus', ...environment], signal));
    identity = { ...identity, workspaceId: string(object(created.workspace).workspace_id), paneId: string(object(created.root_pane).pane_id), phase: 'starting' };
    onIdentity(identity);
    const args = kind === 'codex'
      ? ['--sandbox', 'workspace-write', '--ask-for-approval', 'on-request', '--no-daemon', '--no-alt-screen']
      : this.options.claudePolicy!.args;
    const started = result(await this.cli(['agent', 'start', name, '--kind', kind, '--pane', string(identity.paneId), '--timeout', '30000', '--', ...args], signal));
    this.validateAgent(object(started.agent), identity);
    identity = { ...identity, launchArgs: started.argv, terminalId: object(started.agent).terminal_id }; onIdentity(identity);
    if (!this.options.cli && process.platform === 'win32') {
      const info = object(result(await this.cli(['pane', 'process-info', '--pane', string(identity.paneId)], signal)).process_info);
      const shellPid = Number(info.shell_pid);
      if (!Number.isSafeInteger(shellPid) || shellPid <= 0) throw attention('herdr shell process identity is unavailable');
      identity = { ...identity, shellPid, processIds: await processTree(shellPid) }; onIdentity(identity);
    }
    this.activeTasks.set(task.id, task);
    try {
    identity = { ...identity, phase: 'prompting' }; onIdentity(identity);
    const prompt = `${task.goal}\n${task.requirements.join('\n')}\nTask ${task.id}; attempt ${attempt.id}; requirement revision ${task.revision}. Report actual files and checks. Do not publish, merge, send to others or change credentials. Permission questions must remain blocked for the user.`;
    // Do not use --wait: it observes lifecycle, not the submitted turn.
    const prompted = result(await this.cli(['agent', 'prompt', name, prompt], signal));
    let agent = object(prompted.agent); this.validateAgent(agent, identity);
    let observedWork = agent.agent_status === 'working';
    identity = { ...identity, phase: 'submitted', observedWork }; onIdentity(identity);
    const deadline = Date.now() + (this.options.maxDurationMs ?? 30 * 60_000);
    while (Date.now() < deadline) {
      signal.throwIfAborted();
      agent = object(result(await this.cli(['agent', 'get', name], signal)).agent);
      this.validateAgent(agent, identity);
      if (agent.agent_status === 'working' && !observedWork) {
        observedWork = true; identity = { ...identity, observedWork, appliedRevision: identity.revision }; onIdentity(identity);
        request.onRequirementApplied?.(Number(identity.revision));
      }
      if (agent.agent_status === 'blocked') throw attention('herdr agent requires user action; no approval response was sent');
      if (observedWork && ['idle', 'done'].includes(String(agent.agent_status))) {
        const latest = this.activeTasks.get(task.id)!;
        if (latest.revision > Number(identity.revision)) {
          task = latest;
          identity = { ...identity, revision: task.revision, phase: 'prompting', observedWork: false,
            goalHash: createHash('sha256').update(JSON.stringify([task.goal, task.requirements])).digest('hex') };
          onIdentity(identity);
          const updated = result(await this.cli(['agent', 'prompt', name, `Apply the current task requirements before reporting completion.\n${task.goal}\n${task.requirements.join('\n')}\nTask ${task.id}; attempt ${attempt.id}; requirement revision ${task.revision}.`], signal));
          agent = object(updated.agent); this.validateAgent(agent, identity);
          observedWork = agent.agent_status === 'working';
          identity = { ...identity, phase: 'submitted', observedWork, ...(observedWork ? { appliedRevision: task.revision } : {}) }; onIdentity(identity);
          if (observedWork) request.onRequirementApplied?.(task.revision);
          continue;
        }
        const read = result(await this.cli(['agent', 'read', name, '--source', 'recent-unwrapped', '--lines', '200'], signal));
        const output = typeof read.text === 'string' ? read.text : typeof read.output === 'string' ? read.output : JSON.stringify(read);
        identity = { ...identity, phase: 'settled', readPosition: agent.revision, stateChangeSeq: agent.state_change_seq };
        onIdentity(identity);
        const verified = await (this.options.verify
          ? this.options.verify(task, { identity, output, revision: task.revision, signal })
          : { text: '执行者已空闲；成果和检查尚未经 Host 验收。', verified: false, partial: true });
        if (this.activeTasks.get(task.id)!.revision > task.revision) continue;
        return verified;
      }
      await delay(this.options.pollMs ?? 500, undefined, { signal });
    }
    const stopped = await this.cancel(identity);
    throw attention(stopped ? 'herdr execution time limit reached; dedicated executor stopped, partial artifacts require inspection' : 'herdr execution time limit reached; executor stop is unconfirmed and requires inspection');
    } finally { this.activeTasks.delete(task.id); }
  }
  async steer(taskId: string, text: string): Promise<boolean> {
    const task = this.activeTasks.get(taskId);
    if (!task) return false;
    this.activeTasks.set(taskId, { ...task, requirements: [...task.requirements, text], revision: task.revision + 1 });
    // Accepted for the next settled boundary; not yet applied by the executor.
    return false;
  }
  private validateAgent(agent: RecordValue, identity: ExecutorIdentity) {
    if (agent.name !== identity.agentName || agent.pane_id !== identity.paneId || agent.workspace_id !== identity.workspaceId || (identity.terminalId && agent.terminal_id !== identity.terminalId) || agent.agent !== identity.agentKind || !samePath(agent.foreground_cwd ?? agent.cwd, identity.cwd)) {
      throw new Error('herdr executor identity or working directory changed; refusing task association');
    }
  }
  async cancel(identity: ExecutorIdentity): Promise<boolean> {
    if (identity.kind !== 'herdr' || identity.session !== this.options.session || !identity.paneId || !identity.agentName) return false;
    try {
      const agent = object(result(await this.cli(['agent', 'get', string(identity.agentName)])).agent);
      this.validateAgent(agent, identity);
      let processIds: number[] | undefined;
      if (!this.options.cli && process.platform === 'win32' && Number.isSafeInteger(identity.shellPid)) {
        const info = object(result(await this.cli(['pane', 'process-info', '--pane', string(identity.paneId)])).process_info);
        if (info.shell_pid !== identity.shellPid) return false;
        processIds = await processTree(Number(identity.shellPid));
      }
      await this.cli(['pane', 'close', string(identity.paneId)]);
      const snapshot = object(result(await this.cli(['api', 'snapshot'])).snapshot);
      if (!Array.isArray(snapshot.panes) || snapshot.panes.some(p => object(p).pane_id === identity.paneId)) return false;
      if (this.options.confirmStopped) return await this.options.confirmStopped(identity);
      if (!processIds?.length) return false;
      return waitForTermination(processIds, 10, 100);
    } catch { return false; }
  }
  async inspect(identity: ExecutorIdentity): Promise<{ state: 'running' | 'completed' | 'stopped' | 'unknown'; result?: TaskResult }> {
    if (identity.kind !== 'herdr' || identity.session !== this.options.session || !identity.agentName || !identity.paneId) return { state: 'unknown' };
    try {
      const agent = object(result(await this.cli(['agent', 'get', string(identity.agentName)])).agent);
      this.validateAgent(agent, identity);
      if (agent.agent_status === 'working') return { state: 'running' };
      const task = this.options.taskForIdentity?.(identity);
      if (!task || ['stopping', 'cancelled'].includes(task.status) || !this.options.verify || !identity.observedWork || task.id !== identity.taskId || task.revision !== identity.revision || !['idle', 'done'].includes(String(agent.agent_status))) return { state: 'unknown' };
      if (identity.goalHash !== createHash('sha256').update(JSON.stringify([task.goal, task.requirements])).digest('hex')) return { state: 'unknown' };
      const read = result(await this.cli(['agent', 'read', string(identity.agentName), '--source', 'recent-unwrapped', '--lines', '200']));
      const output = typeof read.text === 'string' ? read.text : JSON.stringify(read);
      const checked = await this.options.verify(task, { identity, output, revision: task.revision });
      const current = this.options.taskForIdentity?.(identity);
      if (!current || current.revision !== task.revision) return { state: 'unknown' };
      return checked.verified ? { state: 'completed', result: checked } : { state: 'unknown', result: checked };
    } catch { return { state: 'unknown' }; }
  }
}
function attention(message: string) { const error = new Error(message); error.name = 'ExecutorAttentionError'; return error; }
