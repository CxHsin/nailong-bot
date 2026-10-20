// Ported from akashic-agent 94027a5c, MIT, Copyright (c) 2026 kachofugetsu09.
// Full notice: ./LICENSE. Native tokenizer compatibility evidence accompanies fixtures.
import { Jieba } from "@node-rs/jieba";
import { dict } from "@node-rs/jieba/dict.js";

export const LEXICAL_VERSION = "jieba-rs-2.0.4-search-hmm-ascii-cjk3400-9fff-v1";
let tokenizer: Jieba | undefined;

export function utf8Compare(first: string, second: string): number {
  return Buffer.compare(Buffer.from(first), Buffer.from(second));
}

/** Same chunking, search-mode HMM and frequency contract as Python lexical.py. */
export function tokenize(text: string): Array<[string, number]> {
  const terms = new Map<string, number>();
  for (const chunk of text.toLowerCase().match(/[A-Za-z0-9_]+|[\u3400-\u9fff]+/g) ?? []) {
    const pieces = /[\u3400-\u9fff]/u.test(chunk)
      ? (tokenizer ??= Jieba.withDict(dict)).cutForSearch(chunk, true) : [chunk];
    for (const piece of pieces) {
      const term = piece.trim();
      if ([...term].length >= 2) terms.set(term, (terms.get(term) ?? 0) + 1);
    }
  }
  return [...terms].sort(([first], [second]) => utf8Compare(first, second));
}
