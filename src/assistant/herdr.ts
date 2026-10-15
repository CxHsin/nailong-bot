import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile } from "node:fs/promises";
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
        throw new Error(parsed.error.message ?? JSON.stringify(parsed.error));
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
};
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
) {
  return defineTool({
    name: "herdr_watch",
    description: "Observe an already dispatched helper after confirming receipt. Never launches it; idle/done requires result inspection.",
    parameters: Type.Object({session: Type.String(),agent: Type.String(),paneId: Type.String(),workspaceId: Type.String(),cwd: Type.String(),promptPath: Type.String()}),
    replay: "unsafe",
    async execute(args, api) {
      await readFile(resolve(args.promptPath), "utf8");
      const state = await inspectHelper(client,args);
      if (state.launchPending || state.status === "unknown") throw new Error("帮手接收状态未知；先查询和读回，不重复派发");
      if (!records.some((record)=>record.session===args.session&&record.agent===args.agent&&!record.delivered)) {
        records.push({...args,cwd:resolve(args.cwd),promptPath:resolve(args.promptPath),id:api.callId,sequence:state.sequence});
        await save();
      }
      return {output:[{type:"text",text:"已保存帮手身份并在后台观察；现在可继续交流。idle/done 只触发成果核对。"}]};
    },
  });
}
