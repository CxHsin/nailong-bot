import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { defineTool } from '@mariozechner/pi-coding-agent';
import { Type } from 'typebox';
import { runExperiment, scenarios, skillFile } from '../scripts/experiments/tool-surface/harness.js';
import { experimentInterface, type Variant } from '../scripts/experiments/tool-surface/interface.js';
import { PersonalHost } from '../src/personal/host.js';
import { PersonalStore } from '../src/personal/store.js';
import { createWorkTools } from '../src/personal/permissions.js';

test('paired restricted operations use the same exact system approval policy', async () => {
  const a = await runExperiment('independent', 'approval');
  const d = await runExperiment('skill_cli', 'approval');
  assert.equal(a.error, undefined); assert.equal(d.error, undefined);
  assert.deepEqual(a.approvals, d.approvals);
});

test('synthetic helper effects use the real work permission and dispatch ledger', async () => {
  const result = await runExperiment('independent', 'delegation');
  assert.equal(result.error, undefined);
  const store = new PersonalStore(join(result.root, 'state'));
  try {
    const child = store.listTasks().find(task => task.parentTaskId)!;
    assert.ok(store.listActionDispatches().some(action => action.taskId === child.id && action.action.kind === 'write' && action.status === 'succeeded'));
  } finally { store.close(); }
});

test('correct material cannot hide an omitted explicit search or omitted completion', async () => {
  const omittedSearch = await runExperiment('independent', 'memory', undefined, undefined, { source: 'injected', fixtureFault: 'omit-search' });
  assert.equal(omittedSearch.error, undefined);
  assert.deepEqual(omittedSearch.scores, { artifacts: true, instructions: false, permissions: true, lifecycle: true });
  assert.equal(omittedSearch.passed, false);
  const omittedCompletion = await runExperiment('independent', 'memory', undefined, undefined, { fixtureFault: 'omit-completion' });
  assert.equal(omittedCompletion.error, undefined);
  assert.deepEqual(omittedCompletion.scores, { artifacts: true, instructions: true, permissions: true, lifecycle: false });
  assert.equal(omittedCompletion.passed, false);
});

for (const variant of ['independent', 'skill_cli'] as const) {
  test(`${variant} zero-permission helper cannot write despite a correct expected answer`, async () => {
    const result = await runExperiment(variant, 'delegation', undefined, undefined, { helper: 'zero-permission' });
    assert.equal(result.error, undefined, JSON.stringify(result));
    assert.equal(result.passed, true, JSON.stringify(result.checks));
    assert.equal(result.checks.noHelperMaterial, true);
  });
  test(`${variant} deterministically delayed helper resumes and reads actual material`, async () => {
    const result = await runExperiment(variant, 'delegation', undefined, undefined, { helper: 'delayed' });
    assert.equal(result.error, undefined, JSON.stringify(result));
    assert.equal(result.passed, true, JSON.stringify(result.checks));
  });
}

test('paired runs freeze equal initial input and execution policies', async () => {
  const a = await runExperiment('independent', 'organize');
  const d = await runExperiment('skill_cli', 'organize');
  assert.deepEqual(a.calibration, d.calibration);
  assert.equal(a.calibration.permissionMode, 'trusted');
  assert.equal(a.checks.modeMatches, true); assert.equal(d.checks.modeMatches, true);
  assert.deepEqual(a.approvals, []); assert.deepEqual(d.approvals, []);
});

test('reading a workflow skill cannot substitute for inspecting the helper artifact', async () => {
  const result = await runExperiment('skill_cli', 'delegation', undefined, undefined, { workflow: 'skill', fixtureFault: 'omit-helper-read' });
  assert.equal(result.error, undefined, JSON.stringify(result));
  assert.equal(result.checks.helperMaterial, true);
  assert.equal(result.checks.completed, true);
  assert.ok(result.trace.some(trace => trace.operation === 'read' && trace.status === 'ok'));
  assert.equal(result.checks.readMaterial, false);
  assert.equal(result.scores.instructions, false);
  assert.equal(result.passed, false);
});

test('frozen input, scoring and budgets are available before the first Provider request', async () => {
  let frozen: unknown;
  const result = await runExperiment('skill_cli', 'memory', undefined, undefined, { source: 'injected', async onFrozen(report) {
    assert.equal(report.requests, 0);
    assert.ok(report.frozen.input.includes('已注入的历史来源'));
    assert.deepEqual(report.frozen.scoring.instructions, ['searched', 'readOriginal']);
    assert.equal(report.limits.maxTurns, 20);
    frozen = structuredClone(report.frozen);
  } });
  assert.equal(result.passed, true, JSON.stringify(result));
  assert.deepEqual(result.frozen, frozen);
});

for (const scenario of scenarios) for (const variant of ['independent', 'skill_cli'] as const) {
  test(`isolated ${variant} ${scenario} crosses real Host and verifies actual effects`, async () => {
    const result = await runExperiment(variant, scenario);
    assert.equal(result.error, undefined, JSON.stringify(result));
    assert.equal(result.passed, true, JSON.stringify(result.checks));
    assert.ok(result.requests > 1);
    const names = result.wireTools[0]!;
    if (variant === 'independent') {
      assert.equal(names.length, 13); assert.ok(names.includes('file_operation')); assert.ok(names.includes('work_permission'));
    } else {
      for (const requestTools of result.wireTools) assert.deepEqual(requestTools, ['read', 'write', 'edit', 'bash', 'tool_search']);
      for (const forbidden of ['file_operation', 'work_permission', 'task_control', 'delegate_work', 'complete_work', 'child_control', 'memory_search', 'memory_read']) assert.equal(names.includes(forbidden), false);
    }
    assert.ok(result.surfaces[0]!.schemaBytes > 0);
    if (scenario === 'denial') assert.equal(await readFile(join(result.root, 'protected', 'note.txt'), 'utf8'), 'original');
  });
}

async function boundaryFixture(variant: Variant) {
  const directory = await mkdtemp(join(tmpdir(), 'tool-boundary-'));
  const root = join(directory, 'materials'); const dataDir = join(root, 'state'); await mkdir(dataDir, { recursive: true });
  const sentinel = join(directory, 'sentinel.txt'); await writeFile(sentinel, 'original');
  const host = new PersonalHost({ store: new PersonalStore(dataDir), dialogue: { async decide() { return { kind: 'reply', text: 'unused' }; } }, executor: { async execute() { throw new Error('Unexpected delegation'); } } });
  const work = host.workContext({ conversationId: 'fixture', actorId: 'fixture', inputId: 'initial', text: 'boundary check' });
  await mkdir(work.current().cwd!, { recursive: true }); const original = join(work.current().cwd!, 'original.txt'); await writeFile(original, 'keep');
  let confirmations = 0;
  // Eligibility marker only. These cases must never call completion or a real shell.
  const completion = defineTool({ name: 'complete_work', label: 'unused', description: 'unused', parameters: Type.Object({}), async execute() { throw new Error('Unexpected completion'); } });
  const { tools } = experimentInterface({ variant, root, dataDir, skillFile, surfaces: [], trace: [], confirmPending: async () => {
    confirmations++;
    for (const action of host.store.listActions().filter(action => action.status === 'pending')) host.authorizeAction({ conversationId: 'fixture', actorId: 'fixture', inputId: 'human', text: 'deny' }, action.id, false);
    return false;
  } })({ scope: { sessionId: 'boundary', cwd: work.current().cwd! }, tools: [...createWorkTools(() => work, { dataDir }), completion], instructions: '', work: () => work });
  return { host, sentinel, original, confirmations: () => confirmations, execute: (name: string, args: Record<string, unknown>) => tools.find(tool => tool.name === name)!.execute('boundary', args, undefined, undefined, undefined as never) };
}

for (const variant of ['independent', 'skill_cli'] as const) {
  test(`${variant} rejects unsupported shell execution without dispatch`, async t => {
    const f = await boundaryFixture(variant); t.after(() => f.host.close());
    await assert.rejects(f.execute('bash', { command: 'node -e "throw Error()"' }), /Unsupported experiment command/);
    await assert.rejects(f.execute('bash', { command: 'mkdir new; rm original.txt' }), /Shell operators/);
    assert.equal(f.host.store.listActionDispatches().length, 0); assert.equal(f.confirmations(), 0);
    assert.equal(await readFile(f.original, 'utf8'), 'keep');
  });
  test(`${variant} rejects paths beyond synthetic materials before proposing permission`, async t => {
    const f = await boundaryFixture(variant); t.after(() => f.host.close());
    await assert.rejects(f.execute('write', { path: f.sentinel, content: 'changed' }), /outside synthetic experiment materials/);
    await assert.rejects(f.execute('bash', { command: `mv original.txt "${f.sentinel}"` }), /outside synthetic experiment materials/);
    assert.equal(await readFile(f.sentinel, 'utf8'), 'original'); assert.equal(await readFile(f.original, 'utf8'), 'keep');
    assert.equal(f.host.store.listActions().length, 0); assert.equal(f.host.store.listActionDispatches().length, 0);
  });
  test(`${variant} terminal cannot approve its own action`, async t => {
    const f = await boundaryFixture(variant); t.after(() => f.host.close());
    await assert.rejects(f.execute('bash', { command: 'agentctl work authorize {"approved":true}' }));
    assert.equal(f.host.store.listActions().length, 0); assert.equal(f.confirmations(), 0);
  });
  test(`${variant} denied deletion preserves original and does not dispatch`, async t => {
    const f = await boundaryFixture(variant); t.after(() => f.host.close());
    await assert.rejects(f.execute('bash', { command: 'rm original.txt' }), /删除原件需要明确确认/);
    assert.equal(f.confirmations(), 1); assert.equal(await readFile(f.original, 'utf8'), 'keep');
    assert.equal(f.host.store.listActionDispatches().length, 0); assert.ok(f.host.store.listActions().some(action => action.status === 'denied'));
  });
}
