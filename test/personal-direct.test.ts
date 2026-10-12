import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPersonalRuntime } from '../src/personal/runtime.js';
import { createTestServer } from './fixtures/http-server.js';
import { sendChatCompletion } from './fixtures/chat-completion.js';

test('main dialogue writes actual files within a durable work instead of internal Session cwd', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'nailong-direct-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const promptFile = join(directory, 'prompt.md'); await writeFile(promptFile, 'Help.');
  const server = createTestServer(t, async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    const wire = JSON.parse(body); const last = wire.messages.at(-1);
    if (last.role === 'tool') return sendChatCompletion(res, 'created');
    sendChatCompletion(res, '', [{ index: 0, id: 'direct_write', type: 'function', function: { name: 'write', arguments: JSON.stringify({ path: 'answer.txt', content: '42' }) } }]);
  });
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const env = { AGENT_DATA_DIR: join(directory, 'data'), AGENT_PROMPT_FILE: promptFile, MODEL_NAMES: 'test', MODEL_DEFAULT: 'test', MODEL_TEST_API_KEY: 'test', MODEL_TEST_API: 'openai-completions', MODEL_TEST_MODEL: 'test', MODEL_TEST_BASE_URL: `http://127.0.0.1:${address.port}` };
  const runtime = await createPersonalRuntime(env);
  await runtime.host.submit({ conversationId: 'one', actorId: 'one', inputId: '1', text: 'create answer.txt' });
  const work = runtime.host.listTasks('one').find(task => task.direct);
  assert.ok(work, 'direct work is durable'); assert.notEqual(work.cwd, env.AGENT_DATA_DIR);
  assert.equal(await readFile(join(work.cwd!, 'answer.txt'), 'utf8'), '42');
  await runtime.close();
  const restarted = await createPersonalRuntime(env);
  assert.equal(restarted.host.getTask(work.id)?.cwd, work.cwd);
  await restarted.close();
});


async function directFixture(t: import('node:test').TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'nailong-permission-'));
  const promptFile = join(directory, 'prompt.md'); await writeFile(promptFile, 'Help.');
  let next: { name: string; args: unknown } = { name: 'write', args: { path: 'first.txt', content: 'first' } };
  let output = ''; let pending = '';
  const server = createTestServer(t, async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    const wire = JSON.parse(body); const last = wire.messages.at(-1);
    if (last.role === 'tool') { output = String(last.content); return sendChatCompletion(res, 'done'); }
    const match = (typeof last.content === 'string' ? last.content : last.content.map((part: { text?: string }) => part.text ?? '').join('\n')).match(/待确认动作：([^\n]+)/);
    if (match) { const actions = JSON.parse(match[1]); pending = actions.find((a: { status: string }) => a.status === 'pending')?.id ?? ''; }
    const args = next.name === 'authorize' ? { kind: 'authorize', actionId: pending, approved: true } : next.args;
    sendChatCompletion(res, '', [{ index: 0, id: `call_${next.name}`, type: 'function', function: { name: next.name === 'authorize' ? 'task_control' : next.name, arguments: JSON.stringify(args) } }]);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const runtime = await createPersonalRuntime({ AGENT_DATA_DIR: join(directory, 'data'), AGENT_PROMPT_FILE: promptFile, MODEL_NAMES: 'test', MODEL_DEFAULT: 'test', MODEL_TEST_API_KEY: 'test', MODEL_TEST_API: 'openai-completions', MODEL_TEST_MODEL: 'test', MODEL_TEST_BASE_URL: `http://127.0.0.1:${address.port}` });
  t.after(async () => { await runtime.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(directory, { recursive: true, force: true }); });
  let input = 0;
  return { runtime, directory, get output() { return output; }, async call(name: string, args: unknown, actorId = 'owner', replyToWork = true) { next = { name, args }; return runtime.host.submit({ conversationId: 'chat', actorId, inputId: String(++input), replyTaskId: replyToWork ? runtime.host.listTasks('chat').find(task => task.direct && !task.cancelRequested)?.id : undefined, text: `user explicitly requests ${name}` }); } };
}

test('main direct files reject physical directory escapes and hardlink mutation while preserving originals', async t => {
  const f = await directFixture(t); await f.call('write', { path: 'first.txt', content: 'first' });
  const work = f.runtime.host.listTasks()[0]!;
  const outside = join(f.directory, 'outside.txt'); await writeFile(outside, 'original');
  await f.call('write', { path: outside, content: 'bad' }); assert.match(f.output, /授权目录/);
  assert.equal(await readFile(outside, 'utf8'), 'original');
  const { link, symlink } = await import('node:fs/promises');
  await link(outside, join(work.cwd!, 'alias.txt'));
  await f.call('edit', { path: 'alias.txt', oldText: 'original', newText: 'bad' }); assert.match(f.output, /硬链接/);
  await symlink(f.directory, join(work.cwd!, 'escape'), 'junction');
  await f.call('write', { path: 'escape/outside.txt', content: 'bad' }); assert.match(f.output, /授权目录/);
  assert.equal(await readFile(outside, 'utf8'), 'original');
});

test('trusted grant remains a proposal until owner confirms then ordinary commands execute autonomously', async t => {
  const f = await directFixture(t); await f.call('write', { path: 'first.txt', content: 'first' });
  const work = f.runtime.host.listTasks()[0]!;
  const marker = join(work.cwd!, 'command.txt');
  const command = `"${process.execPath}" -e "require('node:fs').writeFileSync('command.txt','executed')"`;
  await f.call('bash', { command }); assert.match(f.output, /未派发命令/); await assert.rejects(readFile(marker), { code: 'ENOENT' });
  await f.call('work_permission', { mode: 'trusted', readRoots: [work.cwd], writeRoots: [work.cwd], network: false, expiresAt: Date.now() + 60_000 });
  assert.equal(f.runtime.host.getTask(work.id)?.permission?.mode, 'restricted');
  await f.call('authorize', {}, 'intruder'); assert.equal(f.runtime.host.getTask(work.id)?.permission?.mode, 'restricted');
  await f.call('authorize', {}); assert.equal(f.runtime.host.getTask(work.id)?.permission?.mode, 'trusted');
  await f.call('bash', { command });
  await f.call('bash', { command: command.replace('command.txt', 'second-command.txt') });
  assert.equal(await readFile(join(work.cwd!, 'second-command.txt'), 'utf8'), 'executed');
  assert.equal(await readFile(marker, 'utf8'), 'executed');
  await f.call('bash', { command }, 'owner', false); assert.match(f.output, /未派发命令/);
  const unrelated = f.runtime.host.listTasks().at(-1)!; assert.notEqual(unrelated.id, work.id); assert.equal(unrelated.permission?.mode, 'restricted');
});

test('controlled move preserves file contents, deletion waits for authorization and explicit owner delivery preserves unknown', async t => {
  const f = await directFixture(t); await f.call('write', { path: 'first.txt', content: 'first' });
  const work = f.runtime.host.listTasks()[0]!;
  await f.call('file_operation', { operation: 'mkdir', path: 'sorted' });
  await f.call('file_operation', { operation: 'move', path: 'first.txt', destination: 'sorted/first.txt' });
  assert.equal(await readFile(join(work.cwd!, 'sorted/first.txt'), 'utf8'), 'first');
  await f.call('file_operation', { operation: 'delete', path: 'sorted/first.txt' }); assert.match(f.output, /明确确认/);
  await f.call('authorize', {}); await f.call('file_operation', { operation: 'delete', path: 'sorted/first.txt' });
  await assert.rejects(readFile(join(work.cwd!, 'sorted/first.txt')), { code: 'ENOENT' });
  await f.call('send_message', { text: 'explicit completed message' });
  const delivery = f.runtime.host.pendingDeliveries().find(d => d.text === 'explicit completed message'); assert.ok(delivery);
  assert.equal(f.runtime.host.beginDelivery(delivery.id), true); f.runtime.host.recordDelivery(delivery.id, 'unknown');
  assert.equal(f.runtime.host.beginDelivery(delivery.id), false);
});




test('expired work permission and stopped work cannot mutate previously authorized files', async t => {
  const f = await directFixture(t); await f.call('write', { path: 'first.txt', content: 'first' });
  const work = f.runtime.host.listTasks()[0]!;
  await f.call('work_permission', { mode: 'restricted', readRoots: [work.cwd], writeRoots: [work.cwd], network: false, expiresAt: Date.now() + 250 });
  await f.call('authorize', {}); await new Promise(resolve => setTimeout(resolve, 300));
  await f.call('write', { path: 'first.txt', content: 'expired' }); assert.match(f.output, /过期/);
  assert.equal(await readFile(join(work.cwd!, 'first.txt'), 'utf8'), 'first');
  await f.call('task_control', { kind: 'cancel', taskId: work.id }); assert.equal(f.runtime.host.getTask(work.id)?.status, 'cancelled');
  await f.call('write', { path: join(work.cwd!, 'first.txt'), content: 'stopped' }); assert.match(f.output, /授权目录/);
  assert.equal(await readFile(join(work.cwd!, 'first.txt'), 'utf8'), 'first');
});
