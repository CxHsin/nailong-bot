import { marked } from "marked";
import { renderTelegramBlocks } from "./telegram-format.js";

export const TELEGRAM_PRESENTATION_VERSION = 2;
const CAPACITY = 4000; // Margin below Telegram's 4096 UTF-16 units after parsing.
const graphemes = new Intl.Segmenter("zh", { granularity: "grapheme" });
export function telegramVisibleLength(html: string): number {
  return html.replace(/<[^>]*>/g, "").replace(/&(?:amp|lt|gt|quot);/g, "x").length;
}

/** Splits rendered HTML, maintaining entity and tag boundaries in every message. */
function splitHtml(html: string, capacity: number): string[] {
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
      while (stop < units.length && length + size + units[stop]!.size <= capacity) size += units[stop++]!.size;
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
export function planTelegramText(text: string, complete = true, capacity = CAPACITY): string[] {
  // Reference labels/definitions can retroactively change any earlier block.
  // Withhold early commits for bracket syntax; final rendering still supports references.
  if (!complete && text.includes("[")) return [];
  const tokens = marked.lexer(text, { gfm: true, breaks: true });
  if (!complete && tokens.length && !(tokens.at(-1)?.type === "code" && /^ {0,3}(`{3,}|~{3,})/.test(tokens.at(-1)!.raw))) tokens.pop(); // The last block can still change interpretation.
  const parts: string[] = [];
  let current = "";
  for (const token of tokens) {
    const rendered = renderTelegramBlocks([token]);
    if (!rendered || !telegramVisibleLength(rendered)) continue;
    const chunks = splitHtml(rendered, capacity);
    if (chunks.length > 1) {
      if (current) { parts.push(current); current = ""; }
      parts.push(...chunks);
    } else {
      const candidate = current ? current + "\n\n" + rendered : rendered;
      if (telegramVisibleLength(candidate) > capacity) {
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
    for (const marker of ["**", "__", "~~", "`", "*", "_"]) {
      const escaped = marker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const emphasisSource = marker.includes("_") ? raw.replace(/(?<=[\p{L}\p{N}])_(?=[\p{L}\p{N}])/gu, "") : raw;
      const openings = emphasisSource.match(new RegExp(`(?<!\\\\)${escaped}`, "g")) ?? [];
      if (openings.length % 2 && !new RegExp(`^\\s*${escaped}\\s`).test(raw)) suffix = marker + suffix;
    }
    if (suffix) {
      // Overlapping runs (e.g. **text*) need only the missing part of the run.
      const candidates = ["", ...Array.from({ length: suffix.length }, (_, index) => suffix.slice(index))];
      let best = text;
      let score = Number.POSITIVE_INFINITY;
      for (const candidate of candidates) {
        const rendered = renderTelegramBlocks(marked.lexer(text + candidate, { gfm: true, breaks: true }));
        const remaining = rendered.replace(/<[^>]*>/g, "").match(/[*_~`]/g)?.length ?? 0;
        if (remaining < score) { score = remaining; best = text + candidate; }
      }
      text = best;
    }
  }
  return planTelegramText(text);
}
