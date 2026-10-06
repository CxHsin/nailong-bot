import { execFileSync } from "node:child_process";

const apply = process.argv.slice(2).includes("--apply");
if (process.argv.slice(2).some((arg) => arg !== "--apply")) {
  throw new Error("Usage: node scripts/clean-branches.mjs [--apply]");
}
const git = (...args) => execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const lines = (value) => value.split(/\r?\n/).filter(Boolean);
const kept = new Set(["main", "development"]);
git("fetch", "origin", "--prune");
const base = "refs/remotes/origin/main";
git("rev-parse", "--verify", base);
const current = git("symbolic-ref", "--quiet", "HEAD");
if (!["refs/heads/main", "refs/heads/development"].includes(current)) {
  throw new Error("Switch to main or development before cleaning branches.");
}
const occupied = new Set(lines(git("worktree", "list", "--porcelain"))
  .filter((line) => line.startsWith("branch ")).map((line) => line.slice(7)));
const plan = [];
for (const [prefix, remote] of [["refs/heads/", false], ["refs/remotes/origin/", true]]) {
  for (const row of lines(git("for-each-ref", "--format=%(refname) %(symref)", prefix))) {
    const [ref, symbolic] = row.split(" ");
    const name = ref.slice(prefix.length);
    if (symbolic || name === "HEAD" || kept.has(name)) continue;
    // Compare against the fetched main, never an outdated local branch.
    try { git("merge-base", "--is-ancestor", ref, base); }
    catch { throw new Error(`Refusing to delete unmerged branch: ${ref}`); }
    if (!remote && occupied.has(ref)) throw new Error(`Branch is checked out in a worktree: ${ref}`);
    plan.push({ ref, name, remote, oid: git("rev-parse", ref) });
  }
}
for (const item of plan) console.log(`${apply ? "DELETE" : "PREVIEW"} ${item.ref} (${item.oid})`);
if (!apply) {
  console.log("Preview only. Run with --apply to delete the listed merged branches.");
} else {
  const remote = plan.filter((item) => item.remote);
  if (remote.length) {
    // Leases reject remote changes made after fetch; atomic push prevents partial deletion.
    git("push", "--atomic", ...remote.map((item) => `--force-with-lease=refs/heads/${item.name}:${item.oid}`),
      "origin", ...remote.map((item) => `:refs/heads/${item.name}`));
  }
  for (const item of plan.filter((item) => !item.remote)) {
    if (git("rev-parse", item.ref) !== item.oid) throw new Error(`Branch changed during cleanup: ${item.ref}`);
    git("branch", "-d", "--", item.name);
  }
  console.log("Cleanup complete; main and development retained.");
}
