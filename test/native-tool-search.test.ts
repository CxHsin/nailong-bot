import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Type } from 'typebox';
import { defineTool } from '@mariozechner/pi-coding-agent';
import { createPersonalPi } from '../src/personal/pi.js';
import { PersonalHost } from '../src/personal/host.js';
import { PersonalStore } from '../src/personal/store.js';
import { createTestServer } from './fixtures/http-server.js';

test('An Anthropic pause checkpoint survives process death before the first Pi JSONL assistant flush', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'native-crash-')); const promptFile = join(dir, 'prompt.md'); await writeFile(promptFile, 'Be helpful.');
  let requests = 0; let executed = 0;
  const tool = defineTool({ name: 'probe_sum', label: 'Sum', description: 'Add numbers.', parameters: Type.Object({ a: Type.Number(), b: Type.Number() }),
    async execute(_id, args) { executed++; return { content: [{ type: 'text', text: String(args.a + args.b) }], details: undefined }; } });
  const server = createTestServer(t, async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk; const wire = JSON.parse(body); requests++;
    if (requests === 2) assert.equal(wire.messages.filter((message: { role: string; content?: Array<{ type: string }> }) => message.role === 'assistant' && message.content?.some(block => block.type === 'server_tool_use')).length, 1);
    const blocks = requests === 1 ? [{ type: 'server_tool_use', id: 'srvtoolu_crash', name: 'tool_search_tool_regex', input: { pattern: 'probe_sum' } },
      { type: 'tool_search_tool_result', tool_use_id: 'srvtoolu_crash', content: { type: 'tool_search_tool_search_result', tool_references: [{ type: 'tool_reference', tool_name: 'probe_sum' }] } }] :
      requests === 2 ? [{ type: 'tool_use', id: 'sum', name: 'probe_sum', input: { a: 3, b: 4 } }] : [{ type: 'text', text: '7' }];
    const events: Array<{ type: string; [key: string]: unknown }> = [{ type: 'message_start', message: { id: `m${requests}`, usage: { input_tokens: 10, output_tokens: 0 } } }];
    blocks.forEach((block, index) => events.push({ type: 'content_block_start', index, content_block: block }, { type: 'content_block_stop', index }));
    events.push({ type: 'message_delta', delta: { stop_reason: requests === 1 ? 'pause_turn' : requests === 2 ? 'tool_use' : 'end_turn' }, usage: { output_tokens: 5 } }, { type: 'message_stop' });
    res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''));
  });
  await new Promise<void>(accept => server.listen(0, '127.0.0.1', accept)); const addr = server.address(); assert.ok(addr && typeof addr !== 'string');
  const config = { dataDir: dir, promptFile, limits: { timeoutMs: 5000, maxRetries: 0 }, modelConfiguration: { defaultModel: 'native', models: [{ alias: 'native', api: 'anthropic-messages' as const, baseUrl: `http://127.0.0.1:${addr.port}`, model: 'claude-sonnet-4-6', apiKey: 'fixture', toolSearch: 'native' as const }] } };
  const childFile = join(dir, 'crash.mjs');
  const moduleUrl = (path: string) => JSON.stringify(pathToFileURL(resolve(path)).href);
  await writeFile(childFile, `import {createPersonalPi} from ${moduleUrl('src/personal/pi.ts')};
import {PersonalHost} from ${moduleUrl('src/personal/host.ts')}; import {PersonalStore} from ${moduleUrl('src/personal/store.ts')};
import {defineTool} from ${moduleUrl('node_modules/@mariozechner/pi-coding-agent/dist/index.js')}; import {Type} from ${moduleUrl('node_modules/typebox/build/index.mjs')};
const tool=defineTool({name:'probe_sum',label:'Sum',description:'Add numbers.',parameters:Type.Object({a:Type.Number(),b:Type.Number()}),async execute(){throw new Error('must not execute');}});
const options=${JSON.stringify(config)};const pi=await createPersonalPi({...options,capabilityCatalog:()=>[{tool}],nativeSearch:{mode:'server',beforeRequest:e=>{if(e.requestNumber===2)process.exit(71);}}});
const host=new PersonalHost({store:new PersonalStore(options.dataDir),dialogue:pi.dialogue,executor:pi.executor});await host.submit({conversationId:'c',actorId:'u',inputId:'crash1',text:'Add 3 and 4.'});`);
  let exitCode: number | undefined;
  try { await promisify(execFile)(process.execPath, ['--import', 'tsx', childFile], { cwd: process.cwd(), windowsHide: true, timeout: 10000 }); }
  catch (error) { exitCode = (error as NodeJS.ErrnoException & { code: number }).code; if (exitCode !== 71) throw error; }
  assert.equal(exitCode, 71); assert.equal(requests, 1);
  const pi = await createPersonalPi({ ...config, capabilityCatalog: () => [{ tool }], nativeSearch: { mode: 'server' } });
  const host = new PersonalHost({ store: new PersonalStore(dir), dialogue: pi.dialogue, executor: pi.executor });
  t.after(async () => { await host.close(); await pi.close(); server.closeAllConnections(); await new Promise<void>(accept => server.close(() => accept())); await rm(dir, { recursive: true, force: true }); });
  assert.equal((await host.submit({ conversationId: 'c', actorId: 'u', inputId: '2', text: 'Continue the confirmed search.' })).text, '7'); assert.equal(executed, 1);
});

test('Anthropic pause_turn stops at its finite continuation budget and records actual usage', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'native-pause-budget-')); const promptFile = join(dir, 'prompt.md'); await writeFile(promptFile, 'Be helpful.');
  let requests = 0; const usage: number[] = [];
  const server = createTestServer(t, async (_req, res) => {
    requests++; res.writeHead(200, { 'content-type': 'text/event-stream' });
    const events = [{ type: 'message_start', message: { id: 'm', usage: { input_tokens: 10, output_tokens: 0 } } },
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: 'searching' } }, { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'pause_turn' }, usage: { output_tokens: 5 } }, { type: 'message_stop' }];
    res.end(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''));
  });
  await new Promise<void>(accept => server.listen(0, '127.0.0.1', accept)); const addr = server.address(); assert.ok(addr && typeof addr !== 'string');
  const pi = await createPersonalPi({ dataDir: dir, promptFile, limits: { timeoutMs: 3000, maxRetries: 0 },
    nativeSearch: { maxPauseContinuations: 1, onUsage: event => { usage.push(event.usage.totalTokens); } },
    modelConfiguration: { defaultModel: 'native', models: [{ alias: 'native', api: 'anthropic-messages', baseUrl: `http://127.0.0.1:${addr.port}`, model: 'claude-sonnet-4-6', apiKey: 'fixture', toolSearch: 'native' }] } });
  const host = new PersonalHost({ store: new PersonalStore(dir), dialogue: pi.dialogue, executor: pi.executor });
  t.after(async () => { await host.close(); await pi.close(); server.closeAllConnections(); await new Promise<void>(accept => server.close(() => accept())); await rm(dir, { recursive: true, force: true }); });
  await assert.rejects(host.submit({ conversationId: 'c', actorId: 'u', inputId: '1', text: 'Search.' }), /续接预算/);
  assert.equal(requests, 2); assert.deepEqual(usage, [15, 15]);
});

test('Anthropic server search stays in native order and pause_turn continues without local dispatch', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'native-server-')); const promptFile = join(dir, 'prompt.md'); await writeFile(promptFile, 'Be helpful.');
  let calls = 0; let executed = 0;
  const tool = defineTool({ name: 'probe_sum', label: 'Sum', description: 'Add numbers.', parameters: Type.Object({ a: Type.Number(), b: Type.Number() }),
    async execute(_id, args) { executed++; return { content: [{ type: 'text', text: String(args.a + args.b) }], details: undefined }; } });
  const server = createTestServer(t, async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk; const wire = JSON.parse(body); calls++;
    const blocks = calls === 1 ? [
      { type: 'server_tool_use', id: 'srvtoolu_1', name: 'tool_search_tool_regex', input: { pattern: 'probe_sum' } },
      { type: 'tool_search_tool_result', tool_use_id: 'srvtoolu_1', content: { type: 'tool_search_tool_search_result', tool_references: [{ type: 'tool_reference', tool_name: 'probe_sum' }] } },
    ] : calls === 2 ? [{ type: 'tool_use', id: 'sum1', name: 'probe_sum', input: { a: 3, b: 4 } }] : [{ type: 'text', text: '7' }];
    if (calls >= 2) {
      const dirs = await readdir(join(dir, 'personal-sessions'));
      const checkpoint = JSON.parse(await readFile(join(dir, 'personal-sessions', dirs[0]!, 'native-pause.json'), 'utf8'));
      assert.equal(checkpoint.record.pages[0][0].type, 'server_tool_use');
      const assistant = wire.messages.find((message: { role: string; content?: Array<{ type: string }> }) => message.role === 'assistant' && message.content?.some(block => block.type === 'server_tool_use'));
      assert.deepEqual(assistant.content.map((block: { type: string }) => block.type), ['server_tool_use', 'tool_search_tool_result']);
      assert.equal(JSON.stringify(wire.messages).includes('"tool_use_id":"srvtoolu_1"'), true);
      assert.equal(wire.messages.some((message: { role: string; content?: Array<{ type: string; tool_use_id?: string }> }) => message.role === 'user' && message.content?.some(block => block.type === 'tool_result' && block.tool_use_id === 'srvtoolu_1')), false);
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const events: unknown[] = [{ type: 'message_start', message: { id: `m${calls}`, type: 'message', role: 'assistant', content: [], usage: { input_tokens: 10, output_tokens: 0 } } }];
    blocks.forEach((block, index) => events.push({ type: 'content_block_start', index, content_block: block }, { type: 'content_block_stop', index }));
    events.push({ type: 'message_delta', delta: { stop_reason: calls === 1 ? 'pause_turn' : calls === 2 ? 'tool_use' : 'end_turn' }, usage: { output_tokens: 5 } }, { type: 'message_stop' });
    res.end(events.map(event => `event: ${(event as { type: string }).type}\ndata: ${JSON.stringify(event)}\n\n`).join(''));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); const addr = server.address(); assert.ok(addr && typeof addr !== 'string');
  const pi = await createPersonalPi({ dataDir: dir, promptFile, limits: { timeoutMs: 3000, maxRetries: 0 }, nativeSearch: { mode: 'server' },
    modelConfiguration: { defaultModel: 'native', models: [{ alias: 'native', api: 'anthropic-messages', baseUrl: `http://127.0.0.1:${addr.port}`, model: 'claude-sonnet-4-6', apiKey: 'fixture', toolSearch: 'native' }] }, capabilityCatalog: () => [{ tool }] });
  const host = new PersonalHost({ store: new PersonalStore(dir), dialogue: pi.dialogue, executor: pi.executor });
  t.after(async () => { await host.close(); await pi.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(dir, { recursive: true, force: true }); });
  assert.equal((await host.submit({ conversationId: 'c', actorId: 'u', inputId: '1', text: 'Add 3 and 4.' })).text, '7'); assert.equal(executed, 1); assert.equal(calls, 3);
});

test('Personal Agent uses Anthropic deferred definitions and native references', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'anthropic-search-')); const promptFile = join(dir, 'prompt.md'); await writeFile(promptFile, 'Be helpful.');
  let stage = 0; let actual = 0;
  const tool = defineTool({ name: 'probe_sum', label: 'Sum', description: 'Add two numbers.', parameters: Type.Object({ a: Type.Number(), b: Type.Number() }),
    async execute(_id, args) { actual = args.a + args.b; return { content: [{ type: 'text', text: String(actual) }], details: undefined }; } });
  const server = createTestServer(t, async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk; const wire = JSON.parse(body);
    assert.equal(wire.tools.find((entry: { name: string }) => entry.name === 'probe_sum')?.defer_loading, true);
    if (stage === 1) assert.ok(JSON.stringify(wire.messages).includes('tool_reference'));
    const block = stage++ === 0 ? { type: 'tool_use', id: 'search1', name: 'tool_search', input: { query: 'probe_sum' } } : stage === 2 ?
      { type: 'tool_use', id: 'sum1', name: 'probe_sum', input: { a: 3, b: 4 } } : { type: 'text', text: '7' };
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const events = [{ type: 'message_start', message: { id: `m${stage}`, type: 'message', role: 'assistant', content: [], usage: { input_tokens: 10, output_tokens: 0 } } },
      { type: 'content_block_start', index: 0, content_block: block }, { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: stage < 3 ? 'tool_use' : 'end_turn' }, usage: { output_tokens: 5 } }, { type: 'message_stop' }];
    res.end(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); const addr = server.address(); assert.ok(addr && typeof addr !== 'string');
  const pi = await createPersonalPi({ dataDir: dir, promptFile, limits: { timeoutMs: 3000, maxRetries: 0 },
    modelConfiguration: { defaultModel: 'native', models: [{ alias: 'native', api: 'anthropic-messages', baseUrl: `http://127.0.0.1:${addr.port}`, model: 'claude-sonnet-4-6', apiKey: 'fixture', toolSearch: 'native' }] }, capabilityCatalog: () => [{ tool }] });
  const host = new PersonalHost({ store: new PersonalStore(dir), dialogue: pi.dialogue, executor: pi.executor });
  t.after(async () => { await host.close(); await pi.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(dir, { recursive: true, force: true }); });
  assert.equal((await host.submit({ conversationId: 'c', actorId: 'u', inputId: '1', text: 'Add 3 and 4.' })).text, '7'); assert.equal(actual, 7);
});

test('Personal Agent discovers a deferred tool through native Responses and executes it without changing the resident prefix', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'native-search-'));
  const promptFile = join(dir, 'prompt.md'); await writeFile(promptFile, 'Use tool_search to find the requested capability.');
  let stage = 0; let actual = 0; let prefix: unknown;
  const tool = defineTool({ name: 'probe_sum', label: 'Sum', description: 'Add two numbers.',
    parameters: Type.Object({ a: Type.Number(), b: Type.Number() }),
    async execute(_id, args) { actual = args.a + args.b; return { content: [{ type: 'text', text: String(actual) }], details: undefined }; } });
  const server = createTestServer(t, async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    const wire = JSON.parse(body);
    assert.equal(wire.tools.some((entry: { name: string }) => entry.name === 'probe_sum'), false);
    assert.equal(wire.tools.some((entry: { type: string; execution?: string }) => entry.type === 'tool_search' && entry.execution === 'client'), true);
    prefix ??= wire.tools; assert.deepEqual(wire.tools, prefix);
    if (stage === 1) assert.ok(wire.input.some((item: { type: string; tools?: Array<{ name: string }> }) => item.type === 'tool_search_output' && item.tools?.[0]?.name === 'probe_sum'));
    if (stage === 2) assert.ok(wire.input.some((item: { type: string; output?: string }) => item.type === 'function_call_output' && item.output?.includes('7')));
    const item = stage++ === 0 ? { type: 'tool_search_call', id: 'search1', call_id: 'search-call', execution: 'client', status: 'completed', arguments: { query: 'probe_sum' } } : stage === 2 ?
      { type: 'function_call', id: 'fn1', call_id: 'sum-call', name: 'probe_sum', arguments: '{"a":3,"b":4}', status: 'completed' } :
      { type: 'message', id: 'm1', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: '7', annotations: [] }] };
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end([{ type: 'response.created', response: { id: `r${stage}`, status: 'in_progress' } },
      { type: 'response.output_item.added', output_index: 0, item }, { type: 'response.output_item.done', output_index: 0, item },
      { type: 'response.completed', response: { id: `r${stage}`, status: 'completed', output: [item], usage: { input_tokens: 10, output_tokens: 5 } } }]
      .map(event => `data: ${JSON.stringify(event)}\n\n`).join(''));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address(); assert.ok(addr && typeof addr !== 'string');
  const pi = await createPersonalPi({ dataDir: dir, promptFile,
    limits: { timeoutMs: 3000, maxRetries: 0 },
    modelConfiguration: { defaultModel: 'native', models: [{ alias: 'native', api: 'openai-responses', baseUrl: `http://127.0.0.1:${addr.port}`, model: 'gpt-5.4', apiKey: 'fixture', toolSearch: 'native' }] },
    capabilityCatalog: () => [{ tool }] });
  const host = new PersonalHost({ store: new PersonalStore(dir), dialogue: pi.dialogue, executor: pi.executor });
  t.after(async () => { await host.close(); await pi.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(dir, { recursive: true, force: true }); });
  const answer = await host.submit({ conversationId: 'c', actorId: 'u', inputId: '1', text: 'Add 3 and 4.' });
  assert.equal(answer.text, '7'); assert.equal(actual, 7);
  await host.close(); await pi.close();
  const reopened = await createPersonalPi({ dataDir: dir, promptFile, limits: { timeoutMs: 3000, maxRetries: 0 },
    modelConfiguration: { defaultModel: 'native', models: [{ alias: 'native', api: 'openai-responses', baseUrl: `http://127.0.0.1:${addr.port}`, model: 'gpt-5.4', apiKey: 'fixture', toolSearch: 'native' }] },
    capabilityCatalog: () => [{ tool }] });
  const resumed = new PersonalHost({ store: new PersonalStore(dir), dialogue: reopened.dialogue, executor: reopened.executor });
  try { assert.equal((await resumed.submit({ conversationId: 'c', actorId: 'u', inputId: '2', text: 'Repeat.' })).text, '7'); }
  finally { await resumed.close(); await reopened.close(); }
});
