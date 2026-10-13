import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { PersonalStore } from '../src/personal/store.js';
import { PersonalHost } from '../src/personal/host.js';
import type { Decision, TaskExecution } from '../src/personal/types.js';

test('retired fixed herdr start creates no task and legacy queued herdr never redispatches', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'personal-retired-herdr-'));
  const store = new PersonalStore(directory); let executions = 0;
  const host = new PersonalHost({ store, dialogue: { async decide() { return { kind: 'start', goal: 'code', executor: 'herdr' }; } },
    executor: { async execute() { executions++; return { text: 'wrong executor', verified: true }; } } });
  try {
    await host.submit({ conversationId: 'c', actorId: 'a', inputId: 'new', text: 'code' });
    await host.waitForIdle(); assert.equal(host.listTasks().length, 0); assert.equal(executions, 0);
    store.putTask({ id: 'legacy', conversationId: 'c', actorId: 'a', goal: 'old code', executor: 'herdr', sessionId: 'old', status: 'queued', resources: [], requirements: [], revision: 0, createdAt: 1, updatedAt: 1 });
    await host.recover(); await host.waitForIdle();
    assert.equal(executions, 0); assert.equal(host.getTask('legacy')?.status, 'waiting');
    assert.equal(store.listAttempts('legacy').length, 0); assert.equal(host.getTask('legacy')?.result, undefined);
  } finally { await host.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('Host accepts a goal and makes verified results retrievable without replay', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'personal-host-'));
  const store = new PersonalStore(directory);
  const host = new PersonalHost({ store, dialogue: { async decide() { return { kind: 'start', goal: 'prepare report' }; } },
    executor: { async execute() { return { text: 'Report prepared and checked', verified: true }; } } });
  try {
    const response = await host.submit({ conversationId: 'c', actorId: 'a', inputId: '1', text: 'prepare report' });
    assert.ok(response.taskId);
    await host.waitForIdle();
    assert.equal(host.getTask(response.taskId)?.status, 'completed');
    assert.equal(host.getTask(response.taskId)?.result?.text, 'Report prepared and checked');
    assert.equal(host.listTasks('c').length, 1);
    const repeated = await host.submit({ conversationId: 'c', actorId: 'a', inputId: '1', text: 'prepare report' });
    assert.equal(repeated.taskId, response.taskId);
    assert.equal(host.listTasks('c').length, 1);
  } finally { await host.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('chat and independent tasks proceed while overlapping directories wait', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'personal-host-'));
  let release!: () => void; const barrier = new Promise<void>(resolve => { release = resolve; });
  const entered: string[] = [];
  const decisions: Record<string, Decision> = {
    first: { kind: 'start', goal: 'first', cwd: join(directory, 'project') },
    overlap: { kind: 'start', goal: 'overlap', cwd: join(directory, 'project', 'child') },
    independent: { kind: 'start', goal: 'independent', cwd: join(directory, 'elsewhere') },
    chat: { kind: 'reply', text: 'Hello while work continues' },
  };
  const host = new PersonalHost({ store: new PersonalStore(directory), dialogue: { async decide(input) { return decisions[input.text]!; } },
    executor: { async execute({ task }) { entered.push(task.goal); if (task.goal === 'first') await barrier; return { text: task.goal, verified: true }; } } });
  const input = (text: string) => ({ conversationId: 'c', actorId: 'a', inputId: text, text });
  try {
    const first = await host.submit(input('first'));
    const overlap = await host.submit(input('overlap'));
    await host.submit(input('independent'));
    assert.equal((await host.submit(input('chat'))).text, 'Hello while work continues');
    assert.deepEqual(entered, ['first', 'independent']);
    assert.equal(host.getTask(first.taskId!)?.status, 'running');
    assert.equal(host.getTask(overlap.taskId!)?.status, 'queued');
    release(); await host.waitForIdle(); assert.deepEqual(entered, ['first', 'independent', 'overlap']);
  } finally { release(); await host.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('ambiguous cancellation leaves tasks running and explicit reply stops only its task', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'personal-host-'));
  const host: PersonalHost = new PersonalHost({ store: new PersonalStore(directory),
    dialogue: { async decide(input) { return input.text === 'stop' ? { kind: 'cancel' } : { kind: 'start', goal: input.text }; } },
    executor: { async execute({ signal }: TaskExecution) { await new Promise<void>(resolve => { signal.addEventListener('abort', () => resolve(), { once: true }); }); return { text: 'partial work retained', verified: false, partial: true }; } } });
  try {
    const first = await host.submit({ conversationId: 'c', actorId: 'a', text: 'first', inputId: '1' });
    const second = await host.submit({ conversationId: 'c', actorId: 'a', text: 'second', inputId: '2' });
    assert.match((await host.submit({ conversationId: 'c', actorId: 'a', text: 'stop', inputId: '3' })).text, /明确/);
    const stopping = await host.submit({ conversationId: 'c', actorId: 'a', text: 'stop', inputId: '4', replyTaskId: first.taskId });
    assert.match(stopping.text, /正在停止/);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(host.getTask(first.taskId!)?.status, 'cancelled');
    assert.equal(host.getTask(second.taskId!)?.status, 'running');
  } finally { await host.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('executor cancellation is requested before execution returns, and unknown stop holds conflicting work', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'personal-host-'));
  let release!: () => void; const barrier = new Promise<void>(resolve => { release = resolve; });
  let cancelObserved = false;
  const host: PersonalHost = new PersonalHost({ store: new PersonalStore(directory),
    dialogue: { async decide(input) { return input.text === 'stop' ? { kind: 'cancel' } : { kind: 'start', goal: input.text, cwd: directory }; } },
    executor: { async execute(request) { request.onIdentity({ kind: 'external', id: 'worker' }); await barrier; return { text: 'unchecked', verified: false }; },
      async cancel() { cancelObserved = true; return false; } } });
  try {
    const first = await host.submit({ conversationId: 'c', actorId: 'a', inputId: '1', text: 'first' });
    await host.submit({ conversationId: 'c', actorId: 'a', inputId: '2', text: 'stop', replyTaskId: first.taskId });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(cancelObserved, true, 'stop reaches external executor while original execution is blocked');
    release(); await host.waitForIdle();
    const next = await host.submit({ conversationId: 'c', actorId: 'a', inputId: '3', text: 'next' });
    assert.equal(host.getTask(first.taskId!)?.status, 'waiting');
    assert.equal(host.getTask(next.taskId!)?.status, 'queued');
  } finally { release(); await host.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('received steering cannot turn stale work into verified completion', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'personal-host-'));
  let release!: () => void; const barrier = new Promise<void>(resolve => { release = resolve; });
  const host = new PersonalHost({ store: new PersonalStore(directory), dialogue: { async decide(input) { return input.text === 'change' ? { kind: 'steer', text: 'include appendix' } : { kind: 'start', goal: 'report' }; } },
    executor: { async execute() { await barrier; return { text: 'old report', verified: true }; }, async steer() { return false; } } });
  try {
    const first = await host.submit({ conversationId: 'c', actorId: 'a', inputId: '1', text: 'report' });
    const response = await host.submit({ conversationId: 'c', actorId: 'a', inputId: '2', text: 'change', replyTaskId: first.taskId });
    assert.match(response.text, /尚未确认/); release(); await host.waitForIdle();
    assert.equal(host.getTask(first.taskId!)?.status, 'partial');
    assert.equal(host.getTask(first.taskId!)?.result?.verified, false);
    assert.equal(host.getTask(first.taskId!)?.result?.producedRevision, 0);
    assert.equal(host.store.listAttempts(first.taskId!).at(-1)?.startedRevision, 0);
    assert.equal(host.store.listAttempts(first.taskId!).at(-1)?.presentedRevision, 0);
  } finally { release(); await host.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('applied requirements remain distinct from attempt start and produce the matching result revision', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'personal-version-'));
  let release!: () => void; const barrier = new Promise<void>(resolve => { release = resolve; });
  let execution!: TaskExecution;
  const host = new PersonalHost({ store: new PersonalStore(directory),
    dialogue: { async decide(input) { return input.text === 'change' ? { kind: 'steer', text: 'add sources' } : { kind: 'start', goal: 'research' }; } },
    executor: { async execute(request) { execution = request; await barrier; request.onRequirementApplied?.(1); request.onRequirementApplied?.(0); request.onRequirementApplied?.(9); return { text: 'research with sources', verified: true }; }, async steer() { return true; } } });
  try {
    const response = await host.submit({ conversationId: 'c', actorId: 'a', inputId: 'start', text: 'research' });
    await host.submit({ conversationId: 'c', actorId: 'a', inputId: 'change', text: 'change', replyTaskId: response.taskId });
    release(); await host.waitForIdle();
    assert.equal(execution.attempt.startedRevision, 0);
    assert.equal(host.store.listAttempts(response.taskId!).at(-1)?.presentedRevision, 1);
    assert.equal(host.getTask(response.taskId!)?.result?.producedRevision, 1);
    assert.equal(host.getTask(response.taskId!)?.status, 'completed');
  } finally { release(); await host.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('external action approval is bound to owner, exact parameters, and current requirements', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'personal-host-'));
  let actionAllowed = false;
  let release!: () => void; const barrier = new Promise<void>(resolve => { release = resolve; });
  const action = { kind: 'publish', target: 'release', parameters: { version: '1' }, content: 'Prepared release' };
  const host: PersonalHost = new PersonalHost({ store: new PersonalStore(directory),
    dialogue: { async decide(input): Promise<Decision> {
      if (input.text === 'approve') return { kind: 'authorize', actionId: host.store.listActions()[0]!.id, approved: true };
      if (input.text === 'change') return { kind: 'steer', text: 'publish version 2 instead' };
      return { kind: 'start', goal: 'release' };
    } }, executor: { async execute(request) { actionAllowed = await request.requestAction!(action); await barrier; return { text: 'waiting approval', verified: false }; } } });
  try {
    const task = await host.submit({ conversationId: 'c', actorId: 'a', inputId: '1', text: 'release' });
    await new Promise(resolve => setImmediate(resolve)); assert.equal(actionAllowed, false);
    const denied = await host.submit({ conversationId: 'c', actorId: 'other', inputId: '2', text: 'approve' });
    assert.match(denied.text, /失效/);
    await host.submit({ conversationId: 'c', actorId: 'a', inputId: '3', text: 'approve' });
    assert.equal(await host.requestAction(task.taskId!, action), true);
    assert.equal(await host.requestAction(task.taskId!, action), false, 'dispatch claim cannot authorize a repeated commitment');
    assert.equal(await host.requestAction(task.taskId!, { ...action, parameters: { version: '2' } }), false);
    await host.submit({ conversationId: 'c', actorId: 'a', inputId: '4', text: 'change', replyTaskId: task.taskId });
    assert.equal(await host.requestAction(task.taskId!, action), false);
  } finally { release(); await host.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('restart preserves result and session identity and rejects a competing Host', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'personal-host-'));
  const sessions: string[] = [];
  const dialogue = { async decide(_input: unknown, context: { sessionId: string }): Promise<Decision> { sessions.push(context.sessionId); return { kind: 'start', goal: 'report' }; } };
  const executor = { async execute() { return { text: 'checked report', verified: true }; } };
  let host = new PersonalHost({ store: new PersonalStore(directory), dialogue, executor });
  try {
    assert.throws(() => new PersonalStore(directory), /另一个 Host/);
    const response = await host.submit({ conversationId: 'c', actorId: 'a', inputId: '1', text: 'report' });
    await host.waitForIdle(); const session = host.getTask(response.taskId!)!.sessionId;
    await host.close(); host = new PersonalHost({ store: new PersonalStore(directory), dialogue, executor });
    assert.equal(host.getTask(response.taskId!)?.result?.text, 'checked report');
    assert.equal(host.getTask(response.taskId!)?.sessionId, session);
    await host.submit({ conversationId: 'c', actorId: 'a', inputId: '2', text: 'report' }); await host.waitForIdle();
    assert.equal(sessions[0], sessions[1]);
  } finally { await host.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('use budget exhaustion preserves partial output and waits rather than claiming cancellation', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'personal-host-'));
  const host = new PersonalHost({ store: new PersonalStore(directory), maxTokens: 10,
    dialogue: { async decide() { return { kind: 'start', goal: 'report' }; } },
    executor: { async execute(request) { request.onUsage({ input: 11, costKnown: false }); return { text: 'partial report', verified: false, partial: true }; } } });
  try {
    const response = await host.submit({ conversationId: 'c', actorId: 'a', inputId: '1', text: 'report' });
    await host.waitForIdle(); assert.equal(host.getTask(response.taskId!)?.status, 'waiting');
    assert.equal(host.getTask(response.taskId!)?.result?.text, 'partial report');
  } finally { await host.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('after process death Host reattaches live executor without starting its task again', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'personal-host-crash-'));
  const base = fileURLToPath(new URL('../src/personal/', import.meta.url));
  const script = `import {PersonalStore} from ${JSON.stringify(pathToFileURL(join(base, 'store.ts')).href)};
    import {PersonalHost} from ${JSON.stringify(pathToFileURL(join(base, 'host.ts')).href)};
    const host=new PersonalHost({store:new PersonalStore(${JSON.stringify(directory)}),
      dialogue:{async decide(){return {kind:'start',goal:'remote report',cwd:${JSON.stringify(directory)}}}},
      executor:{async execute(r){r.onIdentity({kind:'external',id:'surviving-worker'});console.log('READY');await new Promise(()=>{});}}});
    setInterval(()=>{},1000);await host.submit({conversationId:'c',actorId:'a',inputId:'1',text:'report'});`;
  const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', script], { stdio: ['ignore', 'pipe', 'pipe'] });
  let output = ''; let errors = ''; child.stderr.on('data', chunk => { errors += String(chunk); });
  try {
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('child did not start: ' + errors)), 10_000);
      child.stdout.on('data', chunk => { output += String(chunk); if (output.includes('READY')) { clearTimeout(timeout); resolve(); } });
      child.once('exit', code => { clearTimeout(timeout); reject(new Error('early child exit ' + code + errors)); });
    });
    const exited = new Promise<void>(resolve => child.once('exit', () => resolve())); child.kill('SIGKILL'); await exited;
    let starts = 0;
    const host = new PersonalHost({ store: new PersonalStore(directory), dialogue: { async decide() { return { kind: 'start', goal: 'conflicting task', cwd: directory }; } },
      executor: { async execute() { starts++; return { text: 'unexpected duplicate', verified: true }; }, async inspect() { return { state: 'running' }; } } });
    try {
      const task = host.listTasks('c')[0]!; await host.recover();
      assert.equal(host.getTask(task.id)?.status, 'running');
      const queued = await host.submit({ conversationId: 'c', actorId: 'a', inputId: '2', text: 'another report' });
      assert.equal(host.getTask(queued.taskId!)?.status, 'queued'); assert.equal(starts, 0);
    } finally { await host.close(); }
  } finally { if (child.exitCode === null) child.kill('SIGKILL'); rmSync(directory, { recursive: true, force: true }); }
});

test('cancel an uncertain waiting executor checks actual stop before releasing its directory', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'personal-cancel-waiting-'));
  let stops = 0;
  const host = new PersonalHost({ store: new PersonalStore(directory),
    dialogue: { async decide(input) { return input.text === 'stop' ? { kind: 'cancel' } : { kind: 'start', goal: input.text, cwd: directory }; } },
    executor: { async execute(request) { request.onIdentity({ kind: 'external' }); const error = new Error('unknown outcome'); error.name = 'ExecutorAttentionError'; throw error; }, async cancel() { stops++; return false; } } });
  try {
    const task = await host.submit({ conversationId: 'c', actorId: 'a', inputId: '1', text: 'work' }); await host.waitForIdle();
    await host.submit({ conversationId: 'c', actorId: 'a', inputId: '2', text: 'stop', replyTaskId: task.taskId });
    await new Promise(resolve => setImmediate(resolve));
    assert.ok(stops > 0); assert.equal(host.getTask(task.taskId!)?.status, 'waiting');
    const next = await host.submit({ conversationId: 'c', actorId: 'a', inputId: '3', text: 'next' }); assert.equal(host.getTask(next.taskId!)?.status, 'queued');
  } finally { await host.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('safe local retry preserves task identity and ends at persisted attempt limit', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'personal-retry-limit-'));
  let executions = 0;
  const host = new PersonalHost({ store: new PersonalStore(directory), maxAttempts: 2,
    dialogue: { async decide() { return { kind: 'start', goal: 'report' }; } },
    executor: { async execute(request) { executions++; request.onIdentity({ kind: 'safe-local' }); throw new Error('temporary model failure'); }, async inspect() { return { state: 'resumable' }; } } });
  try {
    const task = await host.submit({ conversationId: 'c', actorId: 'a', inputId: '1', text: 'report' }); await host.waitForIdle();
    assert.equal(executions, 2); assert.equal(host.getTask(task.taskId!)?.status, 'waiting');
    await host.recover(); await host.waitForIdle(); assert.equal(executions, 2);
  } finally { await host.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('directory aliases share one reservation and shutdown does not cancel a surviving executor', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'personal-resource-alias-')); const real = join(directory, 'real'); const alias = join(directory, 'alias');
  mkdirSync(real); symlinkSync(real, alias, process.platform === 'win32' ? 'junction' : 'dir');
  let cancellations = 0;
  const host = new PersonalHost({ store: new PersonalStore(directory),
    dialogue: { async decide(input) { return { kind: 'start', goal: input.text, cwd: input.text === 'one' ? real : alias }; } },
    executor: { async execute(request) { request.onIdentity({ kind: 'herdr', worker: 'one' }); await new Promise<void>(resolve => request.signal.addEventListener('abort', () => resolve(), { once: true })); return { text: 'detached', verified: false }; }, async cancel() { cancellations++; return false; } } });
  try {
    const one = await host.submit({ conversationId: 'c', actorId: 'a', inputId: '1', text: 'one' });
    const two = await host.submit({ conversationId: 'c', actorId: 'a', inputId: '2', text: 'two' });
    assert.equal(host.getTask(two.taskId!)?.status, 'queued');
    await host.close(); assert.equal(cancellations, 0);
    const reopened = new PersonalStore(directory);
    try { assert.equal(reopened.getTask(one.taskId!)?.status, 'running'); assert.equal(reopened.getTask(two.taskId!)?.status, 'queued'); } finally { reopened.close(); }
  } finally { await host.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('recovery resolves an uncertain waiting result and releases its directory without repeating execution', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'personal-waiting-reconcile-'));
  let executions = 0;
  const host = new PersonalHost({ store: new PersonalStore(directory),
    dialogue: { async decide(input) { return { kind: 'start', goal: input.text, cwd: directory }; } },
    executor: { async execute(request) { executions++; if (request.task.goal === 'first') { request.onIdentity({ kind: 'external' }); const error = new Error('outcome unknown'); error.name = 'ExecutorAttentionError'; throw error; } return { text: 'second complete', verified: true }; }, async inspect() { return { state: 'completed', result: { text: 'first checked after recovery', verified: true } }; } } });
  try {
    const first = await host.submit({ conversationId: 'c', actorId: 'a', inputId: '1', text: 'first' }); await host.waitForIdle();
    const second = await host.submit({ conversationId: 'c', actorId: 'a', inputId: '2', text: 'second' }); assert.equal(host.getTask(second.taskId!)?.status, 'queued');
    await host.recover(); await host.waitForIdle();
    assert.equal(executions, 2); assert.equal(host.getTask(first.taskId!)?.status, 'completed'); assert.equal(host.getTask(second.taskId!)?.status, 'completed');
    assert.equal(host.getTask(first.taskId!)?.result?.producedRevision, 0);
  } finally { await host.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('accepted input survives dialogue failure and restart without repeating a completed task', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'personal-inbox-'));
  let host = new PersonalHost({ store: new PersonalStore(directory), dialogue: { async decide() { throw new Error('provider unavailable'); } }, executor: { async execute() { return { text: 'unexpected', verified: true }; } } });
  try {
    const input = { conversationId: 'c', actorId: 'a', inputId: '1', text: 'retained goal' };
    await assert.rejects(host.submit(input), /provider unavailable/); await host.close();
    let executions = 0;
    host = new PersonalHost({ store: new PersonalStore(directory), dialogue: { async decide(message) { return { kind: 'start', goal: message.text }; } }, executor: { async execute() { executions++; return { text: 'goal finished', verified: true }; } } });
    await host.recover(); await host.waitForIdle();
    assert.equal(host.listTasks('c')[0]?.goal, 'retained goal'); assert.equal(host.listTasks('c')[0]?.status, 'completed');
    await host.submit(input); await host.waitForIdle(); assert.equal(executions, 1);
  } finally { await host.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('forgotten conversation task details cannot reenter model context while other conversations stay usable', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'personal-scope-forget-'));
  let taskGoals: string[] = [];
  const host = new PersonalHost({ store: new PersonalStore(directory), dialogue: { async decide(input, context) { taskGoals = context.tasks.map(t => t.goal); return input.text === 'query' ? { kind: 'reply', text: 'context checked' } : { kind: 'start', goal: input.text }; } }, executor: { async execute() { return { text: 'secret result', verified: true }; } } });
  try {
    await host.submit({ conversationId: 'a', actorId: 'owner', inputId: '1', text: 'private goal' });
    await host.submit({ conversationId: 'b', actorId: 'owner', inputId: '2', text: 'other goal' }); await host.waitForIdle();
    await host.excludeConversationContext('a');
    await host.submit({ conversationId: 'a', actorId: 'owner', inputId: '3', text: 'query' }); assert.deepEqual(taskGoals, []);
    await host.submit({ conversationId: 'b', actorId: 'owner', inputId: '4', text: 'query' }); assert.deepEqual(taskGoals, ['other goal']);
  } finally { await host.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('sibling directories of one Git checkout serialize while another checkout proceeds', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'personal-project-lock-'));
  const checkout = join(directory, 'project'); const other = join(directory, 'other');
  for (const path of [join(checkout, '.git'), join(checkout, 'src'), join(checkout, 'test'), join(other, '.git')]) mkdirSync(path, { recursive: true });
  let release!: () => void; const barrier = new Promise<void>(resolve => { release = resolve; }); const entered: string[] = [];
  const host = new PersonalHost({ store: new PersonalStore(join(directory, 'data')),
    dialogue: { async decide(input) { return { kind: 'start', goal: input.text, cwd: input.text === 'src' ? join(checkout, 'src') : input.text === 'test' ? join(checkout, 'test') : other }; } },
    executor: { async execute({ task }) { entered.push(task.goal); if (task.goal === 'src') await barrier; return { text: 'checked', verified: true }; } } });
  try {
    await host.submit({ conversationId: 'c', actorId: 'a', inputId: '1', text: 'src' });
    const sibling = await host.submit({ conversationId: 'c', actorId: 'a', inputId: '2', text: 'test' });
    await host.submit({ conversationId: 'c', actorId: 'a', inputId: '3', text: 'other' });
    assert.deepEqual(entered, ['src', 'other']); assert.equal(host.getTask(sibling.taskId!)?.status, 'queued');
    release(); await host.waitForIdle(); assert.deepEqual(entered, ['src', 'other', 'test']);
  } finally { release(); await host.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('generated task workspaces stay independent when Host data lives inside its own Git checkout', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'personal-default-workspaces-')); mkdirSync(join(directory, '.git'));
  let release!: () => void; const barrier = new Promise<void>(resolve => { release = resolve; }); const entered: string[] = [];
  const host = new PersonalHost({ store: new PersonalStore(join(directory, 'data')),
    dialogue: { async decide(input) { return { kind: 'start', goal: input.text }; } },
    executor: { async execute({ task }) { entered.push(task.goal); await barrier; return { text: 'checked', verified: true }; } } });
  try {
    await host.submit({ conversationId: 'c', actorId: 'a', inputId: '1', text: 'first' });
    await host.submit({ conversationId: 'c', actorId: 'a', inputId: '2', text: 'second' });
    assert.deepEqual(entered, ['first', 'second']);
  } finally { release(); await host.close(); rmSync(directory, { recursive: true, force: true }); }
});
