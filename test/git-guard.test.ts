import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile, cp, mkdir, copyFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

test("installed hooks reject main commits and protected remote refs even when pushed from development", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "nailong-git-guard-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const repo = join(dir, "repo"); const remote = join(dir, "remote.git");
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  await cp(resolve(".githooks"), join(repo, ".githooks"), { recursive: true });
  await mkdir(join(repo, "scripts"));
  for (const name of ["install-git-hooks.mjs", "git-guard.mjs"]) {
    await copyFile(resolve("scripts", name), join(repo, "scripts", name));
  }
  git("init", "-b", "development"); git("config", "user.name", "Fixture"); git("config", "user.email", "fixture@example.com");
  execFileSync(process.execPath, ["scripts/install-git-hooks.mjs"], { cwd: repo });
  assert.equal(git("config", "--local", "core.hooksPath"), ".githooks");
  await writeFile(join(repo, "file.txt"), "one"); git("add", "."); git("commit", "-m", "test(agent): fixture");
  const initial = git("rev-parse", "HEAD");
  await writeFile(join(repo, "new.txt"), "new line with trailing space \n"); git("add", "new.txt");
  const whitespace = spawnSync("git", ["commit", "-m", "test(agent): whitespace blocked"], { cwd: repo, encoding: "utf8" });
  assert.notEqual(whitespace.status, 0);
  assert.match(whitespace.stderr, /Staged whitespace check failed/);
  assert.match(whitespace.stderr, /new\.txt:1: trailing whitespace/);
  assert.equal(git("rev-parse", "HEAD"), initial);
  // Correcting only the working tree must still fail: the hook checks the index.
  await writeFile(join(repo, "new.txt"), "new line without trailing space\n");
  const unstagedFix = spawnSync("git", ["commit", "-m", "test(agent): index still dirty"], { cwd: repo, encoding: "utf8" });
  assert.notEqual(unstagedFix.status, 0);
  git("add", "new.txt"); git("commit", "-m", "test(agent): corrected index");
  execFileSync("git", ["init", "--bare", remote], { stdio: "pipe" }); git("remote", "add", "origin", remote);
  git("push", "origin", "HEAD:development");
  for (const ref of ["HEAD:main", ":main"]) {
    const push = spawnSync("git", ["push", "origin", ref], { cwd: repo, encoding: "utf8" });
    assert.notEqual(push.status, 0); assert.match(push.stderr, /protected|main/);
  }
  git("switch", "-c", "main");
  const commit = spawnSync("git", ["commit", "--allow-empty", "-m", "test(agent): blocked"], { cwd: repo, encoding: "utf8" });
  assert.notEqual(commit.status, 0); assert.match(commit.stderr, /main is protected/);
  assert.equal(git("rev-parse", "HEAD"), git("rev-parse", "development"));
  git("switch", "--detach");
  const detached = spawnSync("git", ["commit", "--allow-empty", "-m", "test(agent): blocked"], { cwd: repo, encoding: "utf8" });
  assert.notEqual(detached.status, 0); assert.match(detached.stderr, /Detached HEAD cannot commit/);
  git("config", "--local", "core.hooksPath", "existing-hooks");
  const install = spawnSync(process.execPath, ["scripts/install-git-hooks.mjs"], { cwd: repo, encoding: "utf8" });
  assert.notEqual(install.status, 0); assert.equal(git("config", "--local", "core.hooksPath"), "existing-hooks");
});

test("task worktree commits stay isolated from main and retain protected remote refs", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "nailong-task-worktree-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const repo = join(dir, "repo"); const remote = join(dir, "remote.git"); const task = join(dir, "task");
  const gitAt = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  const git = (...args: string[]) => gitAt(repo, ...args);
  await cp(resolve(".githooks"), join(repo, ".githooks"), { recursive: true });
  await mkdir(join(repo, "scripts"));
  for (const name of ["install-git-hooks.mjs", "git-guard.mjs"]) {
    await copyFile(resolve("scripts", name), join(repo, "scripts", name));
  }
  git("init", "-b", "main"); git("config", "user.name", "Fixture"); git("config", "user.email", "fixture@example.com");
  await writeFile(join(repo, "file.txt"), "baseline\n");
  git("add", "."); git("commit", "-m", "test(git): baseline before installing guards");
  const baseline = git("rev-parse", "HEAD");
  execFileSync("git", ["init", "--bare", remote], { stdio: "pipe" });
  git("remote", "add", "origin", remote); git("push", "origin", "HEAD:main");
  execFileSync(process.execPath, ["scripts/install-git-hooks.mjs"], { cwd: repo });
  git("worktree", "add", "-b", "fix/297-task", task, "main");
  await writeFile(join(task, "file.txt"), "task change\n");
  gitAt(task, "add", "file.txt"); gitAt(task, "commit", "-m", "fix(git): isolated task change");
  assert.notEqual(gitAt(task, "rev-parse", "HEAD"), baseline);
  assert.equal(git("rev-parse", "HEAD"), baseline);
  assert.equal(git("status", "--porcelain"), "");
  gitAt(task, "push", "origin", "HEAD:fix/297-task");
  for (const ref of ["HEAD:main", ":main"]) {
    const push = spawnSync("git", ["push", "origin", ref], { cwd: task, encoding: "utf8" });
    assert.notEqual(push.status, 0); assert.match(push.stderr, /main is protected/);
  }
  assert.equal(git("--git-dir", remote, "rev-parse", "refs/heads/main"), baseline);
});
