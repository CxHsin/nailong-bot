import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAssistant } from "../src/assistant/runtime.js";
import { assistantFixture } from "./fixtures/assistant.js";
import { sendChatCompletion } from "./fixtures/chat-completion.js";

test("the formal assistant rejects a legacy conversations namespace without rewriting it", async () => {
  const directory = await mkdtemp(join(tmpdir(), "assistant-legacy-reject-"));
  const index = JSON.stringify({ version: 1, conversations: [{ id: "old", cwd: directory }] });
  await writeFile(join(directory, "conversations.json"), index);
  try {
    await assert.rejects(createAssistant({ dataDir: directory, modelConfiguration: { defaultModel: "local", models: [
      { alias: "local", api: "openai-completions", model: "local", apiKey: "test", baseUrl: "http://127.0.0.1:1" },
    ] } }), /旧.*会话|独立新目录/);
    assert.equal(await readFile(join(directory, "conversations.json"), "utf8"), index);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("an old session pointer without a conversation index is still rejected as an execution namespace", async () => {
  const directory = await mkdtemp(join(tmpdir(), "assistant-session-reject-"));
  const session = join(directory, "sessions", "orphaned-legacy-session");
  await mkdir(session, { recursive: true });
  const pointer = JSON.stringify({ version: 1, sessionFile: "retained-history.jsonl" });
  await writeFile(join(session, "session.json"), pointer);
  let app: Awaited<ReturnType<typeof createAssistant>> | undefined;
  try {
    await assert.rejects(async () => {
      app = await createAssistant({ dataDir: directory, modelConfiguration: { defaultModel: "local", models: [
        { alias: "local", api: "openai-completions", model: "local", apiKey: "test", baseUrl: "http://127.0.0.1:1" },
      ] } });
    }, /旧.*会话|独立新目录/);
    assert.equal(await readFile(join(session, "session.json"), "utf8"), pointer);
  } finally { await app?.close(); await rm(directory, { recursive: true, force: true }); }
});

test("legacyDataDir copies helper identity read-only, reconciles the original helper, and excludes old history", { timeout: 15_000 }, async () => {
  const oldSecret = "LEGACY-HISTORY-MUST-NEVER-ENTER-MAIN-CONTEXT-92742";
  const calls: Array<{ session: string; args: string[] }> = [];
  const sourceFiles = new Map<string, string>();
  const requests: string[] = [];
  let status = "working";
  let directory = "";
  const f = await assistantFixture((wire, response) => {
    const all = JSON.stringify(wire.messages);
    requests.push(all);
    assert.doesNotMatch(all, new RegExp(oldSecret));
    sendChatCompletion(response, all.includes("original-helper-result-evidence") ? "imported helper inspected" : "fresh context response");
  }, async (cwd) => {
    directory = cwd;
    const legacyDataDir = join(cwd, "old-native-data");
    const hash = createHash("sha256").update("one").digest("hex");
    const session = join(legacyDataDir, "sessions", hash);
    await mkdir(session, { recursive: true });
    sourceFiles.set(join(legacyDataDir, "conversations.json"), JSON.stringify({ version: 1, conversations: [{ id: "one", cwd }] }));
    sourceFiles.set(join(session, "session.json"), JSON.stringify({ version: 1, sessionFile: join(session, "history.jsonl") }));
    sourceFiles.set(join(session, "history.jsonl"), JSON.stringify({ type: "message", message: { role: "user", content: [{ type: "text", text: oldSecret }] } }) + "\n");
    sourceFiles.set(join(session, "helpers.json"), JSON.stringify({ version: 1, helpers: [{ id: "legacy-watch-id", session: "original-session", agent: "original-coder",
      paneId: "w7:p3", workspaceId: "w7", cwd, promptPath: join(cwd, "original-prompt.txt"), sequence: 7, delivered: false }] }));
    sourceFiles.set(join(cwd, "original-prompt.txt"), "Original helper's assigned goal, already dispatched.");
    for (const [path, content] of sourceFiles) await writeFile(path, content);
    return { legacyDataDir, pollMs: 25, herdr: { async run(session, args) {
      calls.push({ session, args: [...args] });
      assert.equal(session, "original-session");
      assert.equal(args[0], "agent");
      assert.ok(args[1] === "get" || args[1] === "read", "migration may inspect only; it must not start, prompt or redispatch");
      assert.equal(args[2], "original-coder");
      if (args[1] === "read") return "original-helper-result-evidence";
      return JSON.stringify({ result: { agent: { name: "original-coder", pane_id: "w7:p3", workspace_id: "w7", cwd,
        agent_status: status, state_change_seq: status === "working" ? 7 : 8 } } });
    } } };
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await f.app.receive({ conversationId: "one", inputId: "fresh", text: "new main conversation" });
    await f.app.waitForIdle();
    assert.match(requests[0]!, /original-coder/);
    assert.match(requests[0]!, /original-session/);
    assert.match(requests[0]!, /w7:p3/);
    const returned = new Promise<void>((resolve, reject) => {
      timer = setTimeout(() => reject(new Error("original imported helper result was not reconciled")), 5000);
      const stop = f.app.subscribe((output) => {
        if (output.type === "text" && output.text === "imported helper inspected") { clearTimeout(timer); stop(); resolve(); }
      });
    });
    status = "done";
    await returned; await f.app.waitForIdle();
    assert.ok(calls.some((call) => call.args[1] === "get"));
    assert.equal(calls.filter((call) => call.args[1] === "read").length, 1);
    assert.equal(requests.filter((request) => request.includes("original-helper-result-evidence")).length, 1);
    await f.reopen();
    await f.app.receive({ conversationId: "one", inputId: "after-reopen", text: "continue fresh conversation" });
    await f.app.waitForIdle();
    assert.equal(calls.filter((call) => call.args[1] === "read").length, 1, "a second startup does not re-import an already handled helper");
    for (const [path, content] of sourceFiles) assert.equal(await readFile(path, "utf8"), content, `migration must preserve source ${path}`);
    assert.ok(requests.every((request) => !request.includes(oldSecret)));
    assert.ok(directory);
  } finally { clearTimeout(timer); await f.close(); }
});
