import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PersonalHost } from '../src/personal/host.js';
import { PersonalStore } from '../src/personal/store.js';
import { HerdrExecutor } from '../src/personal/herdr.js';

test('Host never delivers old idle herdr work as a verified new task', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'personal-herdr-'));
  let name = '';
  const executor = new HerdrExecutor({ session: 'test', executionPolicy: { verified: true, readIsolation: true, writeIsolation: true, networkIsolation: true, processTreeStop: true, args: ['--fixture-policy'] }, maxDurationMs: 20, pollMs: 1,
    cli: async args => {
      if (args.includes('create')) return { result: { workspace: { workspace_id: 'w1' }, root_pane: { pane_id: 'w1:p1' } } };
      if (args[1] === 'start') name = args[2]!;
      return { result: { agent: { pane_id: 'w1:p1', workspace_id: 'w1', name, agent: 'codex', agent_status: 'idle', cwd: directory, state_change_seq: 0 } } };
    },
    verify: async () => ({ text: 'Old work is present', verified: true }),
  });
  const host = new PersonalHost({ store: new PersonalStore(directory), executor,
    dialogue: { decide: async () => ({ kind: 'start', goal: 'Produce current result', executor: 'herdr', cwd: directory }) } });
  try {
    const accepted = await host.submit({ conversationId: 'chat', actorId: 'owner', inputId: '1', text: 'Produce current result' });
    await host.waitForIdle();
    assert.notEqual(host.getTask(accepted.taskId!)?.status, 'completed');
    assert.ok(host.pendingDeliveries('chat').every(delivery => !delivery.text.includes('状态：completed')));
  } finally { await host.close(); await rm(directory, { recursive: true, force: true }); }
});

for (const failure of ['missing artifact', 'failed check', 'wrong workspace'] as const) {
  test(`Host refuses herdr completion with ${failure}`, async () => {
    const directory = await mkdtemp(join(tmpdir(), 'personal-herdr-'));
    let name = ''; let working = false;
    const executor = new HerdrExecutor({ session: 'test', executionPolicy: { verified: true, readIsolation: true, writeIsolation: true, networkIsolation: true, processTreeStop: true, args: ['--fixture-policy'] }, pollMs: 1,
      cli: async args => {
        if (args[1] === 'create') return { result: { workspace: { workspace_id: 'w1' }, root_pane: { pane_id: 'w1:p1' } } };
        if (args[1] === 'start') name = args[2]!;
        if (args[1] === 'prompt') working = true;
        if (args[1] === 'read') return { result: { text: 'Done, all checks passed.' } };
        const agent_status = working ? 'working' : 'idle'; working = false;
        return { result: { agent: { pane_id: 'w1:p1', workspace_id: failure === 'wrong workspace' ? 'w2' : 'w1', name, agent: 'codex', agent_status, cwd: directory } } };
      },
      verify: async () => ({ text: failure === 'missing artifact' ? 'Required file is absent' : 'Required check failed', verified: false }),
    });
    const host = new PersonalHost({ store: new PersonalStore(directory), executor,
      dialogue: { decide: async () => ({ kind: 'start', goal: 'Make checked output', executor: 'herdr', cwd: directory }) } });
    try {
      const accepted = await host.submit({ conversationId: 'chat', actorId: 'owner', inputId: '1', text: 'Make checked output' });
      await host.waitForIdle();
      assert.notEqual(host.getTask(accepted.taskId!)?.status, 'completed');
      assert.ok(host.pendingDeliveries('chat').every(delivery => !delivery.text.includes('状态：completed')));
    } finally { await host.close(); await rm(directory, { recursive: true, force: true }); }
  });
}

test('Host reports cancellation as uncertain when herdr cannot prove external processes stopped', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'personal-herdr-'));
  let name = ''; let active = false; let observed!: () => void;
  const barrier = new Promise<void>(accept => { observed = accept; });
  const executor = new HerdrExecutor({ session: 'test', executionPolicy: { verified: true, readIsolation: true, writeIsolation: true, networkIsolation: true, processTreeStop: true, args: ['--fixture-policy'] }, pollMs: 1,
    cli: async args => {
      if (args[1] === 'create') return { result: { workspace: { workspace_id: 'w1' }, root_pane: { pane_id: 'w1:p1' } } };
      if (args[1] === 'start') name = args[2]!;
      if (args[1] === 'prompt') { active = true; observed(); }
      if (args[1] === 'close') return { result: { type: 'ok' } };
      if (args[1] === 'snapshot') return { result: { snapshot: { panes: [] } } };
      return { result: { agent: { pane_id: 'w1:p1', workspace_id: 'w1', name, agent: 'codex', agent_status: active ? 'working' : 'idle', cwd: directory } } };
    },
  });
  const host = new PersonalHost({ store: new PersonalStore(directory), executor,
    dialogue: { decide: async input => input.text === 'stop' ? { kind: 'cancel', taskId: input.replyTaskId } : { kind: 'start', goal: 'Long work', executor: 'herdr', cwd: directory } } });
  try {
    const accepted = await host.submit({ conversationId: 'chat', actorId: 'owner', inputId: '1', text: 'Long work' });
    await barrier;
    await host.submit({ conversationId: 'chat', actorId: 'owner', inputId: '2', text: 'stop', replyTaskId: accepted.taskId });
    await host.waitForIdle();
    assert.equal(host.getTask(accepted.taskId!)?.status, 'waiting');
    assert.match(host.getTask(accepted.taskId!)?.error ?? '', /未知|核实/);
  } finally { await host.close(); await rm(directory, { recursive: true, force: true }); }
});

test('supplemented task waits for herdr to execute and verify the new requirement', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'personal-herdr-'));
  let name = ''; let prompts = 0; let started!: () => void; let release!: () => void;
  const begun = new Promise<void>(accept => { started = accept; });
  const gate = new Promise<void>(accept => { release = accept; });
  const output = join(directory, 'result.txt');
  const executor = new HerdrExecutor({ session: 'test', executionPolicy: { verified: true, readIsolation: true, writeIsolation: true, networkIsolation: true, processTreeStop: true, args: ['--fixture-policy'] }, pollMs: 1,
    cli: async args => {
      if (args[1] === 'create') return { result: { workspace: { workspace_id: 'w1' }, root_pane: { pane_id: 'w1:p1' } } };
      if (args[1] === 'start') name = args[2]!;
      if (args[1] === 'prompt') { prompts++; started(); await writeFile(output, args[3]!.includes('use 84') ? '84\n' : '42\n'); }
      if (args[1] === 'get' && prompts === 1) await gate;
      if (args[1] === 'read') return { result: { text: 'Completed file' } };
      return { result: { agent: { pane_id: 'w1:p1', workspace_id: 'w1', name, agent: 'codex', agent_status: args[1] === 'prompt' ? 'working' : 'idle', cwd: directory } } };
    },
    verify: async (task, evidence) => ({ text: `Checked revision ${evidence.revision}`, verified: task.requirements.includes('use 84') && await readFile(output, 'utf8') === '84\n', artifacts: [output] }),
  });
  const host = new PersonalHost({ store: new PersonalStore(directory), executor,
    dialogue: { decide: async input => input.text === 'use 84' ? { kind: 'steer', taskId: input.replyTaskId, text: input.text } : { kind: 'start', goal: 'Make result file', executor: 'herdr', cwd: directory } } });
  try {
    const accepted = await host.submit({ conversationId: 'chat', actorId: 'owner', inputId: '1', text: 'Make result file' });
    await begun;
    const supplemented = await host.submit({ conversationId: 'chat', actorId: 'owner', inputId: '2', text: 'use 84', replyTaskId: accepted.taskId });
    assert.match(supplemented.text, /尚未确认|已接收/);
    release(); await host.waitForIdle();
    assert.equal(await readFile(output, 'utf8'), '84\n');
    assert.equal(host.getTask(accepted.taskId!)?.status, 'completed');
    assert.match(host.getTask(accepted.taskId!)?.result?.text ?? '', /revision 1/);
  } finally { release(); await host.close(); await rm(directory, { recursive: true, force: true }); }
});

test('Host delivers a herdr task only after its real artifact passes the requested check', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'personal-herdr-'));
  let name = ''; let working = false;
  const output = join(directory, 'answer.txt');
  const executor = new HerdrExecutor({ session: 'test', executionPolicy: { verified: true, readIsolation: true, writeIsolation: true, networkIsolation: true, processTreeStop: true, args: ['--fixture-policy'] }, pollMs: 1,
    cli: async args => {
      if (args[1] === 'create') return { result: { workspace: { workspace_id: 'w1' }, root_pane: { pane_id: 'w1:p1' } } };
      if (args[1] === 'start') name = args[2]!;
      if (args[1] === 'prompt') { working = true; await writeFile(output, '42\n'); }
      if (args[1] === 'read') return { result: { text: 'Created answer.txt and ran check.' } };
      const agent_status = working ? 'working' : 'idle';
      working = false;
      return { result: { agent: { pane_id: 'w1:p1', workspace_id: 'w1', name, agent: 'codex', agent_status, cwd: directory } } };
    },
    verify: async (_task, evidence) => ({ text: evidence.output, verified: await readFile(output, 'utf8') === '42\n', artifacts: [output] }),
  });
  const host = new PersonalHost({ store: new PersonalStore(directory), executor,
    dialogue: { decide: async () => ({ kind: 'start', goal: 'Create answer.txt containing 42', executor: 'herdr', cwd: directory }) } });
  try {
    const accepted = await host.submit({ conversationId: 'chat', actorId: 'owner', inputId: '1', text: 'Create answer.txt' });
    await host.waitForIdle();
    assert.equal(host.getTask(accepted.taskId!)?.status, 'completed');
    assert.deepEqual(host.getTask(accepted.taskId!)?.result?.artifacts, [output]);
    assert.ok(host.pendingDeliveries('chat').some(delivery => delivery.artifacts?.includes(output)));
  } finally { await host.close(); await rm(directory, { recursive: true, force: true }); }
});

test('restricted herdr task remains blocked before any external workspace is created', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'personal-herdr-permission-'));
  let calls = 0;
  const executor = new HerdrExecutor({ session: 'test', cli: async () => { calls++; throw new Error('must not dispatch'); } });
  const host = new PersonalHost({ store: new PersonalStore(directory), executor,
    dialogue: { decide: async () => ({ kind: 'start', goal: 'restricted coding', executor: 'herdr', cwd: directory }) } });
  try {
    const result = await host.submit({ conversationId: 'chat', actorId: 'owner', inputId: '1', text: 'restricted coding' });
    await host.waitForIdle(); assert.equal(calls, 0); assert.equal(host.getTask(result.taskId!)?.status, 'waiting');
  } finally { await host.close(); await rm(directory, { recursive: true, force: true }); }
});
