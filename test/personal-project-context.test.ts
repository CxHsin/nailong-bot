import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { createPersonalPi } from '../src/personal/pi.js';
import type { Task, WorkingAgreement } from '../src/personal/types.js';
import { sendChatCompletion } from './fixtures/chat-completion.js';

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'personal-project-context-'));
  const projectDir = join(root, 'project', 'nested');
  const target = join(root, 'target', 'nested');
  const dataDir = join(root, 'data');
  await Promise.all([projectDir, target, dataDir].map(path => mkdir(path, { recursive: true })));
  const promptFile = join(root, 'prompt.md');
  await writeFile(promptFile, 'BOT_STABLE_PROMPT');
  await writeFile(join(root, 'project', 'AGENTS.md'), 'PROJECT_PARENT_RULE');
  await writeFile(join(projectDir, 'AGENTS.md'), 'PROJECT_CHILD_RULE');
  await writeFile(join(root, 'target', 'AGENTS.md'), 'TARGET_PARENT_RULE');
  await writeFile(join(target, 'AGENTS.md'), 'TARGET_CHILD_RULE');
  const systems: string[] = [];
  const server = createServer(async (request, response) => {
    let body = ''; for await (const part of request) body += part;
    const wire = JSON.parse(body);
    systems.push(wire.messages.find((message: { role: string }) => message.role === 'system')?.content ?? '');
    sendChatCompletion(response, '收到');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const options = { dataDir, projectDir, promptFile, modelConfiguration: { defaultModel: 'local', models: [{ alias: 'local', api: 'openai-completions' as const,
    baseUrl: `http://127.0.0.1:${address.port}`, model: 'local', apiKey: 'test' }] } };
  return { root, target, projectDir, systems, options, async close() {
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  } };
}

test('main Session loads startup project instructions before changing context and reloads them on reopening', async () => {
  const f = await fixture(); let agreements: WorkingAgreement[] = [];
  const options = { ...f.options, agreementsForInput: () => agreements };
  let pi = await createPersonalPi(options);
  const input = { conversationId: 'c', actorId: 'owner', inputId: 'one', text: 'FIRST_USER_CONTENT' };
  try {
    await pi.dialogue.decide(input, { tasks: [], sessionId: 'main' });
    agreements = [{ id: 'agreement', actorId: 'owner', conversationId: 'c', content: 'DYNAMIC_WORK_RULE', scope: { kind: 'global' },
      revision: 0, state: 'active', sourceInputId: 'source', confirmedInputId: 'confirm', at: Date.now(), history: [] }];
    await pi.dialogue.decide({ ...input, inputId: 'two', text: 'SECOND_USER_CONTENT' }, { tasks: [], sessionId: 'main' });
    assert.equal(f.systems.length, 2);
    const role = '你是持续共事的个人助手';
    assert.equal(f.systems[0]!.slice(0, f.systems[0]!.indexOf(role)), f.systems[1]!.slice(0, f.systems[1]!.indexOf(role)));
    assert.doesNotMatch(f.systems[0]!, /DYNAMIC_WORK_RULE/);
    assert.match(f.systems[1]!, /DYNAMIC_WORK_RULE/);
    const system = f.systems[0]!;
    assert.ok(system.indexOf('BOT_STABLE_PROMPT') < system.indexOf('PROJECT_PARENT_RULE'));
    assert.ok(system.indexOf('PROJECT_PARENT_RULE') < system.indexOf('PROJECT_CHILD_RULE'));
    assert.ok(system.indexOf('PROJECT_CHILD_RULE') < system.indexOf('你是持续共事的个人助手'));
    assert.equal(system.split('PROJECT_CHILD_RULE').length - 1, 1);
    assert.doesNotMatch(system, /FIRST_USER_CONTENT|SECOND_USER_CONTENT|TARGET_PARENT_RULE/);
    await pi.close();
    await writeFile(join(f.projectDir, 'AGENTS.md'), 'PROJECT_CHILD_UPDATED');
    pi = await createPersonalPi(options);
    await pi.dialogue.decide({ ...input, inputId: 'three', text: '继续' }, { tasks: [], sessionId: 'main' });
    assert.match(f.systems.at(-1)!, /PROJECT_CHILD_UPDATED/);
    assert.doesNotMatch(f.systems.at(-1)!, /PROJECT_CHILD_RULE/);
  } finally { await pi.close(); await f.close(); }
});

test('task and verification Sessions load target hierarchy without inheriting startup project rules', async () => {
  const f = await fixture(); const pi = await createPersonalPi(f.options);
  const task: Task = { id: 'task', conversationId: 'c', actorId: 'owner', goal: '检查目标', resources: [], executor: 'local', cwd: f.target,
    sessionId: 'child', status: 'running', createdAt: Date.now(), updatedAt: Date.now(), requirements: [], revision: 0,
    workKind: 'delegation', purpose: 'research' };
  try {
    const result = await pi.executor.execute({ task, attempt: { id: 'attempt', taskId: task.id, sessionId: task.sessionId, status: 'running', startedAt: Date.now() },
      signal: new AbortController().signal, onIdentity() {}, onUsage() {} });
    await pi.verify(task, result);
    assert.equal(f.systems.length, 2);
    for (const system of f.systems) {
      assert.ok(system.indexOf('TARGET_PARENT_RULE') >= 0);
      assert.ok(system.indexOf('TARGET_PARENT_RULE') < system.indexOf('TARGET_CHILD_RULE'));
      assert.equal(system.split('TARGET_CHILD_RULE').length - 1, 1);
      assert.doesNotMatch(system, /PROJECT_PARENT_RULE|PROJECT_CHILD_RULE/);
    }
  } finally { await pi.close(); await f.close(); }
});
