import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

test("document link check resolves Markdown targets and fails on a retired file", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "nailong-doc-links-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  execFileSync("git", ["init", "-b", "development"], { cwd: dir, stdio: "pipe" });
  await mkdir(join(dir, "docs"));
  await writeFile(join(dir, "docs", "target file.md"), "# Target\n");
  await writeFile(join(dir, "docs", "image.svg"), "<svg/>\n");
  const source = [
    "[relative](docs/target%20file.md#target)",
    "[reference][target]",
    "[target]: <docs/target file.md>",
    "![image](docs/image.svg)",
    "[root](/docs/target%20file.md)",
    "[web](https://example.com/absent.md)",
    "[skill](C:/not-on-ci/SKILL.md)",
    "[anchor](#heading)",
    "`[inline example](absent.md)`",
    "```md", "[code example](absent.md)", "```",
  ].join("\n\n");
  await writeFile(join(dir, "README.md"), source);
  // Scratch documents are not normative repository inputs.
  await writeFile(join(dir, "scratch.md"), "[scratch](absent.md)");
  execFileSync("git", ["add", "README.md", "docs"], { cwd: dir, stdio: "pipe" });
  const check = () => spawnSync(process.execPath, [resolve("scripts/check-doc-links.mjs")], { cwd: dir, encoding: "utf8" });
  const valid = check();
  assert.equal(valid.status, 0, valid.stderr);
  assert.match(valid.stdout, /Checked 4 local links/);
  await rm(join(dir, "docs", "target file.md"));
  execFileSync("git", ["add", "-u"], { cwd: dir, stdio: "pipe" });
  const retired = check();
  assert.notEqual(retired.status, 0);
  assert.match(retired.stderr, /README\.md: missing target: docs\/target%20file\.md#target/);
  await writeFile(join(dir, "docs", "target file.md"), "Restored, but not staged.\n");
  const untracked = check();
  assert.notEqual(untracked.status, 0);
  assert.match(untracked.stderr, /untracked target/);
});
