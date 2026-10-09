import { resolve } from "node:path";
import { diagnoseRun } from "./run-diagnostics.js";

try {
  const args = process.argv.slice(2); const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index]!; const value = args[index + 1];
    if (!["--data-dir", "--run-id"].includes(key) || !value || values.has(key)) throw new Error("参数无效");
    values.set(key, value);
  }
  const runId = values.get("--run-id"); if (!runId) throw new Error("缺少 --run-id");
  console.log(JSON.stringify(diagnoseRun({ dataDir: resolve(values.get("--data-dir") ?? "data"), runId }), null, 2));
} catch {
  console.error("运行诊断失败。用法：npm run run:diagnose -- --run-id ID [--data-dir data]；请核对参数、Run 和只读数据库。");
  process.exitCode = 1;
}
