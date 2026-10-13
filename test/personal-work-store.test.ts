import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { PersonalStore } from '../src/personal/store.js';
import { PersonalHost } from '../src/personal/host.js';
import type { Task } from '../src/personal/types.js';

const oldTask: Task = { id: 'old', conversationId: 'c', actorId: 'a', goal: '原文目标', resources: [], executor: 'local', sessionId: 'old-session', status: 'completed', createdAt: 1, updatedAt: 2, requirements: ['原文要求'], revision: 3, result: { text: '原文成果', verified: true } };

test('business schema upgrade keeps historical identities and backs up original records once', () => {
  const directory = mkdtempSync(join(tmpdir(), 'personal-upgrade-'));
  const fixture = new DatabaseSync(join(directory, 'personal.sqlite'));
  fixture.exec('CREATE TABLE tasks(id TEXT PRIMARY KEY, conversation TEXT NOT NULL, body TEXT NOT NULL)');
  fixture.prepare('INSERT INTO tasks VALUES(?,?,?)').run(oldTask.id, oldTask.conversationId, JSON.stringify(oldTask)); fixture.close();
  let store: PersonalStore | undefined;
  try {
    store = new PersonalStore(directory);
    assert.deepEqual(store.getTask('old'), { ...oldTask, workKind: 'root', rootTaskId: 'old' });
    const schema = store.businessSchema(); assert.equal(schema.version, 4); assert.ok(schema.backupPath);
    const backup = new DatabaseSync(schema.backupPath, { readOnly: true });
    try { assert.deepEqual(JSON.parse(String(backup.prepare('SELECT body FROM tasks').get()!.body)), oldTask); } finally { backup.close(); }
    store.close(); store = new PersonalStore(directory);
    assert.deepEqual(store.businessSchema(), schema);
    assert.equal(readdirSync(join(directory, 'personal-schema-backups')).length, 1);
    assert.equal(store.listDeliveries().length, 0);
  } finally { store?.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('upgrade preserves pending obligations, unknown outcomes and exclusion records without delivering old results', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'personal-upgrade-state-'));
  const fixture = new DatabaseSync(join(directory, 'personal.sqlite'));
  fixture.exec(`PRAGMA journal_mode=WAL;
    CREATE TABLE tasks(id TEXT PRIMARY KEY, conversation TEXT NOT NULL, body TEXT NOT NULL);
    CREATE TABLE attempts(id TEXT PRIMARY KEY, task TEXT NOT NULL, body TEXT NOT NULL);
    CREATE TABLE plans(id TEXT PRIMARY KEY, body TEXT NOT NULL);
    CREATE TABLE deliveries(id TEXT PRIMARY KEY, conversation TEXT NOT NULL, body TEXT NOT NULL);
    CREATE TABLE conversations(id TEXT PRIMARY KEY, session TEXT NOT NULL);`);
  const waiting = { ...oldTask, id: 'waiting', status: 'waiting', result: undefined, resourceHeld: true, requirementInputs: ['source-original'], contextExcluded: true };
  const attempt = { id: 'attempt', taskId: 'waiting', sessionId: 'task-session', startedAt: 1, status: 'waiting', identity: { kind: 'external', id: 'actual-process' } };
  const plan = { id: 'plan', afterTaskId: 'old', goal: 'follow-up original', status: 'active', version: 2 };
  const pending = { id: 'pending', conversationId: 'c', actorId: 'a', taskId: 'old', text: 'saved page', status: 'pending', createdAt: 1 };
  const unknown = { ...pending, id: 'unknown', status: 'unknown' };
  fixture.prepare('INSERT INTO tasks VALUES(?,?,?)').run('old', 'c', JSON.stringify(oldTask));
  fixture.prepare('INSERT INTO tasks VALUES(?,?,?)').run('waiting', 'c', JSON.stringify(waiting));
  fixture.prepare('INSERT INTO attempts VALUES(?,?,?)').run('attempt', 'waiting', JSON.stringify(attempt));
  fixture.prepare('INSERT INTO plans VALUES(?,?)').run('plan', JSON.stringify(plan));
  for (const delivery of [pending, unknown]) fixture.prepare('INSERT INTO deliveries VALUES(?,?,?)').run(delivery.id, 'c', JSON.stringify(delivery));
  fixture.prepare('INSERT INTO conversations VALUES(?,?)').run('c', 'original-main-session'); fixture.close();
  const marker = join(directory, 'personal-history-migration.json'); writeFileSync(marker, 'original import digest / exclusion evidence');
  const store = new PersonalStore(directory); let executions = 0;
  const host = new PersonalHost({ store, dialogue: { async decide() { return { kind: 'reply', text: 'chat' }; } }, executor: { async execute() { executions++; return { text: 'should not execute', verified: true }; } } });
  try {
    assert.deepEqual(store.getAttempt('attempt'), attempt); assert.deepEqual(store.getPlan('plan'), plan);
    assert.equal(store.getTask('old')?.result?.producedRevision, undefined);
    assert.deepEqual(store.getDelivery('unknown'), unknown); assert.deepEqual(store.getDelivery('pending'), pending);
    assert.equal(store.conversationSession('c'), 'original-main-session');
    await host.recover(); await host.waitForIdle();
    assert.equal(executions, 0); assert.equal(store.listDeliveries().length, 2);
    assert.equal(store.getDelivery('unknown')?.status, 'unknown'); assert.equal(store.getDelivery('pending')?.status, 'pending');
    assert.equal(host.getTask('waiting')?.contextExcluded, true); assert.equal(host.getTask('waiting')?.resourceHeld, true);
    assert.equal(readFileSync(marker, 'utf8'), 'original import digest / exclusion evidence');
  } finally { await host.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('backup failure leaves the old database intact and releases Host ownership for repair', () => {
  const directory = mkdtempSync(join(tmpdir(), 'personal-upgrade-failure-'));
  const fixture = new DatabaseSync(join(directory, 'personal.sqlite'));
  fixture.exec('CREATE TABLE tasks(id TEXT PRIMARY KEY, conversation TEXT NOT NULL, body TEXT NOT NULL)');
  fixture.prepare('INSERT INTO tasks VALUES(?,?,?)').run('old', 'c', JSON.stringify(oldTask)); fixture.close();
  const obstacle = join(directory, 'personal-schema-backups'); writeFileSync(obstacle, 'blocked backup directory');
  try {
    assert.throws(() => new PersonalStore(directory));
    const beforeRepair = new DatabaseSync(join(directory, 'personal.sqlite'), { readOnly: true });
    try { assert.equal(beforeRepair.prepare("SELECT name FROM sqlite_master WHERE name='personal_schema'").get(), undefined); } finally { beforeRepair.close(); }
    rmSync(obstacle);
    const repaired = new PersonalStore(directory); try { assert.equal(repaired.getTask('old')?.rootTaskId, 'old'); } finally { repaired.close(); }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('event receipts and unknown dispatch remain attributable across restart without replay', () => {
  const directory = mkdtempSync(join(tmpdir(), 'personal-receipt-')); let store = new PersonalStore(directory);
  try {
    store.putTask({ ...oldTask, id: 'parent', status: 'running', result: undefined });
    const child: Task = { ...oldTask, id: 'child', parentTaskId: 'parent', rootTaskId: 'parent', workKind: 'delegation', status: 'completed', result: { text: 'research', verified: true, producedRevision: 3 } };
    store.putTask(child);
    const event = store.settleDelegationResult(child, { id: 'attempt', taskId: 'child', sessionId: 'child-session', startedAt: 1, status: 'completed' });
    assert.equal(store.claimWorkEvent(event.id)?.state, 'processing'); assert.equal(store.claimWorkEvent(event.id), undefined);
    assert.throws(() => store.completeWorkEvent(event.id, { sessionId: 'main', entryId: 'completed', at: 3 }), /注入/);
    store.recordWorkEventInjection(event.id, { sessionId: 'main', entryId: 'injected', at: 2 });
    const dispatch = { id: 'dispatch', taskId: 'parent', eventId: event.id, revision: 3, action: { kind: 'send', target: 'user', parameters: {}, content: 'summary' }, status: 'dispatching' as const, startedAt: 2 };
    assert.equal(store.reserveActionDispatch(dispatch).created, true);
    store.finishActionDispatch(dispatch.id, 'unknown', 'connection lost'); store.close(); store = new PersonalStore(directory);
    const repeated = store.reserveActionDispatch(dispatch); assert.equal(repeated.created, false); assert.equal(repeated.record.status, 'unknown');
    assert.deepEqual(store.getWorkEvent(event.id)?.injection, { sessionId: 'main', entryId: 'injected', at: 2 });
    assert.throws(() => store.completeWorkEvent(event.id, { sessionId: 'other', entryId: 'completed', at: 3 }), /Session/);
    assert.throws(() => store.completeWorkEvent(event.id, { sessionId: 'main', entryId: 'completed', at: 3 }), /动作/);
    store.finishActionDispatch(dispatch.id, 'succeeded', 'provider receipt');
    store.completeWorkEvent(event.id, { sessionId: 'main', entryId: 'completed', at: 3 });
    assert.equal(store.getWorkEvent(event.id)?.state, 'consumed'); assert.equal(store.listActionDispatches(event.id).length, 1);
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('delegation settlement records one result event atomically without delivery or resurrection', () => {
  const directory = mkdtempSync(join(tmpdir(), 'personal-work-')); const store = new PersonalStore(directory);
  try {
    store.putTask({ ...oldTask, id: 'parent', status: 'running', result: undefined });
    const child: Task = { ...oldTask, id: 'child', parentTaskId: 'parent', rootTaskId: 'parent', workKind: 'delegation', revision: 1, status: 'completed', result: { text: 'old research', verified: true, producedRevision: 1 } };
    store.putTask({ ...child, status: 'running', result: undefined });
    const attempt = { id: 'attempt', taskId: 'child', sessionId: 'child-session', status: 'completed' as const, startedAt: 1, startedRevision: 1, presentedRevision: 1 };
    assert.throws(() => store.transaction(() => { store.settleDelegationResult(child, attempt); throw new Error('crash before commit'); }), /crash/);
    assert.equal(store.getTask('child')?.result, undefined); assert.deepEqual(store.listWorkEvents(), []); assert.deepEqual(store.listAttempts('child'), []);
    const latest = store.getTask('child')!; latest.cancelRequested = true; latest.status = 'waiting'; latest.resourceHeld = true; latest.revision = 2; store.putTask(latest);
    const event = store.settleDelegationResult(child, attempt);
    assert.equal(event.state, 'blocked'); assert.equal(event.result?.producedRevision, 1);
    assert.equal(store.getTask('child')?.cancelRequested, true); assert.equal(store.getTask('child')?.status, 'waiting');
    assert.equal(store.getTask('child')?.resourceHeld, true); assert.equal(store.getTask('child')?.revision, 2);
    assert.deepEqual(store.settleDelegationResult(child, attempt), event);
    assert.equal(store.listWorkEvents().length, 1); assert.equal(store.listDeliveries().length, 0);
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('old child results remain reusable material while cancelled consumption stays blocked', () => {
  const directory = mkdtempSync(join(tmpdir(), 'personal-old-result-')); const store = new PersonalStore(directory);
  try {
    store.putTask({ ...oldTask, id: 'parent', status: 'running', revision: 4, result: undefined });
    const child: Task = { ...oldTask, id: 'child', parentTaskId: 'parent', rootTaskId: 'parent', workKind: 'delegation', status: 'completed', result: { text: 'sources found under original requirements', verified: true, producedRevision: 1 } };
    store.putTask({ ...child, revision: 2, status: 'running', result: undefined });
    const event = store.settleDelegationResult(child, { id: 'attempt', taskId: 'child', sessionId: child.sessionId, startedAt: 1, status: 'completed', presentedRevision: 1 });
    assert.equal(store.getTask('child')?.status, 'partial'); assert.equal(event.result?.verified, false);
    assert.equal(event.result?.text, 'sources found under original requirements'); assert.equal(store.getTask('parent')?.status, 'running');
    store.claimWorkEvent(event.id); store.recordWorkEventInjection(event.id, { sessionId: 'main', entryId: 'material', at: 2 });
    const stopped = store.getTask('child')!; stopped.cancelRequested = true; store.putTask(stopped);
    assert.equal(store.completeWorkEvent(event.id, { sessionId: 'main', entryId: 'review', at: 3 }).state, 'blocked');
    assert.equal(store.getWorkEvent(event.id)?.completion, undefined);
    assert.equal(store.listDeliveries().length, 0);
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
});
