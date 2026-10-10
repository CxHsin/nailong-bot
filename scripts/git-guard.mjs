import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const action = process.argv[2];
try {
  if (action === "commit") {
    const branch = execFileSync("git", ["symbolic-ref", "--quiet", "HEAD"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
    if (branch !== "refs/heads/development") throw new Error("Commit on development; switch branches before committing.");
  } else if (action === "push") {
    for (const line of readFileSync(0, "utf8").split(/\r?\n/).filter(Boolean)) {
      const fields = line.trim().split(/\s+/);
      if (fields.length !== 4) throw new Error("Invalid pre-push input.");
      if (fields[2] === "refs/heads/main") throw new Error("main is protected: merge through a reviewed PR.");
    }
  } else throw new Error("Usage: git-guard.mjs commit|push");
} catch (error) {
  console.error(error instanceof Error && error.message.startsWith("Command failed") ? "Commit on development; detached HEAD cannot commit." : error.message);
  process.exitCode = 1;
}
