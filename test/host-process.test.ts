import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { createRuntimeEventLog } from "../src/runtime/event-log.js";
import { createTestServer } from "./fixtures/http-server.js";

async function processFixture(t: TestContext, hold = false) {
  const dir = await mkdtemp(join(tmpdir(), "host-process-"));
  const promptFile = join(dir, "prompt.md"); await writeFile(promptFile, "helpful");
  let calls = 0;
  const server = createTestServer(t, (_req, res) => {
    calls++;
    if (hold) { res.writeHead(200, { "content-type": "text/event-stream" }); res.write(": waiting\n\n"); return; }
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: "done" }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const children: ReturnType<typeof spawn>[] = [];
  const start = (dataDir = dir) => {
    const child = spawn(process.execPath, ["--import", "tsx", "src/cli/main.ts", "chat", "--json"], {
      cwd: resolve("."), stdio: ["pipe", "pipe", "pipe"], env: { ...process.env,
        AGENT_DATA_DIR: dataDir, AGENT_PROMPT_FILE: promptFile, AGENT_CAPABILITIES_FILE: "", TINYFISH_API_KEY: "",
        MODEL_NAMES: "test", MODEL_DEFAULT: "test", MODEL_TEST_API_KEY: "test", MODEL_TEST_API: "openai-completions",
        MODEL_TEST_MODEL: "test", MODEL_TEST_BASE_URL: `http://127.0.0.1:${address.port}`, CONTEXT_COMPACTION: "" } });
    children.push(child);
    const lines: any[] = []; let errors = ""; let raw = "";
    const waiters: Array<{ matches: (event: any) => boolean; resolve: (value: any) => void }> = [];
    child.stderr!.on("data", (chunk) => { errors += String(chunk); });
    child.stdout!.on("data", (chunk) => {
      raw += String(chunk); const complete = raw.split("\n"); raw = complete.pop()!;
      for (const line of complete) { const event = JSON.parse(line); lines.push(event); for (const waiter of waiters) if (waiter.matches(event)) waiter.resolve(event); }
    });
    const exit = once(child, "exit");
    const wait = (matches: (event: any) => boolean) => lines.some(matches) ? Promise.resolve(lines.find(matches)) : new Promise<any>((resolve) => { waiters.push({ matches, resolve }); });
    return { child, lines, exit, wait, errors: () => errors };
  };
  t.after(async () => {
    for (const child of children) if (child.exitCode === null && child.signalCode === null) { child.kill(); await once(child, "exit").catch(() => {}); }
    server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve()));
    if (dirname(resolve(dir)) !== resolve(tmpdir())) throw new Error("Unexpected cleanup path");
    await rm(dir, { recursive: true, force: true });
  });
  return { dir, start, calls: () => calls };
}

test("a second CLI Host cannot recover or change a live Host using the same directory", { timeout: 60000 }, async (t) => {
  const f = await processFixture(t);
  const first = f.start(); first.child.stdin!.write("/help\n"); await first.wait((event) => event.type === "run_succeeded");
  const log = await createRuntimeEventLog(f.dir); const before = await log.read();
  const second = f.start(join(f.dir, ".")); second.child.stdin!.end("/help\n");
  const [code] = await second.exit;
  assert.equal(code, 1); assert.match(second.errors(), /Host.*占用/);
  assert.deepEqual(await log.read(), before);
  first.child.stdin!.end(); await first.exit;
  const third = f.start(); third.child.stdin!.end("/help\n");
  assert.equal((await third.exit)[0], 0);
  assert.equal(f.calls(), 0);
});

test("a crashed CLI Host restarts with one recovery summary and never executes its old queue", { timeout: 60000 }, async (t) => {
  const f = await processFixture(t, true);
  const first = f.start(); first.child.stdin!.write("old-task\n");
  await first.wait((event) => event.progress?.segmentId?.endsWith(":input-ready"));
  first.child.stdin!.write("cancelled-pending\n");
  await first.wait((event) => event.type === "input_receipt" && event.phase === "queued");
  first.child.kill(); await first.exit;
  const second = f.start(); second.child.stdin!.end("/help\n");
  assert.equal((await second.exit)[0], 0);
  const notices = second.lines.filter((event) => event.type === "recovery_notice");
  assert.equal(notices.length, 1); assert.match(notices[0].text, /重新提交/);
  assert.ok(f.calls() <= 1);
  const third = f.start(); third.child.stdin!.end("/help\n"); await third.exit;
  assert.equal(third.lines.some((event) => event.type === "recovery_notice"), false);
});

test("simultaneous Hosts elect one directory owner while a different directory runs independently", { timeout: 60000 }, async (t) => {
  const f = await processFixture(t);
  const contenders = [f.start(), f.start()];
  for (const contender of contenders) contender.child.stdin!.write("/help\n");
  const [loser] = await Promise.race(contenders.map(async (contender) => { await contender.exit; return [contender]; }));
  assert.equal(loser!.child.exitCode, 1); assert.match(loser!.errors(), /Host.*占用/);
  const winner = contenders.find((contender) => contender !== loser)!;
  await winner.wait((event) => event.type === "run_succeeded");
  const independent = f.start(join(f.dir, "independent")); independent.child.stdin!.end("independent-task\n");
  assert.equal((await independent.exit)[0], 0);
  assert.equal(f.calls(), 1);
  winner.child.stdin!.end(); assert.equal((await winner.exit)[0], 0);
});
