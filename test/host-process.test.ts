import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { createTestServer } from "./fixtures/http-server.js";
import { sendChatCompletion } from './fixtures/chat-completion.js';
import { PersonalStore } from '../src/personal/store.js';

async function processFixture(t: TestContext, mode: 'reply' | 'task' | 'inbox' = 'reply') {
  const dir = await mkdtemp(join(tmpdir(), "host-process-"));
  const promptFile = join(dir, "prompt.md"); await writeFile(promptFile, "helpful");
  let calls = 0;
  let held = true; let taskCalls = 0;
  let taskStarted!: () => void; const taskReady = new Promise<void>(resolve => { taskStarted = resolve; });
  let inboxStarted!: () => void; const inboxReady = new Promise<void>(resolve => { inboxStarted = resolve; });
  const server = createTestServer(t, async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    const wire = JSON.parse(body);
    calls++;
    if (mode === 'inbox' && held) { inboxStarted(); res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write(': waiting\n\n'); return; }
    if (mode === 'task') {
      const main = wire.tools?.some((tool: { function: { name: string } }) => tool.function.name === 'task_control');
      if (!main) { taskCalls++; taskStarted(); res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write(': waiting\n\n'); return; }
      if (wire.messages.at(-1)?.role === 'tool') {
        const result = wire.messages.at(-1);
        if (result.tool_call_id === 'query') {
          const task = JSON.parse(result.content);
          return sendChatCompletion(res, `任务 ${task.id} 状态：${task.status} ${task.error ?? ''}`);
        }
        return sendChatCompletion(res, '提议已提交');
      }
      const user = JSON.stringify(wire.messages.at(-1)?.content);
      if (user.includes('查询任务')) {
        const id = /查询任务 ([a-z0-9:-]+)/.exec(user)?.[1];
        return sendChatCompletion(res, '', [{ index: 0, id: 'query', type: 'function', function: { name: 'task_control', arguments: JSON.stringify({ kind: 'query', taskId: id }) } }]);
      }
      return sendChatCompletion(res, '', [{ index: 0, id: 'start', type: 'function', function: { name: 'task_control', arguments: JSON.stringify({ kind: 'start', goal: '持久任务' }) } }]);
    }
    sendChatCompletion(res, 'done');
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const children: ReturnType<typeof spawn>[] = [];
  const start = (dataDir = join(dir, 'data')) => {
    const child = spawn(process.execPath, ["--import", "tsx", "src/cli/main.ts", "chat", "--json"], {
      cwd: resolve("."), stdio: ["pipe", "pipe", "pipe"], env: { ...process.env,
        AGENT_DATA_DIR: dataDir, AGENT_PROMPT_FILE: promptFile, AGENT_CAPABILITIES_FILE: "", TINYFISH_API_KEY: "",
        EMBEDDING_API_KEY: '', AGENT_VERIFICATION_CHECKS: '',
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
  return { dir, start, calls: () => calls, taskCalls: () => taskCalls, taskReady, inboxReady, releaseInbox() { held = false; } };
}

test("a second CLI Host cannot recover or change a live Host using the same directory", { timeout: 60000 }, async (t) => {
  const f = await processFixture(t);
  const first = f.start(); first.child.stdin!.write("/help\n"); await first.wait((event) => event.type === "message");
  const second = f.start(join(f.dir, 'data', ".")); second.child.stdin!.end("/help\n");
  const [code] = await second.exit;
  assert.equal(code, 1); assert.match(second.errors(), /Host.*占用/);
  assert.equal(second.lines.length, 0);
  first.child.stdin!.write('/help\n'); await first.wait(event => event.type === 'message' && event.id !== first.lines[0]?.id);
  first.child.stdin!.end(); await first.exit;
  const third = f.start(); third.child.stdin!.end("/help\n");
  assert.equal((await third.exit)[0], 0);
  assert.equal(f.calls(), 0);
});

test("a crashed CLI Host retains its task identity and waits when native execution cannot be established", { timeout: 60000 }, async (t) => {
  const f = await processFixture(t, 'task');
  const first = f.start(); first.child.stdin!.write("old-task\n");
  const acknowledgement = await first.wait((event) => event.type === 'message' && event.taskId);
  await f.taskReady;
  first.child.kill(); await first.exit;
  const records = new PersonalStore(join(f.dir, 'data'));
  const helper = records.listTasks().find(task => task.parentTaskId === acknowledgement.taskId);
  records.close(); assert.ok(helper, 'the accepted overall work retains its helper identity');
  const second = f.start(); second.child.stdin!.write(`查询任务 ${helper.id}\n`);
  const query = await second.wait(event => event.type === 'message' && event.text.includes('状态：'));
  assert.match(query.text, new RegExp(helper.id));
  assert.match(query.text, /状态：waiting/);
  assert.match(query.text, /不会重复启动|未知/);
  second.child.stdin!.end();
  assert.equal((await second.exit)[0], 0);
  assert.equal(f.taskCalls(), 1);
  const third = f.start(); third.child.stdin!.end("/help\n"); await third.exit;
  assert.equal(f.taskCalls(), 1);
});

test('actual CLI recovers a durable unanswered input after crash exactly once', { timeout: 60000 }, async t => {
  const f = await processFixture(t, 'inbox'); const first = f.start();
  first.child.stdin!.write('保留这个未回答的问题\n'); await f.inboxReady;
  first.child.kill(); await first.exit; f.releaseInbox();
  const second = f.start();
  await second.wait(event => event.type === 'message' && event.text === 'done');
  second.child.stdin!.end(); assert.equal((await second.exit)[0], 0);
  assert.equal(f.calls(), 2);
  const third = f.start(); third.child.stdin!.end('/help\n'); assert.equal((await third.exit)[0], 0);
  assert.equal(third.lines.some(event => event.text === 'done'), false);
  assert.equal(f.calls(), 2);
});

test("simultaneous Hosts elect one directory owner while a different directory runs independently", { timeout: 60000 }, async (t) => {
  const f = await processFixture(t);
  const contenders = [f.start(), f.start()];
  for (const contender of contenders) contender.child.stdin!.write("/help\n");
  const [loser] = await Promise.race(contenders.map(async (contender) => { await contender.exit; return [contender]; }));
  assert.equal(loser!.child.exitCode, 1); assert.match(loser!.errors(), /Host.*占用/);
  const winner = contenders.find((contender) => contender !== loser)!;
  await winner.wait((event) => event.type === "message");
  const independent = f.start(join(f.dir, "independent")); independent.child.stdin!.end("independent-task\n");
  assert.equal((await independent.exit)[0], 0);
  assert.equal(f.calls(), 1);
  winner.child.stdin!.end(); assert.equal((await winner.exit)[0], 0);
});
