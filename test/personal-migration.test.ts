import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { PersonalStore } from '../src/personal/store.js';
import { PersonalHost } from '../src/personal/host.js';
import { createPersonalPi } from '../src/personal/pi.js';
import { migratePersonalHistory } from '../src/personal/migration.js';
import { configuredModel } from '../src/agent/model-config.js';
import { sendChatCompletion } from './fixtures/chat-completion.js';

test('Host continues migrated conversation without tasks, deliveries, or rewriting original history', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'personal-migration-'));
  const promptFile = join(directory, 'prompt.md'); await writeFile(promptFile, 'Be helpful.');
  const source = [
    { type: 'message', role: 'user', text: '项目名字是莲花', requestId: 'r1', conversationId: 'c', at: '2026-10-10T00:00:00Z' },
    { type: 'answer_generated', text: '我会记住莲花', requestId: 'r1', conversationId: 'c', at: '2026-10-10T00:00:01Z' },
    { type: 'delivery_succeeded', requestId: 'r1', conversationId: 'c', at: '2026-10-10T00:00:02Z' },
  ].map(event => JSON.stringify(event)).join('\n') + '\n';
  await writeFile(join(directory, 'events.jsonl'), source);
  let seesHistory = false;
  const server = createServer(async (request, response) => {
    let body = ''; for await (const chunk of request) body += chunk;
    seesHistory = JSON.parse(body).messages.some((message: { content: unknown }) => JSON.stringify(message.content).includes('项目名字是莲花'));
    sendChatCompletion(response, seesHistory ? '莲花' : '不知道');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const config = { alias: 'local', api: 'openai-completions' as const, model: 'local', baseUrl: `http://127.0.0.1:${address.port}`, apiKey: 'test' };
  const store = new PersonalStore(directory); let pi: Awaited<ReturnType<typeof createPersonalPi>> | undefined; let host: PersonalHost | undefined;
  try {
    await migratePersonalHistory(store, configuredModel(config));
    await migratePersonalHistory(store, configuredModel(config));
    pi = await createPersonalPi({ dataDir: directory, promptFile, modelConfiguration: { defaultModel: 'local', models: [config] } });
    host = new PersonalHost({ store, dialogue: pi.dialogue, executor: pi.executor });
    assert.equal(host.listTasks().length, 0); assert.equal(host.pendingDeliveries().length, 0);
    const result = await host.submit({ conversationId: 'c', actorId: 'a', inputId: 'new', text: '项目叫什么名字？' });
    assert.equal(result.text, '莲花'); assert.equal(seesHistory, true);
    await pi.reset(store.conversationSession('c'));
    await migratePersonalHistory(store, configuredModel(config));
    seesHistory = false;
    const resetResult = await host.submit({ conversationId: 'c', actorId: 'a', inputId: 'after-reset', text: '现在能看到什么？' });
    assert.equal(resetResult.text, '不知道', 'explicit reset must not reimport original history on next startup');
    assert.equal(await readFile(join(directory, 'events.jsonl'), 'utf8'), source);
  } finally { if (host) await host.close(); else store.close(); await pi?.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(directory, { recursive: true, force: true }); }
});

test('Host startup rejects a corrupt historical active start and leaves original source unchanged', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'personal-migration-corrupt-'));
  const source = [
    { type: 'message', role: 'user', text: 'keep requirement', requestId: 'r', conversationId: 'c', at: '2026-10-10T00:00:00Z' },
    { type: 'active_context_started', version: 1, activeContextId: 'a', resetIdentity: 'initial', initialRequestIds: ['r'], sourceThrough: 1, sourceDigest: 'corrupt', conversationId: 'c', at: '2026-10-10T00:00:01Z' },
  ].map(event => JSON.stringify(event)).join('\n') + '\n';
  await writeFile(join(directory, 'events.jsonl'), source); const store = new PersonalStore(directory);
  try {
    await assert.rejects(async () => { await migratePersonalHistory(store, configuredModel({ alias: 'local', api: 'openai-completions', model: 'local', baseUrl: 'http://localhost', apiKey: 'test' })); return new PersonalHost({ store, dialogue: { async decide() { return { kind: 'reply', text: 'unexpected' }; } }, executor: { async execute() { return { text: 'unexpected', verified: true }; } } }); }, /活动上下文起点损坏/);
    assert.equal(await readFile(join(directory, 'events.jsonl'), 'utf8'), source);
  } finally { store.close(); await rm(directory, { recursive: true, force: true }); }
});

test('Host resumes an interrupted migration without duplicating Session history or restoring forgotten content', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'personal-migration-retry-'));
  const promptFile = join(directory, 'prompt.md'); await writeFile(promptFile, 'Be helpful.');
  const events = [
    { type: 'message', role: 'user', text: '秘密内容 forbidden-secret', requestId: 'forgotten', conversationId: 'c', at: '2026-10-10T00:00:00Z' },
    { type: 'message', role: 'user', text: '有效约束 keep-valid', requestId: 'retained', conversationId: 'c', at: '2026-10-10T00:00:01Z' },
    { type: 'memory_excluded', nodeId: 'forgotten', conversationId: 'c', at: '2026-10-10T00:00:02Z' },
  ];
  const source = events.map(event => JSON.stringify(event)).join('\n') + '\n'; await writeFile(join(directory, 'events.jsonl'), source);
  let seesForgotten = false; let retainedOccurrences = 0;
  const server = createServer(async (request, response) => { let body = ''; for await (const chunk of request) body += chunk; seesForgotten = body.includes('forbidden-secret'); retainedOccurrences = body.split('keep-valid').length - 1; sendChatCompletion(response, '约束仍有效'); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); const address = server.address(); assert.ok(address && typeof address !== 'string');
  const config = { alias: 'local', api: 'openai-completions' as const, model: 'local', baseUrl: `http://127.0.0.1:${address.port}`, apiKey: 'test' };
  const store = new PersonalStore(directory); let host: PersonalHost | undefined; let pi: Awaited<ReturnType<typeof createPersonalPi>> | undefined;
  try {
    await migratePersonalHistory(store, configuredModel(config));
    await rm(join(directory, 'personal-history-migration.json')); // interruption after Session rename, before manifest commit
    await migratePersonalHistory(store, configuredModel(config));
    pi = await createPersonalPi({ dataDir: directory, promptFile, modelConfiguration: { defaultModel: 'local', models: [config] } });
    host = new PersonalHost({ store, dialogue: pi.dialogue, executor: pi.executor });
    await host.submit({ conversationId: 'c', actorId: 'a', inputId: '1', text: '继续遵守之前的约束' });
    assert.equal(seesForgotten, false); assert.equal(retainedOccurrences, 1); assert.equal(host.listTasks().length, 1);
    assert.equal(host.listTasks()[0]?.status, 'waiting');
    assert.equal(await readFile(join(directory, 'events.jsonl'), 'utf8'), source);
  } finally { if (host) await host.close(); else store.close(); await pi?.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(directory, { recursive: true, force: true }); }
});
