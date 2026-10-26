import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFile, readFile } from "node:fs/promises";
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
type RouterContext = { current: { text: string }; works: Array<{ id: string; summary: string; status: string }> };
function classify(response: ServerResponse, actions: unknown[]) {
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: JSON.stringify({ actions }) }, finish_reason: "stop" }] }));
}
function lastUserText(wire: Wire) {
  const content = wire.messages.filter((message) => message.role === "user").at(-1)?.content;
  return typeof content === "string" ? content : Array.isArray(content) ? content.map((part) => part.text ?? "").join("\n") : "";
}
function requestedFiles(text: string) {
  return [...text.matchAll(/本轮仅处理此原输入中的要求：write ([a-z-]+\.txt)/g)].map((match) => match[1]!);
}
function tool(response: ServerResponse, id: string, files: string[]) {
  sendChatCompletion(response, "", [{ index: 0, id, type: "function", function: { name: "append_results", arguments: JSON.stringify({ files }) } }]);
}
async function effectFixture(route: (context: RouterContext) => unknown[], main?: (wire: Wire, response: ServerResponse) => boolean | Promise<boolean>) {
  const entered = deferred();
  const release = deferred();
  const requests: string[] = [];
  let busyRequests = 0;
  let directory = "";
  const f = await assistantFixture(async (wire, response) => {
    if ((wire as Wire & { model: string }).model === "router") {
      classify(response, route(JSON.parse(String(wire.messages.at(-1)!.content))));
      return;
    }
    const text = lastUserText(wire);
    requests.push(text);
    if (await main?.(wire,response)) return;
    if (wire.messages.at(-1)?.role === "tool") { sendChatCompletion(response, "文件已保存"); return; }
    if (text.includes("hold current")) {
      if (++busyRequests === 1) { entered.resolve(); await release.promise; }
      sendChatCompletion(response, "当前工作已处理");
      return;
    }
    const files = requestedFiles(text);
    if (files.length) tool(response, `append-${requests.length}`, files);
    else sendChatCompletion(response, "请明确要取消哪一项；候选均保留。");
  }, async (cwd) => {
    directory = cwd;
    return {
      intent: { model: "router" },
      modelConfiguration: { defaultModel: "local", models: [
        { alias: "local", model: "local", api: "openai-completions", apiKey: "test", baseUrl: "" },
        { alias: "router", model: "router", api: "openai-completions", apiKey: "test", baseUrl: "" },
      ] },
      tools: [{ name: "append_results", label: "Append results", description: "Save each requested result, leaving an observable record of every effect", parameters: Type.Object({ files: Type.Array(Type.String()) }),
        async execute(_id, args) {
          for (const file of (args as { files: string[] }).files) {
            await appendFile(join(cwd, file), "saved\n");
            await appendFile(join(cwd, "effects.jsonl"), JSON.stringify(file) + "\n");
          }
          return { content: [{ type: "text" as const, text: `confirmed files saved: ${(args as {files:string[]}).files.join(", ")}` }], details: {} };
        } }],
    };
  });
  return { ...f, get app() { return f.app; }, entered, release, requests,
    async effects(): Promise<string[]> { return (await readFile(join(directory, "effects.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line)); },
  };
}
function request(text: string) { return { kind: "request", text }; }
function target(context: RouterContext, summary: string) {
  const found = context.works.find((work) => work.summary === summary);
  assert.ok(found, `missing work ${summary}`);
  return found.id;
}

test("queued cancellation keeps the other target from the same input through reopen, reset and resume", { timeout: 60_000 }, async () => {
  const f = await effectFixture((context) => {
    const text = context.current.text;
    if (text === "write report.txt and write chart.txt") return [request("write report.txt"), request("write chart.txt")];
    if (text === "cancel report") return [{ kind: "cancel", text, target: target(context, "write report.txt") }];
    return [request(text)];
  });
  try {
    await f.app.receive({ conversationId: "one", inputId: "busy", text: "hold current" });
    await f.entered.promise;
    await f.app.receive({ conversationId: "one", inputId: "pair", text: "write report.txt and write chart.txt" });
    await f.app.receive({ conversationId: "one", inputId: "cancel", text: "cancel report" });
    await f.app.waitForRouting();
    const pair = f.app.routingStatus("one").works.filter((work) => work.inputId === "pair");
    assert.equal(pair.length, 2);
    assert.notEqual(pair[0]!.id, pair[1]!.id);
    assert.equal(pair[0]!.status, "cancelled");
    await f.reopen();
    f.release.resolve();
    await f.app.waitForIdle();
    assert.deepEqual(await f.effects(), ["chart.txt"]);
    await f.app.receive({ conversationId: "one", inputId: "reset", text: "/reset" });
    await f.app.receive({ conversationId: "one", inputId: "resume", text: "/resume" });
    await f.app.receive({ conversationId: "one", inputId: "after", text: "write after.txt" });
    await f.app.waitForIdle();
    assert.deepEqual(await f.effects(), ["chart.txt", "after.txt"]);
    await assert.rejects(readFile(join(f.directory, "report.txt")), { code: "ENOENT" });
    assert.equal(f.app.routingStatus("one").works.find((work) => work.id === pair[0]!.id)?.status, "cancelled");
  } finally { f.release.resolve(); await f.close(); }
});

test("compound cancel plus new request leaves unrelated queued work ahead of the new request", { timeout: 60_000 }, async () => {
  const f = await effectFixture((context) => {
    const text = context.current.text;
    if (text === "cancel report then write new.txt") return [{ kind: "cancel", text: "cancel report", target: target(context, "write report.txt") }, request("write new.txt")];
    return [request(text)];
  });
  try {
    await f.app.receive({ conversationId: "one", inputId: "busy", text: "hold current" }); await f.entered.promise;
    await f.app.receive({ conversationId: "one", inputId: "report", text: "write report.txt" });
    await f.app.receive({ conversationId: "one", inputId: "weather", text: "write weather.txt" });
    const composite = { conversationId: "one", inputId: "compound", text: "cancel report then write new.txt" };
    await f.app.receive(composite); await f.app.waitForRouting();
    f.release.resolve(); await f.app.waitForIdle();
    assert.deepEqual(await f.effects(), ["weather.txt", "new.txt"]);
    await f.app.receive(composite); await f.app.waitForIdle();
    assert.deepEqual(await f.effects(), ["weather.txt", "new.txt"]);
    await assert.rejects(readFile(join(f.directory, "report.txt")), { code: "ENOENT" });
  } finally { f.release.resolve(); await f.close(); }
});

test("ambiguous cancellation asks for a target without changing either candidate's effects", { timeout: 60_000 }, async () => {
  const f = await effectFixture((context) => {
    const text = context.current.text;
    if (text === "cancel that") return [{ kind: "clarify", text, candidates: [target(context, "write report.txt"), target(context, "write chart.txt")] }];
    return [request(text)];
  });
  try {
    await f.app.receive({ conversationId: "one", inputId: "busy", text: "hold current" }); await f.entered.promise;
    await f.app.receive({ conversationId: "one", inputId: "report", text: "write report.txt" });
    await f.app.receive({ conversationId: "one", inputId: "chart", text: "write chart.txt" });
    await f.app.receive({ conversationId: "one", inputId: "ambiguous", text: "cancel that" });
    await f.app.waitForRouting();
    assert.ok(f.app.routingStatus("one").works.filter((work) => ["report", "chart"].includes(work.inputId)).every((work) => work.status === "queued"));
    f.release.resolve(); await f.app.waitForIdle();
    assert.deepEqual(await f.effects(), ["report.txt", "chart.txt"]);
    assert.ok(f.requests.some((text) => /目标待澄清/.test(text)));
    assert.ok(!f.app.routingStatus("one").works.some((work) => work.status === "cancelled"));
  } finally { f.release.resolve(); await f.close(); }
});

test("cancelling one running target preserves confirmed effects and resumes the same batch's survivor once", { timeout: 60_000 }, async () => {
  const confirmed = deferred();
  const releaseOldResponse = deferred();
  let stage = 0;
  const resumed: string[] = [];
  const f = await effectFixture((context) => {
    const text = context.current.text;
    if (text === "write report.txt and write chart.txt") return [request("write report.txt"), request("write chart.txt")];
    if (text === "cancel report") return [{ kind: "cancel", text, target: target(context, "write report.txt") }];
    return [request(text)];
  }, async (wire,response) => {
    const text=lastUserText(wire);
    if(stage===0 && requestedFiles(text).length===2) {
      stage=1;
      tool(response,"write-report-confirmed",["report.txt"]);
      return true;
    }
    if(stage===1 && wire.messages.at(-1)?.role==="tool") {
      stage=2;
      confirmed.resolve();
      await releaseOldResponse.promise;
      if(!response.destroyed) sendChatCompletion(response,"old batch response");
      return true;
    }
    if(stage===2 && wire.messages.at(-1)?.role==="user") {
      resumed.push(text);
      stage=3;
      tool(response,"write-survivor",requestedFiles(text));
      return true;
    }
    return false;
  });
  try {
    await f.app.receive({conversationId:"one",inputId:"busy",text:"hold current"}); await f.entered.promise;
    await f.app.receive({conversationId:"one",inputId:"pair",text:"write report.txt and write chart.txt"});
    await f.app.waitForRouting();
    f.release.resolve();
    await confirmed.promise;
    assert.deepEqual(await f.effects(),["report.txt"]);
    const pair=f.app.routingStatus("one").works.filter((work)=>work.inputId==="pair");
    assert.equal(pair[0]!.batchId,pair[1]!.batchId);
    const cancellation={conversationId:"one",inputId:"cancel",text:"cancel report"};
    await f.app.receive(cancellation); await f.app.waitForRouting();
    await f.app.waitForIdle();
    assert.equal(resumed.length,1);
    assert.deepEqual(requestedFiles(resumed[0]!),["chart.txt"]);
    assert.match(resumed[0]!,/原工作已确认工具结果/);
    assert.match(resumed[0]!,/confirmed files saved: report.txt/);
    assert.deepEqual(await f.effects(),["report.txt","chart.txt"]);
    assert.equal(await readFile(join(f.directory,"report.txt"),"utf8"),"saved\n");
    assert.equal(await readFile(join(f.directory,"chart.txt"),"utf8"),"saved\n");
    await f.reopen();
    await f.app.receive(cancellation);
    await f.app.receive({conversationId:"one",inputId:"reset",text:"/reset"});
    await f.app.receive({conversationId:"one",inputId:"resume",text:"/resume"});
    await f.app.waitForIdle();
    assert.deepEqual(await f.effects(),["report.txt","chart.txt"]);
    assert.equal(f.app.routingStatus("one").works.find((work)=>work.id===pair[0]!.id)?.status,"cancelled");
    assert.equal(f.app.routingStatus("one").works.find((work)=>work.id===pair[1]!.id)?.status,"completed");
  } finally {f.release.resolve();releaseOldResponse.resolve();await f.close();}
});
