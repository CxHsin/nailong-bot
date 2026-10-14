import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, rm, mkdir, cp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, basename } from "node:path";
import { createServer } from "node:http";
import { createAssistant } from "../src/assistant/runtime.js";
import { sendChatCompletion } from "./fixtures/chat-completion.js";
import { assistantFixture } from "./fixtures/assistant.js";

test("reset immediately after a visible helper return retains its durable acknowledgement", async () => {
  let directory = "";
  let status = "working";
  let returns = 0;
  let reconciled!: () => void;
  const checked = new Promise<void>((resolve) => {
    reconciled = resolve;
  });
  const f = await assistantFixture(
    (wire, response) => {
      const last = JSON.stringify(wire.messages.at(-1));
      if (last.includes("watch coder"))
        sendChatCompletion(response, "", [
          {
            index: 0,
            id: "ack-watch",
            type: "function",
            function: {
              name: "herdr_watch",
              arguments: JSON.stringify({
                session: "fixture",
                agent: "coder",
                paneId: "w1:p1",
                workspaceId: "w1",
                cwd: directory,
                promptPath: join(directory, "prompt.txt"),
              }),
            },
          },
        ]);
      else if (last.includes("herdr_result")) {
        returns++;
        sendChatCompletion(response, "visible result");
      } else sendChatCompletion(response, "watching");
    },
    async (cwd) => {
      directory = cwd;
      await writeFile(join(cwd, "prompt.txt"), "fixture");
      return {
        pollMs: 100,
        herdr: {
          async run(_session, args) {
            if (args[1] === "read") return "fixture result";
            if (returns) reconciled();
            return JSON.stringify({
              result: {
                agent: {
                  name: "coder",
                  pane_id: "w1:p1",
                  workspace_id: "w1",
                  cwd,
                  agent_status: status,
                  state_change_seq: status === "working" ? 1 : 2,
                },
              },
            });
          },
        },
      };
    },
  );
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await f.app.receive({
      conversationId: "one",
      inputId: "1",
      text: "watch coder",
    });
    await f.app.waitForIdle();
    status = "done";
    await new Promise<void>((resolve, reject) => {
      timer = setTimeout(() => reject(new Error("no first result")), 3000);
      const unsubscribe = f.app.subscribe((output) => {
        if (output.type === "text" && output.text === "visible result") {
          clearTimeout(timer);
          unsubscribe();
          resolve();
        }
      });
    });
    await f.app.waitForIdle();
    await f.app.receive({
      conversationId: "one",
      inputId: "2",
      text: "/reset",
    });
    // An unfixed reset queries and returns the helper again; fixed acknowledgement skips it.
    await Promise.race([
      checked,
      new Promise((resolve) => setTimeout(resolve, 250)),
    ]);
    await f.app.waitForIdle();
    assert.equal(returns, 1);
  } finally {
    clearTimeout(timer);
    await f.close();
  }
});

test("restart from pre-first-reply disk state does not lose a helper receipt held only in memory", async () => {
  let directory = "";
  let status = "working";
  let held = false;
  let release!: () => void;
  const hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  let observed!: () => void;
  const saved = new Promise<void>((resolve) => {
    observed = resolve;
  });
  let queries = 0;
  const f = await assistantFixture(
    async (wire, response) => {
      const last = JSON.stringify(wire.messages.at(-1));
      if (last.includes("watch coder"))
        sendChatCompletion(response, "", [
          {
            index: 0,
            id: "durable-watch",
            type: "function",
            function: {
              name: "herdr_watch",
              arguments: JSON.stringify({
                session: "fixture",
                agent: "coder",
                paneId: "w1:p1",
                workspaceId: "w1",
                cwd: directory,
                promptPath: join(directory, "prompt.txt"),
              }),
            },
          },
        ]);
      else if (last.includes("herdr_result")) {
        if (!held) {
          held = true;
          await hold;
          if (!response.destroyed)
            sendChatCompletion(response, "old pending turn");
        } else sendChatCompletion(response, "disk state recovered");
      } else sendChatCompletion(response, "watching");
    },
    async (cwd) => {
      directory = cwd;
      await writeFile(join(cwd, "prompt.txt"), "fixture");
      return {
        pollMs: 10,
        herdr: {
          async run(_session, args) {
            if (args[1] === "read") return "fixture artifact";
            if (held && ++queries >= 2) observed();
            return JSON.stringify({
              result: {
                agent: {
                  name: "coder",
                  pane_id: "w1:p1",
                  workspace_id: "w1",
                  cwd,
                  agent_status: status,
                  state_change_seq: status === "working" ? 1 : 2,
                },
              },
            });
          },
        },
      };
    },
  );
  let restarted: Awaited<ReturnType<typeof createAssistant>> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await f.app.receive({
      conversationId: "one",
      inputId: "1",
      text: "watch coder",
    });
    await f.app.waitForIdle();
    await f.app.receive({
      conversationId: "one",
      inputId: "2",
      text: "/reset",
    });
    status = "done";
    await saved;
    // Copy the actual on-disk crash boundary before graceful abort can flush an assistant entry.
    const snapshot = join(f.directory, "crash-snapshot");
    await cp(f.options.dataDir, snapshot, {
      recursive: true,
      filter: (path) => !basename(path).startsWith("owner.sqlite"),
    });
    restarted = await createAssistant({ ...f.options, dataDir: snapshot });
    await f.app.close();
    release();
    const answers: string[] = [];
    await new Promise<void>((resolve, reject) => {
      timer = setTimeout(
        () => reject(new Error("lost in-memory helper receipt")),
        3000,
      );
      restarted!.subscribe((output) => {
        if (output.type === "text") {
          answers.push(output.text);
          if (output.text === "disk state recovered") {
            clearTimeout(timer);
            resolve();
          }
        }
      });
    });
    await restarted.waitForIdle();
    assert.deepEqual(answers, ["disk state recovered"]);
  } finally {
    clearTimeout(timer);
    release();
    await restarted?.close();
    await f.close();
  }
});

test("a helper read crossing reset returns only to the new main Session", async () => {
  let directory = "";
  let status = "working";
  let reading!: () => void;
  const readStarted = new Promise<void>((resolve) => {
    reading = resolve;
  });
  let release!: () => void;
  const hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  let returnRequests = 0;
  const f = await assistantFixture(
    (wire, response) => {
      const last = JSON.stringify(wire.messages.at(-1));
      if (last.includes("start OLD_ONLY"))
        sendChatCompletion(response, "", [
          {
            index: 0,
            id: "reset-watch",
            type: "function",
            function: {
              name: "herdr_watch",
              arguments: JSON.stringify({
                session: "fixture",
                agent: "coder",
                paneId: "w1:p1",
                workspaceId: "w1",
                cwd: directory,
                promptPath: join(directory, "prompt.txt"),
              }),
            },
          },
        ]);
      else if (last.includes("herdr_result")) {
        returnRequests++;
        assert.doesNotMatch(JSON.stringify(wire.messages), /OLD_ONLY/);
        sendChatCompletion(response, "new Session received return");
      } else sendChatCompletion(response, "watching");
    },
    async (cwd) => {
      directory = cwd;
      await writeFile(join(cwd, "prompt.txt"), "fixture");
      return {
        pollMs: 10,
        herdr: {
          async run(_session, args) {
            if (args[1] === "read") {
              reading();
              await hold;
              return "new result";
            }
            return JSON.stringify({
              result: {
                agent: {
                  name: "coder",
                  pane_id: "w1:p1",
                  workspace_id: "w1",
                  cwd,
                  agent_status: status,
                  state_change_seq: status === "working" ? 1 : 2,
                },
              },
            });
          },
        },
      };
    },
  );
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await f.app.receive({
      conversationId: "one",
      inputId: "1",
      text: "start OLD_ONLY",
    });
    await f.app.waitForIdle();
    status = "done";
    await readStarted;
    await f.app.receive({
      conversationId: "one",
      inputId: "2",
      text: "/reset",
    });
    const returned = new Promise<void>((resolve, reject) => {
      timer = setTimeout(
        () => reject(new Error("no return after reset")),
        3000,
      );
      const unsubscribe = f.app.subscribe((output) => {
        if (
          output.type === "text" &&
          output.text === "new Session received return"
        ) {
          clearTimeout(timer);
          unsubscribe();
          resolve();
        }
      });
    });
    release();
    await returned;
    await f.app.waitForIdle();
    assert.equal(returnRequests, 1);
  } finally {
    clearTimeout(timer);
    release();
    await f.close();
  }
});

test("a helper return queued behind an active turn survives restart before Session insertion", async () => {
  let status = "working";
  let queriesAfterRead = 0;
  let read = false;
  let queued!: () => void;
  const observedTwice = new Promise<void>((resolve) => {
    queued = resolve;
  });
  let entered!: () => void;
  const active = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let release!: () => void;
  const hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  let directory = "";
  const f = await assistantFixture(
    async (wire, response) => {
      const last = JSON.stringify(wire.messages.at(-1));
      if (last.includes("watch coder"))
        sendChatCompletion(response, "", [
          {
            index: 0,
            id: "queued-watch",
            type: "function",
            function: {
              name: "herdr_watch",
              arguments: JSON.stringify({
                session: "fixture",
                agent: "coder",
                paneId: "w1:p1",
                workspaceId: "w1",
                cwd: directory,
                promptPath: join(directory, "prompt.txt"),
              }),
            },
          },
        ]);
      else if (last.includes("pause turn")) {
        entered();
        await hold;
        if (!response.destroyed) sendChatCompletion(response, "old turn");
      } else if (last.includes("herdr_result"))
        sendChatCompletion(response, "recovered helper return");
      else sendChatCompletion(response, "watching");
    },
    async (cwd) => {
      directory = cwd;
      await writeFile(join(cwd, "prompt.txt"), "fixture work");
      return {
        pollMs: 10,
        herdr: {
          async run(_session, args) {
            if (args[1] === "read") {
              read = true;
              return "fixture result";
            }
            if (read && ++queriesAfterRead >= 2) queued();
            return JSON.stringify({
              result: {
                agent: {
                  name: "coder",
                  pane_id: "w1:p1",
                  workspace_id: "w1",
                  cwd,
                  agent_status: status,
                  state_change_seq: status === "working" ? 1 : 2,
                },
              },
            });
          },
        },
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
    await f.app.receive({
      conversationId: "one",
      inputId: "2",
      text: "pause turn",
    });
    await active;
    status = "done";
    await Promise.race([
      observedTwice,
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("helper not queued")), 3000),
      ),
    ]);
    await f.app.close();
    release();
    await f.reopen();
    await Promise.race([
      new Promise<void>((resolve) => {
        const unsubscribe = f.app.subscribe((output) => {
          if (
            output.type === "text" &&
            output.text === "recovered helper return"
          ) {
            unsubscribe();
            resolve();
          }
        });
      }),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("lost queued return")), 3000),
      ),
    ]);
    await f.app.waitForIdle();
    assert.equal(
      f.outputs.filter(
        (output) =>
          output.type === "text" && output.text === "recovered helper return",
      ).length,
      1,
    );
  } finally {
    release();
    await f.close();
  }
});

test("assistant writes through native Pi tools, replies without settlement and resumes its Session", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-assistant-"));
  const observed: string[] = [];
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const part of request) body += part;
    const wire = JSON.parse(body);
    const names = wire.tools.map(
      (tool: { function: { name: string } }) => tool.function.name,
    );
    assert.ok(names.includes("write"));
    assert.equal(names.includes("work_permission"), false);
    assert.equal(names.includes("complete_work"), false);
    const last = wire.messages.at(-1);
    if (
      last.role === "user" &&
      JSON.stringify(last.content).includes("remember lotus")
    ) {
      sendChatCompletion(response, "", [
        {
          index: 0,
          id: "write-note",
          type: "function",
          function: {
            name: "write",
            arguments: JSON.stringify({ path: "note.txt", content: "lotus" }),
          },
        },
      ]);
    } else {
      assert.match(JSON.stringify(wire.messages), /remember lotus/);
      sendChatCompletion(response, "lotus saved");
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const options = {
    cwd: directory,
    dataDir: join(directory, "fresh"),
    modelConfiguration: {
      defaultModel: "local",
      models: [
        {
          alias: "local",
          api: "openai-completions" as const,
          baseUrl: `http://127.0.0.1:${address.port}`,
          model: "local",
          apiKey: "test",
        },
      ],
    },
  };
  let app = await createAssistant(options);
  app.subscribe((output) => {
    if (output.type === "text") observed.push(output.text);
  });
  try {
    await assert.rejects(createAssistant(options), /数据目录.*使用/);
    await app.receive({
      conversationId: "one",
      inputId: "1",
      text: "remember lotus",
    });
    await app.waitForIdle();
    assert.equal(await readFile(join(directory, "note.txt"), "utf8"), "lotus");
    assert.deepEqual(observed, ["lotus saved"]);
    await app.close();
    app = await createAssistant(options);
    app.subscribe((output) => {
      if (output.type === "text") observed.push(output.text);
    });
    await app.receive({
      conversationId: "one",
      inputId: "1",
      text: "remember lotus",
    });
    await app.receive({
      conversationId: "one",
      inputId: "2",
      text: "what name?",
    });
    await app.waitForIdle();
    assert.deepEqual(observed, ["lotus saved", "lotus saved"]);
  } finally {
    await app.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});

test("herdr observation runs in background, returns to the right Session and is not replayed after restart", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-herdr-"));
  await writeFile(join(directory, "prompt.txt"), "write result.txt");
  let helperState = "working";
  let queries = 0;
  const herdr = {
    async run(_session: string, args: string[]) {
      queries++;
      if (args[1] === "get")
        return JSON.stringify({
          result: {
            agent: {
              name: "coder",
              pane_id: "w1:p1",
              workspace_id: "w1",
              cwd: directory,
              agent_status: helperState,
              state_change_seq: helperState === "working" ? 2 : 3,
            },
          },
        });
      return "helper wrote result.txt; inspect actual file";
    },
  };
  const answers: string[] = [];
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const part of request) body += part;
    const wire = JSON.parse(body);
    const last = JSON.stringify(wire.messages.at(-1));
    if (last.includes("start coder"))
      sendChatCompletion(response, "", [
        {
          index: 0,
          id: "watch",
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
    else if (last.includes("herdr_result"))
      sendChatCompletion(response, "helper result received");
    else
      sendChatCompletion(
        response,
        last.includes("unrelated chat")
          ? "chat remains responsive"
          : "coder is running",
      );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const options = {
    cwd: directory,
    dataDir: join(directory, "fresh"),
    herdr,
    pollMs: 10,
    modelConfiguration: {
      defaultModel: "local",
      models: [
        {
          alias: "local",
          api: "openai-completions" as const,
          baseUrl: `http://127.0.0.1:${address.port}`,
          model: "local",
          apiKey: "test",
        },
      ],
    },
  };
  let app = await createAssistant(options);
  app.subscribe((output) => {
    if (output.type === "text") answers.push(output.text);
  });
  try {
    await app.receive({
      conversationId: "one",
      inputId: "1",
      text: "start coder",
    });
    await app.waitForIdle();
    await app.receive({
      conversationId: "one",
      inputId: "2",
      text: "unrelated chat",
    });
    await app.waitForIdle();
    assert.deepEqual(answers, ["coder is running", "chat remains responsive"]);
    // Restart while the helper is still running; no user message should be needed to resume observation.
    await app.close();
    app = await createAssistant(options);
    app.subscribe((output) => {
      if (output.type === "text") answers.push(output.text);
    });
    await writeFile(join(directory, "result.txt"), "helper artifact");
    helperState = "done";
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("no helper return")),
        3000,
      );
      const unsubscribe = app.subscribe((output) => {
        if (
          output.type === "text" &&
          output.text === "helper result received"
        ) {
          clearTimeout(timer);
          unsubscribe();
          resolve();
        }
      });
    });
    assert.ok(queries > 1);
    assert.equal(
      await readFile(join(directory, "result.txt"), "utf8"),
      "helper artifact",
    );
    await app.waitForIdle();
    await app.close();
    app = await createAssistant(options);
    app.subscribe((output) => {
      if (output.type === "text") answers.push(output.text);
    });
    await app.receive({
      conversationId: "one",
      inputId: "3",
      text: "continue",
    });
    await app.waitForIdle();
    assert.equal(
      answers.filter((text) => text === "helper result received").length,
      1,
    );
  } finally {
    await app.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});

test("skills and extensions load natively and tool errors return to the model", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-resources-"));
  await mkdir(join(directory, ".pi", "extensions"), { recursive: true });
  await mkdir(join(directory, ".pi", "skills", "fixture"), { recursive: true });
  await writeFile(
    join(directory, ".pi", "skills", "fixture", "SKILL.md"),
    "---\nname: fixture\ndescription: FIXTURE_SKILL_DISCOVERY\n---\nUse for fixture work.",
  );
  await writeFile(
    join(directory, ".pi", "extensions", "fixture.ts"),
    `export default function(pi) { pi.registerTool({name:'fixture_failure',label:'failure',description:'fixture',parameters:{type:'object',properties:{}},async execute(){throw new Error('fixture tool failed')}}); }`,
  );
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const part of request) body += part;
    const wire = JSON.parse(body);
    assert.match(JSON.stringify(wire.messages), /FIXTURE_SKILL_DISCOVERY/);
    if (wire.messages.at(-1).role !== "tool")
      sendChatCompletion(response, "", [
        {
          index: 0,
          id: "failure",
          type: "function",
          function: { name: "fixture_failure", arguments: "{}" },
        },
      ]);
    else {
      assert.match(JSON.stringify(wire.messages.at(-1)), /fixture tool failed/);
      sendChatCompletion(response, "explained failure");
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const app = await createAssistant({
    cwd: directory,
    dataDir: join(directory, "fresh"),
    modelConfiguration: {
      defaultModel: "local",
      models: [
        {
          alias: "local",
          api: "openai-completions",
          baseUrl: `http://127.0.0.1:${address.port}`,
          model: "local",
          apiKey: "test",
        },
      ],
    },
  });
  const answers: string[] = [];
  app.subscribe((output) => {
    if (output.type === "text") answers.push(output.text);
  });
  try {
    await app.receive({
      conversationId: "one",
      inputId: "1",
      text: "try fixture",
    });
    await app.waitForIdle();
    assert.deepEqual(answers, ["explained failure"]);
  } finally {
    await app.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});
