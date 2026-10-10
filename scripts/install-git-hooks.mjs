import { execFileSync } from "node:child_process";
import { accessSync, chmodSync } from "node:fs";
import { join } from "node:path";

const git = (...args) => execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const root = git("rev-parse", "--show-toplevel");
let current;
try { current = git("config", "--get", "core.hooksPath"); } catch (error) { if (error.status !== 1) throw error; }
if (current && current !== ".githooks") throw new Error("Existing core.hooksPath detected; integrate the branch guards with your hooks before installing.");
for (const name of ["pre-commit", "pre-push"]) {
  const path = join(root, ".githooks", name);
  accessSync(path); chmodSync(path, 0o755);
}
git("config", "--local", "core.hooksPath", ".githooks");
console.log("Installed development commit guard and main push guard.");
