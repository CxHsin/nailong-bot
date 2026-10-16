import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ServerResponse } from "node:http";
import { Type } from "typebox";
import { assistantFixture, type Wire } from "./fixtures/assistant.js";
import { sendChatCompletion } from "./fixtures/chat-completion.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}
async function bounded(promise: Promise<void>, description: string) {
  let timer: NodeJS.Timeout | undefined;
  try { await Promise.race([promise, new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error(description)), 1500); })]); }
  finally { clearTimeout(timer); }
}
function classified(response: ServerResponse, actions: unknown[]) {
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify({ id: "intent", object: "chat.completion", choices: [{ index: 0, message: { role: "assistant", content: JSON.stringify({ actions }) }, finish_reason: "stop" }] }));
}

async function helperFixture(options: { prompt?: (agent: string, text: string) => Promise<void>; pollMs?: number } = {}) {
  let directory = "";
  let status = "working";
  let mismatch = false;
  const mainEntered = deferred();
  const mainRelease = deferred();
  const sent = deferred();
  const commands: string[][] = [];
  const mainInputs: Wire[] = [];
  const contexts: Array<{ current: { text: string }; replyTargets: string[]; works: Array<{ id: string; helperId?: string; summary: string }> }> = [];
  const f = await assistantFixture(async (wire, response) => {
    if ((wire as Wire & { model?: string }).model === "router") {
      const context = JSON.parse(String(wire.messages.at(-1)!.content));
      contexts.push(context);
      const text: string = context.current.text;
      const agent = text.includes("other") ? "other" : "coder";
      const kind = text.includes("补充") ? "supplement" : text.includes("停止") ? "cancel" : "request";
      const target = context.works.find((work: { helperId?: string; summary: string }) => work.helperId && work.summary === `任务 ${agent}`)?.id;
      classified(response, [{ kind, text, ...(kind !== "request" ? { target } : {}) }]);
      return;
    }
    mainInputs.push(wire);
    const last = wire.messages.at(-1)!;
    const text = JSON.stringify(last.content);
    if (last.role === "user" && text.includes("登记")) {
      const agent = text.includes("other") ? "other" : "coder";
      sendChatCompletion(response, "", [{ index: 0, id: `watch-${agent}`, type: "function", function: { name: "herdr_watch", arguments: JSON.stringify({ session: "fixture", agent, paneId: `${agent}:p1`, workspaceId: "w1", cwd: directory, promptPath: join(directory, "prompt.txt"), summary: `任务 ${agent}` }) } }]);
    } else if (last.role === "user" && text.includes("主会话慢工具")) {
      sendChatCompletion(response, "", [{ index: 0, id: "main-hold", type: "function", function: { name: "main_hold", arguments: "{}" } }]);
    } else sendChatCompletion(response, "主会话已处理");
  }, async (cwd) => {
    directory = cwd;
    await writeFile(join(cwd, "prompt.txt"), "registered original helper request");
    return {
      pollMs: options.pollMs ?? 60_000,
      intent: { model: "router" },
      modelConfiguration: { defaultModel: "local", models: [
        { alias: "local", model: "local", api: "openai-completions", apiKey: "test", baseUrl: "" },
        { alias: "router", model: "router", api: "openai-completions", apiKey: "test", baseUrl: "" },
      ] },
      tools: [{ name: "main_hold", label: "Hold main tool", description: "Controlled independent main work", parameters: Type.Object({}), async execute() { mainEntered.resolve(); await mainRelease.promise; return { content: [{ type: "text" as const, text: "main tool finished" }], details: {} }; } }],
      herdr: { async run(session, args) {
        assert.equal(session, "fixture");
        commands.push([...args]);
        const agent = args[2]!;
        if (args[0] === "agent" && args[1] === "get") return JSON.stringify({ result: { agent: { name: agent, pane_id: mismatch ? "changed:p1" : `${agent}:p1`, workspace_id: "w1", cwd, agent_status: status, state_change_seq: 1 } } });
        if (args[1] === "prompt") { sent.resolve(); await options.prompt?.(agent, args[3]!); return JSON.stringify({ result: { submitted: true } }); }
        if (args[1] === "send-keys") return "{}";
        if (args[1] === "read") return "ARTIFACT_LEDGER_RESULT: completed helper output, inspect ledger.txt";
        throw new Error("process ownership unavailable");
      } },
    };
  });
  return { ...f, get app() { return f.app; }, commands, mainInputs, contexts, mainEntered, mainRelease, sent,
    setStatus(value: string) { status = value; }, mismatch() { mismatch = true; },
    async register(agent = "coder") { await f.app.receive({ conversationId: "one", inputId: `register-${agent}`, text: `登记 ${agent}` }); await f.app.waitForIdle(); },
  };
}

test("natural helper supplement is actually submitted while the main durable tool remains busy", { timeout: 15000 }, async () => {
  const f = await helperFixture();
  const status = deferred();
  const unsubscribe = f.app.subscribe((output) => { if (output.type === "text" && /已转交.*采纳仍待核实/.test(output.text)) status.resolve(); });
  try {
    await f.register();
    await f.app.receive({ conversationId: "one", inputId: "slow-main", text: "主会话慢工具" });
    await f.mainEntered.promise;
    await f.app.receive({ conversationId: "one", inputId: "csv", text: "补充 coder：改为 CSV，保留原数据" });
    await bounded(f.sent.promise, "helper submission waited for the unrelated main tool");
    await f.app.waitForRouting();
    await bounded(status.promise, "helper submission status waited for the unrelated main tool");
    const prompt = f.commands.find((args) => args[1] === "prompt");
    assert.equal(prompt?.[2], "coder");
    assert.match(prompt?.[3] ?? "", /补充 coder：改为 CSV，保留原数据/);
    assert.match(prompt?.[3] ?? "", /稳定身份/);
    assert.ok(f.contexts.at(-1)!.works.some((work) => work.helperId && work.summary === "任务 coder"));
    assert.ok(f.outputs.some((output) => output.type === "text" && /已转交.*采纳仍待核实/.test(output.text)));
    const notice = f.outputs.find(output => output.type === "text" && /已转交.*采纳仍待核实/.test(output.text))!;
    f.app.recordReply("one", "helper-notice", notice.outputId!);
    await f.app.receive({conversationId:"one",inputId:"reply-to-notice",text:"查看刚才的工作状态",replyToMessageId:"helper-notice"});
    await f.app.waitForRouting();
    const context = f.contexts.at(-1)!;
    assert.deepEqual(context.replyTargets, context.works.filter(work => work.helperId && work.summary === "任务 coder").map(work => work.id));
  } finally { unsubscribe(); f.mainRelease.resolve(); await f.app.waitForIdle(); await f.close(); }
});

test("a delivered helper remains a routable result target and supplements continue from its result", { timeout: 15000 }, async () => {
  const f = await helperFixture({ pollMs: 10 });
  const delivered = deferred();
  const unsubscribe = f.app.subscribe((output) => {
    if (output.type === "text" && f.mainInputs.some((wire) => JSON.stringify(wire.messages.at(-1)).includes("ARTIFACT_LEDGER_RESULT"))) delivered.resolve();
  });
  try {
    await f.register();
    f.setStatus("done");
    await bounded(delivered.promise, "helper result was not delivered to the main assistant");
    await f.app.waitForIdle();
    await f.reopen();
    await f.app.receive({ conversationId: "one", inputId: "follow-delivered", text: "补充 coder：基于成果改成 CSV" });
    await f.app.waitForIdle();
    assert.ok(f.contexts.at(-1)!.works.some((work) => work.helperId && work.summary === "任务 coder"));
    assert.equal(f.commands.filter((args) => args[1] === "prompt").length, 0);
    assert.match(JSON.stringify(f.mainInputs.at(-1)!.messages), /原执行已结束.*基于已有成果/);
    assert.match(JSON.stringify(f.mainInputs.at(-1)!.messages), /补充 coder：基于成果改成 CSV/);
  } finally { unsubscribe(); f.mainRelease.resolve(); await f.close(); }
});

test("unconfirmed helper delivery stays unknown across duplicate input and reopening without resending", { timeout: 15000 }, async () => {
  const f = await helperFixture({ async prompt() { throw new Error("transport ended after possible send"); } });
  try {
    await f.register();
    const input = { conversationId: "one", inputId: "unknown-supplement", text: "补充 coder：改为 CSV" };
    await f.app.receive(input); await f.app.waitForIdle();
    assert.equal(f.commands.filter((args) => args[1] === "prompt").length, 1);
    assert.ok(f.outputs.some((output) => output.type === "text" && /投递结果待核实/.test(output.text)));
    await f.app.receive(input); await f.app.waitForIdle();
    await f.reopen();
    await f.app.receive(input); await f.app.waitForIdle();
    assert.equal(f.commands.filter((args) => args[1] === "prompt").length, 1);
  } finally { f.mainRelease.resolve(); await f.close(); }
});

for (const failure of ["blocked", "mismatch"] as const) {
  test(`${failure} helper preserves the original user supplement for main model fallback`, { timeout: 15000 }, async () => {
    const f = await helperFixture();
    try {
      await f.register();
      if (failure === "blocked") f.setStatus("blocked"); else f.mismatch();
      const text = "补充 coder：保留原始数据，改为 CSV";
      await f.app.receive({ conversationId: "one", inputId: `${failure}-supplement`, text });
      await f.app.waitForIdle();
      assert.equal(f.commands.filter((args) => args[1] === "prompt").length, 0);
      const lastUser = f.mainInputs.at(-1)!.messages.filter((message) => message.role === "user").at(-1)!;
      assert.match(JSON.stringify(lastUser.content), /补充 coder：保留原始数据，改为 CSV/);
      assert.match(JSON.stringify(f.mainInputs.at(-1)!.messages), failure === "blocked" ? /未发送/ : /身份复核失败/);
    } finally { f.mainRelease.resolve(); await f.close(); }
  });
}

test("helper cancel requests Escape and reports unknown until actual process ownership is verified", { timeout: 15000 }, async () => {
  const f = await helperFixture();
  try {
    await f.register();
    await f.app.receive({ conversationId: "one", inputId: "stop-coder", text: "停止 coder，保留已有文件" });
    await f.app.waitForIdle();
    assert.ok(f.commands.some((args) => args[1] === "send-keys" && args[2] === "coder" && args[3] === "esc"));
    assert.ok(f.commands.some((args) => args[0] === "pane" && args[1] === "process-info" && args[3] === "coder:p1"));
    assert.ok(f.outputs.some((output) => output.type === "text" && /实际停止状态仍待核实/.test(output.text)));
    assert.ok(!f.outputs.some((output) => output.type === "text" && /已核实.*停止/.test(output.text)));
    assert.ok(f.app.routingStatus("one").works.some((work) => work.status === "cancelled"));
    await f.reopen();
    await f.app.receive({ conversationId: "one", inputId: "after-stop-supplement", text: "补充 coder：再改成 JSON" });
    await f.app.waitForIdle();
    assert.equal(f.commands.filter((args) => args[1] === "prompt").length, 0, "a supplement must not revive the cancelled helper");
    assert.ok(f.app.routingStatus("one").works.some((work) => work.status === "cancelled"));
  } finally { f.mainRelease.resolve(); await f.close(); }
});

test("a slow helper delivery does not prevent another helper's explicit supplement from being submitted", { timeout: 15000 }, async () => {
  const firstEntered = deferred();
  const firstRelease = deferred();
  const secondSent = deferred();
  const f = await helperFixture({ async prompt(agent) {
    if (agent === "coder") { firstEntered.resolve(); await firstRelease.promise; }
    else secondSent.resolve();
  } });
  try {
    await f.register("coder"); await f.register("other");
    await f.app.receive({ conversationId: "one", inputId: "first-helper", text: "补充 coder：报表改为 CSV" });
    await bounded(firstEntered.promise, "first helper was not addressed");
    await f.app.receive({ conversationId: "one", inputId: "second-helper", text: "补充 other：只分析周四" });
    await bounded(secondSent.promise, "second helper is blocked behind an unrelated helper delivery");
    assert.ok(f.commands.some((args) => args[1] === "prompt" && args[2] === "other" && args[3]!.includes("补充 other：只分析周四")));
  } finally { firstRelease.resolve(); f.mainRelease.resolve(); await f.app.waitForIdle(); await f.close(); }
});
