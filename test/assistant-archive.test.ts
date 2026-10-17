import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Type } from "@earendil-works/pi-ai";
import { assistantFixture, type Wire } from "./fixtures/assistant.js";
import { sendChatCompletion } from "./fixtures/chat-completion.js";

function invoke(response: Parameters<typeof sendChatCompletion>[0], name: string, args: object, id: string) {
  sendChatCompletion(response, "", [{ index: 0, id, type: "function", function: { name, arguments: JSON.stringify(args) } }]);
}
function toolText(wire: Wire) { return String(wire.messages.filter((message) => message.role === "tool").at(-1)?.content ?? ""); }
function archiveDirectory(directory: string) { return join(directory, "fresh", "executions", createHash("sha256").update("one").digest("hex"), "archives"); }

test("long tool evidence is bounded before its first provider continuation and can be found and paged after reset/reopen", { timeout: 15000 }, async () => {
  const original = "FAILED old test\n" + "奶龙🙂".repeat(400) + "\nfinal evidence\n";
  let phase = "produce"; let effects = 0; let reference = ""; let continuation = "";
  const pages: Array<{ text: string; bytes: number; lines: number; next?: { byteOffset: number; offset: number } }> = [];
  const f = await assistantFixture((wire, response) => {
    if (phase === "produce") {
      if (wire.messages.at(-1)?.role !== "tool") return invoke(response, "test_log", { command: "npm test old" }, "old-test");
      continuation = toolText(wire); reference = continuation.match(/archive:[a-f0-9]{64}/)?.[0] ?? "";
      return sendChatCompletion(response, "evidence saved");
    }
    if (wire.messages.at(-1)?.role !== "tool") return invoke(response, "archive_search", { command: "npm test", limit: 999 }, "search-old");
    const lastId = wire.messages.filter((message) => message.role === "tool").at(-1)?.tool_call_id;
    if (lastId === "search-old") {
      const search = JSON.parse(toolText(wire));
      assert.equal(search.scope, "one"); assert.equal(search.items.length, 1); assert.equal(search.items[0].status, "success");
      assert.equal(search.items[0].ref, reference);
      return invoke(response, "archive_read", { ref: reference, maxBytes: 129, limit: 2 }, "page-0");
    }
    const page = JSON.parse(toolText(wire)); pages.push(page);
    assert.ok(page.bytes <= 129); assert.ok(page.lines <= 2);
    if (page.next) return invoke(response, "archive_read", { ref: reference, ...page.next, maxBytes: 129, limit: 2 }, `page-${pages.length}`);
    sendChatCompletion(response, "recovered evidence");
  }, async () => ({ archive: { thresholdBytes: 1024, previewBytes: 512 }, tools: [{ name: "test_log", label: "test log", description: "Run tests", parameters: Type.Object({ command: Type.String() }),
    async execute() { effects++; return { content: [{ type: "text" as const, text: original }], details: {} }; } }] }));
  try {
    await f.app.receive({ conversationId: "one", inputId: "1", text: "run old test" }); await f.app.waitForIdle();
    assert.match(continuation, /archived/); assert.ok(reference); assert.ok(Buffer.byteLength(continuation) < 1400);
    assert.doesNotMatch(continuation, /final evidence/);
    await f.app.receive({ conversationId: "one", inputId: "2", text: "/reset" }); await f.app.waitForIdle(); await f.reopen();
    phase = "recover";
    await f.app.receive({ conversationId: "one", inputId: "3", text: "find old npm test evidence" }); await f.app.waitForIdle();
    assert.equal(pages.map((page) => page.text).join(""), original); assert.equal(effects, 1);
  } finally { await f.close(); }
});

test("archive discovery separates failed and successful similar executions, pages its index, and bounds cumulative connector progress", { timeout: 15000 }, async () => {
  let phase = "failure"; let effects = 0; const views: string[] = []; const discoveries: any[] = []; let progressPage: any;
  const f = await assistantFixture((wire, response) => {
    if (phase === "failure" || phase === "success") {
      if (wire.messages.at(-1)?.role !== "tool") return invoke(response, "test_log", { command: "npm test", path: "src/example.ts" }, `${phase}-call`);
      views.push(toolText(wire)); return sendChatCompletion(response, "recorded");
    }
    if (wire.messages.at(-1)?.role !== "tool") return invoke(response, "archive_search", { command: "npm test", file: "example.ts", limit: 999 }, "search-1");
    const lastId = wire.messages.filter((message) => message.role === "tool").at(-1)?.tool_call_id;
    if (lastId?.startsWith("search")) {
      const page = JSON.parse(toolText(wire)); assert.equal(page.items.length, 1); discoveries.push(...page.items);
      if (page.next !== undefined) return invoke(response, "archive_search", { command: "npm test", file: "example.ts", limit: 999, cursor: page.next }, "search-2");
      return invoke(response, "archive_read", { ref: discoveries[0].ref, stream: "progress", maxBytes: 999999, limit: 99999 }, "progress-page");
    }
    progressPage = JSON.parse(toolText(wire)); sendChatCompletion(response, "found both outcomes");
  }, async () => ({ archive: { thresholdBytes: 1024, previewBytes: 256, maxSearchLimit: 1, maxReadBytes: 64, maxReadLines: 2 },
    tools: [{ name: "test_log", label: "tests", description: "Execute tests with progress", parameters: Type.Object({ command: Type.String(), path: Type.String() }),
      async execute(_id, _args, _signal, update) {
        effects++; for (let index = 0; index < 20; index++) update?.({ content: [{ type: "text", text: `step ${index}: ` + "a".repeat(100) + "\n" }], details: {} });
        return { content: [{ type: "text" as const, text: phase === "failure" ? "FAILED 1 test; error: original failure" : "PASSED 1 test" }], details: { isError: phase === "failure" } };
      } }] }));
  try {
    for (const outcome of ["failure", "success"]) { phase = outcome; await f.app.receive({ conversationId: "one", inputId: outcome, text: `run ${outcome}` }); await f.app.waitForIdle(); }
    assert.match(views[0]!, /status=error/); assert.match(views[0]!, /original failure/); assert.match(views[1]!, /status=success/);
    assert.ok(views.every((view) => Buffer.byteLength(view) < 1200));
    await f.app.receive({ conversationId: "one", inputId: "reset", text: "/reset" }); await f.app.waitForIdle(); await f.reopen(); phase = "search";
    await f.app.receive({ conversationId: "one", inputId: "search", text: "find npm test runs" }); await f.app.waitForIdle();
    assert.deepEqual(discoveries.map((entry) => entry.status), ["error", "success"]); assert.notEqual(discoveries[0].ref, discoveries[1].ref);
    assert.equal(progressPage.bytes, 64); assert.ok(progressPage.next); assert.match(progressPage.text, /^step 0:/); assert.equal(effects, 2);
  } finally { await f.close(); }
});

test("an archive write failure preserves the executed effect and the tool's critical error without inventing a reference", { timeout: 12000 }, async () => {
  let effects = 0; let view = "";
  const f = await assistantFixture((wire, response) => {
    if (wire.messages.at(-1)?.role !== "tool") return invoke(response, "effect_log", {}, "effect-once");
    view = toolText(wire); sendChatCompletion(response, "effect executed but evidence storage failed");
  }, async (directory) => ({ archive: { thresholdBytes: 1024, previewBytes: 256 }, tools: [{ name: "effect_log", label: "effect", description: "Create an external effect", parameters: Type.Object({}),
    async execute() {
      effects++; const archivePath = archiveDirectory(directory); await mkdir(join(archivePath, ".."), { recursive: true }); await writeFile(archivePath, "not a directory");
      return { content: [{ type: "text" as const, text: "normal output\n".repeat(200) + "ERROR: final-effect-validation-failed" }], details: { isError: true } };
    } }] }));
  try {
    await f.app.receive({ conversationId: "one", inputId: "effect", text: "perform once" }); await f.app.waitForIdle();
    assert.equal(effects, 1); assert.match(view, /Archive failed/); assert.match(view, /status=error/);
    assert.match(view, /final-effect-validation-failed/); assert.doesNotMatch(view, /archive:[a-f0-9]{64}/);
    assert.ok(Buffer.byteLength(view) < 1600);
  } finally { await f.close(); }
});

test("missing archive originals, corrupt indexes, and an empty search remain distinguishable", { timeout: 12000 }, async () => {
  let phase = "produce"; let reference = ""; const observations: any[] = [];
  const f = await assistantFixture((wire, response) => {
    if (wire.messages.at(-1)?.role !== "tool") {
      if (phase === "produce") return invoke(response, "long_log", {}, "original-call");
      if (phase === "missing") return invoke(response, "archive_read", { ref: reference }, "missing-read");
      return invoke(response, "archive_search", { query: "never-happened" }, "search");
    }
    if (phase === "produce") reference = toolText(wire).match(/archive:[a-f0-9]{64}/)?.[0] ?? "";
    else observations.push(JSON.parse(toolText(wire)));
    sendChatCompletion(response, "inspection finished");
  }, async () => ({ archive: { thresholdBytes: 1024 }, tools: [{ name: "long_log", label: "log", description: "Produce evidence", parameters: Type.Object({}),
    async execute() { return { content: [{ type: "text" as const, text: "original evidence\n".repeat(200) }], details: {} }; } }] }));
  try {
    await f.app.receive({ conversationId: "one", inputId: "produce", text: "produce log" }); await f.app.waitForIdle(); assert.ok(reference);
    phase = "empty"; await f.app.receive({ conversationId: "one", inputId: "empty", text: "search absent evidence" }); await f.app.waitForIdle();
    assert.deepEqual(observations[0].items, []); assert.equal(observations[0].error, undefined);
    const directory = archiveDirectory(f.directory); await rm(join(directory, `${reference.slice(8)}.txt`));
    phase = "missing"; await f.app.receive({ conversationId: "one", inputId: "missing", text: "read evidence" }); await f.app.waitForIdle();
    assert.equal(observations[1].error, "archive_original_missing");
    await writeFile(join(directory, `${reference.slice(8)}.index.json`), "corrupt index");
    phase = "corrupt"; await f.app.receive({ conversationId: "one", inputId: "corrupt", text: "search evidence again" }); await f.app.waitForIdle();
    assert.equal(observations[2].error, "archive_index_unavailable");
  } finally { await f.close(); }
});

test("native shell spill originals survive removal of the SDK temporary output file", { timeout: 15000 }, async () => {
  let phase = "produce"; let reference = ""; let produced = ""; let recovered: any;
  const f = await assistantFixture((wire, response) => {
    if (wire.messages.at(-1)?.role !== "tool") {
      if (phase === "produce") return invoke(response, "bash", { command: "node -e \"process.stdout.write('BEGIN-NATIVE\\n' + 'x'.repeat(70000) + '\\nEND-NATIVE\\n'); process.exitCode=3\"" }, "native-spill");
      return invoke(response, "archive_read", { ref: reference, maxBytes: 128, limit: 2 }, "native-read");
    }
    if (phase === "produce") { produced = toolText(wire); reference = produced.match(/archive:[a-f0-9]{64}/)?.[0] ?? ""; }
    else recovered = JSON.parse(toolText(wire));
    sendChatCompletion(response, "native evidence inspected");
  }, async () => ({ archive: { thresholdBytes: 1024, previewBytes: 256 } }));
  try {
    await f.app.receive({ conversationId: "one", inputId: "native", text: "run native output" }); await f.app.waitForIdle();
    assert.ok(reference, produced); assert.match(produced, /exitCode=3/); assert.match(produced, /status=error/);
    const spillPath = produced.match(/Full output: ([^\n]+)/)?.[1]; assert.ok(spillPath); await rm(spillPath);
    await f.reopen(); phase = "read"; await f.app.receive({ conversationId: "one", inputId: "read-native", text: "read native evidence" }); await f.app.waitForIdle();
    assert.match(recovered.text, /^BEGIN-NATIVE\n/); assert.equal(recovered.bytes, 128); assert.equal(recovered.totalBytes, 70025); assert.ok(recovered.next);
  } finally { await f.close(); }
});
