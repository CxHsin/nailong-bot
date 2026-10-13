import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { Bot } from 'grammy';
import { Response as ApiResponse } from 'node-fetch';
import type { AgentSessionEvent } from '@mariozechner/pi-coding-agent';
import type { AssistantMessage } from '@mariozechner/pi-ai';
import { richReplyPages, textOnlyMarkdown } from '../src/telegram/rich-reply.js';
import { createDraftPreview } from '../src/telegram/draft-preview.js';
import { publicReplyText } from '../src/personal/reply-preview.js';
import { PersonalHost } from '../src/personal/host.js';
import { PersonalStore } from '../src/personal/store.js';
import { createPersonalTelegram } from '../src/personal/telegram.js';
import { createPersonalPi } from '../src/personal/pi.js';

test('Markdown pages preserve headings, table and closed code blocks, with exact source reconstruction', () => {
  const blocks = ['# 标题\n\n', '**粗体** 和 `code`。\n\n', '|工具|能力|\n|---|---|\n|read|读取|\n\n', '```ts\nconst value = 42;\n```\n\n'];
  const source = blocks.join('').repeat(80);
  const pages = richReplyPages(source);
  assert.ok(pages.length > 1);
  assert.equal(pages.map(page => page.text).join(''), source);
  for (const page of pages) {
    assert.equal(page.textFormat, 'markdown');
    assert.ok(Buffer.byteLength(page.text) <= 8000);
    assert.equal((page.text.match(/```/g) ?? []).length % 2, 0);
    assert.equal((page.text.match(/\|工具\|能力\|/g) ?? []).length, (page.text.match(/\|read\|读取\|/g) ?? []).length);
  }
});

test('oversized code, tables and Unicode retain all content as bounded literal pages', () => {
  for (const source of ['```ts\n' + '中文🙂\n'.repeat(5000) + '```', '|a|b|\n|---|---|\n' + '|x|y|\n'.repeat(600), '- item\n'.repeat(600), '[link][ref]\n\n[ref]: https://example.com', '# Heading\r\n\r\nCRLF']) {
    const pages = richReplyPages(source);
    assert.equal(pages.map(page => page.text).join(''), source);
    assert.ok(pages.some(page => page.textFormat === 'plain'));
    for (const page of pages) { assert.ok(Buffer.byteLength(page.text) <= 8000); assert.equal(page.text.includes('\uFFFD'), false); }
  }
});

test('reply Markdown cannot upload remote media or execute rich HTML media tags', () => {
  const safe = textOnlyMarkdown('# title\n\n![remote](https://example.com/a.png)\n\n<tg-collage>\n<img src="https://example.com/b.png">\n</tg-collage>');
  assert.ok(safe.startsWith('# title'));
  assert.equal(safe.includes('!['), false);
  assert.equal(safe.includes('<tg-collage>'), false);
  assert.equal(safe.includes('<img'), false);
  assert.equal(textOnlyMarkdown('**bold** and `code`'), '**bold** and `code`');
});

test('preview extracts only public text snapshots, not reasoning, tools or previous messages', () => {
  const message: AssistantMessage = { role: 'assistant', content: [{ type: 'thinking', thinking: 'SECRET' }, { type: 'text', text: 'visible' }],
    api: 'openai-completions', provider: 'fixture', model: 'fixture', timestamp: 0, stopReason: 'stop',
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
  const event: AgentSessionEvent = { type: 'message_update', message, assistantMessageEvent: { type: 'text_delta', contentIndex: 1, delta: 'visible', partial: message } };
  assert.equal(publicReplyText(event), 'visible');
  assert.equal(publicReplyText({ ...event, assistantMessageEvent: { type: 'thinking_delta', contentIndex: 0, delta: 'SECRET', partial: message } }), undefined);
  assert.equal(publicReplyText({ ...event, assistantMessageEvent: { type: 'toolcall_delta', contentIndex: 2, delta: 'SECRET', partial: message } }), undefined);
  assert.equal(publicReplyText({ type: 'message_start', message }), '');
});

test('draft updates coalesce, use the same id, and stop drains in-flight requests', async () => {
  const sent: Array<{ id: number; text: string }> = [];
  let release!: () => void;
  const barrier = new Promise<void>(resolve => { release = resolve; });
  const draft = createDraftPreview({ intervalMs: 10, reportFailure: assert.fail,
    send: async (id, text) => { sent.push({ id, text }); if (sent.length === 1) await barrier; } });
  try {
    draft.update({ conversationId: 'c', replyId: '1', text: 'a' });
    await delay(15);
    for (const text of ['ab', 'abc', 'abcd']) draft.update({ conversationId: 'c', replyId: '1', text });
    assert.equal(sent.length, 1);
    release(); await delay(30);
    assert.deepEqual(sent.map(item => item.text), ['a', 'abcd']);
    assert.equal(sent[0]!.id, sent[1]!.id);
    draft.update({ conversationId: 'c', replyId: '1' });
    draft.update({ conversationId: 'c', replyId: '1', text: 'late' });
    await draft.stop(); await delay(20);
    assert.equal(sent.length, 2);
  } finally { release(); await draft.close(); }
});

test('final send waits for draft, suppresses drafts during delivery and ignores ended replies', async () => {
  const order: string[] = [];
  let release!: () => void;
  const barrier = new Promise<void>(resolve => { release = resolve; });
  const draft = createDraftPreview({ intervalMs: 5, reportFailure: assert.fail,
    send: async () => { order.push('draft:start'); await barrier; order.push('draft:end'); } });
  try {
    draft.update({ conversationId: 'c', replyId: '1', text: 'preview' }); await delay(15);
    const formal = draft.withoutDrafts(async () => { order.push('final'); await delay(10); });
    await delay(10); assert.deepEqual(order, ['draft:start']);
    release(); await formal;
    draft.update({ conversationId: 'c', replyId: '1', text: 'late' }); await delay(15);
    assert.deepEqual(order, ['draft:start', 'draft:end', 'final']);
  } finally { release(); await draft.close(); }
});

test('draft 429 observes retry_after and retries only the latest snapshot; close clears cooldown', async () => {
  const sent: string[] = [];
  const draft = createDraftPreview({ intervalMs: 5, reportFailure: () => {}, send: async (_id, text) => {
    sent.push(text); if (sent.length === 1) throw Object.assign(new Error('limited'), { error_code: 429, parameters: { retry_after: 1 } });
  } });
  try {
    draft.update({ conversationId: 'c', replyId: '1', text: 'a' }); await delay(30);
    draft.update({ conversationId: 'c', replyId: '1', text: 'latest' }); await delay(100);
    assert.deepEqual(sent, ['a']); await delay(1000);
    assert.deepEqual(sent, ['a', 'latest']);
  } finally { await draft.close(); }
});

test('draft failure and even a throwing error reporter do not prevent final delivery', async () => {
  const draft = createDraftPreview({ intervalMs: 5, reportFailure: () => { throw new Error('report failure'); }, send: async () => { throw new Error('network'); } });
  draft.update({ conversationId: 'c', replyId: '1', text: 'a' }); await delay(15);
  let sent = false; await draft.withoutDrafts(async () => { sent = true; }); await draft.close();
  assert.equal(sent, true);
});

function fakeBot(send: (method: string, payload: Record<string, any>) => Promise<Record<string, unknown>>) {
  return new Bot('123:test', { client: { fetch: async (url, init) => new ApiResponse(JSON.stringify(await send(new URL(String(url)).pathname.split('/').at(-1)!, JSON.parse(String(init?.body))))) } });
}

test('format rejection falls back to plain rich blocks; network ambiguity never triggers a second send', async () => {
  for (const code of [400, 0]) {
    const directory = await mkdtemp(join(tmpdir(), 'telegram-rich-fallback-'));
    const calls: Record<string, any>[] = [];
    const host = new PersonalHost({ store: new PersonalStore(directory), dialogue: { decide: async () => ({ kind: 'reply', text: '**bold**' }) }, executor: { execute: async () => ({ text: '', verified: false }) } });
    const bot = fakeBot(async (method, payload) => {
      assert.equal(method, 'sendRichMessage'); calls.push(payload);
      if (calls.length === 1) { if (!code) throw new Error('connection lost'); return { ok: false, error_code: 400, description: "Bad Request: can't parse rich message" }; }
      return { ok: true, result: { message_id: 9 } };
    });
    const channel = createPersonalTelegram({ bot, ownerId: 42, host, download: async () => { throw new Error('unused'); }, reportFailure: () => {} });
    try {
      const result = await channel.receive({ conversationId: 'telegram:private:42', actorId: 'telegram:42', inputId: '1', text: 'hello' }); await channel.flush();
      assert.equal(calls.length, code ? 2 : 1);
      assert.equal(host.delivery(result.deliveryId!)?.status, code ? 'sent' : 'unknown');
      if (code) assert.deepEqual(calls[1]!.rich_message.blocks, [{ type: 'paragraph', text: '**bold**' }]);
      await channel.recover(); assert.equal(calls.length, code ? 2 : 1);
    } finally { await channel.close(); await host.close(); await rm(directory, { recursive: true, force: true }); }
  }
});

test('actual Pi SSE → Host → grammY previews before generation finishes and learns only formal delivery', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'telegram-pi-stream-'));
  const promptFile = join(directory, 'prompt.md'); await writeFile(promptFile, 'Be helpful.');
  let finishModel!: () => void;
  const modelBarrier = new Promise<void>(resolve => { finishModel = resolve; });
  let previewArrived!: () => void;
  const previewBarrier = new Promise<void>(resolve => { previewArrived = resolve; });
  const server = createServer(async (request, response) => {
    for await (const _part of request) { /* consume request */ }
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: '# 工具\n\n**粗体**' }, finish_reason: null }] })}\n\n`);
    await modelBarrier;
    response.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: '\n\n|工具|能力|\n|---|---|\n|read|读取|' }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const pi = await createPersonalPi({ dataDir: directory, promptFile, modelConfiguration: { defaultModel: 'local', models: [{ alias: 'local', api: 'openai-completions', baseUrl: `http://127.0.0.1:${address.port}`, model: 'local', apiKey: 'test' }] } });
  const host = new PersonalHost({ store: new PersonalStore(directory), dialogue: pi.dialogue, executor: pi.executor });
  const calls: Array<{ method: string; payload: Record<string, any> }> = [];
  let learned = 0;
  const bot = fakeBot(async (method, payload) => {
    calls.push({ method, payload });
    if (method === 'sendRichMessageDraft') { previewArrived(); return { ok: true, result: true }; }
    assert.equal(method, 'sendRichMessage'); return { ok: true, result: { message_id: 99 } };
  });
  const channel = createPersonalTelegram({ bot, ownerId: 42, host, download: async () => { throw new Error('unused'); }, onDelivered: async () => { learned++; }, reportFailure: error => assert.fail(String(error)) });
  let pending: Promise<unknown> | undefined;
  try {
    pending = channel.receive({ conversationId: 'telegram:private:42', actorId: 'telegram:42', inputId: '1', text: '列工具' });
    await Promise.race([previewBarrier, delay(5000).then(() => { throw new Error('No preview before model finished'); })]);
    assert.equal(calls.length, 1); assert.equal(learned, 0); assert.equal(host.store.listDeliveries().length, 0);
    assert.equal(calls[0]!.payload.rich_message.markdown, '# 工具\n\n**粗体**');
    assert.ok(calls[0]!.payload.draft_id > 0);
    finishModel(); await pending; await channel.flush();
    assert.equal(calls.at(-1)!.method, 'sendRichMessage');
    assert.ok(calls.at(-1)!.payload.rich_message.markdown.includes('|read|读取|'));
    assert.equal(learned, 1); assert.equal(host.resolveReply('telegram:private:42', '99'), undefined);
    await channel.recover(); assert.equal(learned, 1);
  } finally { finishModel(); await pending?.catch(() => {}); await channel.close(); await host.close(); await pi.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(directory, { recursive: true, force: true }); }
});

test('Host ends failed reply previews, isolates conversations and suppresses scheduled input previews', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'telegram-preview-host-'));
  const host = new PersonalHost({ store: new PersonalStore(directory), dialogue: { decide: async (_input, context) => { context.onText?.('partial'); throw new Error('model failed'); } }, executor: { execute: async () => ({ text: '', verified: false }) } });
  const events: Array<{ conversationId: string; replyId: string; text?: string }> = [];
  host.subscribePreviews(event => { events.push(event); });
  try {
    const input = { conversationId: 'c', actorId: 'a', inputId: '1', text: 'hello' };
    await assert.rejects(host.submit(input), /model failed/);
    assert.equal(events.length, 2); assert.equal(events[0]!.text, 'partial'); assert.equal(events[1]!.text, undefined);
    assert.equal(events[0]!.replyId, events[1]!.replyId); assert.equal(host.store.listDeliveries().length, 0);
    await assert.rejects(host.submit({ ...input, inputId: '2', origin: 'plan' }), /model failed/);
    assert.equal(events.length, 2);
    await assert.rejects(host.submit({ ...input, conversationId: 'other', inputId: '3' }), /model failed/);
    assert.equal(events[2]!.conversationId, 'other'); assert.notEqual(events[2]!.replyId, events[0]!.replyId);
  } finally { await host.close(); await rm(directory, { recursive: true, force: true }); }
});
