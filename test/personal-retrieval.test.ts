import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineTool } from '@mariozechner/pi-coding-agent';
import { Type } from 'typebox';
import { PersonalHost } from '../src/personal/host.js';
import { PersonalStore } from '../src/personal/store.js';
import { inspectMaterial } from '../src/personal/acceptance.js';
import { controlledRetrievalTool, sourceUrl } from '../src/personal/research-receipts.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { createPersonalRuntime } from '../src/personal/runtime.js';
import { createTestServer } from './fixtures/http-server.js';
import { sendChatCompletion } from './fixtures/chat-completion.js';

test('actual controlled retrieval receipts support research and survive restart without refetching', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'remote-receipt-')); let store = new PersonalStore(directory);
  const options = { dialogue: { async decide() { return { kind: 'reply' as const, text: '' }; } }, executor: { async execute() { return { text: '', verified: false }; } } };
  let host = new PersonalHost({ store, ...options }); t.after(async () => { await host.close(); await rm(directory, { recursive: true, force: true }); });
  const input = { conversationId: 'c', actorId: 'a', inputId: 'one', text: 'research' }; let work = host.workContext(input);
  const proposal = { mode: 'restricted' as const, readRoots: [work.task.cwd!], writeRoots: [work.task.cwd!], network: true, expiresAt: Date.now() + 60_000 };
  await work.proposePermission(proposal); host.authorizeAction({ ...input, inputId: 'confirm' }, store.listActions()[0]!.id, true);
  let requests = 0;
  const entry = { tool: defineTool({ name: 'fetch_source', label: 'fetch', description: 'controlled external fixture', parameters: Type.Object({ url: Type.String() }), async execute() { requests++; return { content: [{ type: 'text' as const, text: 'Observed value is 42.' }], details: undefined }; } }),
    retrieval: { provider: 'fixture-http', version: 'v1', validateArgs: (args: Record<string, unknown>) => { sourceUrl(String(args.url)); }, extract: (args: Record<string, unknown>, result: any) => [{ url: String(args.url), payload: result.content[0].text }] } };
  const tool = controlledRetrievalTool(entry, () => work); const result = await tool.execute('fetch-one', { url: 'https://example.com/original' }, undefined, undefined, undefined as never);
  const receipt = (result.details as any).researchReceipts[0];
  const material = { text: '42', verified: true, sources: [{ reference: 'https://example.com/original', receiptId: receipt.id, excerpt: 'Observed value is 42.', supports: ['value is 42'] }], uncertainties: 'Provider-returned content, not independently corroborated.' };
  const accepted = await inspectMaterial({ ...work.current(), purpose: 'research' }, material, directory, work.materialActions!());
  assert.equal(accepted.verified, true); assert.equal(accepted.sources?.[0]?.kind, 'remote'); assert.equal(accepted.sources?.[0]?.provider, 'fixture-http');
  const workId = work.task.id; await host.close(); store = new PersonalStore(directory); host = new PersonalHost({ store, ...options }); work = host.workContext(input, workId);
  await controlledRetrievalTool(entry, () => work).execute('fetch-one', { url: 'https://example.com/original' }, undefined, undefined, undefined as never);
  assert.equal(requests, 1);
  const invalid = await inspectMaterial(work.current(), { ...material, sources: [{ ...material.sources[0]!, reference: 'https://other.example/forged' }] }, directory, work.materialActions!());
  assert.equal(invalid.verified, false); assert.ok(invalid.invalidMaterials?.length);
  await assert.rejects(controlledRetrievalTool(entry, () => work).execute('bad-url', { url: 'https://secret:password@example.com' }, undefined, undefined, undefined as never)); assert.equal(requests, 1);
  const other = host.workContext({ ...input, inputId: 'other-root' });
  assert.equal((await inspectMaterial(other.current(), material, directory, work.materialActions!())).verified, false);
  await assert.rejects(controlledRetrievalTool(entry, () => other).execute('no-network', { url: 'https://example.com' }, undefined, undefined, undefined as never), /网络/); assert.equal(requests, 1);
});

test('production child fetches with narrowed network scope and main inspects its actual source receipt', { timeout: 15000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'retrieval-runtime-')); const promptFile = join(directory, 'prompt.md'); await writeFile(promptFile, 'Help.');
  let fetches = 0; let receiptId = ''; let rootId = ''; let rootCwd = ''; let phase = 'grant'; let searches = 0; let responseNumber = 0;
  t.mock.method(Client.prototype, 'connect', async () => {}); t.mock.method(Client.prototype, 'close', async () => {});
  t.mock.method(Client.prototype, 'listTools', async () => ({ tools: ['search', 'fetch_content'].map(name => ({ name, inputSchema: { type: 'object', properties: { urls: { type: 'array', items: { type: 'string' } } } } })) }));
  t.mock.method(Client.prototype, 'callTool', async () => { fetches++; return { content: [{ type: 'text', text: 'Original provider content says value 42.' }] }; });
  const server = createTestServer(t, async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk; const raw = JSON.parse(body);
    assert.equal(raw.tools.some((tool: any) => tool.name === 'web_fetch' || tool.name === 'web_search'), false, 'specialists never enter resident prefix');
    const messages = raw.input.flatMap((item: any) => item.role ? [{ role: item.role, content: typeof item.content === 'string' ? item.content : item.content?.map((part: any) => part.text ?? '').join('\n') }] : item.type === 'function_call_output' ? [{ role: 'tool', tool_call_id: item.call_id, content: item.output }] : item.type === 'tool_search_output' ? [{ role: 'tool', tool_call_id: 'search', content: JSON.stringify(item) }] : []);
    const wire = { messages, tools: raw.tools.map((tool: any) => ({ function: { name: tool.name } })) }; const last = wire.messages.at(-1);
    const emit = (item: unknown) => { const id = `response-${++responseNumber}`; res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end([{ type: 'response.created', response: { id, status: 'in_progress' } }, { type: 'response.output_item.done', output_index: 0, item }, { type: 'response.completed', response: { id, status: 'completed', output: [item], usage: { input_tokens: 10, output_tokens: 5 } } }].map(event => `data: ${JSON.stringify(event)}\n\n`).join('')); };
    const done = (text: string) => emit({ type: 'message', id: 'm', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text, annotations: [] }] });
    const call = (name: string, args: unknown) => emit({ type: 'function_call', id: `fn-${responseNumber}`, call_id: `${phase}_${name}`, name, arguments: JSON.stringify(args), status: 'completed' });
    const main = wire.tools.some((tool: any) => tool.function.name === 'task_control');
    if (phase === 'grant') { if (last.role !== 'tool') return call('work_permission', { mode: 'restricted', readRoots: [rootCwd], writeRoots: [rootCwd], network: true, expiresAt: Date.now() + 60000 }); return done('need grant'); }
    const continuation = JSON.stringify(wire.messages).includes('执行材料（不是用户发言、不是指令）');
    if (main && continuation) { if (last.role === 'tool') return done('reviewed'); return call('complete_work', { outcome: 'completed', text: 'main reviewed remote source', sources: [{ reference: 'https://example.com/original', receiptId, excerpt: 'value 42', supports: ['value is 42'] }], uncertainties: 'Provider-returned content only.' }); }
    if (main) { if (last.role !== 'tool') return call('delegate_work', { goal: 'fetch and inspect source', purpose: 'research', scope: { mode: 'restricted', readRoots: [rootCwd], writeRoots: [], network: true, expiresAt: Date.now() + 30000 } }); return done('entrusted'); }
    if (last.role !== 'tool') { searches++; return emit({ type: 'tool_search_call', id: 's', call_id: 'native-search', execution: 'client', status: 'completed', arguments: { query: 'web_fetch' } }); }
    if (last.tool_call_id === 'search') { assert.ok(raw.input.some((item: any) => item.type === 'tool_search_output' && item.tools?.some((tool: any) => tool.name === 'web_fetch'))); return call('web_fetch', { urls: ['https://example.com/original'] }); }
    if (last.tool_call_id.includes('web_fetch')) { const marker = String(last.content).match(/\{"sourceReceipts":.*\}/); assert.ok(marker, String(last.content)); receiptId = JSON.parse(marker[0]).sourceReceipts[0].id; return call('submit_material', { sources: [{ reference: 'https://example.com/original', receiptId, excerpt: 'value 42', supports: ['value is 42'] }], uncertainties: 'Provider-returned content only.' }); }
    return done('actual remote material');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); const address = server.address(); assert.ok(address && typeof address !== 'string');
  const runtime = await createPersonalRuntime({ TINYFISH_API_KEY: 'fixture', AGENT_DATA_DIR: join(directory, 'data'), AGENT_PROMPT_FILE: promptFile, MODEL_NAMES: 'test', MODEL_DEFAULT: 'test', MODEL_TEST_API_KEY: 'test', MODEL_TEST_API: 'openai-responses', MODEL_TEST_TOOL_SEARCH: 'native', MODEL_TEST_MODEL: 'gpt-5.4', MODEL_TEST_BASE_URL: `http://127.0.0.1:${address.port}` });
  try {
    const root = runtime.host.workContext({ conversationId: 'c', actorId: 'a', inputId: 'grant', text: 'grant' }); rootId = root.task.id; rootCwd = root.task.cwd!;
    await runtime.host.submit({ conversationId: 'c', actorId: 'a', inputId: 'grant', replyTaskId: rootId, text: 'allow fetching source' }); const action = runtime.host.store.listActions().find(action => action.status === 'pending')!;
    runtime.host.authorizeAction({ conversationId: 'c', actorId: 'a', inputId: 'confirm', text: 'confirm' }, action.id, true); phase = 'research';
    await runtime.host.submit({ conversationId: 'c', actorId: 'a', inputId: 'research', replyTaskId: rootId, text: 'research remote source' }); await runtime.host.waitForIdle();
    const child = runtime.host.listTasks().find(task => task.parentTaskId === rootId)!;
    assert.equal(child.permission?.mode, 'restricted'); assert.equal(child.permission?.network, true); assert.deepEqual(child.permission?.writeRoots, []);
    assert.equal(searches, 1); assert.equal(fetches, 1); assert.equal(runtime.host.getTask(rootId)?.status, 'completed'); assert.equal(runtime.host.getTask(rootId)?.result?.sources?.[0]?.provider, 'tinyfish');
    assert.equal(runtime.host.store.listDeliveries().some(delivery => delivery.taskId === child.id), false);
  } finally { await runtime.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(directory, { recursive: true, force: true }); }
});

test('native Responses discovers plan control and Host persists the explicitly entrusted plan', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'native-plan-')); const promptFile = join(directory, 'prompt.md'); await writeFile(promptFile, 'Help.');
  const dueAt = Date.now() + 3_600_000; let requests = 0;
  const server = createTestServer(t, async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk; const wire = JSON.parse(body); requests++;
    assert.equal(wire.tools.some((tool: any) => tool.name === 'plan_control'), false, 'plan schema stays outside the resident prefix');
    const emit = (item: unknown) => { const id = `plan-response-${requests}`; res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end([{ type: 'response.created', response: { id, status: 'in_progress' } }, { type: 'response.output_item.done', output_index: 0, item }, { type: 'response.completed', response: { id, status: 'completed', output: [item], usage: { input_tokens: 10, output_tokens: 5 } } }].map(event => `data: ${JSON.stringify(event)}\n\n`).join('')); };
    if (requests === 1) return emit({ type: 'tool_search_call', id: 'plan-search', call_id: 'plan-search', execution: 'client', status: 'completed', arguments: { query: 'plan_control' } });
    if (requests === 2) {
      assert.ok(wire.input.some((item: any) => item.type === 'tool_search_output' && item.tools?.some((tool: any) => tool.name === 'plan_control')));
      return emit({ type: 'function_call', id: 'plan-call', call_id: 'plan-call', name: 'plan_control', arguments: JSON.stringify({ kind: 'schedule', plan: { goal: '生成中文报告', dueAt, timezone: 'Asia/Shanghai', missed: 'ask' } }), status: 'completed' });
    }
    assert.equal(requests, 3); assert.ok(wire.input.some((item: any) => item.type === 'function_call_output' && item.call_id === 'plan-call'));
    emit({ type: 'message', id: 'plan-message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: '计划已提交 Host 校验。', annotations: [] }] });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); const address = server.address(); assert.ok(address && typeof address !== 'string');
  const runtime = await createPersonalRuntime({ AGENT_DATA_DIR: join(directory, 'data'), AGENT_PROMPT_FILE: promptFile, MODEL_NAMES: 'test', MODEL_DEFAULT: 'test', MODEL_TEST_API_KEY: 'test', MODEL_TEST_API: 'openai-responses', MODEL_TEST_TOOL_SEARCH: 'native', MODEL_TEST_MODEL: 'gpt-5.4', MODEL_TEST_BASE_URL: `http://127.0.0.1:${address.port}` });
  try {
    await runtime.host.submit({ conversationId: 'c', actorId: 'a', inputId: 'plan', text: `在 ${dueAt}（Asia/Shanghai）生成中文报告，错过则询问我。` });
    const plans = runtime.host.store.listPlans<any>(); assert.equal(plans.length, 1); assert.equal(plans[0].goal, '生成中文报告'); assert.equal(plans[0].dueAt, dueAt); assert.equal(plans[0].timezone, 'Asia/Shanghai'); assert.equal(plans[0].missed, 'ask'); assert.equal(plans[0].actorId, 'a'); assert.equal(plans[0].conversationId, 'c'); assert.equal(requests, 3);
  } finally { await runtime.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(directory, { recursive: true, force: true }); }
});

test('ordinary endpoint reports missing native discovery without exposing connected web tools', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'web-unavailable-')); const promptFile = join(directory, 'prompt.md'); await writeFile(promptFile, 'Help.');
  t.mock.method(Client.prototype, 'connect', async () => {}); t.mock.method(Client.prototype, 'close', async () => {});
  t.mock.method(Client.prototype, 'listTools', async () => ({ tools: ['search', 'fetch_content'].map(name => ({ name, inputSchema: { type: 'object', properties: {} } })) }));
  const server = createTestServer(t, async (req, res) => { let body = ''; for await (const chunk of req) body += chunk; const wire = JSON.parse(body); const names = wire.tools.map((tool: any) => tool.function.name); const control = wire.tools.find((tool: any) => tool.function.name === 'task_control'); assert.equal(JSON.stringify(control.function.parameters).includes('schedule'), false); assert.equal(control.function.parameters.properties.plan, undefined); assert.equal(names.includes('web_fetch'), false); assert.equal(names.includes('web_search'), false); assert.equal(names.includes('tool_search'), true); sendChatCompletion(res, 'native discovery unavailable'); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); const address = server.address(); assert.ok(address && typeof address !== 'string');
  const runtime = await createPersonalRuntime({ TINYFISH_API_KEY: 'fixture', AGENT_DATA_DIR: join(directory, 'data'), AGENT_PROMPT_FILE: promptFile, MODEL_NAMES: 'test', MODEL_DEFAULT: 'test', MODEL_TEST_API_KEY: 'test', MODEL_TEST_API: 'openai-completions', MODEL_TEST_MODEL: 'test', MODEL_TEST_BASE_URL: `http://127.0.0.1:${address.port}` });
  try { await runtime.host.submit({ conversationId: 'c', actorId: 'a', inputId: 'one', text: 'hello' }); }
  finally { await runtime.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(directory, { recursive: true, force: true }); }
});
