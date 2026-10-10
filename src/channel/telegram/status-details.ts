const suffix = "\n\n</details>";
const capacity = 3500;
const graphemes = new Intl.Segmenter("zh", { granularity: "grapheme" });

/** Complete native details pages; live snapshots open, persisted messages collapse. */
export function planStatusDetails(text: string, open = false): string[] {
  const prefix = `<details${open ? " open" : ""}><summary>运行状态</summary>\n\n`;
  const pages: string[] = []; let body = "";
  const flush = () => { if (body) pages.push(prefix + body + suffix); body = ""; };
  const append = (unit: string) => {
    if (prefix.length + body.length + unit.length + suffix.length > capacity) flush();
    body += unit;
  };
  // Status labels are data. Encode markup punctuation atomically so neither
  // tool names nor a page boundary can introduce tags or Markdown structure.
  const literal = (unit: string) => unit.replace(/[&<>\\`*_{}\[\]()#+.!|~=\-]/g, (character) => `&#${character.codePointAt(0)};`);
  for (const { segment } of graphemes.segment(text)) {
    const encoded = literal(segment);
    if (prefix.length + encoded.length + suffix.length <= capacity) append(encoded);
    else for (const character of segment) append(literal(character));
  }
  flush(); return pages;
}
