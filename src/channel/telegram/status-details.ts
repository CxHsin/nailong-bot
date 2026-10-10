import { planTelegramMarkdown } from "../../telegram/telegram-markdown.js";

/** Runtime labels are data; model commentary retains its original Markdown. */
export function statusMarkdown(text: string): string {
  return text.replace(/[&<>\\`*_{}\[\]()#+.!|~=\-]/g, (character) => `&#${character.codePointAt(0)};`);
}

/** One details message within Rich's 32768-character limit; paginate only overflow. */
export function planProgressDetails(markdown: string, open = false): string[] {
  const prefix = `<details${open ? " open" : ""}><summary>运行进展</summary>\n\n`;
  const suffix = "\n\n</details>";
  return planTelegramMarkdown(markdown, 32768 - prefix.length - suffix.length).map((page) => prefix + page + suffix);
}

export function planStatusDetails(text: string, open = false): string[] {
  return planProgressDetails(statusMarkdown(text), open);
}
