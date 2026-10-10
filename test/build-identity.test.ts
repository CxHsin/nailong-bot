import assert from "node:assert/strict";
import test from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { readArtifactIdentity, sourceBuildIdentity } from "../src/runtime/build-identity.js";
import { createAgentHost } from "../src/application/agent-host.js";
import { createRuntimeEventLog } from "../src/runtime/event-log.js";
import { diagnoseRun } from "../src/cli/run-diagnostics.js";

const exec = promisify(execFile);
test("artifact identity survives checkout changes and missing stamps remain unknown", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "build-stamp-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const git = (...args: string[]) => exec("git", args, { cwd: root });
  await git("init"); await writeFile(join(root, "source.txt"), "one"); await git("add", "source.txt");
  await git("-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "test: first");
  const first = await sourceBuildIdentity(root); assert.equal(first.trackedDirty, false); assert.ok(first.gitSha);
  await mkdir(join(root, "dist"));
  const artifact = { ...first, mode: "build", builtAt: "2026-10-10T00:00:00.000Z" };
  await writeFile(join(root, "dist", "build-info.json"), JSON.stringify(artifact));
  await writeFile(join(root, "source.txt"), "two"); assert.equal((await sourceBuildIdentity(root)).trackedDirty, true);
  await git("add", "source.txt");
  await git("-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "test: second");
  assert.notEqual((await sourceBuildIdentity(root)).gitSha, first.gitSha);
  assert.deepEqual(await readArtifactIdentity(root), artifact);
  await writeFile(join(root, "dist", "build-info.json"), "bad stamp");
  assert.deepEqual(await readArtifactIdentity(root), { mode: "build", gitSha: null, trackedDirty: null, builtAt: null });
});

test("Host records the process identity per Run without adding it to model history", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "host-identity-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const log = await createRuntimeEventLog(dir);
  const identity = { mode: "source" as const, gitSha: "a".repeat(40), trackedDirty: false, builtAt: null };
  const host = createAgentHost({ dataDir: dir, promptFile: join(dir, "prompt.md"), log, runtimeIdentity: identity,
    agent: { answer: async (messages) => { assert.doesNotMatch(JSON.stringify(messages), /gitSha|runtime_identity/); return "answer"; } } });
  const run = host.submit({ actor: { id: "owner" }, conversationId: "c", text: "test" });
  assert.equal((await run.done).type, "run_succeeded");
  assert.deepEqual(diagnoseRun({ dataDir: dir, runId: run.runId }).runtimeIdentity, identity);
});
