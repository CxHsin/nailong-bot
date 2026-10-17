import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join, resolve } from "node:path";
import { writeFile } from "node:fs/promises";
import { assistantFixture } from "./fixtures/assistant.js";
import { sendChatCompletion } from "./fixtures/chat-completion.js";

test("official CLI shares exclusive data ownership and resumes the saved durable conversation", async () => {
  const entry = resolve("src/cli/main.ts");
  const f = await assistantFixture((wire, response) => {
    if (wire.messages.filter((message) => message.role === "user").length > 1)
      assert.match(JSON.stringify(wire.messages), /CLI_LOTUS/);
    sendChatCompletion(response, "lotus reply");
  });
  const env = {
    ...process.env,
    MODEL_NAMES: "local",
    MODEL_DEFAULT: "local",
    MODEL_LOCAL_API: "openai-completions",
    MODEL_LOCAL_BASE_URL: f.options.modelConfiguration.models[0]!.baseUrl,
    MODEL_LOCAL_MODEL: "local",
    MODEL_LOCAL_API_KEY: "test",
    ASSISTANT_DATA_DIR: f.options.dataDir,
    ASSISTANT_WORK_DIR: f.directory,
    AGENT_PROMPT_FILE: join(f.directory, "prompt.txt"),
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
    await writeFile(env.AGENT_PROMPT_FILE, "Reply clearly.");
    await assert.rejects(run("CLI_LOTUS"), /数据目录.*使用/);
    await f.app.close();
    const first = await run("CLI_LOTUS");
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
