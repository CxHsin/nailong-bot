import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PersonalHost } from '../src/personal/host.js';
import { PersonalStore } from '../src/personal/store.js';
import { createPlainChannel } from '../src/personal/channels.js';
import { createPersonalTelegram } from '../src/personal/telegram.js';
import { Bot } from 'grammy';
import { Response as ApiResponse } from 'node-fetch';
import type { Update } from 'grammy/types';
import { freezeArtifacts } from '../src/personal/artifacts.js';
import { createHash } from 'node:crypto';

test('delivery preserves accepted bytes across later workspace changes and rejects a stale acceptance', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'nailong-artifact-evidence-'));
  const { writeFile, readFile } = await import('node:fs/promises');
  const file = join(directory, 'result.txt');
  const host = new PersonalHost({ store: new PersonalStore(join(directory, 'data')),
    dialogue: { decide: async () => ({ kind: 'start', goal: 'result 42', cwd: directory }) },
    executor: { execute: async () => ({ text: 'unused', verified: false }) } });
  try {
    const response = await host.submit({ conversationId: 'one', actorId: 'one', inputId: '1', text: 'result 42' });
    await host.waitForIdle(); const task = host.getTask(response.taskId!)!;
    await writeFile(file, '42');
    const evidence = { text: '42 accepted', verified: true, artifacts: [file],
      artifactDigests: { [file]: createHash('sha256').update('42').digest('hex') } };
    const result = await freezeArtifacts(host.store.directory, task, evidence);
    await writeFile(file, '84');
    assert.equal(await readFile(result.artifacts![0]!, 'utf8'), '42');
    await assert.rejects(freezeArtifacts(host.store.directory, task, evidence), /验收后变化/);
  } finally { await host.close(); await rm(directory, { recursive: true, force: true }); }
});

test('confirmed delivery repairs failed learning after restart without sending again', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'nailong-learning-retry-'));
  const create = () => new PersonalHost({ store: new PersonalStore(directory),
    dialogue: { decide: async () => ({ kind: 'reply', text: 'confirmed answer' }) },
    executor: { execute: async () => ({ text: 'unused', verified: false }) } });
  let host = create(); let sends = 0; let learning = 0;
  let channel = createPlainChannel({ host, accepts: () => true, sendText: async () => { sends++; return '1'; },
    onDelivered: async () => { throw new Error('disk temporarily unavailable'); } });
  try {
    const response = await channel.receive({ conversationId: 'one', actorId: 'one', inputId: '1', text: 'hello' });
    await channel.flush(); assert.equal(host.delivery(response.deliveryId!)?.status, 'sent');
    await channel.close(); await host.close();
    host = create(); channel = createPlainChannel({ host, accepts: () => true,
      sendText: async () => { sends++; return 'unexpected'; }, onDelivered: async () => { learning++; } });
    await channel.recover(); await channel.recover();
    assert.equal(sends, 1); assert.equal(learning, 1);
    assert.equal(host.delivery(response.deliveryId!)?.learningRecorded, true);
  } finally { await channel.close(); await host.close(); await rm(directory, { recursive: true, force: true }); }
});

test('rejected page retry budget persists across restarts and explicit deliveries', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'nailong-page-budget-'));
  const create = () => new PersonalHost({ store: new PersonalStore(directory),
    dialogue: { decide: async () => ({ kind: 'reply', text: 'answer' }) },
    executor: { execute: async () => ({ text: 'unused', verified: false }) } });
  let host = create(); let sends = 0;
  const options = { accepts: () => true, sendText: async () => { sends++; throw Object.assign(new Error('rejected'), { error_code: 400 }); } };
  let channel = createPlainChannel({ ...options, host });
  try {
    const response = await channel.receive({ conversationId: 'one', actorId: 'one', inputId: '1', text: 'hello' });
    await channel.flush(); await channel.deliver(response.deliveryId!);
    await channel.close(); await host.close(); host = create(); channel = createPlainChannel({ ...options, host });
    await channel.deliver(response.deliveryId!); await channel.deliver(response.deliveryId!);
    assert.equal(sends, 3); assert.equal(host.delivery(response.deliveryId!)?.status, 'rejected');
  } finally { await channel.close(); await host.close(); await rm(directory, { recursive: true, force: true }); }
});

test('CLI → Host sends ordinary answers, persists split delivery, and does not resend an uncertain page', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'nailong-channel-'));
  const host = new PersonalHost({ store: new PersonalStore(directory),
    dialogue: { decide: async () => ({ kind: 'reply', text: '第一段。第二段。第三段。' }) },
    executor: { execute: async () => ({ text: 'unused', verified: false }) } });
  const visible: string[] = [];
  let disconnected = true;
  const channel = createPlainChannel({ host, maxChars: 5, accepts: () => true,
    sendText: async text => { if (visible.length === 1 && disconnected) throw new Error('connection lost'); visible.push(text); return String(visible.length); } });
  try {
    const response = await channel.receive({ conversationId: 'cli:one', actorId: 'one', inputId: '1', text: '说三段话' });
    await channel.flush();
    assert.equal(visible.length, 1);
    assert.equal(host.delivery(response.deliveryId!)?.status, 'unknown');
    disconnected = false;
    await channel.deliver(response.deliveryId!);
    assert.equal(visible.length, 1, 'uncertain send must not blindly repeat');
    assert.equal(host.listTasks().length, 0);
  } finally { await channel.close(); await host.close(); await rm(directory, { recursive: true, force: true }); }
});

test('Telegram → Host authenticates input, answers during file work, and delivers files without drafts or tool reports', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'nailong-telegram-'));
  const visible: Array<{ method: string; text?: string }> = [];
  let release!: () => void;
  const barrier = new Promise<void>(resolve => { release = resolve; });
  const host = new PersonalHost({ store: new PersonalStore(directory),
    dialogue: { decide: async input => input.text === '生成文件' ? { kind: 'start', goal: '生成文件' } : { kind: 'reply', text: '可以继续聊天' } },
    executor: { execute: async () => { await barrier; return { text: '已生成文件', verified: true, artifacts: [join(directory, 'result.txt')] }; } } });
  const bot = new Bot('123:test', { botInfo: { id: 123, is_bot: true, first_name: 'test', username: 'test_bot', can_join_groups: false, can_read_all_group_messages: false, supports_inline_queries: false,
    can_connect_to_business: false, has_main_web_app: false, has_topics_enabled: false, allows_users_to_create_topics: false,
    can_manage_bots: false, supports_join_request_queries: false },
    client: { fetch: async (url, init) => {
      const method = new URL(String(url)).pathname.split('/').at(-1)!;
      if (method !== 'sendMessage' && method !== 'sendDocument') throw new Error(`Unexpected UI operation: ${method}`);
      const payload = method === 'sendMessage' ? JSON.parse(String(init?.body)) : undefined;
      visible.push({ method, text: payload?.text });
      return new ApiResponse(JSON.stringify({ ok: true, result: { message_id: visible.length, date: 0, chat: { id: 42, type: 'private' } } }));
    } } });
  const channel = createPersonalTelegram({ bot, ownerId: 42, host, download: async () => { throw new Error('unused'); }, reportFailure: error => { throw error; } });
  const send = async (id: number, from: number, text: string) => {
    const update: Update = { update_id: id, message: { message_id: id, date: 0, from: { id: from, is_bot: false, first_name: 'user' }, chat: { id: from, type: 'private', first_name: 'user' }, text } };
    await bot.handleUpdate(update); await channel.finish(); await channel.flush();
  };
  try {
    const { writeFile } = await import('node:fs/promises'); await writeFile(join(directory, 'result.txt'), '真实成果');
    await send(1, 7, '未经授权'); assert.equal(visible.length, 0);
    await send(2, 42, '生成文件');
    await send(3, 42, '还在吗');
    assert.equal(host.listTasks()[0]?.status, 'running');
    assert.ok(visible.some(item => item.text === '可以继续聊天'));
    release(); await host.waitForIdle(); await channel.flush();
    assert.equal(visible.filter(item => item.method === 'sendDocument').length, 1);
    assert.equal(visible.filter(item => item.text?.startsWith('已接收任务')).length, 1);
    assert.deepEqual(new Set(visible.map(item => item.method)), new Set(['sendMessage', 'sendDocument']));
  } finally { release(); await channel.close(); await host.close(); await rm(directory, { recursive: true, force: true }); }
});
