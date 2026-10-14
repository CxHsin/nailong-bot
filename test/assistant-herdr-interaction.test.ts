import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { assistantFixture } from "./fixtures/assistant.js";
import { sendChatCompletion } from "./fixtures/chat-completion.js";

test("native skill flow transfers explicit supplements only and reports unverified stop honestly", async () => {
  const skill = resolve(".agents/skills/herdr-workflow/SKILL.md");
  const f = await assistantFixture(
    (wire, response) => {
      const last = wire.messages.at(-1)!;
      const input = JSON.stringify(
        wire.messages.filter((message) => message.role === "user").at(-1),
      );
      if (last.role === "tool") {
        const text = JSON.stringify(last.content);
        if (text.includes("STOP_UNKNOWN"))
          sendChatCompletion(
            response,
            "无法确认已停止；保留现场，不重复启动。",
          );
        else if (text.includes("FORWARDED"))
          sendChatCompletion(response, "补充要求已转交 coder。");
        else
          sendChatCompletion(response, "", [
            {
              index: 0,
              id: "transfer",
              type: "function",
              function: {
                name: "bash",
                arguments: JSON.stringify({
                  command: input.includes("stop coder")
                    ? "node helper-cli.mjs stop coder"
                    : "node helper-cli.mjs supplement coder Thursday",
                }),
              },
            },
          ]);
      } else if (input.includes("unrelated"))
        sendChatCompletion(response, "继续日常交流。");
      else {
        assert.match(JSON.stringify(wire.messages), /herdr-workflow/);
        sendChatCompletion(response, "", [
          {
            index: 0,
            id: "skill",
            type: "function",
            function: {
              name: "read",
              arguments: JSON.stringify({ path: skill }),
            },
          },
        ]);
      }
    },
    async () => ({ skillPaths: [skill] }),
  );
  try {
    await writeFile(
      join(f.directory, "helper-cli.mjs"),
      "import {appendFileSync} from 'node:fs'; const args=process.argv.slice(2); appendFileSync('commands.jsonl',JSON.stringify(args)+'\\n'); console.log(args[0]==='stop'?'STOP_UNKNOWN':'FORWARDED');",
    );
    await f.app.receive({
      conversationId: "one",
      inputId: "1",
      text: "send coder supplement Thursday",
    });
    await f.app.waitForIdle();
    await f.app.receive({
      conversationId: "one",
      inputId: "2",
      text: "unrelated daily chat",
    });
    await f.app.waitForIdle();
    await f.app.receive({
      conversationId: "one",
      inputId: "3",
      text: "stop coder",
    });
    await f.app.waitForIdle();
    assert.deepEqual(
      (await readFile(join(f.directory, "commands.jsonl"), "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line)),
      [
        ["supplement", "coder", "Thursday"],
        ["stop", "coder"],
      ],
    );
    assert.deepEqual(
      f.outputs
        .filter((output) => output.type === "text")
        .map((output) => output.text),
      [
        "补充要求已转交 coder。",
        "继续日常交流。",
        "无法确认已停止；保留现场，不重复启动。",
      ],
    );
  } finally {
    await f.close();
  }
});

test("watch refuses a different helper identity and returns the error to the main model", async () => {
  let directory = "";
  const f = await assistantFixture(
    (wire, response) => {
      if (wire.messages.at(-1)?.role === "tool") {
        assert.match(JSON.stringify(wire.messages.at(-1)), /身份或目录不匹配/);
        sendChatCompletion(response, "身份不匹配，先核对原帮手。");
      } else
        sendChatCompletion(response, "", [
          {
            index: 0,
            id: "wrong",
            type: "function",
            function: {
              name: "herdr_watch",
              arguments: JSON.stringify({
                session: "test",
                agent: "coder",
                paneId: "w1:p1",
                workspaceId: "w1",
                cwd: directory,
                promptPath: join(directory, "prompt.txt"),
              }),
            },
          },
        ]);
    },
    async (cwd) => {
      directory = cwd;
      await writeFile(join(cwd, "prompt.txt"), "original work");
      return {
        herdr: {
          async run() {
            return JSON.stringify({
              result: {
                agent: {
                  name: "someone-else",
                  pane_id: "w1:p1",
                  workspace_id: "w1",
                  cwd,
                  agent_status: "done",
                },
              },
            });
          },
        },
        pollMs: 10,
      };
    },
  );
  try {
    await f.app.receive({
      conversationId: "one",
      inputId: "1",
      text: "watch coder",
    });
    await f.app.waitForIdle();
    assert.ok(
      f.outputs.some(
        (output) =>
          output.type === "text" && output.text.includes("身份不匹配"),
      ),
    );
  } finally {
    await f.close();
  }
});
