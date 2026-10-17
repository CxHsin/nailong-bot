import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { richReplyPages, textOnlyMarkdown } from '../src/telegram/rich-reply.js';
import { createDraftPreview } from '../src/telegram/draft-preview.js';

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
