import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PersonalHost } from '../src/personal/host.js';
import { PersonalStore } from '../src/personal/store.js';
import { PersonalPlans } from '../src/personal/plans.js';
import type { Decision } from '../src/personal/types.js';

test('CLI → Host persists a one-time plan across restart and consumes its trigger only once', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'nailong-plan-'));
  let now = 1000;
  let plans: PersonalPlans;
  const makeHost = () => new PersonalHost({ store: new PersonalStore(directory), now: () => now,
    dialogue: { decide: async () => ({ kind: 'schedule', plan: { goal: '生成报告', dueAt: 2000, timezone: 'Asia/Shanghai', missed: 'run' } }) },
    executor: { execute: async () => ({ text: '报告已生成', verified: true }) },
    handleDecision: (input, decision) => plans.handle(input, decision) });
  let host = makeHost(); plans = new PersonalPlans(host, () => now);
  try {
    const response = await host.submit({ conversationId: 'cli:one', actorId: 'one', inputId: 'plan-1', text: '稍后生成报告' });
    assert.match(response.text, /计划/);
    assert.equal(host.listTasks().length, 0);
    await host.close();
    host = makeHost(); plans = new PersonalPlans(host, () => now);
    now = 2000; await plans.tick(); await host.waitForIdle();
    await plans.tick(); await host.waitForIdle();
    assert.equal(host.listTasks().length, 1);
    assert.equal(host.listTasks()[0]?.goal, '生成报告');
    assert.equal(host.listTasks()[0]?.status, 'completed');
    assert.equal(plans.list('cli:one')[0]?.status, 'completed');
  } finally { await host.close(); await rm(directory, { recursive: true, force: true }); }
});

test('a scheduled task queued behind conflicting work cannot start after its deadline', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'nailong-plan-'));
  let now = 1000; let plans!: PersonalPlans; let release!: () => void;
  const barrier = new Promise<void>(accept => { release = accept; });
  const performed: string[] = [];
  const host = new PersonalHost({ store: new PersonalStore(directory), now: () => now,
    dialogue: { async decide(input): Promise<Decision> {
      return input.text === 'occupy' ? { kind: 'start', goal: 'occupy resource', cwd: directory }
        : { kind: 'schedule', plan: { goal: 'bounded report', cwd: directory, dueAt: 2000, deadline: 3000, timezone: 'UTC', missed: 'run' } };
    } }, executor: { async execute(request) { performed.push(request.task.goal); if (request.task.goal === 'occupy resource') await barrier; return { text: 'done', verified: true }; } },
    handleDecision: (input, decision) => plans.handle(input, decision) });
  plans = new PersonalPlans(host, () => now);
  try {
    await host.submit({ conversationId: 'c', actorId: 'a', inputId: 'occupy', text: 'occupy' });
    await host.submit({ conversationId: 'c', actorId: 'a', inputId: 'schedule', text: 'schedule' });
    now = 2000; await plans.tick();
    assert.equal(host.listTasks().find(task => task.goal === 'bounded report')?.status, 'queued');
    now = 4000; release(); await host.waitForIdle();
    assert.deepEqual(performed, ['occupy resource']);
    assert.equal(host.listTasks().find(task => task.goal === 'bounded report')?.status, 'waiting');
  } finally { release(); await host.close(); await rm(directory, { recursive: true, force: true }); }
});

test('overdue resume asks once until a concrete new time or catch-up policy is supplied', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'nailong-plan-'));
  let now = 1000; let plans!: PersonalPlans;
  const host = new PersonalHost({ store: new PersonalStore(directory), now: () => now,
    dialogue: { async decide(input, context): Promise<Decision> {
      if (input.text === 'resume') return { kind: 'plan', action: 'resume', planId: context.plans![0]!.id };
      if (input.text === 'catch up') return { kind: 'plan', action: 'resume', planId: context.plans![0]!.id, missed: 'run' };
      return { kind: 'schedule', plan: { goal: '报告', dueAt: 2000, timezone: 'UTC', missed: 'ask' } };
    } }, executor: { execute: async () => ({ text: '已完成', verified: true }) },
    handleDecision: (input, decision) => plans.handle(input, decision) });
  plans = new PersonalPlans(host, () => now);
  try {
    await host.submit({ conversationId: 'c', actorId: 'a', inputId: 'create', text: 'schedule' });
    now = 120_000; await plans.tick();
    assert.equal(plans.list('c')[0]?.status, 'waiting');
    const count = host.pendingDeliveries().length;
    const resumed = await host.submit({ conversationId: 'c', actorId: 'a', inputId: 'resume', text: 'resume' });
    assert.match(resumed.text, /明确|错过/);
    await plans.tick(); await plans.tick();
    assert.equal(host.listTasks().length, 0);
    assert.equal(host.pendingDeliveries().length, count + 1);
    await host.submit({ conversationId: 'c', actorId: 'a', inputId: 'catchup', text: 'catch up' });
    await plans.tick(); await host.waitForIdle(); await plans.tick();
    assert.equal(host.listTasks().length, 1);
  } finally { await host.close(); await rm(directory, { recursive: true, force: true }); }
});

test('replayed plan mutation after receipt failure changes the plan only once', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'nailong-plan-'));
  let plans!: PersonalPlans; let loseReceipt = true;
  const host = new PersonalHost({ store: new PersonalStore(directory),
    dialogue: { async decide(input, context): Promise<Decision> {
      return input.text === 'pause' ? { kind: 'plan', planId: context.plans![0]!.id, action: 'pause' }
        : { kind: 'schedule', plan: { goal: '报告', dueAt: Date.now() + 60_000, timezone: 'UTC', missed: 'ask' } };
    } }, executor: { execute: async () => ({ text: '', verified: false }) },
    handleDecision: async (input, decision) => {
      const response = await plans.handle(input, decision);
      if (decision.kind === 'plan' && loseReceipt) { loseReceipt = false; throw new Error('Receipt storage unavailable'); }
      return response;
    } });
  plans = new PersonalPlans(host);
  try {
    await host.submit({ conversationId: 'c', actorId: 'a', inputId: 'create', text: 'schedule' });
    const input = { conversationId: 'c', actorId: 'a', inputId: 'pause-once', text: 'pause' };
    await assert.rejects(host.submit(input), /Receipt storage/);
    assert.equal(plans.list('c')[0]?.version, 2);
    await host.submit(input);
    assert.equal(plans.list('c')[0]?.version, 2);
    assert.equal(plans.list('c')[0]?.status, 'paused');
  } finally { await host.close(); await rm(directory, { recursive: true, force: true }); }
});

test('changing a saved plan updates its goal, interval and policy before the next trigger', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'nailong-plan-'));
  let now = 1000; let plans!: PersonalPlans;
  const host = new PersonalHost({ store: new PersonalStore(directory), now: () => now,
    dialogue: { async decide(input, context): Promise<Decision> {
      if (input.text === 'change') return { kind: 'plan', planId: context.plans![0]!.id, action: 'change',
        goal: '新版报告', intervalMs: 120_000, timezone: 'UTC', missed: 'skip' };
      return { kind: 'schedule', plan: { goal: '旧版报告', dueAt: 2000, intervalMs: 60_000, timezone: 'Asia/Shanghai', missed: 'ask' } };
    } }, executor: { execute: async () => ({ text: '新报告', verified: true }) },
    handleDecision: (input, decision) => plans.handle(input, decision) });
  plans = new PersonalPlans(host, () => now);
  try {
    await host.submit({ conversationId: 'c', actorId: 'a', inputId: 'create', text: 'schedule' });
    await host.submit({ conversationId: 'c', actorId: 'a', inputId: 'update', text: 'change' });
    const plan = plans.list('c')[0]!;
    assert.equal(plan.goal, '新版报告'); assert.equal(plan.intervalMs, 120_000);
    assert.equal(plan.timezone, 'UTC'); assert.equal(plan.missed, 'skip');
    now = 2000; await plans.tick(); await host.waitForIdle();
    assert.equal(host.listTasks()[0]?.goal, '新版报告');
    assert.equal(plans.list('c')[0]?.dueAt, 122_000);
  } finally { await host.close(); await rm(directory, { recursive: true, force: true }); }
});
