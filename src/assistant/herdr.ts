import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { access, open } from "node:fs/promises";
import { resolve } from "node:path";
import { Type } from "typebox";
import { defineTool } from "@earendil-works/pi-durable";

export interface HerdrClient {
  run(session: string, args: string[]): Promise<string>;
}
export const herdrClient: HerdrClient = {
  async run(session, args) {
    const result = await promisify(execFile)(
      "herdr",
      ["--session", session, ...args],
      { windowsHide: true, timeout: 35_000, maxBuffer: 2 * 1024 * 1024 },
    );
    // Some CLI errors are JSON envelopes even when the process exit code is zero.
    try {
      const parsed = JSON.parse(result.stdout);
      if (parsed.error)
        throw Object.assign(new Error(parsed.error.message ?? JSON.stringify(parsed.error)), { code: parsed.error.code });
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
    }
    return result.stdout;
  },
};
export type HelperRecord = {
  id: string;
  session: string;
  agent: string;
  paneId: string;
  workspaceId: string;
  cwd: string;
  promptPath: string;
  sequence: number;
  notice?: string;
  delivered?: boolean;
  targetIds?: string[];
  summary?: string;
};
export type HelperTargetContext = { targetIds: string[]; summary?: string };
const shortSummary = (text: string) => Array.from(text.trim()).slice(0, 512).join("");

/** Legacy helpers may supply bounded material, but never gain an invented target association. */
export async function helperSummary(record: Pick<HelperRecord, "summary" | "promptPath">): Promise<string> {
  if (record.summary?.trim()) return shortSummary(record.summary);
  let file: Awaited<ReturnType<typeof open>> | undefined;
  try {
    file = await open(resolve(record.promptPath), "r");
    const buffer = Buffer.alloc(4096);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    return shortSummary(buffer.subarray(0, bytesRead).toString("utf8")) || "信息不足：原交办摘要缺失";
  } catch { return "信息不足：无法读取原交办摘要"; }
  finally { await file?.close(); }
}
export async function inspectHelper(
  client: HerdrClient,
  record: Pick<
    HelperRecord,
    "session" | "agent" | "paneId" | "workspaceId" | "cwd"
  >,
) {
  const reply = JSON.parse(
    await client.run(record.session, ["agent", "get", record.agent]),
  );
  if (reply.error) throw new Error(reply.error.message);
  const agent = reply.result?.agent;
  const pathKey = (path: string) =>
    process.platform === "win32" ? resolve(path).toLowerCase() : resolve(path);
  if (
    !agent ||
    agent.name !== record.agent ||
    agent.pane_id !== record.paneId ||
    agent.workspace_id !== record.workspaceId ||
    typeof agent.cwd !== "string" ||
    pathKey(agent.cwd) !== pathKey(record.cwd)
  )
    throw new Error("herdr 帮手身份或目录不匹配；保留现场核对");
  const status = String(agent.agent_status);
  if (!["idle", "done", "working", "blocked", "unknown"].includes(status))
    throw new Error("无法识别 herdr 状态；保留现场核对");
  return {
    status,
    sequence: Number(agent.state_change_seq ?? 0),
    launchPending: !!agent.launch_pending,
  };
}

/** Observes an already dispatched helper; never starts or restarts external work. */
export function durableHerdrWatch(
  client: HerdrClient,
  records: HelperRecord[],
  save: () => Promise<void>,
  targetContext?: () => HelperTargetContext | undefined | Promise<HelperTargetContext | undefined>,
) {
  return defineTool({
    name: "herdr_watch",
    description: "Observe an already dispatched helper after confirming receipt. Never launches it; idle/done requires result inspection.",
    parameters: Type.Object({session: Type.String(),agent: Type.String(),paneId: Type.String(),workspaceId: Type.String(),cwd: Type.String(),promptPath: Type.String(),targetIds: Type.Optional(Type.Array(Type.String(), { minItems: 1 })),summary: Type.Optional(Type.String({ minLength: 1 }))}),
    replay: "unsafe",
    async execute(args, api) {
      await access(resolve(args.promptPath));
      const context = await targetContext?.();
      if (!args.targetIds && context && context.targetIds.length !== 1)
        throw new Error("当前轮次包含多个目标；登记帮手须明确 targetIds，不能默认绑定整批");
      const targetIds = args.targetIds ?? context?.targetIds;
      if (args.targetIds && context && args.targetIds.some((target) => !context.targetIds.includes(target)))
        throw new Error("帮手目标不属于当前交办；保留现场核对");
      const summary = await helperSummary({ promptPath: args.promptPath, summary: args.summary ?? context?.summary });
      const state = await inspectHelper(client,args);
      if (state.launchPending || state.status === "unknown") throw new Error("帮手接收状态未知；先查询和读回，不重复派发");
      if (!records.some((record)=>record.session===args.session&&record.agent===args.agent&&!record.delivered)) {
        records.push({...args,targetIds:targetIds ? [...new Set(targetIds)] : undefined,summary,cwd:resolve(args.cwd),promptPath:resolve(args.promptPath),id:api.callId,sequence:state.sequence});
        await save();
      }
      return {output:[{type:"text",text:"已保存帮手身份并在后台观察；现在可继续交流。idle/done 只触发成果核对。"}]};
    },
  });
}
