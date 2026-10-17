import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveTelegramDocument } from "../src/assistant/telegram-documents.js";

// A predefined CJK CMap is required: no embedded ToUnicode map can mask its absence.
function chinesePdf() {
  const content = "BT /F1 16 Tf 20 80 Td <4F60597D> Tj ET";
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 100] /Resources << /Font << /F1 4 0 R >> >> /Contents 6 0 R >>",
    "<< /Type /Font /Subtype /Type0 /BaseFont /STSong-Light /Encoding /UniGB-UCS2-H /DescendantFonts [5 0 R] >>",
    "<< /Type /Font /Subtype /CIDFontType0 /BaseFont /STSong-Light /CIDSystemInfo << /Registry (Adobe) /Ordering (GB1) /Supplement 4 >> /DW 1000 >>",
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
  ];
  let pdf = "%PDF-1.4\n"; const offsets = [0];
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(pdf)); pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  pdf += offsets.slice(1).map(offset => `${String(offset).padStart(10, "0")} 00000 n \n`).join("");
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf);
}

test("Telegram PDF extraction loads bundled CMaps and preserves Chinese text without font warnings", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "telegram-cmap-"));
  const warnings: string[] = [];
  const log = console.log;
  t.mock.method(console, "log", (...args: unknown[]) => {
    const line = args.map(String).join(" ");
    if (/Warning:/.test(line)) warnings.push(line); else log(...args);
  });
  try {
    const bytes = chinesePdf();
    const result = await saveTelegramDocument(directory, 1, "中文.pdf", bytes);
    const original = result.match(/^Saved attachment: (.+)$/m)![1]!;
    const extracted = result.match(/^Extracted PDF text: (.+)$/m)![1]!;
    assert.deepEqual(await readFile(original), bytes);
    assert.equal((await readFile(extracted, "utf8")).trim(), "你好");
    assert.match(result, /你好/);
    assert.deepEqual(warnings, []);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
