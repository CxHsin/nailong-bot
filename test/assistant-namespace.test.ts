import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAssistant } from "../src/assistant/runtime.js";

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
