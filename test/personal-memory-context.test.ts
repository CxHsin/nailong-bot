import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, readdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPersonalMemory } from '../src/personal/memory.js';
import { createPersonalPi } from '../src/personal/pi.js';
import { PersonalHost } from '../src/personal/host.js';
import { PersonalStore } from '../src/personal/store.js';
import { createPersonalRuntime } from '../src/personal/runtime.js';
import { createTestServer } from './fixtures/http-server.js';
import { sendChatCompletion } from './fixtures/chat-completion.js';
import { recallIdentity } from '../src/personal/memory-context.js';

test('durable recall retains overflow source references and shrinks to the current model budget', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'personal-budget-'));
  const historical = { async read() { return Array.from({ length: 20 }, (_, index) => [
    { type: 'message', requestId: `n${index}`, role: 'user', text: '秘密原文😀'.repeat(700), chatId: 1, conversationId: 'telegram:private:1', at: '2026-01-01T00:00:00Z' },
    { type: 'answer_generated', requestId: `n${index}`, text: '秘密回复😀'.repeat(700), conversationId: 'telegram:private:1', at: '2026-01-01T00:00:01Z' },
    { type: 'delivery_succeeded', requestId: `n${index}`, conversationId: 'telegram:private:1', at: '2026-01-01T00:00:02Z' },
    { type: 'request_completed', requestId: `n${index}`, conversationId: 'telegram:private:1', at: '2026-01-01T00:00:03Z' },
  ]).flat(); } };
  const memory = createPersonalMemory({ dataDir: directory, historical, invalidateSessions: async () => {} });
  t.after(async () => { await memory.close(); await rm(directory, { recursive: true, force: true }); });
  const input = { conversationId: 'telegram:private:1', actorId: '1', inputId: 'budget', text: '秘密' };
  const full = (await memory.recall(input, 'large', 40960))!;
  assert.equal(full.references.length, 40); assert.ok(full.spans.every(span => span.end <= 1000));
  assert.ok(Math.ceil(Buffer.byteLength(full.content) / 3) + 24 <= full.budget);
  const tiny = (await memory.recall(input, 'small', 1000))!;
  assert.equal(tiny.references.length, 40); assert.ok(!tiny.content || Math.ceil(Buffer.byteLength(tiny.content) / 3) + 24 <= tiny.budget);
  assert.equal(memory.getRecall(recallIdentity(input))!.budget, tiny.budget);
  assert.equal((await memory.recall(input, 'zero', 0))!.content, '');
});

test('actual input time survives delayed delivery; older unknown source time stays unknown', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'personal-input-time-'));
  const memory = createPersonalMemory({ dataDir: directory, invalidateSessions: async () => {} });
  t.after(async () => { await memory.close(); await rm(directory, { recursive: true, force: true }); });
  const inputAt = Date.parse('2026-01-01T00:00:00Z');
  await memory.recordDeliveredTurn({ id: 'delayed', actorId: 'telegram:private:1', userText: '最初用户要求', assistantText: '稍后完成', originInputId: 'real-input', inputAt });
  await memory.recordDeliveredTurn({ id: 'old', actorId: 'telegram:private:1', userText: '旧来源无时间', assistantText: '旧结果' });
  const nodes = await memory.nodes('telegram:private:1');
  assert.equal(nodes.find(node => node.id === 'delayed')!.messages[0]!.at, new Date(inputAt).toISOString());
  assert.ok(Date.parse(nodes.find(node => node.id === 'delayed')!.messages[1]!.at) > inputAt);
  assert.equal(nodes.find(node => node.id === 'old')!.messages[0]!.at, '');
});

test('process death during an actual embedding request leaves unavailable recall and never repeats retrieval', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'personal-recall-crash-')); let requests = 0; let seen!: () => void;
  const reached = new Promise<void>(resolve => { seen = resolve; });
  const server = createTestServer(t, async (request, _response) => { for await (const _part of request) {} requests++; seen(); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); const address = server.address(); assert.ok(address && typeof address !== 'string');
  const input = { conversationId: 'telegram:private:1', actorId: '1', inputId: 'crash', text: '回忆一个秘密' };
  const options = { dataDir: directory, embedding: { baseUrl: `http://127.0.0.1:${address.port}`, model: 'local', apiKey: 'fixture', timeoutMs: 30000 } };
  const source = `import { createPersonalMemory } from ${JSON.stringify(new URL('../src/personal/memory.ts', import.meta.url).href)}; const memory = createPersonalMemory({ ...${JSON.stringify(options)}, invalidateSessions: async () => {} }); await memory.recordDeliveredTurn({ id: 'original', actorId: 'telegram:private:1', userText: '秘密是银杏', assistantText: '记住了', inputAt: Date.now() }); await memory.recall(${JSON.stringify(input)}, 'local', 10000); await memory.close();`;
  const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', source], { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] });
  let childError = ''; child.stderr.on('data', data => { childError += data; });
  t.after(async () => { child.kill(); server.closeAllConnections(); if (server.listening) await new Promise<void>(resolve => server.close(() => resolve())); await rm(directory, { recursive: true, force: true }); });
  await Promise.race([reached, once(child, 'exit').then(() => { throw new Error(`Child exited before embedding: ${childError}`); }), new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error('Embedding barrier timeout')), 20000); timer.unref(); })]);
  const exited = once(child, 'exit'); child.kill(); await exited;
  const memory = createPersonalMemory({ ...options, invalidateSessions: async () => {} });
  try { assert.equal(memory.getRecall(recallIdentity(input))?.state, 'started'); const recovered = await memory.recall(input, 'local', 10000); assert.equal(recovered?.state, 'unavailable'); assert.match(recovered!.error!, /未知/); assert.equal(requests, 1); }
  finally { await memory.close(); }
});

test('memory schema backs up older originals consistently and refuses a future version', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'personal-memory-upgrade-')); const file = join(directory, 'personal-memory.sqlite');
  t.after(() => rm(directory, { recursive: true, force: true }));
  const old = new DatabaseSync(file); old.exec('CREATE TABLE memory_records(id TEXT PRIMARY KEY,payload TEXT NOT NULL)'); old.prepare('INSERT INTO memory_records VALUES(?,?)').run('original', JSON.stringify({ type: 'message', role: 'user', text: '保留', at: '2026-01-01', chatId: 1, conversationId: 'telegram:private:1' })); old.close();
  const memory = createPersonalMemory({ dataDir: directory, invalidateSessions: async () => {} }); assert.equal((await memory.nodes('telegram:private:1'))[0]?.messages[0]?.text, '保留'); await memory.close();
  const backups = await readdir(join(directory, 'memory-schema-backups')); assert.equal(backups.length, 1);
  const backup = new DatabaseSync(join(directory, 'memory-schema-backups', backups[0]!), { readOnly: true }); assert.equal(Object.values(backup.prepare('PRAGMA quick_check').get()!)[0], 'ok'); assert.equal(backup.prepare('SELECT count(*) AS n FROM memory_records').get()!.n, 1); backup.close();
  const future = new DatabaseSync(file); future.exec('UPDATE memory_schema SET version=99'); future.close(); assert.throws(() => createPersonalMemory({ dataDir: directory, invalidateSessions: async () => {} }), /高于/);
});

for (const limit of [1, 50]) test(`production embedding HTTP respects durable global budget and finite background retries (${limit})`, { timeout: 10000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'personal-embedding-budget-')); const promptFile = join(directory, 'prompt.md'); await writeFile(promptFile, 'Help.');
  let embeddings = 0; let modelCalls = 0; let lastAttempt!: () => void;
  const reached = new Promise<void>(resolve => { lastAttempt = resolve; });
  const server = createTestServer(t, async (request, response) => {
    for await (const _part of request) {}
    if (request.url?.endsWith('/embeddings')) { embeddings++; response.writeHead(500); response.end('unavailable'); if (embeddings === (limit === 1 ? 1 : 4)) lastAttempt(); }
    else { modelCalls++; sendChatCompletion(response, '梧桐'); }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); const address = server.address(); assert.ok(address && typeof address !== 'string');
  const runtime = await createPersonalRuntime({ AGENT_DATA_DIR: directory, AGENT_PROMPT_FILE: promptFile,
    MODEL_NAMES: 'local', MODEL_DEFAULT: 'local', MODEL_LOCAL_API: 'openai-completions', MODEL_LOCAL_MODEL: 'local', MODEL_LOCAL_API_KEY: 'fixture', MODEL_LOCAL_BASE_URL: `http://127.0.0.1:${address.port}`,
    EMBEDDING_BASE_URL: `http://127.0.0.1:${address.port}`, EMBEDDING_MODEL: 'local', EMBEDDING_API_KEY: 'fixture', AGENT_DAILY_MAX_CALLS: String(limit) });
  t.after(async () => { await runtime.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(directory, { recursive: true, force: true }); });
  await runtime.memory!.recordDeliveredTurn({ id: 'old', actorId: 'telegram:private:1', userText: '秘密是银杏', assistantText: '已经记录', inputAt: Date.now() });
  const input = { conversationId: 'telegram:private:1', actorId: '1', inputId: 'budget-input', text: '秘密' };
  if (limit === 1) await assert.rejects(runtime.host.submit(input), /预算/); else await runtime.host.submit(input);
  await reached; await new Promise(resolve => setTimeout(resolve, 600));
  assert.equal(embeddings, limit === 1 ? 1 : 4); assert.equal(modelCalls, limit === 1 ? 0 : 1);
  const budget = runtime.host.store.getBudget(`global:${new Date().toISOString().slice(0, 10)}`)!;
  assert.equal(budget.calls, embeddings + modelCalls); assert.equal(budget.costKnown, false);
  if (limit === 1) {
    await assert.rejects(runtime.host.submit({ ...input, inputId: 'next' }), /预算/);
    assert.equal(runtime.memory!.getRecall(recallIdentity({ ...input, inputId: 'next' })), undefined);
    assert.equal(embeddings, 1);
  }
});

async function fixture(t: TestContext, handler: (wire: any, response: Parameters<typeof sendChatCompletion>[0]) => void) {
  const directory = await mkdtemp(join(tmpdir(), 'personal-recall-')); const promptFile = join(directory, 'prompt.md'); await writeFile(promptFile, 'Be helpful.');
  const historical = { async read() { return [
    { type: 'message', requestId: 'old', conversationId: 'telegram:private:1', role: 'user', text: '秘密代号是银杏', chatId: 1, at: '2026-10-01T00:00:00Z' },
    { type: 'answer_generated', requestId: 'old', conversationId: 'telegram:private:1', text: '助手建议改成榕树', at: '2026-10-01T00:00:01Z' },
    { type: 'delivery_succeeded', requestId: 'old', conversationId: 'telegram:private:1', at: '2026-10-01T00:00:02Z' },
    { type: 'request_completed', requestId: 'old', conversationId: 'telegram:private:1', at: '2026-10-01T00:00:03Z' },
  ]; } };
  const server = createTestServer(t, async (request, response) => { let text = ''; for await (const part of request) text += part; handler(JSON.parse(text), response); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); const address = server.address(); assert.ok(address && typeof address !== 'string');
  const options = { dataDir: directory, promptFile, modelConfiguration: { defaultModel: 'local', models: [{ alias: 'local', api: 'openai-completions' as const,
    baseUrl: `http://127.0.0.1:${address.port}`, model: 'local', apiKey: 'fixture' }] },
    workContext: (task: import('../src/personal/types.js').Task, originId: string) => host.workContext({ conversationId: task.conversationId, actorId: task.actorId, inputId: originId, text: task.goal }, task.id) };
  let memory = createPersonalMemory({ dataDir: directory, historical, invalidateSessions: async () => { await host.excludeConversationContext(input.conversationId); await pi.reset(); } });
  let pi = await createPersonalPi({ ...options, memory }); let host = new PersonalHost({ store: new PersonalStore(directory), dialogue: pi.dialogue, executor: pi.executor });
  const input = { conversationId: 'telegram:private:1', actorId: '1', inputId: 'input1', text: '回忆我的秘密；现在使用梧桐，不采用旧建议。' };
  t.after(async () => { await host.close(); await pi.close(); await memory.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(directory, { recursive: true, force: true }); });
  return { directory, input, get memory() { return memory; }, get pi() { return pi; }, get host() { return host; },
    async reopen() { await host.close(); await pi.close(); await memory.close(); memory = createPersonalMemory({ dataDir: directory, historical, invalidateSessions: async () => pi.reset() }); pi = await createPersonalPi({ ...options, memory }); host = new PersonalHost({ store: new PersonalStore(directory), dialogue: pi.dialogue, executor: pi.executor }); } };
}

test('real user input receives bounded original background with roles and current expression preserved', async t => {
  let content = '';
  const run = await fixture(t, (wire, response) => {
    content = JSON.stringify(wire.messages);
    sendChatCompletion(response, '梧桐');
  });
  assert.equal((await run.host.submit(run.input)).text, '梧桐');
  assert.match(content, /秘密代号是银杏/); assert.match(content, /助手建议改成榕树/);
  assert.match(content, /2026-10-01/); assert.match(content, /当前.*优先/); assert.match(content, /现在使用梧桐/);
});

test('retry and restart reuse one recall snapshot and one original background entry', async t => {
  let failed = true; const backgrounds: number[] = [];
  const run = await fixture(t, (wire, response) => {
    backgrounds.push(wire.messages.filter((message: { content: unknown }) => JSON.stringify(message.content).includes('相关历史原文')).length);
    if (failed) { response.writeHead(400); response.end('{"error":{"message":"fixture failure"}}'); } else sendChatCompletion(response, 'restored');
  });
  await assert.rejects(run.host.submit(run.input));
  const prior = run.memory.getRecall(recallIdentity(run.input)); assert.equal(prior?.state, 'ready');
  failed = false; await run.reopen();
  assert.equal((await run.host.submit({ ...run.input, text: 'duplicate changed body' })).text, 'restored');
  assert.equal(run.memory.getRecall(recallIdentity(run.input))?.query, run.input.text);
  assert.equal(run.memory.getRecall(recallIdentity(run.input))?.content, prior?.content);
  assert.deepEqual(backgrounds, [1, 1]);
});

test('scheduled origin has no automatic recall and exclusion prevents old snapshots returning', async t => {
  const run = await fixture(t, (_wire, response) => sendChatCompletion(response, 'done'));
  await run.host.submit({ ...run.input, inputId: 'plan1', origin: 'plan' });
  assert.equal(run.memory.getRecall(recallIdentity({ ...run.input, inputId: 'plan1' })), undefined);
  await run.host.submit(run.input);
  const node = (await run.memory.nodes(run.input.conversationId))[0]!;
  await run.memory.forget(run.input.conversationId, node.id);
  const record = await run.memory.recall(run.input, 'fixture', 10000);
  assert.equal(record?.state, 'excluded'); assert.equal(record?.content, '');
});

test('confirmed delivery learns the presented originals after restart once', async t => {
  const run = await fixture(t, (_wire, response) => sendChatCompletion(response, '梧桐'));
  await run.host.submit(run.input);
  const learning = run.host.pendingDeliveries(run.input.conversationId)[0]!.learning!;
  await run.reopen();
  await run.memory.recordDeliveredTurn({ id: learning.id, actorId: run.input.conversationId, userText: learning.input, assistantText: learning.answer, recallId: learning.recallId });
  await run.memory.recordDeliveredTurn({ id: learning.id, actorId: run.input.conversationId, userText: learning.input, assistantText: learning.answer, recallId: learning.recallId });
  const evidence = await run.memory.deliveryLearning(learning.id);
  assert.equal(evidence.length, 1); assert.equal((evidence[0]!.activated as unknown[]).length, 1);
});

test('working agreements require exact human confirmation, persist scope, and never grant permissions', async t => {
  const run = await fixture(t, (_wire, response) => sendChatCompletion(response, 'done'));
  await run.host.submit(run.input);
  const work = run.host.workContext(run.input); const before = work.current().permission;
  const proposal = run.host.proposeAgreement(run.input, { operation: 'save', content: '报告使用中文', scope: { kind: 'work', id: work.task.id } });
  assert.match(proposal.text, /报告使用中文/); assert.match(proposal.text, /work/);
  const action = run.host.store.listActions(work.task.id).find(value => value.action.kind === 'working-agreement')!;
  const proposalAgain = run.host.proposeAgreement(run.input, { operation: 'save', content: '报告使用中文', scope: { kind: 'work', id: work.task.id } });
  assert.equal(proposalAgain.text, proposal.text); assert.equal(run.host.store.listActions(work.task.id).filter(value => value.action.kind === 'working-agreement').length, 1);
  run.host.authorizeAction({ ...run.input, inputId: 'chat', text: '今天天气不错' }, action.id, true);
  assert.equal(run.host.agreements(work.task.id).length, 0);
  run.host.authorizeAction({ ...run.input, inputId: 'confirm', text: `确认动作 ${action.id}` }, action.id, true);
  assert.equal(run.host.agreements(work.task.id)[0]?.content, '报告使用中文');
  assert.deepEqual(work.current().permission, before);
  await run.reopen(); assert.equal(run.host.agreements(work.task.id)[0]?.content, '报告使用中文');
  const other = run.host.workContext({ ...run.input, inputId: 'other' }); assert.equal(run.host.agreements(other.task.id).length, 0);
  const original = run.host.agreements(work.task.id)[0]!;
  const editingInput = { ...run.input, inputId: 'edit', replyTaskId: work.task.id, text: '改为简短中文' };
  run.host.proposeAgreement(editingInput, { operation: 'edit', id: original.id, content: '报告使用简短中文' });
  const edit = run.host.store.listActions(work.task.id).find(value => value.action.kind === 'working-agreement' && value.status === 'pending')!;
  run.host.authorizeAction({ ...editingInput, inputId: 'edit-confirm', text: `确认动作 ${edit.id}` }, edit.id, true);
  assert.equal(run.host.agreements(work.task.id)[0]?.revision, 2);
  const revokingInput = { ...editingInput, inputId: 'revoke', text: '撤销这个约定' };
  run.host.proposeAgreement(revokingInput, { operation: 'revoke', id: original.id });
  const revoke = run.host.store.listActions(work.task.id).find(value => value.action.kind === 'working-agreement' && value.status === 'pending')!;
  run.host.authorizeAction({ ...revokingInput, inputId: 'revoke-confirm', text: `确认动作 ${revoke.id}` }, revoke.id, true);
  assert.equal(run.host.agreements(work.task.id).length, 0); assert.equal(run.host.store.listAgreements()[0]?.history.length, 2);
  const globalInput = { ...editingInput, inputId: 'global', text: '全局约定使用中文' };
  run.host.proposeAgreement(globalInput, { operation: 'save', content: '使用中文', scope: { kind: 'global' } });
  const global = run.host.store.listActions(work.task.id).find(value => value.action.kind === 'working-agreement' && value.status === 'pending')!;
  run.host.authorizeAction({ ...globalInput, inputId: 'global-confirm', text: `确认动作 ${global.id}` }, global.id, true);
  assert.equal(run.host.agreements(other.task.id)[0]?.scope.kind, 'global');
  assert.equal(run.host.applicableAgreements({ ...run.input, actorId: '2', inputId: 'other-actor' }).length, 0);
});

test('a helper requests additional background as durable parent material without creating a user input', async t => {
  const run = await fixture(t, (_wire, response) => sendChatCompletion(response, 'done'));
  const parent = run.host.workContext(run.input).task;
  const child = run.host.delegateWork(parent.id, { goal: '研究银杏', purpose: 'research' }, 'child1');
  const work = run.host.workContext({ ...run.input, inputId: 'attempt1', text: child.goal }, child.id);
  const event = work.requestContext!('request1', '需要此前银杏原话');
  assert.equal(event.kind, 'context_request'); assert.equal(event.parentTaskId, parent.id); assert.equal(event.taskId, child.id);
  assert.equal(run.host.store.getWorkEvent(event.id)?.query, '需要此前银杏原话');
  assert.equal(work.requestContext!('request1', '需要此前银杏原话').id, event.id);
  assert.throws(() => work.requestContext!('request1', '替换此前请求'), /不能更换/);
  assert.equal(run.memory.getRecall(recallIdentity({ ...run.input, inputId: 'attempt1' })), undefined);
});

test('parent selects originals for a helper request and resumes it without automatic recall or history tools', async t => {
  let selected: { nodeId: string; messageId: string } | undefined; let childReceived = false; let requested = false;
  const run = await fixture(t, (wire, response) => {
    const names = wire.tools?.map((tool: { function: { name: string } }) => tool.function.name) ?? [];
    const call = (name: string, args: unknown) => sendChatCompletion(response, '', [{ index: 0, id: name, type: 'function', function: { name, arguments: JSON.stringify(args) } }]);
    if (names.includes('submit_material')) {
      assert.equal(names.includes('memory_search'), false); assert.equal(names.includes('memory_read'), false);
      if (!requested) { requested = true; call('request_context', { query: '需要此前银杏原话' }); }
      else { childReceived ||= JSON.stringify(wire.messages).includes('秘密代号是银杏'); sendChatCompletion(response, '已读取本体提供原文'); }
    } else if (names.includes('provide_context') && wire.messages.at(-1)?.role !== 'tool') call('provide_context', { sources: [selected], reason: '提供相关原文' });
    else sendChatCompletion(response, 'done');
  });
  await run.host.submit(run.input);
  const node = (await run.memory.nodes(run.input.conversationId))[0]!; selected = { nodeId: node.id, messageId: node.messages[0]!.id };
  const parent = run.host.workContext(run.input).task;
  const child = run.host.delegateWork(parent.id, { goal: '研究银杏', purpose: 'research' }, 'child1');
  await run.host.waitForIdle();
  const event = run.host.store.listWorkEvents().find(event => event.kind === 'context_request')!;
  assert.equal(event.state, 'consumed'); assert.ok(event.injection); assert.ok(event.completion);
  assert.equal(childReceived, true); assert.equal(run.host.getTask(child.id)?.contextPacket?.spans[0]?.role, 'user');
  assert.equal(run.memory.getRecall(recallIdentity(run.input))?.inputId, run.input.inputId);
  assert.equal(run.memory.recalls(run.input.conversationId).length, 1);
  await run.reopen(); await run.host.recover(); await run.host.waitForIdle();
  assert.equal(run.host.store.listWorkEvents().filter(event => event.kind === 'context_request').length, 1);
});
