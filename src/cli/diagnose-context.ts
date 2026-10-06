import { resolve } from "node:path";
import { diagnoseContext } from "./context-diagnostics.js";

async function main() {
  const args = process.argv.slice(2);
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index]!; const value = args[index + 1];
    if (!["--data-dir", "--conversation-id", "--request-id", "--context-window"].includes(key) || !value)
      throw new Error("用法：npm run context:diagnose -- --conversation-id ID [--data-dir data] [--request-id ID] [--context-window 128000]");
    values.set(key, value);
  }
  const conversationId = values.get("--conversation-id");
  if (!conversationId) throw new Error("需要 --conversation-id");
  const contextWindow = values.has("--context-window") ? Number(values.get("--context-window")) : undefined;
  if (contextWindow !== undefined && (!Number.isSafeInteger(contextWindow) || contextWindow < 1024)) throw new Error("上下文窗口必须是至少 1024 的整数");
  console.log(JSON.stringify(await diagnoseContext({ dataDir: resolve(values.get("--data-dir") ?? "data"), conversationId,
    requestId: values.get("--request-id"), contextWindow }), null, 2));
}
main().catch(() => { console.error("上下文诊断失败：请核对参数、Conversation、只读数据库和工具归档；不会调用模型或修复生产文件。"); process.exitCode = 1; });
