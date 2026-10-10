import { marked, type Token, type Tokens } from "marked";

const graphemes = new Intl.Segmenter("zh", { granularity: "grapheme" });
type Wrap = (text: string) => string;

/** Paginate native Markdown while reopening the block and inline containers on each page. */
export function planTelegramMarkdown(text: string, capacity = 3500): string[] {
  if (text.length <= capacity) return text.trim() ? [text] : [];
  const fits = (text: string) => text.length <= capacity;
  const identity: Wrap = (text) => text;
  const splitRaw = (source: string, wrap: Wrap): string[] => {
    const parts: string[] = []; let current = "";
    const segments = source.split(/(&#\d+;)/g).flatMap((part) => /^&#\d+;$/.test(part) ? [part] : Array.from(graphemes.segment(part), (item) => item.segment));
    for (const segment of segments) {
      const units = fits(wrap(segment)) ? [segment] : Array.from(segment);
      for (const unit of units) {
        if (!fits(wrap(unit))) throw new Error("Markdown 单元超过 Telegram 消息容量");
        if (!fits(wrap(current + unit))) {
          const newline = current.lastIndexOf("\n");
          if (newline >= current.length / 2) { parts.push(current.slice(0, newline + 1)); current = current.slice(newline + 1); }
          else { parts.push(current); current = ""; }
          if (current && !fits(wrap(current + unit))) { parts.push(current); current = ""; }
        }
        current += unit;
      }
    }
    if (current) parts.push(current);
    return parts;
  };
  const pack = (parts: string[], wrap: Wrap): string[] => {
    const pages: string[] = []; let current = "";
    for (const part of parts) {
      if (current && !fits(wrap(current + part))) { pages.push(current); current = ""; }
      current += part;
    }
    if (current) pages.push(current);
    return pages;
  };
  const inline = (tokens: Token[], wrap: Wrap): string[] => pack(tokens.flatMap((token): string[] => {
    if (fits(wrap(token.raw))) return [token.raw];
    let decorate: Wrap | undefined;
    if (token.type === "strong") decorate = (text) => `**${text}**`;
    if (token.type === "em") decorate = (text) => `*${text}*`;
    if (token.type === "del") decorate = (text) => `~~${text}~~`;
    if (token.type === "codespan") {
      const delimiter = "`".repeat(Math.max(1, ...(token.text.match(/`+/g) ?? []).map((run: string) => run.length + 1)));
      decorate = (text) => `${delimiter} ${text} ${delimiter}`;
    }
    if (token.type === "link") {
      const destination = token.raw.slice(token.raw.lastIndexOf("]("));
      if (!destination.startsWith("](")) throw new Error("长引用链接不能拆分为独立 Markdown 页");
      decorate = (text) => `[${text}${destination}`;
    }
    if (decorate) {
      const format = decorate;
      const chunks = "tokens" in token && Array.isArray(token.tokens) ? inline(token.tokens, (text) => wrap(format(text))) : splitRaw("text" in token ? String(token.text) : token.raw, (text) => wrap(format(text)));
      return chunks.map(format);
    }
    if (token.type === "text" && token.tokens?.length) return inline(token.tokens, wrap);
    return splitRaw(token.raw, wrap);
  }), wrap);
  const blocks = (tokens: Token[], wrap: Wrap): string[] => {
    const pages: string[] = []; let current = "";
    for (const token of tokens) {
      const parts = block(token, wrap);
      if (parts.length > 1) {
        if (current) { pages.push(current); current = ""; }
        pages.push(...parts.slice(0, -1)); current = parts.at(-1)!;
      } else if (parts[0]) {
        if (current && !fits(wrap(current + parts[0]))) { pages.push(current); current = ""; }
        current += parts[0];
      }
    }
    if (current) pages.push(current);
    return pages;
  };
  const block = (token: Token, wrap: Wrap): string[] => {
    if (fits(wrap(token.raw))) return [token.raw];
    if (token.type === "code") {
      const fence = "`".repeat(Math.max(3, ...(token.text.match(/`+/g) ?? []).map((run: string) => run.length + 1)));
      const format: Wrap = (text) => `${fence}${token.lang ?? ""}\n${text}\n${fence}\n`;
      return splitRaw(token.text, (text) => wrap(format(text))).map(format);
    }
    if (token.type === "blockquote") {
      const format: Wrap = (text) => text.split("\n").map((line) => `> ${line}`).join("\n");
      return blocks(token.tokens ?? [], (text) => wrap(format(text))).map(format);
    }
    if (token.type === "list") {
      const list = token as Tokens.List;
      return pack(list.items.flatMap((item, index) => {
        const marker = list.ordered ? `${Number(list.start) + index}. ` : "- ";
        const task = item.task ? `[${item.checked ? "x" : " "}] ` : "";
        const format: Wrap = (text) => {
          const lines = (task + text).split("\n");
          return marker + lines[0] + "\n" + lines.slice(1).map((line) => line ? " ".repeat(marker.length) + line : "").join("\n") + "\n";
        };
        return blocks(item.tokens, (text) => wrap(format(text))).map(format);
      }), wrap);
    }
    if ((token.type === "paragraph" || token.type === "text" || token.type === "heading") && token.tokens?.length) {
      const prefix = token.type === "heading" ? "#".repeat(token.depth) + " " : "";
      const format: Wrap = (text) => prefix + text + "\n\n";
      return inline(token.tokens, (text) => wrap(format(text))).map(format);
    }
    if (token.type === "table") {
      const lines = token.raw.trimEnd().split("\n");
      const header = lines.slice(0, 2).join("\n") + "\n";
      const rows = lines.slice(2).map((line) => line + "\n");
      if (rows.some((row) => !fits(wrap(header + row)))) throw new Error("Markdown 表格行超过 Telegram 消息容量");
      return pack(rows, (text) => wrap(header + text)).map((text) => header + text);
    }
    return splitRaw(token.raw, wrap);
  };
  return blocks(marked.lexer(text, { gfm: true, breaks: true }), identity).filter((page) => page.trim());
}
