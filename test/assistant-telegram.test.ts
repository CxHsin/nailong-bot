import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Bot } from "grammy";
import { Response as ApiResponse } from "node-fetch";
import { telegramFixture, botInfo } from "./fixtures/telegram.js";
import { sendChatCompletion } from "./fixtures/chat-completion.js";
import { type Wire } from "./fixtures/assistant.js";
import { downloadTelegramDocument, MAX_DOCUMENT_BYTES } from "../src/telegram/telegram-input.js";

const update = (id: number, actor = 42, photo = false) => ({
  update_id: id,
  message: {
    message_id: id,
    date: 0,
    chat: { id: actor, type: "private" as const, first_name: "owner" },
    from: { id: actor, is_bot: false, first_name: "owner" },
    ...(photo
      ? {
          caption: "inspect photo",
          photo: [
            { file_id: "photo", file_unique_id: "photo", width: 1, height: 1 },
          ],
        }
      : { text: "hello" }),
  },
});

test("unknown remote file acceptance blocks a second tool call and pauses for verification", { timeout: 60_000 }, async () => {
  let requests = 0; let documents = 0;
  const f = await telegramFixture((_wire, response) => {
    requests++;
    if (requests < 3) sendChatCompletion(response, "", [{ index: 0, id: `send-${requests}`, type: "function",
      function: { name: "send_file", arguments: '{"path":"report.txt"}' } }]);
    else sendChatCompletion(response, "I cannot verify the delivery; please check Telegram before continuing.");
  }, async (method) => {
    if (method === "sendDocument") { documents++; await writeFile(join(f.directory, "remote-accepted.txt"), "one document"); throw new Error("ECONNRESET after remote acceptance"); }
    return new ApiResponse(JSON.stringify({ ok: true, result: { message_id: 10, date: 0, chat: { id: 42, type: "private" } } }), { headers: { "content-type": "application/json" } });
  });
  try {
    await writeFile(join(f.directory, "report.txt"), "one requested document");
    await f.app.receive({ conversationId: "telegram:private:42", source: "telegram", inputId: "file-request", text: "Send report.txt once." });
    await f.app.waitForIdle();
    assert.equal(documents, 1);
    const receipts = await readFile(join(f.directory, "telegram-sends.jsonl"), "utf8");
    assert.match(receipts, /unknown/); assert.match(receipts, /report.txt/); assert.match(receipts, /outputId/);
    await f.app.receive({ conversationId: "telegram:private:42", source: "telegram", inputId: "other", text: "Just discuss another question." });
    await f.app.waitForIdle(); assert.equal(documents, 1);
  } finally { await f.close(); }
});


const documentUpdate = (id: number, name: string, actor = 42, caption?: string) => {
  const item = update(id, actor);
  const message = { ...item.message, text: undefined };
  return { ...item, message: { ...message, caption, document: {
    file_id: name, file_unique_id: name, file_name: name, file_size: 100,
  } } };
};

test("Telegram documents persist under media with captions, identity, authorization and deduplication", async () => {
  const wires: Wire[] = [];
  const f = await telegramFixture((wire, response) => { wires.push(wire); sendChatCompletion(response, "saved"); });
  try {
    await f.bot.handleUpdate(documentUpdate(90, "../notes.txt", 43));
    await f.bot.handleUpdate(documentUpdate(91, "../notes.txt", 42, "inspect my notes"));
    await f.bot.handleUpdate(documentUpdate(91, "../notes.txt", 42, "inspect my notes"));
    await f.flush();
    assert.equal(wires.length, 1);
    const wire = JSON.stringify(wires[0]);
    assert.match(wire, /inspect my notes/);
    const paths = [...wire.matchAll(/Saved attachment: ([^\\]+)\\n/g)];
    assert.equal(paths.length, 1);
    const path = paths[0]![1]!;
    assert.match(path, /\/media\//);
    assert.equal(await readFile(path, "utf8"), "attachment data");
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

test("Telegram download failures reply explicitly without starting a model request", async () => {
  let requests = 0;
  const f = await telegramFixture((_wire, response) => { requests++; sendChatCompletion(response, "unexpected"); }, undefined,
    async () => { throw new Error("附件超过 20 MiB 下载限制"); });
  try {
    await f.bot.handleUpdate(documentUpdate(92, "large.bin")); await f.flush();
    assert.equal(requests, 0);
    assert.match(String(f.sent.find(call => call.method === "sendMessage")?.body), /20 MiB/);
  } finally { await f.close(); }
});

// A minimal independent PDF fixture with one text page and a valid cross-reference table.
function textPdf(text: string) {
  const stream = `BT /F1 12 Tf 72 720 Td (${text}) Tj ET`;
  const objects = ["<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>", `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`];
  let pdf = "%PDF-1.4\n"; const offsets = [0];
  objects.forEach((object, i) => { offsets.push(Buffer.byteLength(pdf)); pdf += `${i + 1} 0 obj\n${object}\nendobj\n`; });
  const start = Buffer.byteLength(pdf);
  pdf += `xref\n0 6\n0000000000 65535 f \n${offsets.slice(1).map(offset => `${String(offset).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${start}\n%%EOF\n`;
  return Buffer.from(pdf);
}

test("Telegram PDF text and real paths reach the assistant, while extraction failure retains the original", async () => {
  const requests: Wire[] = [];
  const f = await telegramFixture((wire, response) => { requests.push(wire); sendChatCompletion(response, "read"); }, undefined,
    async id => id === "valid.pdf" ? textPdf("PDF_BODY_314") : Buffer.from("%PDF-broken"));
  try {
    await f.bot.handleUpdate(documentUpdate(93, "valid.pdf")); await f.flush();
    assert.equal(requests.length, 1);
    const serialized = JSON.stringify(requests[0]);
    assert.match(serialized, /PDF_BODY_314/);
    const path = serialized.match(/Extracted PDF text: ([^\\]+)\\n/)?.[1];
    assert.ok(path);
    assert.match(await readFile(path, "utf8"), /PDF_BODY_314/);
    await f.bot.handleUpdate(documentUpdate(94, "broken.pdf")); await f.flush();
    assert.equal(requests.length, 1);
    const failure = JSON.parse(String(f.sent.find(call => call.method === "sendMessage")?.body)).text as string;
    assert.match(failure, /PDF 正文提取失败/);
    const original = failure.match(/原文件已保存：([^；]+)/)?.[1]; assert.ok(original);
    assert.equal(await readFile(original, "utf8"), "%PDF-broken");
  } finally { await f.close(); }
});

test("Telegram document downloads enforce metadata and actual streamed byte limits", async () => {
  let size = MAX_DOCUMENT_BYTES + 1; let downloads = 0;
  const bot = new Bot("test", { botInfo, client: { fetch: async () => new ApiResponse(JSON.stringify({ ok: true,
    result: { file_path: "docs/file", file_size: size } })) } });
  const download: typeof fetch = async () => { downloads++; return new Response(new ReadableStream({ start(controller) {
    controller.enqueue(new Uint8Array(MAX_DOCUMENT_BYTES)); controller.enqueue(new Uint8Array(1)); controller.close();
  } })); };
  let requests = 0;
  const f = await telegramFixture((_wire, response) => { requests++; sendChatCompletion(response, "unexpected"); }, undefined,
    id => downloadTelegramDocument(bot, "test", id, download));
  try {
    await f.bot.handleUpdate(documentUpdate(95, "metadata.bin")); await f.flush();
    assert.equal(downloads, 0);
    size = 1;
    await f.bot.handleUpdate(documentUpdate(96, "streamed.bin")); await f.flush();
    assert.equal(downloads, 1); assert.equal(requests, 0);
    const replies = f.sent.filter(call => call.method === "sendMessage");
    assert.equal(replies.length, 2); assert.ok(replies.every(call => /20 MiB/.test(String(call.body))));
  } finally { await f.close(); }
});

test("Telegram authenticates and deduplicates input and returns rich output from native Pi", async () => {
  let requests = 0;
  const f = await telegramFixture((_wire, response) => {
    requests++;
    sendChatCompletion(response, "**hello**");
  });
  try {
    await f.bot.handleUpdate(update(1, 43));
    await f.bot.handleUpdate(update(2));
    await f.bot.handleUpdate(update(2));
    await f.flush();
    assert.equal(requests, 1);
    assert.equal(
      f.sent.filter((call) => call.method === "sendRichMessage").length,
      1,
    );
    assert.deepEqual(f.errors, []);
  } finally {
    await f.close();
  }
});

test("Telegram /kvcache normalizes bot addressing, authenticates and returns cache reports without a model", async () => {
  let requests = 0;
  const f = await telegramFixture((_wire, response) => { requests++; sendChatCompletion(response, "unexpected"); });
  const command = (id: number, text: string, actor = 42) => {
    const item = update(id, actor);
    return { ...item, message: { ...item.message, text } };
  };
  try {
    await f.bot.handleUpdate(command(1, "/kvcache", 43));
    await f.bot.handleUpdate(command(2, "/kvcache@other_bot"));
    await f.bot.handleUpdate(command(3, "/kvcache@test_bot"));
    await f.bot.handleUpdate(command(3, "/kvcache@test_bot"));
    await f.flush();
    assert.equal(requests, 0);
    const reports = f.sent.filter(call => call.method === "sendMessage");
    assert.equal(reports.length, 1);
    assert.match(String(reports[0]!.body), /胃囊报表/);
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

test("Telegram cache report sends literal multiline text while ordinary answers keep Markdown", async () => {
  const f = await telegramFixture((_wire, response) => {
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: "**hello**" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 630766, completion_tokens: 10, prompt_tokens_details: { cached_tokens: 566272 } } })}\n\ndata: [DONE]\n\n`);
  });
  try {
    await f.bot.handleUpdate(update(1)); await f.flush();
    const command = update(2);
    await f.bot.handleUpdate({ ...command, message: { ...command.message, text: "/kvcache" } });
    await f.flush();
    const answer = f.sent.filter(call => call.method === "sendRichMessage").map(call => JSON.parse(String(call.body)).rich_message);
    assert.equal(answer.length, 1);
    assert.equal(answer[0].markdown, "**hello**");
    const report = f.sent.filter(call => call.method === "sendMessage").map(call => JSON.parse(String(call.body)));
    assert.equal(report.length, 1);
    assert.equal(report[0].parse_mode, undefined);
    assert.equal(report[0].text,
      "🦖 【奶龙赛博反刍胃囊报表】\n\n1. 🟡 命中率：89.8%\nHit：566272\nMiss：64494\n合计输入：630766\n完美反刍，熟悉的味道又回来啦！");
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

test("Telegram photo reaches native Pi and a requested file reaches sendDocument", async () => {
  const f = await telegramFixture((wire, response) => {
    if (wire.messages.at(-1)?.role !== "tool") {
      assert.match(JSON.stringify(wire.messages), /data:image\/png;base64/);
      sendChatCompletion(response, "", [
        {
          index: 0,
          id: "file",
          type: "function",
          function: { name: "send_file", arguments: '{"path":"result.txt"}' },
        },
      ]);
    } else sendChatCompletion(response, "file delivered");
  });
  try {
    await writeFile(join(f.directory, "result.txt"), "photo result");
    await f.bot.handleUpdate(update(1, 42, true));
    await f.flush();
    assert.equal(
      f.sent.filter((call) => call.method === "sendDocument").length,
      1,
    );
    assert.deepEqual(f.errors, []);
    assert.match(
      await readFile(join(f.directory, "telegram-sends.jsonl"), "utf8"),
      /"status":"sent"/,
    );
  } finally {
    await f.close();
  }
});

test("definite Telegram format rejection falls back to plain blocks", async () => {
  let calls = 0;
  const bodies: string[] = [];
  const f = await telegramFixture(
    (_wire, response) => sendChatCompletion(response, "**hello**"),
    (method, body) => {
      if (method === "sendRichMessage") {
        bodies.push(String(body));
        if (++calls === 1)
          return new ApiResponse(
            JSON.stringify({
              ok: false,
              error_code: 400,
              description: "cannot parse entities",
            }),
          );
      }
      return new ApiResponse(
        JSON.stringify({ ok: true, result: { message_id: 10 } }),
      );
    },
  );
  try {
    await f.bot.handleUpdate(update(1));
    await f.flush();
    assert.equal(calls, 2);
    assert.match(bodies[0]!, /markdown/);
    assert.match(bodies[1]!, /blocks/);
    assert.deepEqual(f.errors, []);
  } finally {
    await f.close();
  }
});

test("ambiguous Telegram send is recorded without automatic retry", async () => {
  let calls = 0;
  const f = await telegramFixture(
    (_wire, response) => sendChatCompletion(response, "hello"),
    (method) => {
      if (method === "sendRichMessage") {
        calls++;
        throw new Error("connection lost after request");
      }
      return new ApiResponse(JSON.stringify({ ok: true, result: true }));
    },
  );
  try {
    await f.bot.handleUpdate(update(1));
    await f.flush();
    assert.equal(calls, 1);
    assert.ok(f.errors.length > 0);
    assert.match(
      await readFile(join(f.directory, "telegram-sends.jsonl"), "utf8"),
      /"status":"unknown"/,
    );
  } finally {
    await f.close();
  }
});
