import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type ServerResponse } from "node:http";
import { mkdtemp, rm, readFile, appendFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDurableExecutor } from "../src/assistant/durable-executor.js";
import { sendChatCompletion } from "./fixtures/chat-completion.js";
import { Type } from "typebox";
import { fork } from "node:child_process";
import { once } from "node:events";
import { defineTool } from "@earendil-works/pi-durable";

async function fixture(provider: (body: any, response: ServerResponse) => void | Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), "nailong-durable-"));
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    try { await provider(JSON.parse(body), response); }
    catch (error) { response.writeHead(500); response.end(String(error)); }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("port missing");
  const options = { cwd: directory, dataDir: join(directory, "new-executions"),
    prompt: "You are a personal assistant.", modelConfiguration: { defaultModel: "local", models: [
      { alias: "local", api: "openai-completions" as const, model: "local", apiKey: "test", baseUrl: `http://127.0.0.1:${address.port}` },
    ] } };
  return { directory, options, async close() {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  } };
}

const batch = (id = "batch-1") => ({ id, requestKey: id, conversationId: "one", events: [
  { inputId: "A", conversationId: "one", text: "first request" },
  { inputId: "B", conversationId: "one", text: "second request" },
] });

test("durable executor preserves separate input identities and recovers a settled submission without another request", async () => {
  const requests: any[] = [];
  const f = await fixture((body, response) => { requests.push(body); sendChatCompletion(response, "both handled"); });
  let executor = await createDurableExecutor(f.options);
  const outputs: any[] = [];
  let submissionId: string | undefined;
  const controls = { emit: async (output: any) => { outputs.push(output); }, recordSubmission: async (id: string) => { submissionId = id; } };
  try {
    assert.equal((await executor.execute(batch(), controls)).status, "completed");
    const input = JSON.stringify(requests[0].messages);
    assert.match(input, /first request/); assert.match(input, /second request/);
    assert.match(input, /A/); assert.match(input, /B/);
    assert.equal(outputs.filter((output) => output.text === "both handled").length, 1);
    assert.equal(typeof submissionId, "string");
    await executor.close(); executor = await createDurableExecutor(f.options);
    assert.equal((await executor.execute({ ...batch(), submissionId }, controls)).status, "completed");
    assert.equal(requests.length, 1);
    assert.equal(outputs[0].outputId, outputs.at(-1).outputId, "recovered answer has stable delivery identity");
  } finally { await executor.close(); await f.close(); }
});

test("steering is durably identified, reaches a supported boundary, and keeps drafts separate from confirmed output", async () => {
  const requests: any[] = [];
  let release!: () => void;
  let entered!: () => void;
  const arrived = new Promise<void>((resolve) => { entered = resolve; });
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const f = await fixture(async (body, response) => {
    requests.push(body);
    if (requests.length === 1) {
      entered(); await gate;
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { reasoning_content: "PRIVATE_REASONING_PREVIEW", content: "first answer" }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`);
    }
    else sendChatCompletion(response, "supplement handled");
  });
  const previews: any[] = [];
  const executor = await createDurableExecutor({ ...f.options, onPreview: (preview) => { previews.push(preview); } });
  const outputs: any[] = [];
  try {
    const running = executor.execute(batch(), { emit: async (output) => { outputs.push(output); }, recordSubmission() {} });
    await arrived;
    const steer = await executor.steer("one", { inputId: "S", conversationId: "one", text: "explicit supplement" });
    const duplicate = await executor.steer("one", { inputId: "S", conversationId: "one", text: "explicit supplement" });
    assert.equal(steer.submissionId, duplicate.submissionId);
    release(); await running;
    const receipt = await executor.steerStatus("one", steer.submissionId);
    assert.equal(receipt?.status, "done"); assert.equal(typeof receipt?.entry, "number");
    assert.equal(requests.length, 2);
    assert.match(JSON.stringify(requests[1].messages), /explicit supplement/);
    assert.deepEqual(outputs.map((output) => output.text), ["first answer", "supplement handled"]);
    assert.ok(previews.some((preview) => preview.text === "first answer"));
    assert.doesNotMatch(JSON.stringify(previews), /PRIVATE_REASONING_PREVIEW/);
  } finally { release(); await executor.close(); await f.close(); }
});

test("a completed external tool result is reused across retry exhaustion and explicit continuation", async () => {
  let effects = 0;
  let requests = 0;
  let continueNow = false;
  const previews: Array<{ text?: string }> = [];
  const f = await fixture((body, response) => {
    requests++;
    if (!JSON.stringify(body.messages).includes("effect-confirmed-42")) sendChatCompletion(response, "", [
      { index: 0, id: "confirmed-effect", type: "function", function: { name: "create_effect", arguments: '{"note":"PRIVATE_TOOL_ARGUMENT_PREVIEW"}' } },
    ]);
    else if (!continueNow) { response.writeHead(503); response.end("temporarily unavailable"); }
    else sendChatCompletion(response, "reused confirmed effect");
  });
  const tools = [{ name: "create_effect", label: "effect", description: "Create one external effect", parameters: Type.Object({ note: Type.String() }),
    async execute(_id: string, args: { note: string }) {
      assert.equal(args.note, "PRIVATE_TOOL_ARGUMENT_PREVIEW");
      effects++; return { content: [{ type: "text" as const, text: "effect-confirmed-42" }], details: {} };
    } }];
  const options = { ...f.options, tools, onPreview: (preview: { text?: string }) => { previews.push(preview); } };
  let executor = await createDurableExecutor(options);
  let submissionId = "";
  const controls = { emit() {}, recordSubmission(id: string) { submissionId = id; } };
  try {
    assert.equal((await executor.execute(batch(), controls)).status, "paused");
    assert.equal(effects, 1);
    assert.equal(requests, 5, "one tool planning request plus four generation attempts, no provider retry layer");
    await executor.close(); executor = await createDurableExecutor(options);
    assert.equal((await executor.execute({ ...batch(), submissionId }, controls)).status, "paused");
    assert.equal(requests, 5, "reopen must not bypass exhausted retry budget");
    await executor.reset("one");
    continueNow = true;
    const result = await executor.execute({ ...batch(), requestKey: "batch-1:resume-1", previousSubmissionId: submissionId, resumed: true, reconcile: true, retryEpoch: 1 }, controls);
    assert.equal(result.status, "completed"); assert.equal(effects, 1); assert.equal(requests, 6);
    assert.ok(previews.some((preview) => preview.text === "reused confirmed effect"));
    assert.doesNotMatch(JSON.stringify(previews), /PRIVATE_TOOL_ARGUMENT_PREVIEW/);
  } finally { await executor.close(); await f.close(); }
});

test("hard-killed unsafe effects are verified before completion, re-execution, or asking the user", async (t) => {
  for (const mode of ["confirmed", "not_applied", "unknown", "sequential"] as const) await t.test(mode, async () => {
    let afterCrash = false;
    let inspectionRequests = 0;
    let secondBeforeVerification = 0;
    const tool = (name: string, args: object, id: string) => [{ index: 0, id, type: "function", function: { name, arguments: JSON.stringify(args) } }];
    const f = await fixture((body, response) => {
      const messages = JSON.stringify(body.messages);
      if (!afterCrash) return sendChatCompletion(response, "", [...tool("create_effect", {}, "external-call"), ...(mode === "sequential" ? tool("second_effect", {}, "pending-second-call").map((call) => ({ ...call, index: 1 })) : [])]);
      if (!messages.includes("inspection-result")) return sendChatCompletion(response, "", tool("inspect_effect", {}, "inspection-call"));
      if (!messages.includes("verification-recorded")) return sendChatCompletion(response, "", tool("resolve_interrupted_tool",
        { callId: "external-call", outcome: mode === "sequential" ? "confirmed" : mode, evidence: mode === "unknown" ? "external service cannot be reached" : "inspection-result reads external record" }, "resolution-call"));
      if (mode === "not_applied" && !messages.includes("new-effect-confirmed")) return sendChatCompletion(response, "", tool("create_effect", {}, "new-external-call"));
      if (mode === "sequential" && !messages.includes("second-confirmed")) return sendChatCompletion(response, "", tool("second_effect", {}, "verified-second-call"));
      sendChatCompletion(response, "verified completed result");
    });
    const worker = fork(new URL("./fixtures/durable-worker.ts", import.meta.url), [f.directory, f.options.modelConfiguration.models[0]!.baseUrl, mode],
      { execArgv: ["--import", "tsx"], stdio: ["ignore", "pipe", "pipe", "ipc"], windowsHide: true });
    let errors = ""; worker.stderr?.on("data", (chunk) => { errors += chunk; });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await new Promise<void>((resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`worker boundary timeout: ${errors}`)), 10000);
        worker.on("message", (message: any) => { if (message.type === "effect-boundary") resolve(); });
        worker.on("exit", (code) => reject(new Error(`worker exited ${code}: ${errors}`)));
      });
      clearTimeout(timer); const exited = once(worker, "exit"); worker.kill("SIGKILL"); await exited; afterCrash = true;
      const executor = await createDurableExecutor({ ...f.options, tools: [{ name: "create_effect", label: "effect", description: "Create an external effect", parameters: Type.Object({}),
        async execute() { await appendFile(join(f.directory, "effects.txt"), "one-effect\n"); return { content: [{ type: "text", text: "new-effect-confirmed" }], details: {} }; } },
        { name: "second_effect", label: "second", description: "A subsequent external effect", parameters: Type.Object({}),
          async execute() { if (!inspectionRequests) secondBeforeVerification++; await appendFile(join(f.directory, "second-effect.txt"), "second\n"); return { content: [{ type: "text", text: "second-confirmed" }], details: {} }; } }],
        extraTools: () => [defineTool({ name: "inspect_effect", description: "Read external effect evidence", replay: "safe", parameters: Type.Object({}),
          async execute() { inspectionRequests++; const effect = await readFile(join(f.directory, "effects.txt"), "utf8").catch(() => "none");
            return { output: [{ type: "text", text: `inspection-result: ${effect}` }] }; } })],
      });
      try {
        const result = await executor.execute({ id: "crash-batch", requestKey: "crash-batch", conversationId: "one",
          events: [{ inputId: "original", conversationId: "one", text: "create effect" }] }, { emit() {}, recordSubmission() {} });
        assert.equal(result.status, mode === "unknown" ? "needs_confirmation" : "completed");
        assert.equal(inspectionRequests, 1);
        const effects = await readFile(join(f.directory, "effects.txt"), "utf8").catch(() => "");
        assert.equal(effects, "one-effect\n");
        if (mode === "sequential") { assert.equal(secondBeforeVerification, 0); assert.equal(await readFile(join(f.directory, "second-effect.txt"), "utf8"), "second\n"); }
      } finally { await executor.close(); }
    } finally {
      clearTimeout(timer);
      if (worker.exitCode === null && worker.signalCode === null) {
        const exited = once(worker, "exit"); worker.kill("SIGKILL"); await exited;
      }
      await f.close();
    }
  });
});

test("hard-kill during retry backoff preserves the four-request budget", async () => {
  let requests = 0;
  const f = await fixture((_body, response) => { requests++; response.writeHead(503); response.end("temporarily unavailable"); });
  const worker = fork(new URL("./fixtures/durable-worker.ts", import.meta.url), [f.directory, f.options.modelConfiguration.models[0]!.baseUrl, "retry"],
    { execArgv: ["--import", "tsx"], stdio: ["ignore", "pipe", "pipe", "ipc"], windowsHide: true });
  let errors = ""; worker.stderr?.on("data", (chunk) => { errors += chunk; });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await new Promise<void>((resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`retry boundary timeout: ${errors}`)), 15000);
      worker.on("message", (message: any) => { if (message.type === "output" && message.output.outputId.endsWith(":retry:2")) resolve(); });
      worker.on("exit", (code) => reject(new Error(`worker exited ${code}: ${errors}`)));
    });
    clearTimeout(timer); const exited = once(worker, "exit"); worker.kill("SIGKILL"); await exited;
    assert.equal(requests, 2);
    const executor = await createDurableExecutor(f.options);
    try {
      const result = await executor.execute({ id: "crash-batch", requestKey: "crash-batch", conversationId: "one", events: [
        { inputId: "original", conversationId: "one", text: "create effect" },
      ] }, { emit() {}, recordSubmission() {} });
      assert.equal(result.status, "paused"); assert.equal(requests, 4);
    } finally { await executor.close(); }
  } finally { clearTimeout(timer); if (worker.exitCode === null) worker.kill("SIGKILL"); await f.close(); }
});

test("hard-kill after SDK admission before saving its ID recovers the same submission and executes the input once", { timeout: 15000 }, async () => {
  let reopen = false; let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const recoveredRequests: any[] = [];
  const f = await fixture(async (body, response) => {
    if (!reopen) { await held; return; }
    recoveredRequests.push(body);
    if (!body.messages.some((message: any) => message.role === "tool")) sendChatCompletion(response, "", [
      { index: 0, id: "admitted-effect", type: "function", function: { name: "create_effect", arguments: "{}" } },
    ]);
    else sendChatCompletion(response, "admitted input finished");
  });
  const worker = fork(new URL("./fixtures/durable-worker.ts", import.meta.url), [f.directory, f.options.modelConfiguration.models[0]!.baseUrl, "admission"],
    { execArgv: ["--import", "tsx"], stdio: ["ignore", "pipe", "pipe", "ipc"], windowsHide: true });
  let errors = ""; worker.stderr?.on("data", (chunk) => { errors += chunk; });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const admittedId = await new Promise<string>((resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`admission boundary timeout: ${errors}`)), 10000);
      worker.on("message", (message: any) => { if (message.type === "admission") resolve(message.id); });
      worker.on("exit", (code) => reject(new Error(`worker exited ${code}: ${errors}`)));
    });
    clearTimeout(timer); const exited = once(worker, "exit"); worker.kill("SIGKILL"); await exited;
    reopen = true; release();
    let effects = 0; let recoveredId = "";
    const executor = await createDurableExecutor({ ...f.options, tools: [{ name: "create_effect", label: "effect", description: "Create external effect", parameters: Type.Object({}),
      async execute() { effects++; await appendFile(join(f.directory, "admitted-effects.txt"), "one\n"); return { content: [{ type: "text", text: "effect confirmed" }], details: {} }; } }],
    });
    try {
      const result = await executor.execute({ id: "crash-batch", requestKey: "crash-batch", conversationId: "one", events: [
        { inputId: "original", conversationId: "one", text: "create effect" },
      ] }, { emit() {}, recordSubmission(id) { recoveredId = id; } });
      assert.equal(result.status, "completed"); assert.equal(recoveredId, admittedId);
      assert.equal(effects, 1); assert.equal(await readFile(join(f.directory, "admitted-effects.txt"), "utf8"), "one\n");
      assert.equal(recoveredRequests.length, 2);
      for (const request of recoveredRequests) assert.equal(request.messages.filter((message: any) => message.role === "user" && JSON.stringify(message.content).includes("create effect")).length, 1);
    } finally { await executor.close(); }
  } finally { release(); clearTimeout(timer); if (worker.exitCode === null) worker.kill("SIGKILL"); await f.close(); }
});
