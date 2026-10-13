import { marked } from 'marked';
import type { Delivery } from '../personal/types.js';

export interface RichPage { text: string; textFormat: NonNullable<Delivery['textFormat']> }
const pageBytes = 8000;
function literalPages(text: string): RichPage[] {
  const pages: RichPage[] = [];
  let chunk = ''; let bytes = 0;
  for (const point of text) {
    const size = Buffer.byteLength(point, 'utf8');
    if (bytes + size > pageBytes) { pages.push({ text: chunk, textFormat: 'plain' }); chunk = ''; bytes = 0; }
    chunk += point; bytes += size;
  }
  if (chunk) pages.push({ text: chunk, textFormat: 'plain' });
  return pages;
}

/** Keep whole Markdown blocks together. Oversized blocks are shown literally rather than cut into invalid syntax. */
export function richReplyPages(text: string): RichPage[] {
  const tokens = marked.lexer(text);
  // The lexer omits reference definitions and normalizes CRLF: preserve original bytes in that case.
  if (tokens.map(token => token.raw).join('') !== text) return literalPages(text);
  const pages: RichPage[] = [];
  let pending = '';
  let blocks = 0;
  const flush = () => { if (pending) pages.push({ text: pending, textFormat: 'markdown' }); pending = ''; blocks = 0; };
  for (const token of tokens) {
    // Nested lists and large tables also consume the API's 500-block budget.
    let count = 1;
    marked.walkTokens([token], () => { count++; });
    if (token.type === 'table') count += token.rows.length;
    const raw = token.raw;
    if (Buffer.byteLength(raw, 'utf8') > pageBytes || count > 200) {
      flush(); pages.push(...literalPages(raw));
      continue;
    }
    if (Buffer.byteLength(pending + raw, 'utf8') > pageBytes || blocks + count > 200) flush();
    pending += raw; blocks += count;
  }
  flush();
  return pages;
}

/** Reply rendering cannot upload remote images/media or interpret arbitrary rich HTML tags. */
export function textOnlyMarkdown(text: string): string {
  const replacements = new Map<string, string>();
  marked.walkTokens(marked.lexer(text), token => {
    if (token.type === 'image') replacements.set(token.raw, token.text.replace(/[\\`*_{}\[\]()#+.!<>|~]/g, '\\$&'));
    if (token.type === 'html') replacements.set(token.raw, token.raw.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'));
  });
  for (const [raw, safe] of replacements) text = text.split(raw).join(safe);
  return text;
}
