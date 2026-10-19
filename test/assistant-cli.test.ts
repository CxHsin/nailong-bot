import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolve } from "node:path";
import { assistantEnvironment } from "../src/assistant/environment.js";
import { assistantFixture } from "./fixtures/assistant.js";
import { sendChatCompletion } from "./fixtures/chat-completion.js";

test("official CLI shares exclusive data ownership and resumes the saved durable conversation", async () => {
  const entry = resolve("src/cli/main.ts");
  let requests = 0;
  const f = await assistantFixture((wire, response) => {
    requests++;
    assert.match(String(wire.messages[0]?.content), /BASE_ENV_FIRST\nReply clearly/);
    if (wire.messages.filter((message) => message.role === "user").length > 1)
      assert.match(JSON.stringify(wire.messages), /CLI_LOTUS/);
    sendChatCompletion(response, "lotus reply");
  });
  const env = {
    ...process.env,
    // Old main-model variables must not act as an implicit direct fallback.
    MODEL_NAMES: "",
    MODEL_DEFAULT: "",
    ASSISTANT_INTENT_MODEL: "",
    NAILONG_MAGPIE_CONFIG: f.magpieConfigPath,
    ASSISTANT_DATA_DIR: f.options.dataDir,
    ASSISTANT_WORK_DIR: f.directory,
    AGENT_SYSTEM_PROMPT: "BASE_ENV_FIRST\nReply clearly.",
    TINYFISH_API_KEY: "",
    AGENT_CAPABILITIES_FILE: "",
  };
  const run = (text: string, json = true) =>
    promisify(execFile)(
      process.execPath,
      [
        "--import",
        "tsx",
        entry,
        "send",
        text,
        "--conversation-id",
        "cli-test",
        ...(json ? ["--ndjson"] : []),
      ],
      { env, timeout: 20_000, windowsHide: true },
    );
  try {
    await assert.rejects(run("CLI_LOTUS"), /数据目录.*使用/);
    await f.app.close();
    const waiting = await run("CLI_LOTUS");
    assert.match(waiting.stdout, /模型|选择/);
    assert.equal(requests, 0, "unselected CLI input persists without a direct-model request");
    const first = await run("/model local");
    assert.match(first.stdout, /lotus reply/);
    const second = await run("what name");
    assert.match(second.stdout, /lotus reply/);
    const cache = await run("/kvcache");
    assert.match(cache.stdout, /胃囊报表/);
    assert.match(cache.stdout, /数据缺失/);
    const cacheOutput = JSON.parse(cache.stdout.trim()) as { textFormat: string; text: string };
    assert.equal(cacheOutput.textFormat, "plain");
    assert.match(cacheOutput.text, /1\. ⚪ 命中率：不可用\n数据缺失\nHit：不可用\nMiss：不可用\n合计输入：不可用\n\n2\./);
    const plainCache = await run("/kvcache", false);
    assert.equal(plainCache.stdout, `${cacheOutput.text}\n`);
  } finally {
    await f.close();
  }
});

test("official configuration rejects missing or blank base instructions before connector setup", async () => {
  for (const value of [undefined, " \n "]) {
    await assert.rejects(assistantEnvironment({ AGENT_SYSTEM_PROMPT: value, AGENT_PROMPT_FILE: "system-prompt.md" }), /AGENT_SYSTEM_PROMPT/);
  }
});

test("official entry still validates the routing request budget before startup", async () => {
  await assert.rejects(assistantEnvironment({ AGENT_SYSTEM_PROMPT: "Valid base rules", ASSISTANT_INTENT_TIMEOUT_MS: "0" }), /正整数/);
});
