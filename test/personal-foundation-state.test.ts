import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, access, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { PersonalStore } from '../src/personal/store.js';
import { createPersonalRuntime } from '../src/personal/runtime.js';
import { createPlainChannel, cliInput } from '../src/personal/channels.js';
import { createTestServer } from './fixtures/http-server.js';
import { sendChatCompletion } from './fixtures/chat-completion.js';

async function fixture(t: import('node:test').TestContext, handle: (wire: any, call: (name: string, args: unknown) => void, finish: (text: string) => void) => Promise<void> | void) {
  const directory = await mkdtemp(join(tmpdir(), 'foundation-state-'));
  const prompt = join(directory, 'prompt.md'); await writeFile(prompt, 'Help.');
  let calls = 0; const replies: string[] = [];
  const server = createTestServer(t, async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    await handle(JSON.parse(body), (name, args) => sendChatCompletion(res, '', [{ index: 0, id: `call-${++calls}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }]), text => sendChatCompletion(res, text));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const env = { AGENT_DATA_DIR: join(directory, 'data'), AGENT_PROMPT_FILE: prompt, MODEL_NAMES: 'test', MODEL_DEFAULT: 'test', MODEL_TEST_API_KEY: 'test', MODEL_TEST_API: 'openai-completions', MODEL_TEST_MODEL: 'test', MODEL_TEST_BASE_URL: `http://127.0.0.1:${address.port}` };
  const runtime = await createPersonalRuntime(env);
  const channel = createPlainChannel({ host: runtime.host, accepts: () => true, sendText: async text => { replies.push(text); return 'sent'; }, sendFile: async () => 'file' });
  t.after(async () => { channel.close(); await runtime.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(directory, { recursive: true, force: true }); });
  return { runtime, channel, directory, replies, env };
}

test('repeated synchronous queries allow completion without a model version', async t => {
  let requests = 0;
  const f = await fixture(t, (wire, call, finish) => {
    requests++;
    if (requests === 1) return call('task_control', { kind: 'query' });
    if (requests === 2 || requests === 3) {
      const result = JSON.parse(wire.messages.at(-1).content);
      assert.equal(result.goal, 'produce answer'); assert.equal(result.revision, 0);
      if (requests === 2) return call('task_control', { kind: 'query' });
      return call('write', { path: 'answer.txt', content: '42' });
    }
    if (requests === 4) return call('complete_work', { outcome: 'completed', text: 'verified answer', artifacts: ['answer.txt'] });
    return finish('finished');
  });
  await f.channel.receive({ conversationId: 'c', actorId: 'a', inputId: 'one', text: 'produce answer' });
  await f.runtime.host.waitForIdle();
  assert.equal(f.runtime.host.listTasks()[0]?.status, 'completed');
  assert.equal(f.runtime.host.listTasks()[0]?.result?.producedRevision, 0);
  assert.ok(f.replies.some(reply => reply.includes('verified answer')));
});

test('explicit channel updates during a running tool enter the next request without undoing its effect', async t => {
  let requests = 0;
  const f = await fixture(t, (wire, call, finish) => {
    requests++;
    if (requests === 1) return call('bash', { command: `node -e "const fs=require('fs');fs.writeFileSync('started','effect');const tick=setInterval(()=>{if(fs.existsSync('release'))clearInterval(tick)},20)"` });
    if (requests === 2) {
      assert.match(JSON.stringify(wire.messages), /Required value 84/);
      assert.match(JSON.stringify(wire.messages), /Use plain digits/);
      return call('write', { path: 'answer.txt', content: '84' });
    }
    if (requests === 3) return call('complete_work', { outcome: 'completed', text: 'updated answer', artifacts: ['answer.txt'] });
    finish('finished');
  });
  const conversationId = f.runtime.openLocalConversation({ actorId: 'a', conversationId: 'c', cwd: f.directory });
  const running = f.channel.receive(cliInput('produce answer', conversationId, 'a'));
  let started = false;
  for (let i = 0; i < 200 && !started; i++) { try { await access(join(f.directory, 'started')); started = true; } catch { await new Promise(resolve => setTimeout(resolve, 20)); } }
  assert.ok(started, 'real command reached the file barrier');
  const root = f.runtime.host.listTasks()[0]!;
  const update = cliInput(`/steer ${root.id} Required value 84`, conversationId, 'a');
  const duplicate = await Promise.all([f.channel.receive(update), f.channel.receive(update)]);
  assert.equal(duplicate[0].deliveryId, duplicate[1].deliveryId);
  await f.channel.receive(cliInput(`/steer ${root.id} Use plain digits`, conversationId, 'a'));
  assert.equal(f.runtime.host.getTask(root.id)?.revision, 2);
  await writeFile(join(f.directory, 'release'), 'release'); await running;
  await f.runtime.host.waitForIdle();
  assert.equal(await readFile(join(f.directory, 'started'), 'utf8'), 'effect');
  assert.equal(f.runtime.host.getTask(root.id)?.result?.producedRevision, 2);
  assert.equal(f.runtime.host.getTask(root.id)?.status, 'completed');
});

test('a failure explanation never needs to read an unavailable target as completion evidence', async t => {
  let requests = 0;
  const f = await fixture(t, (wire, call, finish) => {
    requests++;
    if (requests === 1) return call('read', { path: 'missing.txt' });
    if (requests === 2) { assert.match(wire.messages.at(-1).content, /ENOENT/); return call('complete_work', { outcome: 'blocked', text: 'The file is missing; please provide it.', artifacts: ['missing.txt'] }); }
    assert.doesNotMatch(wire.messages.at(-1).content, /ENOENT/);
    finish('The file is missing; please provide it.');
  });
  await f.channel.receive({ conversationId: 'c', actorId: 'a', inputId: 'one', text: 'inspect file' });
  await f.runtime.host.waitForIdle();
  assert.equal(f.runtime.host.listTasks()[0]?.status, 'waiting');
  assert.ok(f.replies.some(reply => reply.includes('please provide it')));
});

test('a requirement arriving after a completion request preserves material and requires a new review', async t => {
  let requests = 0; let f: Awaited<ReturnType<typeof fixture>>;
  f = await fixture(t, async (wire, call, finish) => {
    requests++;
    if (requests === 1) return call('write', { path: 'answer.txt', content: '42' });
    if (requests === 2) {
      const root = f.runtime.host.listTasks()[0]!;
      await f.channel.receive({ conversationId: 'c', actorId: 'a', inputId: 'update', replyTaskId: root.id, control: 'steer', text: 'The required answer is now 84.' });
      return call('complete_work', { outcome: 'completed', text: 'old result', artifacts: ['answer.txt'] });
    }
    if (requests === 3) { assert.match(JSON.stringify(wire.messages), /The required answer is now 84/); return finish('old review ended'); }
    if (requests === 4) { assert.notEqual(f.runtime.host.listTasks()[0]?.status, 'completed'); return call('write', { path: 'answer.txt', content: '84' }); }
    if (requests === 5) return call('complete_work', { outcome: 'completed', text: 'updated result', artifacts: ['answer.txt'] });
    finish('updated review ended');
  });
  await f.channel.receive({ conversationId: 'c', actorId: 'a', inputId: 'one', text: 'produce answer' });
  await f.runtime.host.waitForIdle();
  const root = f.runtime.host.listTasks()[0]!;
  assert.equal(root.status, 'completed'); assert.equal(root.result?.producedRevision, 1);
  assert.ok(root.presentedRequirements?.receipt.entryId);
  assert.equal(f.replies.some(reply => reply === 'old result'), false);
});

test('ordinary failure replies and free text completion do not settle persistent work', async t => {
  let requests = 0;
  const f = await fixture(t, (wire, call, finish) => {
    requests++;
    if (requests === 1) return call('read', { path: 'missing.txt' });
    assert.match(wire.messages.at(-1).content, /ENOENT/);
    finish('Completed my inspection: the requested file is missing.');
  });
  await f.channel.receive(cliInput('inspect missing.txt', 'c', 'a')); await f.runtime.host.waitForIdle();
  assert.equal(requests, 2);
  assert.equal(f.runtime.host.listTasks()[0]?.status, 'waiting');
  assert.ok(f.replies.some(reply => reply.includes('file is missing')));
});

test('after a file error the model can correct its action and explicitly complete verified material', async t => {
  let requests = 0;
  const f = await fixture(t, (wire, call, finish) => {
    requests++;
    if (requests === 1) return call('read', { path: 'missing.txt' });
    if (requests === 2) { assert.match(wire.messages.at(-1).content, /ENOENT/); return call('write', { path: 'answer.txt', content: '42' }); }
    if (requests === 3) return call('complete_work', { outcome: 'completed', text: 'recovered answer', artifacts: ['answer.txt'] });
    finish('review done');
  });
  await f.channel.receive(cliInput('create answer', 'c', 'a')); await f.runtime.host.waitForIdle();
  assert.equal(f.runtime.host.listTasks()[0]?.status, 'completed');
  assert.equal(f.runtime.host.listTasks()[0]?.result?.verified, true);
});

test('explicit completion still checks missing evidence and a later query can inspect finished work', async t => {
  let requests = 0; let taskId: string;
  const f = await fixture(t, (wire, call, finish) => {
    requests++;
    if (requests === 1) return call('complete_work', { outcome: 'completed', text: 'invented success', artifacts: ['missing.txt'] });
    if (requests === 2) { assert.match(wire.messages.at(-1).content, /ENOENT/); return call('write', { path: 'answer.txt', content: '42' }); }
    if (requests === 3) return call('complete_work', { outcome: 'completed', text: 'actual success', artifacts: ['answer.txt'] });
    if (requests === 4) return finish('review ended');
    if (requests === 5) return call('task_control', { kind: 'query', taskId });
    const result = JSON.parse(wire.messages.at(-1).content); assert.equal(result.status, 'completed'); assert.equal(result.id, taskId);
    finish('The task completed with actual evidence.');
  });
  await f.channel.receive(cliInput('produce answer', 'c', 'a')); await f.runtime.host.waitForIdle();
  taskId = f.runtime.host.listTasks()[0]!.id;
  await f.channel.receive({ ...cliInput('what is the task status?', 'c', 'a'), replyTaskId: taskId }); await f.runtime.host.waitForIdle();
  assert.ok(f.replies.some(reply => reply.includes('actual evidence')));
});

for (const boundary of ['saved', 'presented'] as const) test(`real process death with ${boundary} requirements resumes their actual association`, { timeout: 20000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'foundation-process-'));
  const prompt = join(directory, 'prompt.md'); await writeFile(prompt, 'Help.');
  let requests = 0; let recovered = false; let held: (() => void) | undefined;
  let reachBoundary!: () => void; const atBoundary = new Promise<void>(resolve => { reachBoundary = resolve; });
  let reachPresented!: () => void; const atPresented = new Promise<void>(resolve => { reachPresented = resolve; });
  const server = createTestServer(t, async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk; const wire = JSON.parse(body); requests++;
    const call = (name: string, args: unknown) => sendChatCompletion(res, '', [{ index: 0, id: `process-${requests}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }]);
    if (!recovered && requests === 1) return call('write', { path: 'effect.txt', content: 'preserved' });
    if (!recovered && requests === 2) { held = () => call('task_control', { kind: 'query' }); reachBoundary(); return; }
    if (!recovered && requests === 3) {
      assert.match(JSON.stringify(wire.messages), /Required answer 84/);
      return call('task_control', { kind: 'query' });
    }
    if (!recovered) { reachPresented(); return; }
    assert.match(JSON.stringify(wire.messages), /Required answer 84/);
    const tool = wire.messages.at(-1);
    if (tool.role !== 'tool' || !String(tool.content).includes('Successfully wrote')) {
      const existing = wire.messages.some((message: any) => message.role === 'assistant' && message.tool_calls?.some((call: any) => call.function.name === 'complete_work'));
      if (existing) return sendChatCompletion(res, 'recovered review ended');
      return call('write', { path: 'answer.txt', content: '84' });
    }
    return call('complete_work', { outcome: 'completed', text: 'recovered result', artifacts: ['answer.txt', 'effect.txt'] });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const env = { AGENT_DATA_DIR: join(directory, 'data'), AGENT_PROMPT_FILE: prompt, MODEL_NAMES: 'test', MODEL_DEFAULT: 'test', MODEL_TEST_API_KEY: 'test', MODEL_TEST_API: 'openai-completions', MODEL_TEST_MODEL: 'test', MODEL_TEST_BASE_URL: `http://127.0.0.1:${address.port}` };
  const runtimeUrl = pathToFileURL(join(process.cwd(), 'src/personal/runtime.ts')).href;
  const channelsUrl = pathToFileURL(join(process.cwd(), 'src/personal/channels.ts')).href;
  const script = `import {createPersonalRuntime} from ${JSON.stringify(runtimeUrl)};
    import {createPlainChannel,cliInput} from ${JSON.stringify(channelsUrl)};
    const runtime=await createPersonalRuntime(${JSON.stringify(env)});
    const channel=createPlainChannel({host:runtime.host,accepts:()=>true,sendText:async()=> 'sent',sendFile:async()=> 'file'});
    process.stdin.on('data',async()=>{const root=runtime.host.listTasks()[0];await channel.receive(cliInput('/steer '+root.id+' Required answer 84','c','a'));console.log('UPDATED');});
    setInterval(()=>{},1000);void channel.receive({conversationId:'c',actorId:'a',inputId:'one',text:'produce answer'});`;
  const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', script], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  let errors = ''; child.stderr.on('data', chunk => { errors += String(chunk); });
  const kill = async () => { if (child.exitCode === null && child.signalCode === null) { const closed = new Promise<void>(resolve => child.once('close', () => resolve())); child.kill('SIGKILL'); await closed; } };
  t.after(async () => { await kill(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(directory, { recursive: true, force: true }); });
  await Promise.race([atBoundary, new Promise((_, reject) => child.once('exit', () => reject(new Error(errors))))]);
  const updated = new Promise<void>(resolve => { child.stdout.on('data', chunk => { if (String(chunk).includes('UPDATED')) resolve(); }); });
  child.stdin.write('update\n'); await updated;
  if (boundary === 'presented') { held!(); await atPresented; }
  await kill();
  const store = new PersonalStore(env.AGENT_DATA_DIR); const before = store.listTasks()[0]!;
  assert.equal(before.revision, 1); assert.equal(before.presentedRequirements?.revision, boundary === 'saved' ? 0 : 1);
  assert.notEqual(before.status, 'completed'); store.close();
  recovered = true;
  const runtime = await createPersonalRuntime(env);
  try {
    await runtime.host.waitForIdle(); const root = runtime.host.getTask(before.id)!;
    assert.equal(root.status, 'completed'); assert.equal(root.result?.producedRevision, 1);
    assert.equal(await readFile(join(root.cwd!, 'effect.txt'), 'utf8'), 'preserved');
    assert.equal(runtime.host.store.listActionDispatches().filter(action => action.action.target.endsWith('effect.txt')).length, 1);
    await runtime.host.recover(); await runtime.host.waitForIdle();
    assert.equal(runtime.host.getTask(before.id)?.status, 'completed');
  } finally { await runtime.close(); }
});
