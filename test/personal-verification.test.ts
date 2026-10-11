import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PersonalHost } from '../src/personal/host.js';
import { PersonalStore } from '../src/personal/store.js';
import { VerificationChecks } from '../src/personal/verification.js';

test('Host executes a concrete verification command only after its exact approval', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'personal-verify-'));
  const artifact = join(directory, 'verified.txt');
  const checks = new VerificationChecks([{ command: process.execPath, args: ['-e', 'require("node:fs").writeFileSync("verified.txt", "checked")'] }]);
  const host = new PersonalHost({ store: new PersonalStore(directory),
    dialogue: { async decide(input, context) {
      if (input.text === 'approve') return { kind: 'authorize', actionId: context.actions![0]!.id, approved: true };
      return { kind: 'start', goal: 'Check the prepared result', cwd: directory };
    } },
    executor: { async execute(request) {
      const evidence = await checks.run(request.task, { signal: request.signal, requestAction: request.requestAction });
      return { text: 'Independent exact check', verified: evidence.length > 0 && evidence.every(check => check.status === 'passed'), artifacts: [artifact] };
    } },
  });
  try {
    const accepted = await host.submit({ conversationId: 'chat', actorId: 'owner', inputId: '1', text: 'Check result' });
    await host.waitForIdle();
    assert.equal(host.getTask(accepted.taskId!)?.status, 'waiting');
    await assert.rejects(readFile(artifact), { code: 'ENOENT' });
    await host.submit({ conversationId: 'chat', actorId: 'owner', inputId: '2', text: 'approve' });
    await host.waitForIdle();
    assert.equal(await readFile(artifact, 'utf8'), 'checked');
    assert.equal(host.getTask(accepted.taskId!)?.status, 'completed');
  } finally { await host.close(); await rm(directory, { recursive: true, force: true }); }
});

test('failed configured checks remain partial even when the command produces an artifact', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'personal-verify-'));
  const artifact = join(directory, 'partial.txt');
  const checks = new VerificationChecks([{ command: process.execPath, args: ['-e', 'require("node:fs").writeFileSync("partial.txt","partial"); process.exit(3)'] }], { preauthorized: true });
  const host = new PersonalHost({ store: new PersonalStore(directory),
    dialogue: { decide: async () => ({ kind: 'start', goal: 'Check actual result', cwd: directory }) },
    executor: { async execute(request) {
      const evidence = await checks.run(request.task, { signal: request.signal });
      return { text: `${evidence[0]?.status}:${evidence[0]?.exitCode}`, verified: evidence.every(check => check.status === 'passed'), artifacts: [artifact] };
    } },
  });
  try {
    const accepted = await host.submit({ conversationId: 'chat', actorId: 'owner', inputId: '1', text: 'Check actual result' });
    await host.waitForIdle();
    assert.equal(await readFile(artifact, 'utf8'), 'partial');
    assert.equal(host.getTask(accepted.taskId!)?.status, 'partial');
    assert.equal(host.getTask(accepted.taskId!)?.result?.text, 'failed:3');
  } finally { await host.close(); await rm(directory, { recursive: true, force: true }); }
});

test('cancelled Host verification stops a live command and its spawned child', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'personal-verify-'));
  const script = 'const fs=require("node:fs"); const cp=require("node:child_process"); const child=cp.spawn(process.execPath,["-e", "setInterval(()=>{},1000)"],{stdio:"ignore"}); fs.writeFileSync("pids.json",JSON.stringify([process.pid,child.pid])); setInterval(()=>{},1000);';
  const checks = new VerificationChecks([{ command: process.execPath, args: ['-e', script] }], { preauthorized: true });
  const host = new PersonalHost({ store: new PersonalStore(directory),
    dialogue: { decide: async input => input.text === 'stop' ? { kind: 'cancel', taskId: input.replyTaskId } : { kind: 'start', goal: 'Verify long result', cwd: directory } },
    executor: { async execute(request) {
      const evidence = await checks.run(request.task, { signal: request.signal });
      return { text: `${evidence[0]?.status}:${evidence[0]?.terminationConfirmed}`, verified: false };
    } },
  });
  try {
    const accepted = await host.submit({ conversationId: 'chat', actorId: 'owner', inputId: '1', text: 'Verify long result' });
    let ids: number[] = [];
    for (let attempt = 0; attempt < 100; attempt++) {
      try { ids = JSON.parse(await readFile(join(directory, 'pids.json'), 'utf8')); break; } catch { await new Promise(accept => setTimeout(accept, 20)); }
    }
    assert.equal(ids.length, 2);
    await host.submit({ conversationId: 'chat', actorId: 'owner', inputId: '2', text: 'stop', replyTaskId: accepted.taskId });
    await host.waitForIdle();
    assert.equal(host.getTask(accepted.taskId!)?.status, 'cancelled');
    assert.equal(host.getTask(accepted.taskId!)?.result?.text, 'cancelled:true');
    for (const pid of ids) assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
  } finally { await host.close(); await rm(directory, { recursive: true, force: true }); }
});

test('Host refuses successful verification when the configured check exceeds its deadline', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'personal-verify-'));
  const checks = new VerificationChecks([{ command: process.execPath, args: ['-e', 'setTimeout(() => process.exit(0), 400)'] }], { preauthorized: true, timeoutMs: 50 });
  const host = new PersonalHost({ store: new PersonalStore(directory),
    dialogue: { decide: async () => ({ kind: 'start', goal: 'Verify result within budget', cwd: directory }) },
    executor: { async execute(request) {
      const evidence = await checks.run(request.task, { signal: request.signal });
      return { text: evidence.map(check => check.status).join(','), verified: evidence.every(check => check.status === 'passed') };
    } },
  });
  try {
    const accepted = await host.submit({ conversationId: 'chat', actorId: 'owner', inputId: '1', text: 'Verify result' });
    await host.waitForIdle();
    assert.equal(host.getTask(accepted.taskId!)?.status, 'partial');
    assert.match(host.getTask(accepted.taskId!)?.result?.text ?? '', /timed_out|unknown/);
  } finally { await host.close(); await rm(directory, { recursive: true, force: true }); }
});
