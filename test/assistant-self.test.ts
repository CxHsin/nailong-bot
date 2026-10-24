import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { assistantFixture, type Wire } from "./fixtures/assistant.js";
import { sendChatCompletion } from "./fixtures/chat-completion.js";
import { INITIAL_SELF, SelfFile } from "../src/assistant/self.js";

test("default SELF keeps the confirmed core without making old traits permanent", async () => {
  const requests: Wire[] = [];
  const f = await assistantFixture((wire, response) => {
    requests.push(wire);
    sendChatCompletion(response, "ack");
  });
  try {
    await f.app.receive({ conversationId: "one", inputId: "first", text: "hello" });
    await f.app.waitForIdle();
    const system = JSON.stringify(requests[0]!.messages[0]);
    assert.match(system, /纯真善意/);
    assert.match(system, /乐观好奇/);
    assert.match(system, /呆萌中带小机灵/);
    assert.match(system, /爱吃和享受生活/);
    assert.match(system, /可成长的个人偏好/);
    assert.match(system, /不是固定持续标签/);
    assert.doesNotMatch(system, /傲娇/);
    assert.match(await readFile(join(f.options.dataDir, "memory", "SELF.md"), "utf8"), /可成长的个人偏好/);

    await f.reopen();
    await f.app.receive({ conversationId: "one", inputId: "after-restart", text: "continue" });
    await f.app.waitForIdle();
    const restarted = JSON.stringify(requests.at(-1)!.messages[0]);
    assert.match(restarted, /可成长的个人偏好/);
    assert.doesNotMatch(restarted, /傲娇/);
  } finally {
    await f.close();
  }
});

test("managed legacy defaults reconcile through the SELF file boundary", async () => {
  const path = join(tmpdir(), `nailong-self-${Date.now()}-${Math.random()}.md`);
  const legacy = {
    id: "self:legacy-core", sourceId: "source:legacy-core", quote: "", content: "我是用户的私人助手奶龙。天真烂漫、有点傲娇、贪吃，最爱奶香小面包；偶尔迷糊，做正事认真靠谱。",
    kind: "SELF" as const, action: "add" as const, selfSection: "identity" as const, active: true, version: 0, at: "2026-10-17T00:00:00.000Z",
  };
  const legacyExpression = { ...legacy, id: "self:legacy-expression", sourceId: "source:legacy-expression", content: "轻松、可爱、偶尔傲娇，自行措辞；不固定重复口头禅，不要求每段动作，不为了扮演编造发现。代码、路径、引用和结构化数据保持原样。", selfSection: "expression" as const };
  const old = `# SELF\n\n## 身份与基础人设\n\n<!-- self-entry ${JSON.stringify(legacy)} -->\n${legacy.content}\n<!-- /self-entry -->\n\n## 表达习惯\n\n<!-- self-entry ${JSON.stringify(legacyExpression)} -->\n${legacyExpression.content}\n<!-- /self-entry -->\n`;
  await writeFile(path, old);
  try {
    const file = new SelfFile(path, INITIAL_SELF, [legacy, legacyExpression]);
    const entries = file.entries((content, key, section) => ({
      id: `self:${key}`, sourceId: `source:${key}`, quote: "", content,
      kind: "SELF", action: "add", selfSection: section, active: true, version: 1, at: "2026-10-24T00:00:00.000Z",
    }));
    file.update(entries);
    const updated = await readFile(path, "utf8");
    assert.match(updated, /纯真善意/);
    assert.match(updated, /可成长的个人偏好/);
    assert.match(updated, /不是固定持续标签/);
    assert.doesNotMatch(updated, /傲娇/);
    assert.match(updated, /self-entry/);
  } finally {
    await rm(path, { force: true });
  }
});

test("SELF is a directly editable authority and base instructions lead the encoded system", async () => {
  const requests: Wire[] = [];
  const f = await assistantFixture((wire, response) => { requests.push(wire); sendChatCompletion(response, "ack"); }, async (directory) => {
    await mkdir(join(directory, "fresh", "memory"), { recursive: true });
    await writeFile(join(directory, "fresh", "memory", "SELF.md"), "# SELF\n\n我是 HAND_EDITED_SELF。\n");
    await mkdir(join(directory, ".pi", "skills", "ordering"), { recursive: true });
    await writeFile(join(directory, ".pi", "skills", "ordering", "SKILL.md"), "---\nname: ordering\ndescription: SKILL_ORDER_MARKER\n---\nread me");
    await writeFile(join(directory, "AGENTS.md"), "PROJECT_ORDER_MARKER");
    return { prompt: "BASE_ORDER_MARKER" };
  });
  try {
    await f.app.receive({ conversationId: "one", inputId: "first", text: "hello" }); await f.app.waitForIdle();
    const system = JSON.stringify(requests[0]!.messages[0]);
    assert.match(system, /HAND_EDITED_SELF/);
    const markers = ["BASE_ORDER_MARKER", "SKILL_ORDER_MARKER", "PROJECT_ORDER_MARKER", "HAND_EDITED_SELF", "长期记忆快照"];
    assert.ok(markers.every((marker, index) => index === 0 || system.indexOf(marker) > system.indexOf(markers[index - 1]!)), system);
    assert.match(await readFile(join(f.directory, "fresh", "memory", "SELF.md"), "utf8"), /HAND_EDITED_SELF/);
    const before = requests[0]!.messages[0];
    await f.reopen();
    await f.app.receive({ conversationId: "one", inputId: "second", text: "continue" }); await f.app.waitForIdle();
    assert.deepEqual(requests.at(-1)!.messages[0], before);
  } finally { await f.close(); }
});

test("SELF updates reach tool continuations without rewriting the snapshot and survive a manual restart edit", async () => {
  const requests: Wire[] = [];
  const f = await assistantFixture((wire, response) => {
    requests.push(wire);
    if (wire.messages.at(-1)?.role === "user" && JSON.stringify(wire.messages.at(-1)).includes("以后少说口头禅"))
      sendChatCompletion(response, "", [{ index: 0, id: "self-update", type: "function", function: { name: "memory_write", arguments: JSON.stringify({
        action: "add", kind: "SELF", selfSection: "expression", content: "减少口头禅 SELF_NEW_STYLE", quote: "以后少说口头禅", expectedVersion: 0,
      }) } }]);
    else sendChatCompletion(response, "ack");
  }, async () => ({ prompt: "BASE_V1" }));
  try {
    await f.app.receive({ conversationId: "one", inputId: "establish", text: "keep WORK_HISTORY" }); await f.app.waitForIdle();
    const before = requests[0]!.messages[0];
    await f.app.receive({ conversationId: "one", inputId: "style", text: "以后少说口头禅" }); await f.app.waitForIdle();
    assert.match(JSON.stringify(requests.at(-1)), /SELF_NEW_STYLE/);
    assert.deepEqual(requests.at(-1)!.messages[0], before);
    const selfPath = join(f.directory, "fresh", "memory", "SELF.md");
    assert.match(await readFile(selfPath, "utf8"), /SELF_NEW_STYLE/);
    await f.reopen();
    await f.app.receive({ conversationId: "one", inputId: "unchanged-restart", text: "continue existing work" }); await f.app.waitForIdle();
    assert.deepEqual(requests.at(-1)!.messages[0], before, "ordinary updates do not become an implicit restart snapshot");
    assert.match(JSON.stringify(requests.at(-1)), /SELF_NEW_STYLE/);
    await f.app.close();
    await writeFile(selfPath, "# SELF\n\n我是 MANUAL_NEW_IDENTITY。\n");
    f.options.prompt = "BASE_V2";
    await f.reopen();
    await f.app.receive({ conversationId: "one", inputId: "continue", text: "continue" }); await f.app.waitForIdle();
    const latest = JSON.stringify(requests.at(-1));
    assert.match(latest, /MANUAL_NEW_IDENTITY/);
    assert.match(latest, /BASE_V2/);
    assert.match(latest, /WORK_HISTORY/);
    assert.doesNotMatch(latest, /BASE_V1|SELF_NEW_STYLE/);
  } finally { await f.close(); }
});

test("shared SELF additions, reset snapshots and forgetting preserve unrelated identity and work", async () => {
  let phase = "warm"; let target = ""; const requests: Wire[] = [];
  const f = await assistantFixture((wire, response) => {
    requests.push(wire);
    if (phase === "add" && wire.messages.at(-1)?.role === "tool") target = String(wire.messages.at(-1)!.content).match(/memory:[a-f0-9-]{36}/)?.[0] ?? target;
    if (wire.messages.at(-1)?.role !== "tool" && phase === "add") return sendChatCompletion(response, "", [{ index: 0, id: "add", type: "function", function: {
      name: "memory_write", arguments: JSON.stringify({ action: "add", kind: "SELF", selfSection: "relationship", content: "SELF_RELATION_221", quote: "我们是长期搭档", expectedVersion: 0 }),
    } }]);
    if (wire.messages.at(-1)?.role !== "tool" && phase === "correct") return sendChatCompletion(response, "", [{ index: 0, id: "correct", type: "function", function: {
      name: "memory_write", arguments: JSON.stringify({ action: "supersede", targetId: target, kind: "SELF", selfSection: "relationship", content: "SELF_CORRECTED_221", quote: "我们是平等搭档", expectedVersion: 1 }),
    } }]);
    if (wire.messages.at(-1)?.role !== "tool" && phase === "forget") return sendChatCompletion(response, "", [{ index: 0, id: "forget", type: "function", function: {
      name: "memory_forget", arguments: JSON.stringify({ query: "SELF_CORRECTED_221", expectedVersion: 2 }),
    } }]);
    sendChatCompletion(response, "ack");
  });
  const receive = async (conversationId: string, inputId: string, text: string) => { await f.app.receive({ conversationId, inputId, text }); await f.app.waitForIdle(); };
  try {
    await receive("reader", "warm", "KEEP_READER_WORK"); const frozen = requests.at(-1)!.messages[0];
    phase = "add"; await receive("writer", "add", "记住我们是长期搭档");
    phase = "read"; await receive("reader", "first", "continue");
    assert.deepEqual(requests.at(-1)!.messages[0], frozen);
    assert.match(JSON.stringify(requests.at(-1)), /SELF_RELATION_221/);
    await receive("reader", "reset", "/reset"); await receive("reader", "new-generation", "KEEP_NEW_WORK");
    assert.match(JSON.stringify(requests.at(-1)!.messages[0]), /SELF_RELATION_221/);
    phase = "correct"; await receive("writer", "correct", "纠正：我们是平等搭档");
    phase = "read"; await receive("reader", "after-correction", "continue");
    assert.doesNotMatch(JSON.stringify(requests.at(-1)), /SELF_RELATION_221|我们是长期搭档/);
    assert.match(JSON.stringify(requests.at(-1)), /SELF_CORRECTED_221/);
    phase = "forget"; await receive("writer", "forget", "忘记我们的关系理解");
    phase = "read"; await receive("reader", "after-forget", "continue");
    const latest = JSON.stringify(requests.at(-1));
    assert.doesNotMatch(latest, /SELF_RELATION_221|SELF_CORRECTED_221|我们是长期搭档/);
    assert.match(latest, /奶龙/); assert.match(latest, /KEEP_NEW_WORK/);
    const file = await readFile(join(f.options.dataDir, "memory", "SELF.md"), "utf8");
    assert.doesNotMatch(file, /SELF_RELATION_221|SELF_CORRECTED_221/); assert.match(file, /奶龙/);
    await f.reopen(); await receive("reader", "reopen", "continue");
    assert.doesNotMatch(JSON.stringify(requests.at(-1)), /SELF_RELATION_221/);
    const db = new DatabaseSync(join(f.options.dataDir, "assistant-memory.sqlite"));
    try { assert.match(JSON.stringify(db.prepare("SELECT payload FROM memory_sources").all()), /我们是长期搭档/); } finally { db.close(); }
  } finally { await f.close(); }
});

test("SELF file write failure and an external edit do not confirm or overwrite an update", async () => {
  const requests: Wire[] = [];
  const f = await assistantFixture((wire, response) => {
    requests.push(wire);
    if (wire.messages.at(-1)?.role !== "tool") return sendChatCompletion(response, "", [{ index: 0, id: `attempt-${requests.length}`, type: "function", function: {
      name: "memory_write", arguments: JSON.stringify({ action: "add", kind: "SELF", selfSection: "expression", content: "FAILED_SELF_311", quote: "少用口头禅", expectedVersion: 0 }),
    } }]);
    sendChatCompletion(response, "checked result");
  });
  try {
    const path = join(f.options.dataDir, "memory", "SELF.md"); const before = await readFile(path, "utf8");
    await mkdir(`${path}.tmp`);
    await f.app.receive({ conversationId: "one", inputId: "fail", text: "少用口头禅" }); await f.app.waitForIdle();
    assert.equal(await readFile(path, "utf8"), before);
    assert.match(String(requests.at(-1)!.messages.at(-1)!.content), /EISDIR|EPERM|EACCES/);
    await rm(`${path}.tmp`, { recursive: true });
    await writeFile(path, "# SELF\n\nEXTERNAL_MANUAL_SELF\n");
    await f.app.receive({ conversationId: "one", inputId: "conflict", text: "少用口头禅" }); await f.app.waitForIdle();
    assert.match(String(requests.at(-1)!.messages.at(-1)!.content), /changed externally/);
    assert.equal(await readFile(path, "utf8"), "# SELF\n\nEXTERNAL_MANUAL_SELF\n");
    const db = new DatabaseSync(join(f.options.dataDir, "assistant-memory.sqlite"));
    try { assert.equal(db.prepare("SELECT COUNT(*) AS n FROM memory_changes").get()!.n, 0); } finally { db.close(); }
  } finally { await f.close(); }
});

for (const scenario of ["generated", "multiline", "edited_legacy", "edited_managed", "manual", "missing"] as const) test(`SELF migrates current ${scenario} data once and excludes retired entries`, async () => {
  const requests: Wire[] = [];
  const f = await assistantFixture((wire, response) => { requests.push(wire); sendChatCompletion(response, "ack"); }, async directory => {
    const data = join(directory, "fresh"); await mkdir(join(data, "memory"), { recursive: true });
    const db = new DatabaseSync(join(data, "assistant-memory.sqlite"));
    try {
      db.exec("CREATE TABLE memory_sources(id TEXT PRIMARY KEY,payload TEXT NOT NULL); CREATE TABLE memory_entries(id TEXT PRIMARY KEY,payload TEXT NOT NULL)");
      for (const [id, active] of [["legacy", true], ["retired", false]] as const) {
        const source = { id: `source:${id}`, conversationId: "old", inputId: id, text: id, role: "user", at: "2026-10-16", source: "cli" };
        const entry = { id, active, sourceId: source.id, action: "add", kind: "SELF", content: `SELF_${id}${scenario === "multiline" && active ? "\n\nSECOND_PARAGRAPH" : ""}`,
          ...(["multiline", "edited_legacy", "edited_managed"].includes(scenario) ? { project: directory } : {}), quote: id, version: 0, at: source.at };
        db.prepare("INSERT INTO memory_sources VALUES(?,?)").run(source.id, JSON.stringify(source));
        db.prepare("INSERT INTO memory_entries VALUES(?,?)").run(id, JSON.stringify(entry));
      }
    } finally { db.close(); }
    if (scenario !== "missing") await writeFile(join(data, "memory", "SELF.md"), scenario === "manual" ? "# SELF\n\nMANUAL_MIGRATION\n" :
      `# SELF\n\nSource version: 0\n\n[SELF id=legacy version=0 source=source:legacy role=user at=2026-10-16] SELF_legacy${scenario === "multiline" ? "\n\nSECOND_PARAGRAPH" : scenario === "edited_legacy" ? "_MANUAL_CHANGE" : ""}\nquote: legacy\n\n[SELF id=retired version=0 source=source:retired role=user at=2026-10-16] SELF_retired\nquote: retired\n`);
    return {};
  });
  try {
    await f.app.receive({ conversationId: "one", inputId: "first", text: "hello" }); await f.app.waitForIdle();
    const body = JSON.stringify(requests.at(-1));
    assert.match(body, scenario === "manual" ? /MANUAL_MIGRATION/ : /SELF_legacy/);
    assert.doesNotMatch(body, /SELF_retired/);
    if (scenario === "manual") assert.doesNotMatch(body, /SELF_legacy/);
    const selfPath = join(f.options.dataDir, "memory", "SELF.md");
    if (scenario === "edited_managed") {
      await f.app.close();
      const file = await readFile(selfPath, "utf8");
      await writeFile(selfPath, file.replace(/\nSELF_legacy\n/, "\nSELF_legacy_MANUAL_CHANGE\n"));
      await f.reopen();
      await f.app.receive({ conversationId: "one", inputId: "edited", text: "continue" }); await f.app.waitForIdle();
      assert.match(JSON.stringify(requests.at(-1)), /SELF_legacy_MANUAL_CHANGE/);
    }
    const before = await readFile(join(f.options.dataDir, "memory", "SELF.md"), "utf8");
    if (scenario === "multiline") {
      assert.match(before, /"id":"legacy"/);
      assert.match(before, /"sourceId":"source:legacy"/);
      assert.match(before, /"project":/);
      assert.match(body, /SECOND_PARAGRAPH/);
    }
    await f.reopen();
    assert.equal(await readFile(join(f.options.dataDir, "memory", "SELF.md"), "utf8"), before);
    if (["multiline", "edited_legacy", "edited_managed"].includes(scenario)) {
      const otherProject = join(f.directory, "other-project"); await mkdir(otherProject);
      f.options.cwd = otherProject; await f.reopen();
      await f.app.receive({ conversationId: "other", inputId: "scope", text: "hello" }); await f.app.waitForIdle();
      assert.doesNotMatch(JSON.stringify(requests.at(-1)), /SELF_legacy|SECOND_PARAGRAPH/);
    }
  } finally { await f.close(); }
});

for (const interrupt of [false, true]) test(`compaction SELF learning ${interrupt ? "recovers interrupted metadata" : "survives native compression"} on service reopen`, async () => {
  const requests: Wire[] = []; const errors: unknown[] = []; let refinements = 0;
  const f = await assistantFixture((wire, response) => {
    const text = JSON.stringify(wire.messages); requests.push(wire);
    if (text.includes("nailong-memory-refinement")) {
      refinements++;
      const data = JSON.parse(String(wire.messages.at(-1)!.content)) as { originalSources: Array<{ id: string; text: string }> };
      const source = data.originalSources.find(item => item.text.includes("我们是可靠搭档"));
      return sendChatCompletion(response, JSON.stringify(source ? [{ action: "add", kind: "SELF", selfSection: "relationship", sourceId: source.id,
        content: "RECOVERED_FILE_RELATION", quote: "我们是可靠搭档" }] : []));
    }
    if (text.includes("context summarization assistant")) return sendChatCompletion(response, "## Goal\nContinue reliable partnership work.\n## Progress\nUser records are preserved.\n## Next Steps\nContinue the task.");
    sendChatCompletion(response, "ack");
  }, async () => ({
    modelConfiguration: { defaultModel: "local", models: [{ alias: "local", api: "openai-completions", model: "local", apiKey: "test", baseUrl: "", contextWindow: 7000, maxTokens: 1024 }] },
    compaction: { reserveTokens: 1500, keepRecentTokens: 600, backgroundTokens: 0 }, reportFailure(error) { errors.push(error); },
  }));
  try {
    const db = new DatabaseSync(join(f.options.dataDir, "assistant-memory.sqlite"));
    try { if (interrupt) db.exec("CREATE TRIGGER interrupt_refinement BEFORE INSERT ON memory_ranges BEGIN SELECT RAISE(ABORT, 'metadata interrupted'); END"); } finally { db.close(); }
    await f.app.receive({ conversationId: "one", inputId: "seed", text: "我们是可靠搭档" }); await f.app.waitForIdle();
    for (let index = 0; index < 5 && !errors.length; index++) {
      await f.app.receive({ conversationId: "one", inputId: `fill-${index}`, text: "partnership material ".repeat(300) }); await f.app.waitForIdle();
    }
    assert.ok(refinements > 0); if (interrupt) assert.match(errors.map(String).join("\n"), /metadata interrupted/);
    else assert.deepEqual(errors, []);
    const path = join(f.options.dataDir, "memory", "SELF.md");
    assert.match(await readFile(path, "utf8"), /RECOVERED_FILE_RELATION/);
    await f.reopen();
    await f.app.receive({ conversationId: "two", inputId: "recovered", text: "continue" }); await f.app.waitForIdle();
    assert.match(JSON.stringify(requests.at(-1)), /RECOVERED_FILE_RELATION/);
    const before = await readFile(path, "utf8");
    await f.reopen(); assert.equal(await readFile(path, "utf8"), before);
  } finally { await f.close(); }
});

test("SELF and MEMORY share the resident byte budget with pageable references to complete files", async () => {
  const requests: Wire[] = [];
  const content = "LONG_SELF_AUTHORITY_".repeat(500);
  const f = await assistantFixture((wire, response) => { requests.push(wire); sendChatCompletion(response, "ack"); }, async directory => {
    await mkdir(join(directory, "fresh", "memory"), { recursive: true });
    await writeFile(join(directory, "fresh", "memory", "SELF.md"), `# SELF\n\n${content}\n`);
    return { memory: { residentBytes: 1000 } };
  });
  try {
    await f.app.receive({ conversationId: "one", inputId: "read", text: "hello" }); await f.app.waitForIdle();
    const system = String(requests[0]!.messages[0]!.content);
    const self = system.match(/<self>\n([\s\S]*?)\n<\/self>/)?.[1] ?? "";
    const memory = system.match(/<memory>\n([\s\S]*?)\n<\/memory>/)?.[1] ?? "";
    assert.match(self, /memory_read id=self:/);
    assert.ok(Buffer.byteLength(self + memory) <= 1000);
    assert.ok((await readFile(join(f.options.dataDir, "memory", "SELF.md"), "utf8")).includes(content));
  } finally { await f.close(); }
});

for (const api of ["openai-responses", "anthropic-messages"] as const) test(`${api} encodes the effective system order and reloads an existing conversation`, async () => {
  const systems: string[] = [];
  const f = await assistantFixture((wire, response) => {
    const body = wire as Wire & { system?: unknown; instructions?: string; input?: unknown };
    systems.push(api === "anthropic-messages" ? JSON.stringify(body.system) : JSON.stringify(body.instructions ?? body.input));
    const events = api === "anthropic-messages" ? [
      { type: "message_start", message: { id: "a1", type: "message", role: "assistant", model: "local", content: [], stop_reason: null, usage: { input_tokens: 10, output_tokens: 0 } } },
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ack" } },
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 1 } },
      { type: "message_stop" },
    ] : [
      { type: "response.output_item.added", output_index: 0, item: { type: "message", id: "m1", role: "assistant", content: [] } },
      { type: "response.output_text.delta", output_index: 0, content_index: 0, delta: "ack" },
      { type: "response.output_item.done", output_index: 0, item: { type: "message", id: "m1", role: "assistant", content: [{ type: "output_text", text: "ack", annotations: [] }] } },
      { type: "response.completed", response: { id: "r1", status: "completed", output: [{ type: "message", id: "m1", role: "assistant", status: "completed",
      content: [{ type: "output_text", text: "ack", annotations: [] }] }], usage: { input_tokens: 10, output_tokens: 1, total_tokens: 11, input_tokens_details: { cached_tokens: 0 } } } }];
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""));
  }, async directory => {
    await writeFile(join(directory, "AGENTS.md"), "PROJECT_PROTOCOL_MARKER");
    await mkdir(join(directory, ".pi", "skills", "ordering"), { recursive: true });
    await writeFile(join(directory, ".pi", "skills", "ordering", "SKILL.md"), "---\nname: ordering\ndescription: SKILL_PROTOCOL_MARKER\n---\nread me");
    return { prompt: "BASE_PROTOCOL_V1", modelConfiguration: { defaultModel: "local", models: [{ api, alias: "local", model: "local", baseUrl: "", apiKey: "test" }] } };
  });
  try {
    await f.app.receive({ conversationId: "one", inputId: "first", text: "KEEP_PROTOCOL_HISTORY" }); await f.app.waitForIdle();
    const order = ["BASE_PROTOCOL_V1", "SKILL_PROTOCOL_MARKER", "PROJECT_PROTOCOL_MARKER", "奶龙", "长期记忆快照"];
    assert.ok(order.every((item, i) => systems[0]!.includes(item) && (!i || systems[0]!.indexOf(item) > systems[0]!.indexOf(order[i - 1]!))), systems[0]);
    f.options.prompt = "BASE_PROTOCOL_V2"; await f.reopen();
    await f.app.receive({ conversationId: "one", inputId: "second", text: "continue" }); await f.app.waitForIdle();
    assert.match(systems.at(-1)!, /BASE_PROTOCOL_V2/); assert.doesNotMatch(systems.at(-1)!, /BASE_PROTOCOL_V1/);
    assert.ok(f.outputs.some(output => output.type === "text" && output.text === "ack"));
  } finally { await f.close(); }
});
