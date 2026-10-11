import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { createPersonalRuntime } from '../src/personal/runtime.js';
import { createPlainChannel } from '../src/personal/channels.js';
import { sendChatCompletion } from './fixtures/chat-completion.js';
import { createTestServer } from './fixtures/http-server.js';

test('CLI → production Host uses native execution, independently reads the result, and delivers actual file', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'nailong-runtime-'));
  const cwd = join(directory, 'work');
  const promptFile = join(directory, 'prompt.md'); await writeFile(promptFile, 'Help the user.');
  const server = createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    const wire = JSON.parse(body);
    const names: string[] = wire.tools?.map((tool: { function: { name: string } }) => tool.function.name) ?? [];
    const call = (name: string, args: unknown) => sendChatCompletion(res, '', [{ index: 0, id: `call_${name}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }]);
    const last = wire.messages.at(-1);
    if (names.includes('task_control')) {
      if (last.role === 'tool') return sendChatCompletion(res, '已提出任务');
      return call('task_control', { kind: 'start', goal: '创建 result.txt，精确内容为 42', cwd });
    }
    if (names.includes('verify_result')) {
      if (last.role !== 'tool') return call('read', { path: 'result.txt' });
      if (last.tool_call_id === 'call_read') {
        assert.match(last.content, /42/);
        return call('verify_result', { verified: true, text: '已读取 result.txt，内容为 42。', artifacts: ['result.txt'], checksRequired: false });
      }
      return sendChatCompletion(res, '独立验收完成');
    }
    if (last.role === 'tool') return sendChatCompletion(res, '文件已写出');
    return call('write', { path: 'result.txt', content: '42' });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const runtime = await createPersonalRuntime({ AGENT_DATA_DIR: join(directory, 'data'), AGENT_PROMPT_FILE: promptFile,
    MODEL_NAMES: 'test', MODEL_DEFAULT: 'test', MODEL_TEST_API_KEY: 'test', MODEL_TEST_API: 'openai-completions',
    MODEL_TEST_MODEL: 'test', MODEL_TEST_BASE_URL: `http://127.0.0.1:${address.port}` });
  const sentFiles: string[] = [];
  const channel = createPlainChannel({ host: runtime.host, accepts: () => true, sendText: async () => '1',
    sendFile: async path => { sentFiles.push(await readFile(path, 'utf8')); return '2'; }, onDelivered: runtime.onDelivered });
  try {
    const response = await channel.receive({ conversationId: 'cli:owner', actorId: 'owner', inputId: '1', text: '创建 result.txt，内容为 42' });
    await runtime.host.waitForIdle(); await channel.flush();
    assert.equal(runtime.host.getTask(response.taskId!)?.status, 'completed');
    assert.deepEqual(sentFiles, ['42']);
    assert.equal((await runtime.memory.nodes('cli:owner')).length, 1);
  } finally {
    await channel.close(); await runtime.close(); server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});

for (const phase of ['execution', 'verification'] as const) {
  test(`production Host refuses stale results when requirements change during ${phase}`, { timeout: 15_000 }, async t => {
    const directory = await mkdtemp(join(tmpdir(), 'nailong-revision-'));
    const cwd = join(directory, 'work');
    const promptFile = join(directory, 'prompt.md'); await writeFile(promptFile, 'Help the user.');
    let reachBarrier!: () => void; const reached = new Promise<void>(resolve => { reachBarrier = resolve; });
    let releaseBarrier!: () => void; const released = new Promise<void>(resolve => { releaseBarrier = resolve; });
    let blocked = false; let verifierSawCurrent = false;
    const server = createTestServer(t, async (req, res) => {
      let body = ''; for await (const chunk of req) body += chunk;
      const wire = JSON.parse(body);
      const names: string[] = wire.tools?.map((tool: { function: { name: string } }) => tool.function.name) ?? [];
      const last = wire.messages.at(-1);
      const call = (name: string, args: unknown) => sendChatCompletion(res, '', [{ index: 0, id: `call_${name}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }]);
      if (names.includes('task_control')) {
        if (last.role === 'tool') return sendChatCompletion(res, '已提出操作');
        const current = JSON.stringify(last.content);
        const target = /补充任务 ([a-f0-9-]+)/.exec(current)?.[1];
        if (target) return call('task_control', { kind: 'steer', taskId: target, text: 'result.txt 的精确内容改为 84' });
        return call('task_control', { kind: 'start', goal: '创建 result.txt，精确内容为 42', cwd });
      }
      if (names.includes('verify_result')) {
        if (last.role !== 'tool') {
          const current = JSON.stringify(last.content);
          verifierSawCurrent ||= current.includes('当前约束：') && current.includes('精确内容改为 84');
          if (phase === 'verification' && !blocked) { blocked = true; reachBarrier(); await released; }
          return call('read', { path: 'result.txt' });
        }
        if (last.tool_call_id === 'call_read') {
          assert.match(last.content, /42/);
          return call('verify_result', { verified: phase === 'verification', text: phase === 'execution' ? '实际内容仍为 42，不满足最新要求 84。' : '旧版本 42 的验收已通过。', artifacts: ['result.txt'], checksRequired: false });
        }
        return sendChatCompletion(res, '验收结束');
      }
      if (last.role === 'tool') {
        if (phase === 'execution' && !blocked) { blocked = true; reachBarrier(); await released; }
        return sendChatCompletion(res, '原始内容 42 已写出');
      }
      // A queued steering turn is acknowledged by the actual SDK/model boundary,
      // while this controlled executor deliberately leaves the file unchanged.
      if (JSON.stringify(last.content).includes('精确内容改为 84')) return sendChatCompletion(res, '已接收要求，成果仍需独立核对');
      return call('write', { path: 'result.txt', content: '42' });
    }, 10_000);
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address(); assert.ok(address && typeof address !== 'string');
    const runtime = await createPersonalRuntime({ AGENT_DATA_DIR: join(directory, 'data'), AGENT_PROMPT_FILE: promptFile,
      MODEL_NAMES: 'test', MODEL_DEFAULT: 'test', MODEL_TEST_API_KEY: 'test', MODEL_TEST_API: 'openai-completions',
      MODEL_TEST_MODEL: 'test', MODEL_TEST_BASE_URL: `http://127.0.0.1:${address.port}`, AGENT_MODEL_TIMEOUT_MS: '10000' });
    const channel = createPlainChannel({ host: runtime.host, accepts: () => true, sendText: async () => '1', sendFile: async () => '2' });
    try {
      const input = { conversationId: 'cli:owner', actorId: 'owner', inputId: '1', text: '创建 result.txt，内容为 42' };
      const accepted = await channel.receive(input); assert.ok(accepted.taskId);
      await reached;
      await channel.receive({ ...input, inputId: '2', text: `补充任务 ${accepted.taskId}，内容改为 84` });
      releaseBarrier();
      await runtime.host.waitForIdle(); await channel.flush();
      const task = runtime.host.getTask(accepted.taskId)!;
      assert.equal(task.status, 'partial');
      assert.equal(task.result?.verified, false);
      assert.equal(await readFile(join(cwd, 'result.txt'), 'utf8'), '42');
      if (phase === 'execution') {
        assert.equal(verifierSawCurrent, true, 'independent verifier must receive current persisted requirements');
        assert.match(task.result?.text ?? '', /不满足最新要求 84/);
      } else assert.match(task.result?.text ?? '', /验收期间要求发生变化/);
    } finally {
      releaseBarrier(); await channel.close(); await runtime.close(); server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
      await rm(directory, { recursive: true, force: true });
    }
  });
}
