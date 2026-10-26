import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { posix } from "node:path";

// Repository rules cheap enough to enforce in code instead of in instructions.
const files = execFileSync("git", ["ls-files", "-z"], { encoding: "utf8" }).split("\0").filter((f) => f && existsSync(f));
const problems = [];

// 1. Tracked text files carry no raw control characters; an escaped "\b" written as a
//    literal backspace silently changes a regex.
const text = /\.(?:[cm]?[jt]sx?|json|md|ya?ml|sh|css|html|txt)$/i;
for (const file of files.filter((f) => text.test(f))) {
  readFileSync(file, "utf8").split("\n").forEach((line, i) => {
    const m = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.exec(line);
    if (m) problems.push(`${file}:${i + 1}: control character U+${m[0].charCodeAt(0).toString(16).toUpperCase().padStart(4, "0")}`);
  });
}

// 2. Every ADR declares a status, and accepted ADRs appear in the index agents read
//    to choose live decisions (AGENTS.md "Domain docs").
const indexPath = "docs/adr/README.md";
const index = existsSync(indexPath) ? readFileSync(indexPath, "utf8") : "";
for (const file of files.filter((f) => /^docs\/adr\/\d{4}-[^/]+\.md$/.test(f))) {
  const name = file.slice("docs/adr/".length);
  const status = /^---\r?\n(?:.*\r?\n)*?status:\s*(\S+)\s*\r?\n(?:.*\r?\n)*?---/.exec(readFileSync(file, "utf8"))?.[1];
  if (!status) problems.push(`${file}: missing status front matter`);
  else if (status === "accepted" && !index.includes(`(${name})`)) problems.push(`${indexPath}: ${name} is accepted but not listed`);
}

// 3. Top-level modules retired by ADR-0014 (src/host, src/personal, src/memory,
//    src/pi-agent.ts) stay retired: no current code imports them back.
const retired = /^src\/(?:(?:host|personal|memory)\/|pi-agent(?:\.[jt]s)?$)/;
const specifier = /\b(?:from|import)\s*\(?\s*["']([^"']+)["']/g;
for (const file of files.filter((f) => /^(?:src|test|scripts)\/.+\.[cm]?[jt]s$/.test(f))) {
  readFileSync(file, "utf8").split("\n").forEach((line, i) => {
    for (const [, spec] of line.matchAll(specifier)) {
      if (!spec.startsWith(".")) continue;
      const target = posix.normalize(posix.join(posix.dirname(file), spec));
      if (retired.test(target)) problems.push(`${file}:${i + 1}: imports retired module ${spec} (docs/adr/0014-retire-legacy-code-and-data.md)`);
    }
  });
}

if (problems.length) {
  console.error(problems.join("\n"));
  process.exit(1);
}
console.log(`Hygiene checks passed for ${files.length} tracked files.`);
