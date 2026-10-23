import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

const action = process.argv[2];
try {
  if (action === "commit") {
    let branch;
    try {
      branch = execFileSync("git", ["symbolic-ref", "--quiet", "HEAD"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
    } catch (error) {
      if (error.status === 1) throw new Error("Detached HEAD cannot commit; switch to a task branch.");
      throw error;
    }
    if (branch === "refs/heads/main") throw new Error("main is protected: commit on a task branch and merge through a reviewed PR.");
    const check = spawnSync("git", ["diff", "--cached", "--check"], { encoding: "utf8" });
    if (check.error || check.status !== 0)
      throw new Error(`Staged whitespace check failed. Fix the index before committing.\n${check.stdout ?? ""}${check.stderr ?? ""}${check.error?.message ?? ""}`);
  } else if (action === "push") {
    for (const line of readFileSync(0, "utf8").split(/\r?\n/).filter(Boolean)) {
      const fields = line.trim().split(/\s+/);
      if (fields.length !== 4) throw new Error("Invalid pre-push input.");
      if (fields[2] === "refs/heads/main") throw new Error("main is protected: merge through a reviewed PR.");
    }
  } else throw new Error("Usage: git-guard.mjs commit|push");
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
