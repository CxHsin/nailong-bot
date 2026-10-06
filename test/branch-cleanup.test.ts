import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const script = resolve("scripts/clean-branches.mjs");
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "branch-cleanup-"));
  const remote = join(root, "remote.git");
  const repo = join(root, "repo");
  const run = (cwd: string, ...args: string[]) => execFileSync("git", args, {
    cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
  }).trim();
  run(root, "init", "--bare", remote);
  run(root, "init", "-b", "main", repo);
  const git = (...args: string[]) => run(repo, ...args);
  git("config", "user.name", "Test");
  git("config", "user.email", "test@example.invalid");
  git("commit", "--allow-empty", "-m", "initial");
  git("remote", "add", "origin", remote);
  git("branch", "development");
  git("branch", "feat/merged");
  git("push", "origin", "main", "development", "feat/merged");
  // Reproduce origin/HEAD, which caused the session's cleanup failure.
  run(root, "--git-dir", remote, "symbolic-ref", "HEAD", "refs/heads/main");
  git("remote", "set-head", "origin", "--auto");
  const clean = (...args: string[]) => spawnSync(process.execPath, [script, ...args], { cwd: repo, encoding: "utf8" });
  return { root, repo, git, clean };
}

test("branch cleanup previews then removes merged local and remote branches while retaining protected refs", () => {
  const f = fixture();
  try {
    const preview = f.clean();
    assert.equal(preview.status, 0, preview.stderr);
    assert.match(preview.stdout, /PREVIEW refs\/remotes\/origin\/feat\/merged/);
    assert.doesNotMatch(preview.stdout, /PREVIEW refs\/remotes\/origin\/HEAD/);
    assert.equal(f.git("branch", "--list", "feat/merged").trim(), "feat/merged");
    const result = f.clean("--apply");
    assert.equal(result.status, 0, result.stderr);
    assert.equal(f.git("for-each-ref", "--format=%(refname)", "refs/heads"), "refs/heads/development\nrefs/heads/main");
    const remote = f.git("ls-remote", "--heads", "origin");
    assert.match(remote, /refs\/heads\/development/);
    assert.match(remote, /refs\/heads\/main/);
    assert.doesNotMatch(remote, /feat\/merged/);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("an unmerged branch stops the whole cleanup before any deletion", () => {
  const f = fixture();
  try {
    f.git("switch", "-c", "feat/unmerged");
    f.git("commit", "--allow-empty", "-m", "unmerged");
    f.git("push", "origin", "feat/unmerged");
    f.git("switch", "main");
    const result = f.clean("--apply");
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Refusing to delete unmerged branch/);
    assert.match(f.git("ls-remote", "--heads", "origin"), /feat\/merged/);
    assert.match(f.git("branch", "--list"), /feat\/merged/);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("a branch checked out in another worktree stops the whole cleanup", () => {
  const f = fixture();
  try {
    f.git("worktree", "add", join(f.root, "linked"), "feat/merged");
    const result = f.clean("--apply");
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /checked out in a worktree/);
    assert.match(f.git("ls-remote", "--heads", "origin"), /feat\/merged/);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});
