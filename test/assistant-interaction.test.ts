import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { assistantFixture } from "./fixtures/assistant.js";
import { sendChatCompletion } from "./fixtures/chat-completion.js";

test("input during a tool turn steers the native Session before the next model request", async () => {
  let entered!: () => void;
  const ready = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let release!: () => void;
  const hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  const requests: string[] = [];
  const f = await assistantFixture(async (wire, response) => {
    requests.push(JSON.stringify(wire.messages));
    if (requests.length === 1) {
      entered();
      await hold;
      sendChatCompletion(response, "", [
        {
          index: 0,
          id: "read",
          type: "function",
          function: { name: "read", arguments: '{"path":"note.txt"}' },
        },
      ]);
    } else {
      assert.match(JSON.stringify(wire.messages), /change to Thursday/);
      sendChatCompletion(response, "Thursday noted");
    }
  });
  try {
    await writeFile(join(f.directory, "note.txt"), "background");
    await f.app.receive({
      conversationId: "one",
      inputId: "1",
      text: "read note",
    });
    await ready;
    await f.app.receive({
      conversationId: "one",
      inputId: "2",
      text: "change to Thursday",
    });
    release();
    await f.app.waitForIdle();
    assert.equal(requests.length, 2);
    assert.deepEqual(
      f.outputs
        .filter((output) => output.type === "text")
        .map((output) => output.text),
      ["Thursday noted"],
    );
  } finally {
    release();
    await f.close();
  }
});

test("native compaction preserves instructions without loading old Akasha or Task records", async () => {
  let compacted = false;
  const f = await assistantFixture(
    (wire, response) => {
      const encoded = JSON.stringify(wire.messages);
      assert.doesNotMatch(encoded, /LEGACY_SECRET/);
      if (encoded.includes("<conversation>")) {
        compacted = true;
        sendChatCompletion(
          response,
          "Keep the user rule: preserve originals and use Chinese.",
        );
        return;
      }
      if (compacted) {
        assert.match(encoded, /preserve originals/);
        sendChatCompletion(response, "会保留原件");
        return;
      }
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(
        `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: "background ".repeat(3000) }, finish_reason: "stop" }], usage: { prompt_tokens: 5200, completion_tokens: 500 } })}\n\ndata: [DONE]\n\n`,
      );
    },
    async (directory) => {
      await mkdir(join(directory, ".pi"), { recursive: true });
      await writeFile(
        join(directory, ".pi", "settings.json"),
        JSON.stringify({
          compaction: {
            enabled: true,
            reserveTokens: 1000,
            keepRecentTokens: 1000,
          },
        }),
      );
      await mkdir(join(directory, "fresh"), { recursive: true });
      await writeFile(
        join(directory, "fresh", "personal.sqlite"),
        "LEGACY_SECRET",
      );
      await writeFile(
        join(directory, "fresh", "personal-memory.sqlite"),
        "LEGACY_SECRET",
      );
      return {
        modelConfiguration: {
          defaultModel: "local",
          models: [
            {
              alias: "local",
              api: "openai-completions",
              baseUrl: "",
              model: "local",
              apiKey: "test",
              contextWindow: 6000,
              maxTokens: 1000,
            },
          ],
        },
      };
    },
  );
  try {
    await f.app.receive({
      conversationId: "one",
      inputId: "1",
      text: "preserve originals and use Chinese",
    });
    await f.app.waitForIdle();
    await f.app.receive({
      conversationId: "one",
      inputId: "2",
      text: "continue",
    });
    await f.app.waitForIdle();
    assert.equal(compacted, true);
    assert.ok(
      f.outputs.some(
        (output) => output.type === "text" && output.text === "会保留原件",
      ),
    );
  } finally {
    await f.close();
  }
});

test("new Session reset survives restart and local file delivery uses the actual artifact", async () => {
  let phase = 0;
  const f = await assistantFixture((wire, response) => {
    const last = wire.messages.at(-1)!;
    if (phase === 0) {
      phase++;
      sendChatCompletion(response, "remembered");
    } else if (last.role !== "tool") {
      assert.doesNotMatch(JSON.stringify(wire.messages), /OLD_ONLY/);
      sendChatCompletion(response, "", [
        {
          index: 0,
          id: "file",
          type: "function",
          function: { name: "send_file", arguments: '{"path":"artifact.txt"}' },
        },
      ]);
    } else sendChatCompletion(response, "file sent");
  });
  try {
    await writeFile(join(f.directory, "artifact.txt"), "actual content");
    await f.app.receive({
      conversationId: "one",
      inputId: "1",
      text: "OLD_ONLY",
    });
    await f.app.waitForIdle();
    await f.app.receive({
      conversationId: "one",
      inputId: "2",
      text: "/reset",
    });
    await f.reopen();
    await f.app.receive({
      conversationId: "one",
      inputId: "3",
      text: "send artifact",
    });
    await f.app.waitForIdle();
    const output = f.outputs.find((output) => output.type === "file");
    assert.ok(output?.type === "file");
    assert.equal(await readFile(output.path, "utf8"), "actual content");
  } finally {
    await f.close();
  }
});
