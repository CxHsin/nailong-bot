import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir, release } from 'node:os';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { PersonalHost } from '../src/personal/host.js';
import { PersonalStore } from '../src/personal/store.js';
import { createWorkTools, type ExecutionBackend } from '../src/personal/permissions.js';
import { loadExecutionBackends } from '../src/personal/execution-backends.js';

test('restricted command refuses a verified backend for a different work scope before execution', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'backend-scope-'));
  const store = new PersonalStore(directory);
  const host = new PersonalHost({ store, dialogue: { async decide() { return { kind: 'reply', text: 'unused' }; } }, executor: { async execute() { return { text: '', verified: false }; } } });
  t.after(async () => { await host.close(); await rm(directory, { recursive: true, force: true }); });
  const work = host.workContext({ conversationId: 'c', actorId: 'a', inputId: 'one', text: 'command' }); let launches = 0;
  const backend = { id: 'other-scope', verified: true, identity: 'fixture-other', capabilities: { readIsolation: true, writeIsolation: true, networkIsolation: true, processTreeStop: true },
    async supports() { return { supported: false, reasons: ['scope mismatch'] }; }, async execute() { launches++; return 'bad'; } } as ExecutionBackend;
  const bash = createWorkTools(() => work, { dataDir: directory, backends: [backend] }).find(tool => tool.name === 'bash')!;
  await assert.rejects(bash.execute('call', { command: 'outside write' }, undefined, undefined, undefined as never), /未派发/);
  assert.equal(launches, 0); assert.equal(store.listActionDispatches().length, 0);
});

test('partial unelevated candidate self-gates even when an evidence file claims full capability', { skip: process.platform !== 'win32' }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'backend-evidence-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const evidenceFile = join(directory, 'evidence.json');
  const evidence = { version: 1, mode: 'windows-unelevated', adapterVersion: 'codex-unelevated-v1', executable: process.execPath, executableSha256: createHash('sha256').update(await readFile(process.execPath)).digest('hex'), osRelease: release(), measuredAt: Date.now(), scope: { cwd: directory, readRoots: [directory], writeRoots: [directory] }, policyDigest: '0'.repeat(64), observations: { outsideReadDenied: true, outsideWriteDenied: true, networkDenied: true, detachedTreeStopped: true } };
  await writeFile(evidenceFile, JSON.stringify(evidence));
  const config = { AGENT_CODEX_SANDBOX_EXECUTABLE: process.execPath, AGENT_CODEX_SANDBOX_EVIDENCE: evidenceFile };
  const registry = await loadExecutionBackends(config); assert.equal(registry.backends.length, 1);
  const grant = { mode: 'restricted' as const, readRoots: [directory], writeRoots: [directory], network: false, expiresAt: Date.now() + 60000, revision: 0, sourceInputId: 'confirmed' };
  const backend = registry.backends[0]!; assert.equal((await backend.supports({ cwd: directory, grant })).supported, false);
  await assert.rejects(backend.execute({ cwd: directory, grant, command: 'never launch' }), /未派发/);
  await writeFile(evidenceFile, JSON.stringify({ ...evidence, executableSha256: '0'.repeat(64) })); assert.equal((await loadExecutionBackends(config)).backends.length, 0);
});

test('command rechecks a narrowed grant at execution rather than using a captured wider grant', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'backend-stale-')); const store = new PersonalStore(directory);
  const host = new PersonalHost({ store, dialogue: { async decide() { return { kind: 'reply', text: '' }; } }, executor: { async execute() { return { text: '', verified: false }; } } });
  t.after(async () => { await host.close(); await rm(directory, { recursive: true, force: true }); });
  const work = host.workContext({ conversationId: 'c', actorId: 'a', inputId: 'one', text: 'command' }); let launches = 0; let checks = 0;
  const backend: ExecutionBackend = { id: 'stale', identity: 'fixture', verified: true, capabilities: { readIsolation: true, writeIsolation: true, networkIsolation: true, processTreeStop: true },
    async supports() { checks++; if (checks === 2) { const task = work.current(); task.permission!.writeRoots = []; store.putTask(task); } return { supported: true, reasons: [] }; },
    async execute() { launches++; return 'bad'; } };
  const bash = createWorkTools(() => work, { dataDir: directory, backends: [backend] }).find(tool => tool.name === 'bash')!;
  await assert.rejects(bash.execute('call', { command: 'write' }, undefined, undefined, undefined as never), /未派发/); assert.equal(launches, 0);
});
