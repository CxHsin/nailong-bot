import { marked, type Token, type Tokens } from "marked";

const escapeHtml = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;")
  .replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function inline(tokens: Token[]): string {
  return tokens.map((token) => {
    switch (token.type) {
      case "strong": return `<b>${inline(token.tokens ?? [])}</b>`;
      case "em": return `<i>${inline(token.tokens ?? [])}</i>`;
      case "del": return `<s>${inline(token.tokens ?? [])}</s>`;
      case "codespan": return `<code>${escapeHtml(token.text)}</code>`;
      case "link": {
        const label = inline(token.tokens ?? []);
        return /^(https?:\/\/|tg:\/\/)/i.test(token.href)
          ? `<a href="${escapeHtml(token.href)}">${label}</a>` : label;
      }
      case "image": return inline(token.tokens ?? []);
      case "br": return "\n";
      case "text": return token.tokens ? inline(token.tokens) : escapeHtml(token.text);
      case "escape": return escapeHtml(token.text);
      case "html": return escapeHtml(token.text);
      default: return escapeHtml("text" in token && typeof token.text === "string" ? token.text : token.raw);
    }
  }).join("");
}

function blocks(tokens: Token[]): string {
  return tokens.map((token) => {
    switch (token.type) {
      case "heading": return `<b>${inline(token.tokens ?? [])}</b>`;
      case "paragraph": return inline(token.tokens ?? []);
      case "text": return token.tokens ? inline(token.tokens) : escapeHtml(token.text);
      case "code": return `<pre><code>${escapeHtml(token.text)}</code></pre>`;
      case "blockquote": return `<blockquote>${blocks(token.tokens ?? [])}</blockquote>`;
      case "list": return token.items.map((item: Tokens.ListItem, index: number) => {
        const marker = token.ordered ? `${Number(token.start || 1) + index}.` : "•";
        const check = item.task ? (item.checked ? "☑ " : "☐ ") : "";
        return `${marker} ${check}${blocks(item.tokens ?? [])}`;
      }).join("\n");
      case "table": return [token.header, ...token.rows]
        .map((row) => row.map((cell: Tokens.TableCell) => inline(cell.tokens ?? [])).join("  |  ")).join("\n");
      case "hr": return "────";
      case "html": return escapeHtml(token.text);
      case "space": return "";
      default: return escapeHtml("text" in token && typeof token.text === "string" ? token.text : token.raw);
    }
  }).filter(Boolean).join("\n\n");
}

/** Telegram accepts a small HTML subset; raw model HTML is always escaped. */
export function formatMarkdownForTelegram(text: string): string {
  return blocks(marked.lexer(text, { gfm: true, breaks: true })).trim();
}
