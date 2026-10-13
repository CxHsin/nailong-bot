import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPersonalRuntime } from '../src/personal/runtime.js';
import { createPlainChannel, cliInput } from '../src/personal/channels.js';
import { createTestServer } from './fixtures/http-server.js';
import { sendChatCompletion } from './fixtures/chat-completion.js';

test('plans and one-shot channel inputs do not inherit a chat workspace full access default', async t => {
  const root = await mkdtemp(join(tmpdir(), 'workspace-unattended-')); const project = join(root, 'project'); await mkdir(project);
  const promptFile = join(root, 'prompt.md'); await writeFile(promptFile, 'Help.');
  let name = 'local.txt'; const errors: string[] = [];
  const server = createTestServer(t, async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk; const wire = JSON.parse(body);
    if (wire.messages.at(-1).role === 'tool') { errors.push(String(wire.messages.at(-1).content)); return sendChatCompletion(res, 'result explained'); }
    sendChatCompletion(res, '', [{ index: 0, id: `write-${name}`, type: 'function', function: { name: 'write', arguments: JSON.stringify({ path: `../${name}`, content: 'effect' }) } }]);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); const address = server.address(); assert.ok(address && typeof address !== 'string');
  const runtime = await createPersonalRuntime({ AGENT_DATA_DIR: join(root, 'data'), AGENT_PROMPT_FILE: promptFile, MODEL_NAMES: 'test', MODEL_DEFAULT: 'test', MODEL_TEST_API_KEY: 'test', MODEL_TEST_API: 'openai-completions', MODEL_TEST_MODEL: 'test', MODEL_TEST_BASE_URL: `http://127.0.0.1:${address.port}` });
  const conversation = runtime.openLocalConversation({ actorId: 'owner', conversationId: 'same-chat', cwd: project });
  const channel = createPlainChannel({ host: runtime.host, accepts: () => true, sendText: async () => 'sent' });
  t.after(async () => { await channel.close(); await runtime.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(root, { recursive: true, force: true }); });
  await channel.receive(cliInput('write local material', conversation, 'owner')); await runtime.host.waitForIdle();
  assert.equal(await readFile(join(root, 'local.txt'), 'utf8'), 'effect');
  name = 'oneshot.txt'; const oneShot = cliInput('one-shot write', conversation, 'owner'); oneShot.origin = undefined;
  await channel.receive(oneShot); await runtime.host.waitForIdle();
  assert.match(errors.at(-1)!, /授权目录/); await assert.rejects(readFile(join(root, name)), { code: 'ENOENT' });
  name = 'plan.txt';
  await runtime.plans.handle(cliInput('schedule explicit work', conversation, 'owner'), { kind: 'schedule', plan: { goal: 'write planned material', cwd: project, dueAt: Date.now() - 1, timezone: 'Asia/Shanghai', missed: 'run' } });
  await runtime.plans.tick(); await runtime.host.waitForIdle();
  const planTask = runtime.host.listTasks(conversation).find(task => !task.direct)!;
  assert.equal(planTask.permission?.mode, 'restricted');
  assert.match(errors.at(-1)!, /授权目录/); await assert.rejects(readFile(join(root, name)), { code: 'ENOENT' });
  assert.equal(runtime.host.listTasks(conversation).find(task => task.goal === 'one-shot write')?.permission?.mode, 'restricted');
});

test('local interactive work uses project context and full access without a permission proposal', async t => {
  const root = await mkdtemp(join(tmpdir(), 'personal-foundation-workspace-'));
  const project = join(root, 'project'); await mkdir(project);
  const promptFile = join(root, 'prompt.md'); await writeFile(promptFile, 'Help.');
  await writeFile(join(project, 'AGENTS.md'), 'PROJECT_WORKSPACE_RULE');
  const systems: string[] = [];
  const server = createTestServer(t, async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    const wire = JSON.parse(body); systems.push(wire.messages.find((m: { role: string }) => m.role === 'system')?.content ?? '');
    if (wire.messages.at(-1).role === 'tool') {
      if (wire.messages.at(-1).tool_call_id === 'write-outside') return sendChatCompletion(res, '', [{ index: 0, id: 'shell-cwd', type: 'function', function: { name: 'bash', arguments: JSON.stringify({ command: `node -e "require('fs').writeFileSync('shell.txt',process.cwd())"` }) } }]);
      if (wire.messages.at(-1).tool_call_id === 'shell-cwd') return sendChatCompletion(res, '', [{ index: 0, id: 'delete-outside', type: 'function', function: { name: 'file_operation', arguments: JSON.stringify({ operation: 'delete', path: '../remove.txt' }) } }]);
      return sendChatCompletion(res, 'created');
    }
    sendChatCompletion(res, '', [{ index: 0, id: 'write-outside', type: 'function', function: { name: 'write', arguments: JSON.stringify({ path: '../outside.txt', content: '42' }) } }]);
  });
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const runtime = await createPersonalRuntime({ AGENT_DATA_DIR: join(root, 'data'), AGENT_PROMPT_FILE: promptFile, MODEL_NAMES: 'test', MODEL_DEFAULT: 'test', MODEL_TEST_API_KEY: 'test', MODEL_TEST_API: 'openai-completions', MODEL_TEST_MODEL: 'test', MODEL_TEST_BASE_URL: `http://127.0.0.1:${address.port}` });
  const conversationId = runtime.openLocalConversation({ actorId: 'owner', cwd: project });
  await writeFile(join(root, 'remove.txt'), 'delete explicitly requested');
  const replies: string[] = [];
  const channel = createPlainChannel({ host: runtime.host, accepts: id => id === conversationId, sendText: async (text, delivery) => { replies.push(text); return delivery.id; } });
  t.after(async () => { await channel.close(); await runtime.close(); await rm(root, { recursive: true, force: true }); });
  await channel.receive(cliInput('write ../outside.txt', conversationId, 'owner')); await channel.flush();
  assert.equal(await readFile(join(root, 'outside.txt'), 'utf8'), '42');
  assert.equal(await readFile(join(project, 'shell.txt'), 'utf8'), project);
  await assert.rejects(readFile(join(root, 'remove.txt')), { code: 'ENOENT' });
  assert.ok(systems[0]!.includes(project)); assert.match(systems[0]!, /PROJECT_WORKSPACE_RULE/);
  assert.equal(runtime.host.listTasks(conversationId)[0]?.cwd, project);
  assert.equal(runtime.host.listTasks(conversationId)[0]?.permission?.mode, 'trusted');
  assert.equal(runtime.host.store.listActions().length, 0); assert.ok(replies.includes('created'));
});

test('project sessions restore their original directory and mode while restricted and unattended work stay limited', async t => {
  const root = await mkdtemp(join(tmpdir(), 'personal-foundation-reopen-'));
  const project = join(root, 'first'); const other = join(root, 'second'); await Promise.all([mkdir(project), mkdir(other)]);
  const promptFile = join(root, 'prompt.md'); await writeFile(promptFile, 'Help.');
  await writeFile(join(project, 'AGENTS.md'), 'FIRST_PROJECT_ONLY'); await writeFile(join(other, 'AGENTS.md'), 'SECOND_PROJECT_ONLY');
  let operation = 'write'; const systems: string[] = []; const outputs: string[] = [];
  const server = createTestServer(t, async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    const wire = JSON.parse(body); systems.push(wire.messages.find((m: { role: string }) => m.role === 'system')?.content ?? '');
    if (wire.messages.at(-1).role === 'tool') { outputs.push(String(wire.messages.at(-1).content)); return sendChatCompletion(res, 'response'); }
    const args = operation === 'write' ? { path: '../escape.txt', content: 'must not write' } : { command: `node -e "require('fs').writeFileSync('unauthorized-shell.txt','bad')"` };
    sendChatCompletion(res, '', [{ index: 0, id: `${operation}-${systems.length}`, type: 'function', function: { name: operation, arguments: JSON.stringify(args) } }]);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const env = { AGENT_DATA_DIR: join(root, 'data'), AGENT_PROMPT_FILE: promptFile, MODEL_NAMES: 'test', MODEL_DEFAULT: 'test', MODEL_TEST_API_KEY: 'test', MODEL_TEST_API: 'openai-completions', MODEL_TEST_MODEL: 'test', MODEL_TEST_BASE_URL: `http://127.0.0.1:${address.port}` };
  let runtime = await createPersonalRuntime(env);
  t.after(async () => { await runtime.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(root, { recursive: true, force: true }); });
  const receive = async (id: string, text: string) => {
    const channel = createPlainChannel({ host: runtime.host, accepts: candidate => candidate === id, sendText: async (_text, delivery) => delivery.id });
    try { await channel.receive(cliInput(text, id, 'owner')); await channel.flush(); } finally { await channel.close(); }
  };
  const first = runtime.openLocalConversation({ actorId: 'owner', cwd: project, mode: 'restricted' });
  await receive(first, 'do not escape the restricted project');
  await assert.rejects(readFile(join(root, 'escape.txt')), { code: 'ENOENT' }); assert.match(outputs.at(-1)!, /授权目录/);
  const original = runtime.host.listTasks(first)[0]!;
  await runtime.close(); runtime = await createPersonalRuntime(env);
  assert.equal(runtime.openLocalConversation({ actorId: 'owner', cwd: other, conversationId: first }), first);
  operation = 'bash'; await receive(first, 'run command only if restricted backend supports it');
  assert.match(outputs.at(-1)!, /已验证后端/); await assert.rejects(readFile(join(project, 'unauthorized-shell.txt')), { code: 'ENOENT' });
  const recovered = runtime.host.listTasks(first).find(task => task.id !== original.id)!;
  assert.equal(recovered.cwd, project); assert.equal(recovered.permission?.mode, 'restricted'); assert.match(systems.at(-1)!, /FIRST_PROJECT_ONLY/); assert.doesNotMatch(systems.at(-1)!, /SECOND_PROJECT_ONLY/);
  const second = runtime.openLocalConversation({ actorId: 'owner', cwd: other }); assert.notEqual(first, second);
  operation = 'write'; await receive(second, 'write outside this full access project');
  assert.equal(await readFile(join(root, 'escape.txt'), 'utf8'), 'must not write'); assert.match(systems.at(-1)!, /SECOND_PROJECT_ONLY/); assert.doesNotMatch(systems.at(-1)!, /FIRST_PROJECT_ONLY/);
  operation = 'bash'; await receive('telegram:owner', 'unattended command retains existing limited execution');
  const unattended = runtime.host.listTasks('telegram:owner')[0]!; assert.equal(unattended.permission?.mode, 'restricted'); assert.match(outputs.at(-1)!, /已验证后端/);
  runtime.openLocalConversation({ actorId: 'owner', conversationId: first, cwd: other, mode: 'trusted' });
  assert.equal(runtime.host.getTask(original.id)?.permission?.mode, 'restricted');
});
