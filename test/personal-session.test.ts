import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { PersonalHost } from '../src/personal/host.js';
import { PersonalStore } from '../src/personal/store.js';
import { createPersonalPi } from '../src/personal/pi.js';
import { createPersonalMemory } from '../src/personal/memory.js';
import { sendChatCompletion } from './fixtures/chat-completion.js';

test('Host conversation continues its native Session after reopening', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'personal-session-'));
  const promptFile = join(directory, 'prompt.md');
  await writeFile(promptFile, 'Be helpful.');
  let sawEarlierUser = false;
  const server = createServer(async (request, response) => {
    let body = ''; for await (const part of request) body += part;
    const wire = JSON.parse(body);
    sawEarlierUser ||= wire.messages.some((message: { role: string; content: unknown }) => message.role === 'user' && JSON.stringify(message.content).includes('项目名字是莲花'));
    sendChatCompletion(response, sawEarlierUser ? '莲花' : '收到');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const options = { dataDir: directory, promptFile, modelConfiguration: { defaultModel: 'local', models: [{ alias: 'local', api: 'openai-completions' as const,
    baseUrl: `http://127.0.0.1:${address.port}`, model: 'local', apiKey: 'test' }] } };
  let pi = await createPersonalPi(options);
  let host = new PersonalHost({ store: new PersonalStore(directory), dialogue: pi.dialogue, executor: pi.executor });
  try {
    await host.submit({ conversationId: 'c', actorId: '1', inputId: '1', text: '项目名字是莲花' });
    await host.close(); await pi.close();
    sawEarlierUser = false;
    pi = await createPersonalPi(options);
    host = new PersonalHost({ store: new PersonalStore(directory), dialogue: pi.dialogue, executor: pi.executor });
    const answer = await host.submit({ conversationId: 'c', actorId: '1', inputId: '2', text: '项目叫什么名字？' });
    assert.equal(answer.text, '莲花');
    assert.equal(sawEarlierUser, true);
  } finally {
    await host.close(); await pi.close(); server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});

test('Host model selection survives reopening and native SDK transforms earlier model context', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'personal-model-'));
  const promptFile = join(directory, 'prompt.md'); await writeFile(promptFile, 'Be helpful.');
  const observed: string[] = [];
  const server = createServer(async (request, response) => {
    let body = ''; for await (const part of request) body += part;
    const wire = JSON.parse(body); observed.push(wire.model);
    if (wire.model === 'second') {
      assert.ok(JSON.stringify(wire.messages).includes('先记住数据整理要求'));
      assert.equal(JSON.stringify(wire.messages).includes('reasoning_signature'), false);
    }
    sendChatCompletion(response, '收到');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const config = { dataDir: directory, promptFile, modelConfiguration: { defaultModel: 'one', models: ['one', 'two'].map((alias, index) => ({ alias, api: 'openai-completions' as const,
    baseUrl: `http://127.0.0.1:${address.port}`, model: index ? 'second' : 'first', apiKey: 'test' })) } };
  let pi = await createPersonalPi(config);
  let host = new PersonalHost({ store: new PersonalStore(directory), dialogue: pi.dialogue, executor: pi.executor });
  try {
    const input = { conversationId: 'c', actorId: '1', inputId: '1', text: '先记住数据整理要求' };
    await host.submit(input);
    await pi.selectModel(host.store.conversationSession('c'), 'two');
    await host.close(); await pi.close();
    pi = await createPersonalPi(config); host = new PersonalHost({ store: new PersonalStore(directory), dialogue: pi.dialogue, executor: pi.executor });
    await host.submit({ ...input, inputId: '2', text: '继续' });
    assert.deepEqual(observed, ['first', 'second']);
  } finally {
    await host.close(); await pi.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});

test('Host native compaction retains effective user constraints in later conversation input', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'personal-compact-'));
  const promptFile = join(directory, 'prompt.md'); await writeFile(promptFile, 'Be helpful.');
  let compacted = false; let requestsAfterCompaction = 0;
  const server = createServer(async (request, response) => {
    let body = ''; for await (const part of request) body += part;
    const wire = JSON.parse(body);
    const encoded = JSON.stringify(wire.messages);
    if (encoded.includes('<conversation>')) { compacted = true; return sendChatCompletion(response, '有效要求：报告必须使用中文，保留原始文件。已讨论较长背景。'); }
    if (compacted) {
      requestsAfterCompaction++;
      assert.ok(encoded.includes('报告必须使用中文'));
      assert.ok(encoded.includes('保留原始文件'));
      return sendChatCompletion(response, '会继续遵守要求');
    }
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: '背景材料'.repeat(3500) }, finish_reason: 'stop' }], usage: { prompt_tokens: 5100, completion_tokens: 700 } })}\n\ndata: [DONE]\n\n`);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const pi = await createPersonalPi({ dataDir: directory, promptFile, modelConfiguration: { defaultModel: 'local', models: [{ alias: 'local', api: 'openai-completions',
    baseUrl: `http://127.0.0.1:${address.port}`, model: 'local', apiKey: 'test', contextWindow: 6000, maxTokens: 1000 }] } });
  const host = new PersonalHost({ store: new PersonalStore(directory), dialogue: pi.dialogue, executor: pi.executor });
  try {
    await host.submit({ conversationId: 'c', actorId: '1', inputId: '1', text: '报告必须使用中文，保留原始文件。先解释背景。' });
    await host.submit({ conversationId: 'c', actorId: '1', inputId: '2', text: '继续解释' });
    await host.submit({ conversationId: 'c', actorId: '1', inputId: '3', text: '记得要求吗' });
    assert.equal(compacted, true);
    assert.ok(requestsAfterCompaction > 0);
  } finally {
    await host.close(); await pi.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});

test('Host gates exact commands, resumes files once, and keeps opaque cancellation uncertain', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'personal-command-'));
  const promptFile = join(directory, 'prompt.md'); await writeFile(promptFile, 'Be helpful.');
  const command = 'printf approved > approved.txt';
  let observedCommand!: () => void;
  const commandReturned = new Promise<void>(resolve => { observedCommand = resolve; });
  const toolCall = (response: Parameters<typeof sendChatCompletion>[0], name: string, args: unknown) => sendChatCompletion(response, '', [{ index: 0, id: `call_${name}_${Date.now()}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }]);
  const server = createServer(async (request, response) => {
    let body = ''; for await (const part of request) body += part;
    const wire = JSON.parse(body);
    if (wire.tools?.some((tool: { function: { name: string } }) => tool.function.name === 'task_control')) {
      const current = JSON.stringify(wire.messages.at(-1)?.content);
      if (wire.messages.at(-1)?.role === 'tool') return sendChatCompletion(response, '已提交');
      if (/用户输入：\\n停止任务 /.test(current)) return toolCall(response, 'task_control', { kind: 'cancel', taskId: /停止任务 ([a-f0-9-]+)/.exec(current)?.[1] });
      if (/用户输入：\\n确认动作 /.test(current)) {
        const id = /确认动作 ([a-f0-9-]+)/.exec(current)?.[1];
        return toolCall(response, 'task_control', { kind: 'authorize', actionId: id, approved: true });
      }
      return toolCall(response, 'task_control', { kind: 'start', goal: '先写 before.txt 然后生成 approved.txt', cwd: join(directory, 'work') });
    }
    const messages = wire.messages;
    if (!messages.some((message: { role: string; name?: string; tool_call_id?: string }) => message.role === 'tool' && (message.name === 'write' || message.tool_call_id?.includes('write'))))
      return toolCall(response, 'write', { path: 'before.txt', content: '已有成果' });
    const last = messages.at(-1);
    if (last?.role === 'tool' && (last.name === 'bash' || last.tool_call_id?.includes('bash')) && !JSON.stringify(last.content).includes('等待')) {
      observedCommand(); response.writeHead(200, { 'content-type': 'text/event-stream' }); response.write(': waiting for next step\n\n'); return;
    }
    return toolCall(response, 'bash', { command });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const dataDir = join(directory, 'data');
  const pi = await createPersonalPi({ dataDir, promptFile, executionTool: true,
    shellPath: process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : '/bin/bash',
    modelConfiguration: { defaultModel: 'local', models: [{ alias: 'local', api: 'openai-completions', baseUrl: `http://127.0.0.1:${address.port}`, model: 'local', apiKey: 'test' }] } });
  const host = new PersonalHost({ store: new PersonalStore(dataDir), dialogue: pi.dialogue, executor: { ...pi.executor,
    async execute(request) {
      if (request.task.permission?.mode !== 'trusted') {
        await host.workContext({ conversationId: request.task.conversationId, actorId: request.task.actorId, inputId: 'grant-proposal', text: 'request trusted execution' }, request.task.id).proposePermission({ mode: 'trusted', readRoots: [request.task.cwd!], writeRoots: [request.task.cwd!], network: false, expiresAt: Date.now() + 60_000 });
        const error = new Error('等待明确可信本机授权'); error.name = 'ExecutorAttentionError'; throw error;
      }
      return pi.executor.execute(request);
    } } });
  try {
    const input = { conversationId: 'c', actorId: '1', inputId: '1', text: '写文件并运行命令' };
    const accepted = await host.submit(input); assert.ok(accepted.taskId, accepted.text);
    await host.waitForIdle();
    assert.equal(host.getTask(accepted.taskId)?.status, 'waiting');
    await assert.rejects(readFile(join(directory, 'work', 'approved.txt')));
    const grant = host.store.listActions(accepted.taskId).find(action => action.action.kind === 'permission-grant'); assert.ok(grant);
    await host.submit({ ...input, inputId: 'grant-confirmation', text: `确认动作 ${grant.id}` }); await host.waitForIdle();
    const before = await stat(join(directory, 'work', 'before.txt'));
    const action = host.store.listActions(accepted.taskId).find(action => action.status === 'pending');
    assert.ok(action, JSON.stringify(host.getTask(accepted.taskId)));
    await host.submit({ ...input, inputId: '2', text: `确认动作 ${action.id}` });
    await commandReturned;
    assert.equal(await readFile(join(directory, 'work', 'approved.txt'), 'utf8'), 'approved');
    assert.equal((await stat(join(directory, 'work', 'before.txt'))).mtimeMs, before.mtimeMs);
    assert.equal(host.store.listActions(accepted.taskId).find(item => item.id === action.id)?.status, 'consumed');
    await host.submit({ ...input, inputId: '3', text: `停止任务 ${accepted.taskId}` });
    await host.waitForIdle();
    assert.equal(host.getTask(accepted.taskId)?.status, 'waiting');
    assert.match(host.getTask(accepted.taskId)?.error ?? '', /停止状态未知|核实/);
  } finally {
    await host.close(); await pi.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});

test('Host memory retrieval isolates conversations and forget survives reopening native Sessions', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'personal-forget-'));
  const promptFile = join(directory, 'prompt.md'); await writeFile(promptFile, 'Be helpful.');
  const historical = { async read() { return [
    { type: 'message', role: 'user', text: '秘密代号是银杏', chatId: 1, at: '2026-10-01T00:00:00Z' },
    { type: 'message', role: 'assistant', text: '收到银杏', at: '2026-10-01T00:00:01Z' },
    { type: 'message', role: 'user', text: '另一个人的秘密是榕树', chatId: 2, at: '2026-10-01T00:00:02Z' },
    { type: 'message', role: 'assistant', text: '榕树', at: '2026-10-01T00:00:03Z' },
  ]; } };
  let sawOther = false; let sawForgotten = false;
  const server = createServer(async (request, response) => {
    let body = ''; for await (const part of request) body += part;
    const wire = JSON.parse(body);
    const toolMessage = [...wire.messages].reverse().find(message => message.role === 'tool');
    if (wire.messages.at(-1)?.role !== 'tool') return sendChatCompletion(response, '', [{ index: 0, id: 'recall', type: 'function', function: { name: 'memory_search', arguments: JSON.stringify({ query: '秘密', limit: 10 }) } }]);
    const text = JSON.stringify(toolMessage.content);
    sawOther ||= text.includes('榕树'); sawForgotten ||= text.includes('银杏');
    sendChatCompletion(response, text.includes('银杏') ? '银杏' : '没有相关记忆');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  let pi: Awaited<ReturnType<typeof createPersonalPi>>;
  let memory = createPersonalMemory({ dataDir: directory, historical, invalidateSessions: () => pi.reset() });
  const config = { dataDir: directory, promptFile, modelConfiguration: { defaultModel: 'local', models: [{ alias: 'local', api: 'openai-completions' as const,
    baseUrl: `http://127.0.0.1:${address.port}`, model: 'local', apiKey: 'test' }] } };
  pi = await createPersonalPi({ ...config, memory });
  let host = new PersonalHost({ store: new PersonalStore(directory), dialogue: pi.dialogue, executor: pi.executor });
  try {
    const input = { conversationId: 'telegram:private:1', actorId: '1', inputId: '1', text: '找回我的秘密' };
    assert.equal((await host.submit(input)).text, '银杏');
    assert.equal(sawOther, false);
    await pi.reset();
    assert.equal((await host.submit({ ...input, inputId: '2' })).text, '银杏');
    const node = (await memory.nodes(input.conversationId)).find(node => node.messages.some(message => message.text.includes('银杏')))!;
    await memory.forget(input.conversationId, node.id);
    await host.close(); await pi.close(); await memory.close();
    memory = createPersonalMemory({ dataDir: directory, historical, invalidateSessions: () => pi.reset() });
    pi = await createPersonalPi({ ...config, memory });
    host = new PersonalHost({ store: new PersonalStore(directory), dialogue: pi.dialogue, executor: pi.executor });
    sawForgotten = false;
    assert.equal((await host.submit({ ...input, inputId: '3' })).text, '没有相关记忆');
    assert.equal(sawForgotten, false);
    assert.equal((await historical.read()).length, 4);
  } finally {
    await host.close(); await pi.close(); await memory.close(); server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});

test('Host delivers actual task file evidence without treating model text as verified', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'personal-file-'));
  const promptFile = join(directory, 'prompt.md'); await writeFile(promptFile, 'Be helpful.');
  const server = createServer(async (request, response) => {
    let body = ''; for await (const part of request) body += part;
    const wire = JSON.parse(body);
    const dialogue = wire.tools?.some((tool: { function: { name: string } }) => tool.function.name === 'task_control');
    if (wire.messages.at(-1)?.role === 'tool') return sendChatCompletion(response, dialogue ? '已提交' : '报告写好了，内容需要验收。');
    const name = dialogue ? 'task_control' : 'write';
    const args = dialogue ? { kind: 'start', goal: '生成报告文件，内容为：本周完成了数据整理' } : { path: 'report.txt', content: '本周完成了数据整理' };
    sendChatCompletion(response, '', [{ index: 0, id: `call_${name}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }]);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const pi = await createPersonalPi({ dataDir: directory, promptFile, modelConfiguration: { defaultModel: 'local', models: [{ alias: 'local', api: 'openai-completions',
    baseUrl: `http://127.0.0.1:${address.port}`, model: 'local', apiKey: 'test' }] } });
  const host = new PersonalHost({ store: new PersonalStore(directory), dialogue: pi.dialogue, executor: pi.executor });
  try {
    const accepted = await host.submit({ conversationId: 'c', actorId: '1', inputId: '1', text: '生成报告文件，内容为：本周完成了数据整理' });
    assert.ok(accepted.taskId);
    await host.waitForIdle();
    const task = host.getTask(accepted.taskId)!;
    assert.equal(task.status, 'partial');
    assert.equal(task.result?.verified, false);
    const path = task.result?.artifacts?.[0]; assert.ok(path);
    assert.equal(await readFile(path, 'utf8'), '本周完成了数据整理');
    assert.equal(host.pendingDeliveries('c').at(-1)?.artifacts?.[0], path);
  } finally {
    await host.close(); await pi.close(); server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});
