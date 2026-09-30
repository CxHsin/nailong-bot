import { marked } from "marked";
import { renderTelegramBlocks } from "./telegram-format.js";

export const TELEGRAM_PRESENTATION_VERSION = 2;
const CAPACITY = 4000; // Margin below Telegram's 4096 UTF-16 units after parsing.
const graphemes = new Intl.Segmenter("zh", { granularity: "grapheme" });
export function telegramVisibleLength(html: string): number {
  return html.replace(/<[^>]*>/g, "").replace(/&(?:amp|lt|gt|quot);/g, "x").length;
}

/** Splits rendered HTML, maintaining entity and tag boundaries in every message. */
function splitHtml(html: string): string[] {
  const parts: string[] = [];
  const stack: { name: string; opening: string }[] = [];
  let current = "";
  let length = 0;
  const close = () => [...stack].reverse().map((tag) => `</${tag.name}>`).join("");
  const flush = () => {
    if (length) parts.push(current + close());
    current = stack.map((tag) => tag.opening).join("");
    length = 0;
  };
  for (const token of html.match(/<[^>]*>|[^<]+/g) ?? []) {
    if (token.startsWith("<")) {
      const match = token.match(/^<(\/)?([a-z]+)/)!;
      if (match[1]) stack.pop();
      else stack.push({ name: match[2]!, opening: token });
      current += token;
      continue;
    }
    // Entities are atomic; ordinary text is split only at grapheme boundaries.
    const units = (token.match(/&(?:amp|lt|gt|quot);|[^&]+|&/g) ?? []).flatMap((part) =>
      /^&(?:amp|lt|gt|quot);$/.test(part) ? [{ html: part, size: 1 }] :
        Array.from(graphemes.segment(part), (item) => ({ html: item.segment, size: item.segment.length })));
    let start = 0;
    while (start < units.length) {
      let stop = start;
      let size = 0;
      while (stop < units.length && length + size + units[stop]!.size <= CAPACITY) size += units[stop++]!.size;
      if (stop === start) {
        if (length) { flush(); continue; }
        // An adversarial combining sequence can itself exceed the platform cap.
        const pointUnits = Array.from(units[start]!.html, (point) => ({ html: point, size: point.length }));
        units.splice(start, 1, ...pointUnits);
        continue;
      }
      if (stop < units.length) {
        const candidates = units.slice(start, stop);
        let boundary = candidates.findLastIndex((unit) => unit.html === "\n");
        if (boundary < 0) boundary = candidates.findLastIndex((unit) => /[。！？.!?]\s*$/.test(unit.html));
        if (boundary >= 0 && boundary + 1 >= candidates.length / 2) stop = start + boundary + 1;
      }
      const selected = units.slice(start, stop);
      current += selected.map((unit) => unit.html).join("");
      length += selected.reduce((sum, unit) => sum + unit.size, 0);
      start = stop;
      if (start < units.length) flush();
    }
  }
  flush();
  return parts;
}

/** Parse the whole source before pagination so fences never change meaning at a split. */
export function planTelegramText(text: string, complete = true): string[] {
  const tokens = marked.lexer(text, { gfm: true, breaks: true });
  if (!complete && tokens.length && !(tokens.at(-1)?.type === "code" && /^ {0,3}(`{3,}|~{3,})/.test(tokens.at(-1)!.raw))) tokens.pop(); // The last block can still change interpretation.
  const parts: string[] = [];
  let current = "";
  for (const token of tokens) {
    const rendered = renderTelegramBlocks([token]);
    if (!rendered || !telegramVisibleLength(rendered)) continue;
    const chunks = splitHtml(rendered);
    if (chunks.length > 1) {
      if (current) { parts.push(current); current = ""; }
      parts.push(...chunks);
    } else {
      const candidate = current ? current + "\n\n" + rendered : rendered;
      if (telegramVisibleLength(candidate) > CAPACITY) {
        parts.push(current);
        current = rendered;
      } else current = candidate;
    }
  }
  if (current) parts.push(current);
  return parts;
}


export function previewTelegramText(text: string): string[] {
  // A pending URL is shown as its label until it can become a valid link.
  text = text.replace(/\[([^\]\n]+)\]\([^\)\n]*$/, "$1");
  const tokens = marked.lexer(text, { gfm: true, breaks: true });
  const last = tokens.at(-1);
  if (last?.type === "paragraph" || last?.type === "heading") {
    const raw = last.raw;
    let suffix = "";
    for (const marker of ["**", "__", "~~", "`"])
      if (raw.split(marker).length % 2 === 0) suffix = marker + suffix;
    text += suffix;
  }
  return planTelegramText(text);
}
