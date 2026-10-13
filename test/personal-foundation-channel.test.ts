import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Bot } from 'grammy';
import { Response as ApiResponse } from 'node-fetch';
import { createPersonalRuntime } from '../src/personal/runtime.js';
import { createPersonalTelegram } from '../src/personal/telegram.js';
import { createTestServer } from './fixtures/http-server.js';
import { sendChatCompletion } from './fixtures/chat-completion.js';

test('Telegram explicitly saves a Steer while the real Pi request is still running', { timeout: 15000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'foundation-channel-'));
  const promptFile = join(directory, 'prompt.md'); await writeFile(promptFile, 'Help.');
  let ready!: () => void; const requested = new Promise<void>(resolve => { ready = resolve; });
  let release!: () => void; const barrier = new Promise<void>(resolve => { release = resolve; });
  let requests = 0; const presented: string[] = [];
  const server = createTestServer(t, async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    const wire = JSON.parse(body); presented.push(JSON.stringify(wire.messages));
    if (++requests === 1) { ready(); await barrier; }
    sendChatCompletion(res, 'Current work reviewed.');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const runtime = await createPersonalRuntime({ AGENT_DATA_DIR: join(directory, 'data'), AGENT_PROMPT_FILE: promptFile,
    MODEL_NAMES: 'test', MODEL_DEFAULT: 'test', MODEL_TEST_API_KEY: 'test', MODEL_TEST_API: 'openai-completions',
    MODEL_TEST_MODEL: 'test', MODEL_TEST_BASE_URL: `http://127.0.0.1:${address.port}` });
  const bot = new Bot('123:test', { botInfo: { id: 123, is_bot: true, first_name: 'test', username: 'test_bot',
    can_join_groups: false, can_read_all_group_messages: false, supports_inline_queries: false,
    can_connect_to_business: false, has_main_web_app: false, has_topics_enabled: false,
    allows_users_to_create_topics: false, can_manage_bots: false, supports_join_request_queries: false },
    client: { fetch: async () => new ApiResponse(JSON.stringify({ ok: true, result: { message_id: 99, date: 0, chat: { id: 42, type: 'private' } } })) } });
  const failures: unknown[] = [];
  const channel = createPersonalTelegram({ bot, ownerId: 42, host: runtime.host,
    download: async () => { throw new Error('unused'); }, reportFailure: error => { failures.push(error); } });
  t.after(async () => {
    release(); await channel.finish(); await channel.close(); await runtime.close();
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  });
  const send = (id: number, text: string) => bot.handleUpdate({ update_id: id,
    message: { message_id: id, date: 0, from: { id: 42, is_bot: false, first_name: 'owner' },
      chat: { id: 42, type: 'private', first_name: 'owner' }, text } });
  await send(1, 'review current work'); await requested;
  const task = runtime.host.listTasks()[0]!;
  await send(2, `/steer ${task.id} include the revised requirement`);
  assert.equal(runtime.host.getTask(task.id)?.revision, 1);
  assert.deepEqual(runtime.host.getTask(task.id)?.requirements, ['include the revised requirement']);
  release(); await channel.finish(); await runtime.host.waitForIdle();
  assert.ok(presented.slice(1).some(content => content.includes('include the revised requirement')));
  assert.deepEqual(failures, []);
});
