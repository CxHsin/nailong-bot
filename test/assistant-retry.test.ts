import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { assistantFixture } from "./fixtures/assistant.js";
import { sendChatCompletion } from "./fixtures/chat-completion.js";

for (const scenario of ["recover", "exhaust", "reject", "disabled"] as const) {
  test(`native Pi retry messages: ${scenario}`, { timeout: 10000 }, async () => {
    let requests = 0;
    const f = await assistantFixture(
      (_wire, response) => {
        requests++;
        if (scenario === "recover" && requests > 1) {
          sendChatCompletion(response, "任务完成");
          return;
        }
        response.writeHead(scenario === "reject" ? 401 : 429, {
          "content-type": "application/json",
        });
        response.end(JSON.stringify({
          error: { message: scenario === "reject" ? "invalid api key" : "rate limit" },
        }));
      },
      async (directory) => {
        await mkdir(join(directory, ".pi"), { recursive: true });
        await writeFile(join(directory, ".pi", "settings.json"), JSON.stringify({
          retry: {
            enabled: scenario !== "disabled",
            maxRetries: 1,
            baseDelayMs: 1,
            provider: { maxRetries: 0 },
          },
        }));
        return {};
      },
    );
    try {
      await f.app.receive({ conversationId: "retry", inputId: "1", text: "执行任务" });
      await f.app.waitForIdle();
      const replies = f.outputs.flatMap((output) => output.type === "text" ? [output.text] : []);
      assert.equal(requests, scenario === "recover" || scenario === "exhaust" ? 2 : 1);
      if (scenario === "recover") {
        assert.deepEqual(replies, ["模型限流，正在重试（1/1）。", "任务完成"]);
        // A later normal turn must not reuse the previous retry's error.
        await f.app.receive({ conversationId: "retry", inputId: "2", text: "下一个任务" });
        await f.app.waitForIdle();
        const lastReply = f.outputs.at(-1);
        assert.equal(lastReply?.type === "text" && lastReply.text, "任务完成");
      } else if (scenario === "exhaust") {
        assert.equal(replies.length, 2);
        assert.equal(replies[0], "模型限流，正在重试（1/1）。");
        assert.match(replies[1] ?? "", /^模型调用失败：.*rate limit/);
      } else {
        assert.equal(replies.length, 1);
        assert.match(replies[0] ?? "", /^模型调用失败：/);
        assert.match(replies[0] ?? "", scenario === "reject" ? /invalid api key/ : /rate limit/);
      }
    } finally {
      await f.close();
    }
  });
}
