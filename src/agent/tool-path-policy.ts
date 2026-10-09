import { realpath, lstat, stat } from "node:fs/promises";
import { dirname, resolve, relative, isAbsolute } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

// Keep normal file tools available outside the bot workspace, while protecting
// program resources and persistent runtime/configuration storage from mutation.
async function physicalPath(path: string): Promise<string> {
  let current = resolve(path);
  const suffix: string[] = [];
  for (;;) {
    try { return resolve(await realpath(current), ...suffix.reverse()); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      try { await lstat(current); throw new Error("文件路径包含无法解析的链接"); }
      catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
      const parent = dirname(current);
      if (parent === current) throw error;
      suffix.push(current.slice(parent.length).replace(/^[\\/]+/, "")); current = parent;
    }
  }
}
function inside(root: string, path: string) {
  const part = relative(root, path);
  return !part || (!part.startsWith("..") && !isAbsolute(part));
}
export async function createToolPathPolicy(dataDir: string, promptFile: string) {
  const data = await physicalPath(dataDir);
  const program = await physicalPath(resolve(dirname(fileURLToPath(import.meta.url)), ".."));
  const application = dirname(program);
  const prompt = await physicalPath(promptFile);
  return async (tool: string, args: Record<string, unknown>) => {
    if (tool !== "write" && tool !== "edit") return;
    if (typeof args.path !== "string") return;
    // Normalize once and pass the exact checked absolute path to pi as well.
    let input = args.path.replace(/^@/, "").replace(/[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g, " ");
    if (input === "~") input = homedir();
    else if (input.startsWith("~/")) input = homedir() + input.slice(1);
    const resolved = resolve(dataDir, input);
    const target = await physicalPath(resolved);
    args.path = resolved;
    try {
      if ((await stat(target)).nlink > 1) throw new Error("不能通过普通工具修改具有硬链接别名的文件");
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    const part = relative(data, target).replaceAll("\\", "/").toLowerCase();
    const protectedData = ["events.jsonl", "auth.json", "runtime.sqlite", "runtime.sqlite-wal", "runtime.sqlite-shm"];
    if ((inside(application, target) && !inside(data, target)) || inside(program, target) || target.toLowerCase() === prompt.toLowerCase() ||
      protectedData.includes(part) || /^(checkpoints|tool-results|skills|context-projections)(\/|$)/.test(part) ||
      (inside(data, target) && /\.(sqlite|sqlite3|db)(-wal|-shm)?$/i.test(part)))
      throw new Error("该路径属于受保护的程序或运行配置，不能通过普通工具修改");
  };
}
