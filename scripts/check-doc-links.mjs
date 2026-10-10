import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { marked } from "marked";

// Git's tracked paths keep private scratch material outside this check.
const files = execFileSync("git", ["ls-files", "-z"], { encoding: "utf8" }).split("\0").filter(Boolean);
const documents = files.filter((file) => /\.md$/i.test(file));
const tracked = new Set(files);
let checked = 0;
const failures = [];
for (const file of documents) {
  const tokens = marked.lexer(readFileSync(file, "utf8"));
  marked.walkTokens(tokens, (token) => {
    if (token.type !== "link" && token.type !== "image") return;
    const href = token.href;
    // URLs and environment-owned absolute paths (for example C:/.../SKILL.md)
    // have no portable repository target. Fragment-only links need no file lookup.
    if (!href || href.startsWith("#") || /^[a-z][a-z\d+.-]*:/i.test(href) || href.startsWith("//")) return;
    let target;
    try { target = decodeURIComponent(href.split(/[?#]/, 1)[0]); }
    catch { failures.push(`${file}: invalid URL encoding: ${href}`); return; }
    const path = target.startsWith("/") ? resolve(`.${target}`) : resolve(dirname(file), target);
    const repositoryPath = relative(process.cwd(), path).replaceAll("\\", "/");
    checked++;
    if (!existsSync(path)) failures.push(`${file}: missing target: ${href}`);
    else if (!tracked.has(repositoryPath) && !files.some((file) => file.startsWith(`${repositoryPath}/`)))
      failures.push(`${file}: untracked target: ${href}`);
  });
}
if (failures.length) {
  console.error(failures.join("\n"));
  process.exitCode = 1;
} else console.log(`Checked ${checked} local links in ${documents.length} tracked Markdown documents.`);
