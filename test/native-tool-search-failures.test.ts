import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ServerResponse } from 'node:http';
import { Type } from 'typebox';
import { defineTool } from '@mariozechner/pi-coding-agent';
import { createPersonalPi, type PersonalPiOptions } from '../src/personal/pi.js';
import { PersonalHost } from '../src/personal/host.js';
import { PersonalStore } from '../src/personal/store.js';
import { createTestServer } from './fixtures/http-server.js';
import { sendResponsesText } from './fixtures/responses-text.js';
import { sendChatCompletion } from './fixtures/chat-completion.js';

const search = { type: 'tool_search_call', id: 's', call_id: 's1', execution: 'client', status: 'completed', arguments: { query: 'probe' } };
const call = { type: 'function_call', id: 'f', call_id: 'f1', name: 'probe', arguments: '{}', status: 'completed' };
const text = { type: 'message', id: 'm', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'done', annotations: [] }] };
function respond(res: ServerResponse, items: unknown[], options: { terminal?: boolean; duplicate?: boolean; inputTokens?: number } = {}) {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  const events: unknown[] = [{ type: 'response.created', response: { id: 'r', status: 'in_progress' } }];
  items.forEach((item, output_index) => { events.push({ type: 'response.output_item.done', output_index, item }); if (options.duplicate) events.push({ type: 'response.output_item.done', output_index, item }); });
  if (options.terminal !== false) events.push({ type: 'response.completed', response: { id: 'r', status: 'completed', output: items, usage: { input_tokens: options.inputTokens ?? 10, output_tokens: 5 } } });
  res.end(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(''));
}
async function fixture(t: TestContext, handler: (wire: any, res: ServerResponse, request: { headers: any }) => void | Promise<void>, customize: Partial<PersonalPiOptions> = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'native-failure-')); const promptFile = join(dir, 'prompt.md'); await writeFile(promptFile, 'Be helpful.');
  const effects: string[] = [];
  const tool = defineTool({ name: 'probe', label: 'Probe', description: 'Pure test probe.', parameters: Type.Object({}), async execute(id) { effects.push(id); return { content: [{ type: 'text', text: 'observed' }], details: undefined }; } });
  const server = createTestServer(t, async (req, res) => { let body = ''; for await (const chunk of req) body += chunk; await handler(JSON.parse(body), res, req); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); const addr = server.address(); assert.ok(addr && typeof addr !== 'string');
  const options: PersonalPiOptions = { dataDir: dir, promptFile, limits: { timeoutMs: 3000, maxRetries: 0 },
    modelConfiguration: { defaultModel: 'native', models: [{ alias: 'native', api: 'openai-responses', baseUrl: `http://127.0.0.1:${addr.port}`, model: 'gpt-5.4', apiKey: 'fixture', toolSearch: 'native' }] },
    capabilityCatalog: () => [{ tool }], ...customize };
  let pi = await createPersonalPi(options); let host = new PersonalHost({ store: new PersonalStore(dir), dialogue: pi.dialogue, executor: pi.executor });
  t.after(async () => { await host.close(); await pi.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(dir, { recursive: true, force: true }); });
  return { effects, options, get pi() { return pi; }, get host() { return host; },
    submit: (id = '1') => host.submit({ conversationId: 'c', actorId: 'u', inputId: id, text: 'Use probe.' }),
    async reopen() { await host.close(); await pi.close(); pi = await createPersonalPi(options); host = new PersonalHost({ store: new PersonalStore(dir), dialogue: pi.dialogue, executor: pi.executor }); } };
}

test('A deferred call without discovery is rejected before its effect', async t => {
  let stage = 0;
  const run = await fixture(t, (_wire, res) => respond(res, [stage++ ? text : call]));
  assert.equal((await run.submit()).text, 'done'); assert.deepEqual(run.effects, []);
});

test('A truncated native search response cannot execute or establish a discovery', async t => {
  const run = await fixture(t, (_wire, res) => respond(res, [search], { terminal: false }));
  await assert.rejects(run.submit(), /断流/); assert.deepEqual(run.effects, []);
});

test('Incomplete function arguments never dispatch a local capability', async t => {
  const run = await fixture(t, (_wire, res) => respond(res, [{ ...call, arguments: '{"x":' }]));
  await assert.rejects(run.submit()); assert.deepEqual(run.effects, []);
});

test('Duplicate native output events execute a discovered call only once', async t => {
  let stage = 0;
  const run = await fixture(t, (_wire, res) => respond(res, [stage++ === 0 ? search : stage === 2 ? call : text], { duplicate: true }));
  assert.equal((await run.submit()).text, 'done'); assert.deepEqual(run.effects, ['f1']);
});

test('Search is not authorization and a denied capability has no effect', async t => {
  let stage = 0; const denied: string[] = [];
  const forbidden = defineTool({ name: 'probe', label: 'Probe', description: 'Pure test probe.', parameters: Type.Object({}), async execute() { denied.push('executed'); return { content: [{ type: 'text', text: 'bad' }], details: undefined }; } });
  const run = await fixture(t, (_wire, res) => respond(res, [stage++ === 0 ? search : stage === 2 ? call : text]), { capabilityCatalog: () => [{ tool: forbidden, authorize: () => false }] });
  assert.equal((await run.submit()).text, 'done'); assert.deepEqual(denied, []);
});

test('A changed capability definition requires rediscovery after reopening', async t => {
  let stage = 0; let changed = false; const effects: string[] = [];
  const probe = defineTool({ name: 'probe', label: 'Probe', description: 'Pure test probe.', parameters: Type.Object({}), async execute() { effects.push('effect'); return { content: [{ type: 'text', text: 'bad' }], details: undefined }; } });
  const run = await fixture(t, (wire, res) => {
    if (changed) assert.equal(wire.input.some((item: { type: string }) => item.type === 'tool_search_output'), false);
    respond(res, [stage++ === 0 ? search : !changed ? text : stage === 3 ? call : text]);
  }, { capabilityCatalog: () => [{ tool: probe, definitionVersion: changed ? '2' : '1' }] });
  await run.submit(); changed = true; await run.reopen(); await run.submit('2'); assert.deepEqual(effects, []);
});

test('Native HTTP retries preserve credentials and count every attempt against the request budget', async t => {
  let attempts = 0; const requests: number[] = []; const usage: number[] = [];
  const run = await fixture(t, (_wire, res, req) => {
    assert.equal(req.headers.authorization, 'Bearer fixture'); assert.ok(req.headers['x-client-request-id']);
    if (!attempts++) { res.writeHead(429, { 'retry-after-ms': '1' }); res.end('{"error":{"message":"try again"}}'); } else respond(res, [text]);
  }, { limits: { timeoutMs: 3000, maxRetries: 1 }, nativeSearch: { beforeRequest: event => { requests.push(event.requestNumber); }, onUsage: event => { usage.push(event.usage.totalTokens); } } });
  assert.equal((await run.submit()).text, 'done'); assert.deepEqual(requests, [1, 2]); assert.deepEqual(usage, [15]);
});

test('A native request budget stops continuation before another HTTP dispatch', async t => {
  let requests = 0;
  const run = await fixture(t, (_wire, res) => { requests++; respond(res, [search]); }, { nativeSearch: { maxRequests: 1 } });
  await assert.rejects(run.submit(), /预算|Connection/); assert.equal(requests, 1);
});

test('An endpoint rejecting native protocol reports missing capability without a compatibility retry', async t => {
  let requests = 0;
  const run = await fixture(t, (_wire, res) => { requests++; res.writeHead(400); res.end('{"error":{"message":"unsupported tool_search"}}'); });
  await assert.rejects(run.submit(), /原生能力不可用/); assert.equal(requests, 1); assert.deepEqual(run.effects, []);
});

test('Compaction removes discovery eligibility rather than reloading it from the ledger', async t => {
  let stage = 0; let compacted = false; let attempted = false;
  const run = await fixture(t, (wire, res) => {
    const encoded = JSON.stringify(wire.input);
    if (encoded.includes('<conversation>')) { compacted = true; sendResponsesText(res, 'summary', 'final_answer', 'User asked to use probe. Tool was previously found.'); return; }
    if (compacted && !attempted) { attempted = true; assert.equal(wire.input.some((item: { type: string }) => item.type === 'tool_search_output'), false); respond(res, [call]); return; }
    stage++;
    respond(res, [stage === 1 ? search : stage === 3 ? { ...text, content: [{ type: 'output_text', text: '背景材料'.repeat(3500), annotations: [] }] } : text], { inputTokens: stage === 3 ? 5100 : 10 });
  });
  run.options.modelConfiguration!.models[0]!.contextWindow = 6000; run.options.modelConfiguration!.models[0]!.maxTokens = 1000;
  await run.reopen(); await run.submit(); await run.submit('2'); await run.submit('3');
  assert.equal(compacted, true); assert.equal(attempted, true); assert.deepEqual(run.effects, []);
});

test('Switching from native Responses to ordinary Completions keeps chatting without foreign protocol records', async t => {
  let nativeStage = 0; let switched = false;
  const run = await fixture(t, (wire, res) => {
    if (wire.messages) { switched = true; assert.equal(JSON.stringify(wire).includes('tool_search_output'), false); assert.equal(wire.tools?.some((entry: { function?: { name: string } }) => entry.function?.name === 'probe'), false); sendChatCompletion(res, 'ordinary'); return; }
    respond(res, [nativeStage++ === 0 ? search : text]);
  });
  const original = run.options.modelConfiguration!.models[0]!;
  run.options.modelConfiguration!.models.push({ ...original, alias: 'ordinary', api: 'openai-completions', model: 'ordinary', toolSearch: 'auto' });
  await run.reopen(); await run.submit(); await run.pi.selectModel(run.host.store.conversationSession('c'), 'ordinary');
  assert.equal((await run.submit('2')).text, 'ordinary'); assert.equal(switched, true); assert.deepEqual(run.effects, []);
});
