import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PersonalHost } from '../src/personal/host.js';
import { PersonalStore } from '../src/personal/store.js';
import { createPersonalRuntime } from '../src/personal/runtime.js';
import { createTestServer } from './fixtures/http-server.js';
import { sendChatCompletion, sendMainContinuation } from './fixtures/chat-completion.js';
import { readFileSync, writeFileSync, readdirSync, mkdirSync } from 'node:fs';
import { inspectMaterial, operationMaterials } from '../src/personal/acceptance.js';
import { createWorkTools } from '../src/personal/permissions.js';
import { VerificationChecks } from '../src/personal/verification.js';

test('typed material acceptance rejects invented research and verifies actual controlled file moves', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'personal-material-types-')); const store = new PersonalStore(directory);
  const host = new PersonalHost({ store, dialogue: { async decide() { return { kind: 'reply', text: 'unused' }; } }, executor: { async execute() { return { text: 'unused', verified: false }; } } });
  try {
    const work = host.workContext({ conversationId: 'c', actorId: 'a', inputId: 'source', text: 'research' }); const task = work.current(); task.cwd = directory; task.permission!.readRoots = task.permission!.writeRoots = [directory]; task.purpose = 'research'; store.putTask(task); writeFileSync(join(directory, 'original.txt'), 'Observed original evidence.');
    assert.equal((await inspectMaterial(task, { text: 'Unsupported conclusion', verified: true, artifacts: ['original.txt'] }, join(directory, 'data'))).verified, false);
    const research = { text: 'Supported conclusion', verified: true, sources: [{ reference: 'original.txt', excerpt: 'Observed original evidence.', supports: ['The original describes observed evidence.'] }], uncertainties: 'No remote corroboration.' };
    assert.equal((await inspectMaterial(task, research, join(directory, 'data'))).verified, true);
    assert.equal((await inspectMaterial(task, { ...research, sources: [{ ...research.sources[0]!, excerpt: 'Invented evidence.' }] }, join(directory, 'data'))).verified, false);
    const generic = { ...task, purpose: undefined };
    const forged = await inspectMaterial(generic, { text: 'claim', verified: true, artifacts: ['original.txt'], sources: [{ reference: 'https://example.com', excerpt: 'invented', supports: ['claim'] }] }, join(directory, 'data'));
    assert.equal(forged.verified, false); assert.equal(forged.partial, true);
    assert.ok(forged.invalidMaterials?.length, 'declared invalid source must remain visible');
    task.purpose = 'organization'; store.putTask(task);
    assert.equal((await inspectMaterial(task, { text: 'organized', verified: true, artifacts: ['original.txt'] }, join(directory, 'data'))).verified, false);
    const move = createWorkTools(() => work, { dataDir: join(directory, 'data') }).find(tool => tool.name === 'file_operation')!;
    await move.execute('actual-move', { operation: 'move', path: 'original.txt', destination: 'organized.txt' }, undefined, undefined, undefined as never);
    const operations = operationMaterials(work.materialActions!()); const organized = { text: 'one original moved, one destination present', verified: true, artifacts: ['organized.txt'], operations };
    assert.equal((await inspectMaterial(task, organized, join(directory, 'data'))).verified, true); assert.equal(operations[0]?.before.length, 2);
    writeFileSync(join(directory, 'organized.txt'), 'Changed after receipt.'); assert.equal((await inspectMaterial(task, organized, join(directory, 'data'))).verified, false);
  } finally { await host.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('unknown work dispatch blocks a new callId and foreign permission proposals', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'personal-unknown-work-')); const store = new PersonalStore(directory); const host = new PersonalHost({ store, dialogue: { async decide() { return { kind: 'reply', text: 'unused' }; } }, executor: { async execute() { return { text: 'unused', verified: false }; } } });
  try { const work = host.workContext({ conversationId: 'c', actorId: 'a', inputId: 'one', text: 'one' }); let dispatched = 0;
    await assert.rejects(work.dispatch('first', { kind: 'write', target: work.task.cwd!, parameters: {}, content: 'write' }, async () => { dispatched++; throw new Error('lost effect acknowledgement'); }));
    await assert.rejects(work.dispatch('new-id', { kind: 'write', target: work.task.cwd!, parameters: {}, content: 'write' }, async () => { dispatched++; return 'repeat'; }), /未核实/); assert.equal(dispatched, 1);
    const foreign = host.workContext({ conversationId: 'other', actorId: 'other', inputId: 'foreign', text: 'foreign' }, work.task.id);
    assert.throws(() => foreign.proposePermission({ mode: 'trusted', readRoots: [directory], writeRoots: [directory], network: true, expiresAt: Date.now() + 10000 }), /身份/); assert.equal(store.listActions().length, 0);
  } finally { await host.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('production research keeps a denied file action partial even after submitting valid source evidence', { timeout: 15000 }, async t => {
  const directory = mkdtempSync(join(tmpdir(), 'personal-research-denial-')); const promptFile = join(directory, 'prompt.md'); writeFileSync(promptFile, 'Help.'); let denied = 0;
  const server = createTestServer(t, async (req, res) => { let body = ''; for await (const chunk of req) body += chunk; const wire = JSON.parse(body); if (sendMainContinuation(res, wire)) return; const last = wire.messages.at(-1); const main = wire.tools.some((tool: { function: { name: string } }) => tool.function.name === 'task_control'); const call = (name: string, args: unknown) => sendChatCompletion(res, '', [{ index: 0, id: name, type: 'function', function: { name, arguments: JSON.stringify(args) } }]);
    if (main) { if (last.role !== 'tool') return call('delegate_work', { goal: 'inspect the source', purpose: 'research' }); return sendChatCompletion(res, 'entrusted'); }
    if (last.role !== 'tool') return call('write', { path: 'source.txt', content: 'Actual local source.' }); if (last.tool_call_id === 'fixture_submit_material') return call('read', { path: '../escape.txt' }); if (last.tool_call_id === 'read') { assert.match(last.content, /授权目录/); denied++; } return sendChatCompletion(res, 'Source evidence exists but file access was denied.');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); const address = server.address(); assert.ok(address && typeof address !== 'string'); const runtime = await createPersonalRuntime({ AGENT_DATA_DIR: join(directory, 'data'), AGENT_PROMPT_FILE: promptFile, MODEL_NAMES: 'test', MODEL_DEFAULT: 'test', MODEL_TEST_API_KEY: 'test', MODEL_TEST_API: 'openai-completions', MODEL_TEST_MODEL: 'test', MODEL_TEST_BASE_URL: `http://127.0.0.1:${address.port}` });
  try { await runtime.host.submit({ conversationId: 'c', actorId: 'a', inputId: 'real', text: 'research source' }); await runtime.host.waitForIdle(); const child = runtime.host.listTasks().find(task => task.workKind === 'delegation')!; assert.equal(denied, 1); assert.ok(child.result?.sources?.length); assert.equal(child.result?.partial, true); assert.equal(child.result?.verified, false); assert.equal(runtime.host.listTasks().find(task => task.direct)?.status, 'waiting');
  } finally { await runtime.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); rmSync(directory, { recursive: true, force: true }); }
});

test('production direct completion repairs a fsynced verdict after Host transaction loss without another model turn', { timeout: 15000 }, async t => {
  const directory = mkdtempSync(join(tmpdir(), 'personal-direct-complete-')); const promptFile = join(directory, 'prompt.md'); writeFileSync(promptFile, 'Help.'); let calls = 0;
  const server = createTestServer(t, async (req, res) => { let body = ''; for await (const chunk of req) body += chunk; const wire = JSON.parse(body); const last = wire.messages.at(-1); calls++;
    const call = (name: string, args: unknown) => sendChatCompletion(res, '', [{ index: 0, id: name, type: 'function', function: { name, arguments: JSON.stringify(args) } }]);
    if (last.role !== 'tool') return call('write', { path: 'direct.txt', content: 'direct final work' }); if (last.tool_call_id === 'write') return call('complete_work', { outcome: 'completed', reviewedRevision: 0, text: 'direct complete', artifacts: ['direct.txt'] }); return sendChatCompletion(res, 'direct complete');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); const address = server.address(); assert.ok(address && typeof address !== 'string');
  const runtime = await createPersonalRuntime({ AGENT_DATA_DIR: join(directory, 'data'), AGENT_PROMPT_FILE: promptFile, MODEL_NAMES: 'test', MODEL_DEFAULT: 'test', MODEL_TEST_API_KEY: 'test', MODEL_TEST_API: 'openai-completions', MODEL_TEST_MODEL: 'test', MODEL_TEST_BASE_URL: `http://127.0.0.1:${address.port}` });
  try { const original = runtime.host.store.enqueueWorkEvent.bind(runtime.host.store); let crash = true; runtime.host.store.enqueueWorkEvent = event => { if (event.kind === 'direct_completion' && crash) { crash = false; throw new Error('crash before Host enqueue'); } return original(event); };
    await assert.rejects(runtime.host.submit({ conversationId: 'c', actorId: 'a', inputId: 'real-input', text: 'write direct file' }), /crash/); const before = calls;
    await runtime.host.recover(); await runtime.host.waitForIdle(); assert.equal(calls, before); assert.equal(runtime.host.listTasks()[0]?.status, 'completed'); assert.equal(runtime.host.store.listWorkEvents()[0]?.kind, 'direct_completion'); assert.equal(runtime.host.store.listDeliveries().filter(delivery => delivery.text === 'direct complete').length, 1); assert.equal(runtime.host.store.listDeliveries().find(delivery => delivery.text === 'direct complete')?.learning?.originInputId, 'real-input');
  } finally { await runtime.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); rmSync(directory, { recursive: true, force: true }); }
});

for (const backendMatch of [true, false]) test(`production coding helper ${backendMatch ? 'preserves actual checks' : 'refuses a check backend for another scope'}`, { timeout: 15000 }, async t => {
  const directory = mkdtempSync(join(tmpdir(), 'personal-coding-resume-')); const promptFile = join(directory, 'prompt.md'); writeFileSync(promptFile, 'Help.'); let cwd = ''; let name = ''; let prompted = false; let created = 0; let checks = 0;
  const server = createTestServer(t, async (req, res) => { let body = ''; for await (const chunk of req) body += chunk; const wire = JSON.parse(body); if (sendMainContinuation(res, wire)) return; const last = wire.messages.at(-1); const names = wire.tools.map((tool: { function: { name: string } }) => tool.function.name);
    const call = (tool: string, args: unknown) => sendChatCompletion(res, '', [{ index: 0, id: tool, type: 'function', function: { name: tool, arguments: JSON.stringify(args) } }]);
    if (names.includes('verify_result')) { if (last.role !== 'tool') return call('read', { path: 'answer.cjs' }); if (last.tool_call_id === 'read') return call('verify_result', { verified: true, text: 'Actual module and node assertion passed.', artifacts: ['answer.cjs'], checksRequired: true }); return sendChatCompletion(res, 'verified actual code'); }
    if (last.role !== 'tool') return call('delegate_work', { goal: 'Create answer.cjs exporting 42 and run the configured assertion', purpose: 'coding' }); return sendChatCompletion(res, 'coding helper entrusted');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); const address = server.address(); assert.ok(address && typeof address !== 'string');
  const runtime = await createPersonalRuntime({ AGENT_DATA_DIR: join(directory, 'data'), AGENT_PROMPT_FILE: promptFile, MODEL_NAMES: 'test', MODEL_DEFAULT: 'test', MODEL_TEST_API_KEY: 'test', MODEL_TEST_API: 'openai-completions', MODEL_TEST_MODEL: 'test', MODEL_TEST_BASE_URL: `http://127.0.0.1:${address.port}`, AGENT_HERDR_SESSION: 'fixture-only', AGENT_VERIFICATION_CHECKS: JSON.stringify([{ command: process.execPath, args: ['-e', 'require("node:assert/strict").equal(require("./answer.cjs"),42)'] }]) }, {
    herdr: { pollMs: 1, executionPolicy: { verified: true, identity: 'controlled-fixture-v1', supports: async () => true, readIsolation: true, writeIsolation: true, networkIsolation: true, processTreeStop: true, args: ['--fixture-policy'] }, cli: async args => {
      if (args[1] === 'create') { created++; cwd = args[args.indexOf('--cwd') + 1]!; mkdirSync(cwd, { recursive: true }); return { result: { workspace: { workspace_id: 'fixture-w' }, root_pane: { pane_id: 'fixture-w:p' } } }; }
      if (args[1] === 'start') name = args[2]!; if (args[1] === 'prompt') { prompted = true; writeFileSync(join(cwd, 'answer.cjs'), 'module.exports=42;'); }
      if (args[1] === 'read') return { result: { text: 'Actual answer.cjs produced.' } };
      return { result: { agent: { pane_id: 'fixture-w:p', workspace_id: 'fixture-w', name, agent: 'codex', agent_status: args[1] === 'prompt' && prompted ? 'working' : 'idle', cwd } } };
    } }, verificationBackend: { verified: true, identity: 'controlled-fixture-v1', capabilities: { readIsolation: true, writeIsolation: true, networkIsolation: true, processTreeStop: true }, supports: async () => ({ supported: backendMatch, reasons: backendMatch ? [] : ['different scope'] }), async runCommand(task, command, context) { checks++; return (await new VerificationChecks([command], { preauthorized: true }).run(task, context))[0]!; } },
  });
  try { await runtime.host.submit({ conversationId: 'c', actorId: 'a', inputId: 'real-coding', text: 'Make the tested module' }); await runtime.host.waitForIdle(); const root = runtime.host.listTasks().find(task => task.direct)!; const child = runtime.host.listTasks().find(task => task.workKind === 'delegation')!;
    if (!backendMatch) { assert.equal(checks, 0); assert.notEqual(root.status, 'completed'); assert.notEqual(child.status, 'completed'); assert.equal(runtime.host.store.listActionDispatches().some(action => action.action.kind === 'verification-command'), false); return; }
    assert.equal(root.status, 'completed', JSON.stringify(runtime.host.listTasks())); assert.equal(child.status, 'completed'); assert.equal(created, 1); assert.equal(checks, 1); assert.equal(runtime.host.store.listAttempts(child.id)[0]?.identity?.workspaceId, 'fixture-w'); assert.equal(root.result?.checks?.[0]?.taskId, child.id); assert.equal(root.result?.checks?.[0]?.revision, child.revision); assert.equal(root.result?.checks?.[0]?.parentRevision, root.revision); assert.equal(runtime.host.store.listDeliveries().some(delivery => delivery.taskId === child.id), false); assert.equal(readFileSync(root.result!.artifacts![0]!, 'utf8'), 'module.exports=42;'); assert.equal(runtime.host.store.getBudget(`root:${root.id}`)?.costKnown, false);
  } finally { await runtime.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); rmSync(directory, { recursive: true, force: true }); }
});

test('helper result returns to main work before overall completion and never becomes a user delivery', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'personal-orchestration-'));
  const store = new PersonalStore(directory); const seen: string[] = [];
  const host = new PersonalHost({ store, maxConcurrent: 1,
    dialogue: { async decide() { return { kind: 'start', goal: 'research then synthesize' }; },
      async resume(event, context) {
        seen.push(event.result!.text); assert.equal(context.work().current().status, 'waiting');
        context.onInjection({ sessionId: context.sessionId, entryId: 'material', at: 2 });
        return { outcome: 'completed', reviewedRevision: context.task.revision,
          result: { text: 'synthesis reviewed by main', verified: true }, completion: { sessionId: context.sessionId, entryId: 'main-completion', at: 3 } };
      } }, executor: { async execute(request) { assert.equal(request.task.workKind, 'delegation'); return { text: 'helper research material', verified: true }; } } });
  try {
    const response = await host.submit({ conversationId: 'c', actorId: 'a', inputId: 'actual-user', text: 'research then synthesize' });
    await host.waitForIdle();
    assert.deepEqual(seen, ['helper research material']);
    assert.equal(host.getTask(response.taskId!)?.result?.text, 'synthesis reviewed by main');
    const child = host.listTasks().find(task => task.workKind === 'delegation')!;
    assert.equal(child.parentTaskId, response.taskId); assert.equal(child.rootTaskId, response.taskId);
    assert.equal(store.listDeliveries().some(delivery => delivery.taskId === child.id), false);
    assert.equal(store.listDeliveries().filter(delivery => delivery.text.includes('synthesis reviewed')).length, 1);
    assert.equal(store.pendingInputs().length, 0); assert.equal(store.listWorkEvents()[0]?.state, 'consumed');
  } finally { await host.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('queued real user input runs before background material without opening the main Session concurrently', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'personal-input-priority-')); const store = new PersonalStore(directory);
  let finishChild!: () => void; const childBarrier = new Promise<void>(resolve => { finishChild = resolve; });
  let finishChat!: () => void; const chatBarrier = new Promise<void>(resolve => { finishChat = resolve; });
  let enteredChat!: () => void; const chatEntered = new Promise<void>(resolve => { enteredChat = resolve; });
  const order: string[] = []; let open = false;
  const host = new PersonalHost({ store, dialogue: { async decide(input) {
    assert.equal(open, false); open = true; try { if (input.text === 'start') return { kind: 'start', goal: 'goal' }; order.push(input.text); if (input.text === 'chat') { enteredChat(); await chatBarrier; } return { kind: 'reply', text: input.text }; } finally { open = false; }
  }, async resume(_event, context) { assert.equal(open, false); order.push('resume'); context.onInjection({ sessionId: context.sessionId, entryId: 'entry', at: 2 }); return { outcome: 'waiting', reviewedRevision: 0, completion: { sessionId: context.sessionId, entryId: 'done', at: 3 } }; } }, executor: { async execute() { await childBarrier; return { text: 'material', verified: true }; } } });
  try {
    const input = (text: string) => ({ conversationId: 'c', actorId: 'a', inputId: text, text });
    await host.submit(input('start')); const chat = host.submit(input('chat')); await chatEntered; const user = host.submit(input('new-user'));
    finishChild(); await new Promise(resolve => setImmediate(resolve)); finishChat(); await Promise.all([chat, user]); await host.waitForIdle();
    assert.deepEqual(order, ['chat', 'new-user', 'resume']);
  } finally { finishChild(); finishChat(); await host.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('unknown action after injection pauses recovery and retains actual resource occupancy', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'personal-unknown-effect-')); const store = new PersonalStore(directory); let effects = 0;
  const host = new PersonalHost({ store, dialogue: { async decide() { return { kind: 'start', goal: 'goal' }; }, async resume(_event, context) {
    context.onInjection({ sessionId: context.sessionId, entryId: 'injected', at: 2 });
    await context.work().dispatch('external', { kind: 'external', target: 'service', parameters: {}, content: 'send' }, async () => { effects++; throw new Error('lost response after effect'); });
    throw new Error('unreachable');
  }, async inspectContinuation() { return { state: 'injected', injection: { sessionId: store.listTasks().find(task => task.direct)!.sessionId, entryId: 'injected', at: 2 } }; } }, executor: { async execute() { return { text: 'material', verified: true }; } } });
  try {
    const response = await host.submit({ conversationId: 'c', actorId: 'a', inputId: 'user', text: 'goal' }); await host.waitForIdle(); await host.recover(); await host.waitForIdle();
    assert.equal(effects, 1); assert.equal(store.listWorkEvents()[0]?.state, 'unknown'); assert.equal(store.listActionDispatches()[0]?.status, 'unknown'); assert.equal(host.getTask(response.taskId!)?.resourceHeld, true);
  } finally { await host.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('requirements changed during final inspection preserve material without completing the newer root', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'personal-final-revision-')); const store = new PersonalStore(directory);
  const host = new PersonalHost({ store, acceptContinuation: async (task, result) => { const current = store.getTask(task.id)!; current.requirements.push('new requirement'); current.revision++; store.putTask(current); return result; },
    dialogue: { async decide() { return { kind: 'start', goal: 'goal' }; }, async resume(_event, context) { context.onInjection({ sessionId: context.sessionId, entryId: 'injected', at: 2 }); return { outcome: 'completed', reviewedRevision: 0, result: { text: 'old synthesis', verified: true }, completion: { sessionId: context.sessionId, entryId: 'done', at: 3 } }; } }, executor: { async execute() { return { text: 'material', verified: true }; } } });
  try {
    const response = await host.submit({ conversationId: 'c', actorId: 'a', inputId: 'user', text: 'goal' }); await host.waitForIdle();
    assert.equal(host.getTask(response.taskId!)?.status, 'waiting'); assert.equal(host.getTask(response.taskId!)?.result?.verified, false); assert.equal(host.getTask(response.taskId!)?.result?.producedRevision, 0);
    assert.equal(store.listDeliveries().some(delivery => delivery.text === 'old synthesis'), false);
  } finally { await host.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('direct actions serialize granted shared directories across independent conversations', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'personal-shared-resource-')); const store = new PersonalStore(directory);
  const host = new PersonalHost({ store, dialogue: { async decide() { return { kind: 'reply', text: 'ok' }; } }, executor: { async execute() { return { text: 'unused', verified: false }; } } });
  let release!: () => void; const barrier = new Promise<void>(resolve => { release = resolve; });
  try {
    const first = host.workContext({ conversationId: 'a', actorId: 'a', inputId: 'one', text: 'first' });
    const second = host.workContext({ conversationId: 'b', actorId: 'b', inputId: 'two', text: 'second' });
    for (const context of [first, second]) { const task = context.current(); task.resources = [directory]; store.putTask(task); }
    const running = first.dispatch('write', { kind: 'write', target: directory, parameters: {}, content: 'first' }, async () => { await barrier; return 'first result'; });
    await assert.rejects(second.dispatch('write', { kind: 'write', target: directory, parameters: {}, content: 'second' }, async () => 'second result'), /资源/);
    release(); await running;
    assert.equal(await second.dispatch('write', { kind: 'write', target: directory, parameters: {}, content: 'second' }, async () => 'second result'), 'second result');
  } finally { release(); await host.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('overall requirement changes return to main and steer only the selected related helper', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'personal-selective-steer-')); const store = new PersonalStore(directory); let rootId = ''; let selectedId = ''; let siblingId = ''; let release!: () => void; const barrier = new Promise<void>(resolve => { release = resolve; }); let revised!: () => void; const applied = new Promise<void>(resolve => { revised = resolve; }); const steered: string[] = [];
  const host = new PersonalHost({ store, maxConcurrent: 2, dialogue: { async decide(input, context) { if (input.text === 'change') return { kind: 'steer', taskId: rootId, text: 'Only the first topic changes' }; const work = context.work!(); rootId = work.task.id; selectedId = work.delegate!('first', { goal: 'first topic', purpose: 'research', cwd: join(work.task.cwd!, 'first') }).id; siblingId = work.delegate!('second', { goal: 'second topic', purpose: 'research', cwd: join(work.task.cwd!, 'second') }).id; return { kind: 'reply', text: 'entrusted' }; }, async resume(event, context) { context.onInjection({ sessionId: context.sessionId, entryId: `injection:${event.id}`, at: 1 }); if (event.kind === 'requirements_changed') { assert.equal(context.work().current().revision, 1); await context.work().controlChild!('select-first', selectedId, 'steer', 'Only first-topic detail changes'); revised(); } return { outcome: 'waiting', reviewedRevision: context.work().current().revision, completion: { sessionId: context.sessionId, entryId: `completion:${event.id}`, at: 2 } }; } }, executor: { async execute() { await barrier; return { text: 'actual material', verified: false, partial: true }; }, async steer(id) { steered.push(id); return false; } } });
  try { await host.submit({ conversationId: 'c', actorId: 'a', inputId: 'one', text: 'start' }); await new Promise(resolve => setImmediate(resolve)); await host.submit({ conversationId: 'c', actorId: 'a', inputId: 'two', text: 'change' }); await applied; assert.deepEqual(steered, [selectedId]); assert.equal(host.getTask(selectedId)?.revision, 1); assert.equal(host.getTask(siblingId)?.revision, 0); assert.deepEqual(host.getTask(siblingId)?.requirements, []); release(); await host.waitForIdle(); assert.equal(store.listWorkEvents().find(event => event.kind === 'requirements_changed')?.state, 'consumed');
  } finally { release(); await host.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('stopping one helper keeps its unknown occupancy and lets an independent conversation continue', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'personal-stop-one-')); const store = new PersonalStore(directory); let childId = ''; let rootId = ''; let release!: () => void; const barrier = new Promise<void>(resolve => { release = resolve; }); let cancelCalls = 0;
  const host = new PersonalHost({ store, maxConcurrent: 2, dialogue: { async decide(input, context) { const work = context.work!(); if (input.conversationId === 'one') { rootId = work.task.id; childId = work.delegate!('first', { goal: 'first', purpose: 'research' }).id; } else work.delegate!('independent', { goal: 'independent', purpose: 'research' }); return { kind: 'reply', text: 'entrusted' }; }, async resume(event, context) { context.onInjection({ sessionId: context.sessionId, entryId: event.id, at: 1 }); return { outcome: 'waiting', reviewedRevision: context.task.revision, completion: { sessionId: context.sessionId, entryId: `complete:${event.id}`, at: 2 } }; } }, executor: { async execute(request) { request.onIdentity({ kind: 'external', taskId: request.task.id }); if (request.task.conversationId === 'one') await barrier; return { text: request.task.goal, verified: false, partial: true }; }, async cancel() { cancelCalls++; return false; } } });
  try { await host.submit({ conversationId: 'one', actorId: 'a', inputId: 'one', text: 'first' }); await new Promise(resolve => setImmediate(resolve)); await host.cancelWork(childId); await host.submit({ conversationId: 'two', actorId: 'b', inputId: 'two', text: 'independent' }); release(); await host.waitForIdle(); assert.equal(cancelCalls, 1); assert.equal(host.getTask(rootId)?.cancelRequested, undefined); assert.equal(host.getTask(childId)?.status, 'stopping'); assert.equal(host.getTask(childId)?.resourceHeld, true); assert.equal(host.listTasks('two').find(task => task.workKind === 'delegation')?.status, 'partial'); assert.equal(store.listWorkEvents('two')[0]?.state, 'consumed');
  } finally { release(); await host.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('model calls consume persistent root and daily global budgets before dispatch', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'personal-budget-')); let store = new PersonalStore(directory);
  const make = () => new PersonalHost({ store, maxRootCalls: 2, maxGlobalCalls: 3, dialogue: { async decide() { return { kind: 'reply', text: 'ok' }; } }, executor: { async execute() { return { text: 'unused', verified: true }; } } });
  let host = make();
  try {
    const root = host.workContext({ conversationId: 'c', actorId: 'a', inputId: 'real', text: 'goal' }).task;
    host.reserveModelCall(root.id); host.reserveModelCall(root.id); await host.close(); store = new PersonalStore(directory); host = make();
    assert.throws(() => host.reserveModelCall(root.id), /预算/); assert.equal(host.getTask(root.id)?.status, 'waiting');
    assert.throws(() => host.reserveModelCall(root.id), /预算/); assert.equal(store.listDeliveries().filter(delivery => delivery.id.startsWith(`budget-pause:${root.id}:`)).length, 1);
    const other = host.workContext({ conversationId: 'c', actorId: 'a', inputId: 'other', text: 'other goal' }).task;
    host.reserveModelCall(other.id); assert.throws(() => host.reserveModelCall(other.id), /预算/);
    assert.equal(store.getBudget(`root:${root.id}`)?.calls, 2);
  } finally { await host.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('restart repairs Session completion receipt without another model turn or child execution', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'personal-receipt-recovery-')); const store = new PersonalStore(directory);
  let turns = 0; let fail = true;
  const injection = { sessionId: 'main', entryId: 'actual-injection', at: 2 };
  const outcome = { outcome: 'completed' as const, reviewedRevision: 0, result: { text: 'already synthesized', verified: true }, completion: { sessionId: 'main', entryId: 'actual-completion', at: 3 } };
  const host = new PersonalHost({ store, dialogue: { async decide() { return { kind: 'start', goal: 'synthesize' }; },
    async resume(_event, context) { turns++; if (fail) throw new Error('process died after native completion before SQL receipt'); context.onInjection(injection); return outcome; },
    async inspectContinuation() { return { state: 'completed', injection, outcome }; } }, executor: { async execute() { return { text: 'helper result', verified: true }; } } });
  try {
    const response = await host.submit({ conversationId: 'c', actorId: 'a', inputId: 'user', text: 'synthesize' }); await host.waitForIdle(); assert.equal(store.listWorkEvents()[0]?.state, 'unknown');
    fail = false; await host.recover(); await host.waitForIdle();
    assert.equal(turns, 1); assert.equal(host.getTask(response.taskId!)?.status, 'completed'); assert.equal(store.listWorkEvents()[0]?.state, 'consumed');
    await host.recover(); assert.equal(store.listDeliveries().filter(delivery => delivery.text === 'already synthesized').length, 1);
  } finally { await host.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('root cancellation marks all helpers before termination and late results cannot revive stopped work', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'personal-stop-tree-')); const store = new PersonalStore(directory);
  let release!: () => void; const barrier = new Promise<void>(resolve => { release = resolve; }); let rootId = ''; let stopped = 0;
  const host = new PersonalHost({ store, maxConcurrent: 2,
    dialogue: { async decide(input, context) { if (input.text === 'stop') return { kind: 'cancel', taskId: rootId }; const work = context.work!(); rootId = work.task.id; work.delegate!('a', { goal: 'first', purpose: 'research', cwd: join(work.task.cwd!, 'a') }); work.delegate!('b', { goal: 'second', purpose: 'research', cwd: join(work.task.cwd!, 'b') }); return { kind: 'reply', text: 'entrusted' }; },
      async resume() { throw new Error('cancelled material cannot resume'); } },
    executor: { async execute(request) { request.onIdentity({ kind: 'external', taskId: request.task.id }); await barrier; return { text: 'late actual material', verified: true }; }, async cancel() { stopped++; assert.equal(store.listTasks().filter(task => task.workKind === 'delegation' && task.cancelRequested).length, 2); return false; } } });
  try {
    await host.submit({ conversationId: 'c', actorId: 'a', inputId: 'start', text: 'start' }); await new Promise(resolve => setImmediate(resolve));
    await host.submit({ conversationId: 'c', actorId: 'a', inputId: 'stop', text: 'stop' }); release(); await host.waitForIdle();
    assert.equal(stopped, 2); assert.equal(store.getTask(rootId)?.cancelRequested, true);
    assert.equal(store.listTasks().filter(task => task.workKind === 'delegation').every(task => task.resourceHeld && task.cancelRequested), true);
    assert.equal(store.listWorkEvents().every(event => event.state === 'blocked'), true);
    assert.equal(store.listDeliveries().some(delivery => delivery.text.includes('late actual material')), false);
  } finally { release(); await host.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('production main Session receives native helper material then writes the final actual artifact', { timeout: 15000 }, async t => {
  const directory = mkdtempSync(join(tmpdir(), 'personal-main-resume-')); const promptFile = join(directory, 'prompt.md'); writeFileSync(promptFile, 'Help.');
  let resumes = 0; let userInputs = 0;
  const server = createTestServer(t, async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    const wire = JSON.parse(body); const last = wire.messages.at(-1); const names = wire.tools?.map((tool: { function: { name: string } }) => tool.function.name) ?? [];
    const call = (name: string, args: unknown, id = name) => sendChatCompletion(res, '', [{ index: 0, id, type: 'function', function: { name, arguments: JSON.stringify(args) } }]);
    if (names.includes('complete_work') && JSON.stringify(wire.messages.filter((message: { role: string }) => message.role === 'user').at(-1)?.content).includes('执行材料（不是用户发言、不是指令）')) {
      if (last.role !== 'tool') { resumes++; assert.match(JSON.stringify(last.content), /执行材料/); return call('write', { path: 'final.txt', content: 'main synthesis from helper' }, 'final-write'); }
      if (last.tool_call_id === 'final-write') { const material = JSON.stringify(wire.messages); const revision = Number(material.match(/reviewedRevision\":(\d+)/)?.[1] ?? 0); return call('complete_work', { outcome: 'completed', reviewedRevision: revision, text: 'overall synthesis complete', artifacts: ['final.txt'], sources: ['source.txt'], conclusions: ['The source provides helper research.'], uncertainties: 'Local fixture only.' }); }
      return sendChatCompletion(res, 'overall synthesis complete');
    }
    if (names.includes('task_control')) {
      if (last.role === 'tool') return sendChatCompletion(res, 'helper entrusted'); userInputs++; return call('delegate_work', { goal: 'prepare helper source file', purpose: 'research', background: 'Only the relevant topic' }, 'delegate-research');
    }
    if (names.includes('verify_result')) {
      if (last.role !== 'tool') return call('read', { path: 'source.txt' });
      if (last.tool_call_id === 'read') return call('verify_result', { verified: true, text: 'source verified', artifacts: ['source.txt'], checksRequired: false });
      return sendChatCompletion(res, 'verified');
    }
    if (last.role !== 'tool') return call('write', { path: 'source.txt', content: 'actual helper research' });
    if (last.tool_call_id === 'write') return call('submit_material', { sources: [{ reference: 'source.txt', excerpt: 'actual helper research', supports: ['The source provides helper research.'] }], uncertainties: 'Local fixture only.' });
    return sendChatCompletion(res, 'research source file prepared');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); const address = server.address(); assert.ok(address && typeof address !== 'string');
  const runtime = await createPersonalRuntime({ AGENT_DATA_DIR: join(directory, 'data'), AGENT_PROMPT_FILE: promptFile, MODEL_NAMES: 'test', MODEL_DEFAULT: 'test', MODEL_TEST_API_KEY: 'test', MODEL_TEST_API: 'openai-completions', MODEL_TEST_MODEL: 'test', MODEL_TEST_BASE_URL: `http://127.0.0.1:${address.port}`, AGENT_MAX_CONCURRENT: '1' });
  try {
    await runtime.host.submit({ conversationId: 'c', actorId: 'a', inputId: 'true-user', text: 'research and synthesize' }); await runtime.host.waitForIdle();
    const root = runtime.host.listTasks().find(task => task.direct)!; const child = runtime.host.listTasks().find(task => task.workKind === 'delegation')!;
    assert.equal(root.status, 'completed'); assert.equal(readFileSync(join(root.cwd!, 'final.txt'), 'utf8'), 'main synthesis from helper');
    assert.equal(resumes, 1); assert.equal(userInputs, 1); assert.equal(runtime.host.store.listDeliveries().some(delivery => delivery.taskId === child.id), false);
    const files = readdirSync(join(directory, 'data', 'personal-sessions'), { recursive: true }).filter(name => String(name).endsWith('.jsonl'));
    const records = files.flatMap(name => readFileSync(join(directory, 'data', 'personal-sessions', String(name)), 'utf8').trim().split('\n').map(line => JSON.parse(line)));
    assert.equal(records.filter(entry => entry.type === 'custom_message' && entry.customType === 'nailong_work_result').length, 1);
    assert.equal(runtime.host.store.listWorkEvents()[0]?.state, 'consumed'); assert.equal(root.originInput?.inputId, 'true-user');
  } finally { await runtime.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); rmSync(directory, { recursive: true, force: true }); }
});
