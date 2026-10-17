import { createHash } from "node:crypto";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import type { MemoryEntry } from "./memory.js";

export const INITIAL_SELF = `# SELF

## 身份与基础人设

我是用户的私人助手奶龙。天真烂漫、有点傲娇、贪吃，最爱奶香小面包；偶尔迷糊，做正事认真靠谱。

## 相处原则

自然、简洁地用中文回复，除非用户要求其他语言。正事优先，严肃、紧急或精确格式的任务保持清楚准确。角色是说话风格，不改变真实身份、能力或事实。

## 表达习惯

轻松、可爱、偶尔傲娇，自行措辞；不固定重复口头禅，不要求每段动作，不为了扮演编造发现。代码、路径、引用和结构化数据保持原样。

工具动作的昵称仅作风格参考，不必反复复述：grep 是“奶龙雷达”，find 是“奶龙嗅觉”，write 是“奶龙踩脚印”，edit 是“奶龙大尾巴乱涂乱画”，web_search 是“奶龙去外面的世界探险”，web_fetch 是“奶龙翻网页小本本”。实际调用使用原工具名和参数，只提真实路径。
`;

type Part = { text: string; entry?: MemoryEntry };
const digest = (text: string) => createHash("sha256").update(text).digest("hex");

/** Current text lives in this file. SQLite keeps provenance and delivered snapshots, never regenerates it. */
export class SelfFile {
  private text: string;
  private parts: Part[];
  get revision() { return digest(this.text); }
  constructor(readonly path: string, fallback: string, legacy: MemoryEntry[]) {
    this.text = existsSync(path) ? readFileSync(path, "utf8") : fallback;
    this.parts = [];
    const block = /<!-- self-entry (.*?) -->\r?\n([\s\S]*?)\r?\n<!-- \/self-entry -->/g;
    let cursor = 0;
    for (const match of this.text.matchAll(block)) {
      this.addPlain(this.text.slice(cursor, match.index));
      const entry = JSON.parse(match[1]!) as MemoryEntry;
      if (entry.kind !== "SELF" || typeof entry.id !== "string" || typeof entry.sourceId !== "string") throw new Error(`Invalid SELF entry in ${path}`);
      const content = match[2]!;
      this.parts.push({ text: content, entry: content === entry.content ? entry : undefined });
      cursor = match.index! + match[0].length;
    }
    if (cursor) this.addPlain(this.text.slice(cursor));
    else if (/^Source version:/m.test(this.text)) {
      // The retired export includes stable IDs. Preserve modified bodies as local configuration.
      let modified = false;
      for (const paragraph of this.text.split(/\r?\n\r?\n/)) {
        if (!paragraph.trim() || /^# SELF|^Source version:/.test(paragraph)) continue;
        const saved = legacy.find(entry => paragraph.includes(`id=${entry.id} `));
        const content = paragraph.replace(/^\[SELF[^\]]*\]\s*/, "").replace(/\r?\nquote: [\s\S]*$/, "").trim();
        if (saved && !saved.active && saved.content === content) continue;
        if (!saved || saved.content !== content) modified = true;
        if (content) this.parts.push({ text: content, entry: saved && saved.content === content ? saved : undefined });
      }
      if (!modified) {
        const learned = this.parts;
        this.parts = []; this.addPlain(INITIAL_SELF); this.parts.push(...learned);
      }
    } else this.addPlain(this.text);
  }
  private addPlain(text: string) {
    for (const paragraph of text.split(/\r?\n\s*\r?\n/)) {
      const trimmed = paragraph.trim();
      if (trimmed) this.parts.push({ text: trimmed });
    }
  }
  entries(local: (content: string, key: string, section: MemoryEntry["selfSection"]) => MemoryEntry) {
    let section: MemoryEntry["selfSection"] = "identity";
    return this.parts.flatMap(part => {
      if (/^#{1,6} [^\n]+$/.test(part.text)) {
        if (/表达|expression/i.test(part.text)) section = "expression";
        else if (/关系|relationship/i.test(part.text)) section = "relationship";
        else section = "identity";
        return [];
      }
      part.entry ??= local(part.text, digest(part.text), section);
      return [part.entry];
    });
  }
  update(entries: MemoryEntry[]) {
    // Reads only at mutation boundaries, to detect an external edit instead of overwriting it.
    if (!existsSync(this.path) && this.parts.some(part => part.entry)) {
      // First initialization may have parsed a fallback; subsequent deletion must not restore it silently.
      if (this.persisted) throw new Error("SELF file is missing; restart after restoring it");
    }
    if (existsSync(this.path) && readFileSync(this.path, "utf8") !== this.text) throw new Error("SELF file changed externally; restart the service before updating it");
    const current = new Map(entries.map(entry => [entry.id, entry]));
    const parts = this.parts.flatMap(part => {
      if (!part.entry) return [part];
      const entry = current.get(part.entry.id);
      current.delete(part.entry.id);
      return entry ? [{ text: entry.content, entry }] : [];
    });
    parts.push(...[...current.values()].map(entry => ({ text: entry.content, entry })));
    const text = parts.map(part => part.entry
      ? `<!-- self-entry ${JSON.stringify(part.entry)} -->\n${part.text}\n<!-- /self-entry -->`
      : part.text).join("\n\n") + "\n";
    if (!existsSync(this.path) || text !== this.text) {
      writeFileSync(`${this.path}.tmp`, text, "utf8");
      renameSync(`${this.path}.tmp`, this.path);
    }
    this.persisted = true;
    this.text = text; this.parts = parts;
  }
  private persisted = false;
}
