import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HelperControlDispatcher, helperProcesses, type HelperControlRecord } from "../src/assistant/helper-control.js";
import type { HelperRecord, HerdrClient } from "../src/assistant/herdr.js";

const helper: HelperRecord = { id: "watch-1", session: "fixture", agent: "coder", paneId: "w1:p1", workspaceId: "w1", cwd: process.cwd(), promptPath: "prompt.txt", sequence: 1, targetIds: ["report"], summary: "prepare report" };
const identity = (status = "working") => JSON.stringify({ result: { agent: { name: "coder", pane_id: "w1:p1", workspace_id: "w1", cwd: process.cwd(), agent_status: status } } });
async function fixture(client: HerdrClient) {
  const directory = await mkdtemp(join(tmpdir(), "nailong-helper-control-"));
  const storage = {
    async load(conversation: string, id: string): Promise<HelperControlRecord | undefined> {
      try { return JSON.parse(await readFile(join(directory, encodeURIComponent(`${conversation}:${id}`)), "utf8")); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
    },
    async save(conversation: string, record: HelperControlRecord) { await writeFile(join(directory, encodeURIComponent(`${conversation}:${record.id}`)), JSON.stringify(record)); },
  };
  return { storage, open: () => new HelperControlDispatcher({ client, ...storage }), close: () => rm(directory, { recursive: true, force: true }) };
}

test("helper supplement is sent once across reopen, with its original text and stable identity", async () => {
  const sent: string[] = [];
  const f = await fixture({ async run(session, args) {
    assert.equal(session, "fixture");
    if (args[0] === "agent" && args[1] === "get") return identity();
    if (args[0] === "agent" && args[1] === "prompt") { sent.push(args[3]!); return JSON.stringify({ result: { submitted: true } }); }
    throw new Error(`unexpected ${args}`);
  } });
  try {
    const action = { id: "input-2:0", kind: "supplement" as const, target: "report", text: "改成 CSV；保留 `原文`" };
    assert.equal((await f.open().control("one", helper, action)).state, "sent");
    assert.equal((await f.open().control("one", helper, action)).state, "sent");
    assert.equal(sent.length, 1);
    assert.ok(sent[0]!.includes(action.id));
    assert.ok(sent[0]!.includes(action.text));
  } finally { await f.close(); }
});

test("unconfirmed submission survives reopen without a second external send", async () => {
  const sent: string[] = [];
  const f = await fixture({ async run(_session, args) {
    if (args[1] === "get") return identity();
    sent.push(args[3]!); throw new Error("connection lost after submission");
  } });
  try {
    const action = { id: "input-3:0", kind: "supplement" as const, target: "report", text: "加上周四" };
    assert.equal((await f.open().control("one", helper, action)).state, "unknown");
    assert.equal((await f.open().control("one", helper, action)).state, "unknown");
    assert.equal(sent.length, 1);
  } finally { await f.close(); }
});

test("helper stop verifies owned process exit before reporting stopped", async () => {
  let running = true;
  let escaped = false;
  const f = await fixture({ async run(_session, args) {
    if (args[1] === "get") return identity(escaped ? "idle" : "working");
    assert.deepEqual(args, ["agent", "send-keys", "coder", "esc"]);
    escaped = true; return "{}";
  } });
  try {
    const dispatcher = new HelperControlDispatcher({ ...f.storage,
      client: { async run(_session, args) { if (args[1] === "get") return identity(escaped ? "idle" : "working"); escaped = true; return "{}"; } },
      processes: {
        async inspect() { return { complete: true, processes: running ? [{ pid: 123, started: "2026-10-16T00:00:00Z", command: "node task.js" }] : [], evidence: ["owned process tree inspected"] }; },
        async stop(process) { assert.equal(process.pid, 123); assert.equal(escaped, true); running = false; },
      },
    });
    const result = await dispatcher.control("one", helper, { id: "input-4:0", kind: "cancel", target: "report", text: "报表别做了" });
    assert.equal(result.state, "stopped");
    assert.equal(running, false);
  } finally { await f.close(); }
});

test("unknown process ownership still sends Escape and never claims stopped", async () => {
  const keys: string[] = [];
  const f = await fixture({ async run(_session, args) {
    if (args[1] === "get") return identity();
    if (args[1] === "send-keys") { keys.push(args[3]!); return "{}"; }
    throw new Error("process info unavailable");
  } });
  try {
    const result = await f.open().control("one", helper, { id: "stop-unknown", kind: "cancel", target: "report", text: "停止报表" });
    assert.equal(result.state, "unknown");
    assert.deepEqual(keys, ["esc"]);
    assert.match(result.evidence.join("\n"), /进程归属核查失败/);
  } finally { await f.close(); }
});

test("blocked and mismatched helpers retain the original request without external submission", async () => {
  const f = await fixture({ async run(_session, args) { assert.equal(args[1], "get"); return identity("blocked"); } });
  try {
    const blocked = await f.open().control("one", helper, { id: "blocked", kind: "supplement", target: "report", text: "CSV" });
    const mismatch = await f.open().control("one", { ...helper, paneId: "other:p1" }, { id: "mismatch", kind: "supplement", target: "report", text: "CSV" });
    assert.equal(blocked.state, "rejected");
    assert.equal(mismatch.state, "rejected");
    assert.equal(blocked.text, "CSV");
    assert.match(mismatch.evidence.join("\n"), /身份/);
  } finally { await f.close(); }
});

test("CLI acceptance and old working state remain sent until independent execution evidence exists", async () => {
  const f = await fixture({ async run(_session, args) { return args[1] === "get" ? identity() : JSON.stringify({ result: { submitted: true } }); } });
  try {
    const dispatcher = f.open();
    const action = { id: "adoption", kind: "supplement" as const, target: "report", text: "CSV" };
    assert.equal((await dispatcher.control("one", helper, action)).state, "sent");
    await assert.rejects(dispatcher.confirmAdoption("one", action.id, { helperId: helper.id, actionId: "wrong", executionRef: "artifact:report.csv", detail: "CSV created" }), /采纳证据/);
    assert.equal((await dispatcher.confirmAdoption("one", action.id, { helperId: helper.id, actionId: action.id, executionRef: "artifact:report.csv", detail: "已核对本次动作对应的 CSV 文件" })).state, "adopted");
    assert.equal((await f.open().control("one", helper, action)).state, "adopted");
  } finally { await f.close(); }
});

test("an idle helper is handed back for follow-up instead of restarting the old work", async () => {
  const f = await fixture({ async run(_session, args) { assert.equal(args[1], "get"); return identity("idle"); } });
  try {
    assert.equal((await f.open().control("one", helper, { id: "finished", kind: "supplement", target: "report", text: "CSV" })).state, "settled");
  } finally { await f.close(); }
});

test("idle helper cancellation still stops a verified task process without interrupting its old turn", async () => {
  const f = await fixture({ async run(_session, args) { assert.equal(args[1], "get"); return identity("idle"); } });
  let running = true;
  try {
    const dispatcher = new HelperControlDispatcher({ ...f.storage, client: { async run(_session, args) { assert.equal(args[1], "get"); return identity("idle"); } },
      processes: { async inspect() { return { complete: true, processes: running ? [{ pid: 123, started: "start", command: "task" }] : [], evidence: [] }; }, async stop() { running = false; } },
    });
    assert.equal((await dispatcher.control("one", helper, { id: "idle-stop", kind: "cancel", target: "report", text: "停止" })).state, "stopped");
  } finally { await f.close(); }
});

test("each helper preserves supplement order while another helper controls independently", async () => {
  let release!: () => void;
  let entered!: () => void;
  const started = new Promise<void>((resolve) => { entered = resolve; });
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const sent: string[] = [];
  const f = await fixture({ async run(_session, args) {
    if (args[1] === "get") return identity().replace('"coder"', JSON.stringify(args[2]));
    const text = args[3]!;
    if (text.includes("first")) { entered(); await gate; }
    sent.push(text); return "{}";
  } });
  try {
    const dispatcher = f.open();
    const first = dispatcher.control("one", helper, { id: "first", kind: "supplement", target: "report", text: "first change" });
    await started;
    const second = dispatcher.control("one", helper, { id: "second", kind: "supplement", target: "report", text: "second change" });
    const other = await dispatcher.control("one", { ...helper, id: "watch-2", agent: "other" }, { id: "other", kind: "supplement", target: "report", text: "independent change" });
    assert.equal(other.state, "sent");
    assert.equal(sent.length, 1);
    release();
    await Promise.all([first, second]);
    assert.match(sent[1]!, /first change/);
    assert.match(sent[2]!, /second change/);
  } finally { release(); await f.close(); }
});

test("a current process tree cannot prove orphan absence and preserves Codex infrastructure", { skip: process.platform !== "win32" }, async () => {
  const executable = "C:\\Users\\Cx\\AppData\\Local\\OpenAI\\Codex\\bin\\build\\codex.exe";
  const client: HerdrClient = { async run() { return JSON.stringify({ result: { process_info: { pane_id: helper.paneId, foreground_processes: [{ pid: 9336, argv0: executable }] } } }); } };
  const processes = helperProcesses(client, async () => [
    { pid: 9336, parentPid: 12964, started: "root", command: "codex", executable, name: "codex.exe" },
    { pid: 14548, parentPid: 9336, started: "infra", command: "node cua-repl.mjs", executable: "C:\\Users\\Cx\\AppData\\Local\\OpenAI\\Codex\\runtimes\\cua_node\\node.exe", name: "node.exe" },
    { pid: 792, parentPid: 14548, started: "infra-child", command: "node_repl", executable: "C:\\runtime\\node_repl.exe", name: "node_repl.exe" },
    { pid: 34028, parentPid: 792, started: "infra-console", command: "conhost", executable: "C:\\Windows\\conhost.exe", name: "conhost.exe" },
    { pid: 37608, parentPid: 9336, started: "host", command: "codex-code-mode-host", executable: "C:\\Users\\Cx\\AppData\\Local\\OpenAI\\Codex\\bin\\build\\codex-code-mode-host.exe", name: "codex-code-mode-host.exe" },
    { pid: 40000, parentPid: 37608, started: "active-task", command: "node active-task.js", executable: "C:\\Program Files\\nodejs\\node.exe", name: "node.exe" },
    { pid: 35000, parentPid: 30348, started: "orphan", command: "node heartbeat.cjs", executable: "C:\\Program Files\\nodejs\\node.exe", name: "node.exe" },
  ]);
  const inspected = await processes.inspect(helper);
  assert.equal(inspected.complete, false, "the missing historical shell prevents proof of complete task ownership");
  assert.deepEqual(inspected.processes.map((entry) => entry.pid), [40000]);
  assert.match(inspected.evidence.join("\n"), /孤儿|orphan/);
});
