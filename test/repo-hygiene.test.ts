import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

const adr = (status: string) => `---\nstatus: ${status}\n---\n\n# ADR\n`;

test("repository hygiene check enforces ADR index, retired imports and control characters", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "nailong-hygiene-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  execFileSync("git", ["init", "-b", "main"], { cwd: dir, stdio: "pipe" });
  await mkdir(join(dir, "docs", "adr"), { recursive: true });
  await mkdir(join(dir, "src", "assistant"), { recursive: true });
  await writeFile(join(dir, "docs", "adr", "0001-old.md"), adr("superseded"));
  await writeFile(join(dir, "docs", "adr", "0002-live.md"), adr("accepted"));
  await writeFile(join(dir, "docs", "adr", "README.md"), "| [0002](0002-live.md) |\n");
  // A nested module that happens to be named memory/ is not the retired src/memory.
  await writeFile(join(dir, "src", "main.ts"), 'import { x } from "./assistant/memory/service.js";\n');
  execFileSync("git", ["add", "."], { cwd: dir, stdio: "pipe" });
  const check = () => spawnSync(process.execPath, [resolve("scripts/check-hygiene.mjs")], { cwd: dir, encoding: "utf8" });

  const valid = check();
  assert.equal(valid.status, 0, valid.stderr);

  await writeFile(join(dir, "docs", "adr", "0003-new.md"), adr("accepted"));
  await writeFile(join(dir, "docs", "adr", "0004-bare.md"), "# No status\n");
  await writeFile(join(dir, "src", "main.ts"), 'import { x } from "./host/legacy.js";\n');
  await writeFile(join(dir, "src", "assistant", "a.ts"), 'const y = await import("../memory/graph.js");\n');
  // "\b" here is a literal backspace, the mistake the check exists for.
  await writeFile(join(dir, "src", "bad.ts"), "const re = /a\bb/;\n");
  execFileSync("git", ["add", "."], { cwd: dir, stdio: "pipe" });
  const failed = check();
  assert.notEqual(failed.status, 0);
  assert.match(failed.stderr, /0003-new\.md is accepted but not listed/);
  assert.match(failed.stderr, /0004-bare\.md: missing status front matter/);
  assert.match(failed.stderr, /src\/main\.ts:1: imports retired module \.\/host\/legacy\.js/);
  assert.match(failed.stderr, /src\/assistant\/a\.ts:1: imports retired module \.\.\/memory\/graph\.js/);
  assert.match(failed.stderr, /src\/bad\.ts:1: control character U\+0008/);
});
