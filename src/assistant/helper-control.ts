import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { win32 } from "node:path";
import { inspectHelper, type HelperRecord, type HerdrClient } from "./herdr.js";

export type HelperControlAction = { id: string; kind: "supplement" | "cancel"; target: string; text: string };
export type HelperControlRecord = HelperControlAction & {
  helperId: string;
  state: "pending" | "sending" | "sent" | "adopted" | "unknown" | "rejected" | "stopped" | "settled";
  evidence: string[];
  processes?: HelperProcess[];
};
export type HelperProcess = { pid: number; started: string; command: string };
export type WindowsHelperProcess = HelperProcess & { parentPid: number; executable: string; name: string };
export type HelperProcessInspection = { complete: boolean; processes: HelperProcess[]; evidence: string[] };
export interface HelperProcesses {
  inspect(helper: HelperRecord): Promise<HelperProcessInspection>;
  stop(process: HelperProcess): Promise<void>;
}
export type HelperControlOptions = {
  client: HerdrClient;
  load(conversation: string, id: string): Promise<HelperControlRecord | undefined> | HelperControlRecord | undefined;
  save(conversation: string, record: HelperControlRecord): Promise<void> | void;
  processes?: HelperProcesses;
};

async function powershell(script: string) {
  const result = await promisify(execFile)("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], { windowsHide: true, timeout: 15_000, maxBuffer: 2 * 1024 * 1024 });
  return JSON.parse(result.stdout.trim() || "[]");
}

/** Inspect the actual helper process tree; never infer ownership from a name alone. */
export function helperProcesses(client: HerdrClient, snapshot: () => Promise<WindowsHelperProcess[]> = () => powershell("$ErrorActionPreference='Stop'; ConvertTo-Json -Compress -InputObject @(Get-CimInstance Win32_Process | ForEach-Object {@{pid=[int]$_.ProcessId; parentPid=[int]$_.ParentProcessId; started=$_.CreationDate.ToUniversalTime().ToString('o'); command=[string]$_.CommandLine; executable=[string]$_.ExecutablePath; name=[string]$_.Name}})")): HelperProcesses {
  return {
    async inspect(helper) {
      const reply = JSON.parse(await client.run(helper.session, ["pane", "process-info", "--pane", helper.paneId]));
      const info = reply.result?.process_info;
      const roots: number[] = info?.pane_id === helper.paneId ? (info.foreground_processes ?? [])
        .filter((entry: { pid?: number; argv0?: string; name?: string }) => Number.isSafeInteger(entry.pid) && /(?:^|[\\/])(?:codex|claude)(?:\.exe)?$/i.test(entry.argv0 ?? entry.name ?? ""))
        .map((entry: { pid: number }) => entry.pid) : [];
      if (process.platform !== "win32" || !roots.length) return { complete: false, processes: [], evidence: ["无法确认实际 helper 进程根；保留现场，不按名称终止进程"] };
      const entries = await snapshot();
      const rootEntries = entries.filter((entry) => roots.includes(entry.pid) && /^(codex|claude)(?:\.exe)?$/i.test(entry.name));
      if (rootEntries.length !== roots.length) return { complete: false, processes: [], evidence: ["实际进程根与 pane 元数据无法核对；保留现场"] };
      const owned = new Set(roots);
      let changed = true;
      while (changed) {
        changed = false;
        for (const entry of entries) if (owned.has(entry.parentPid) && !owned.has(entry.pid)) { owned.add(entry.pid); changed = true; }
      }
      const installRoots = rootEntries.map((entry) => {
        const executable = win32.normalize(entry.executable).toLowerCase();
        return /^(.*[\\/]openai[\\/]codex)[\\/]/i.exec(executable)?.[1] ?? win32.dirname(executable);
      });
      const infrastructure = (entry: WindowsHelperProcess) => {
        const executable = win32.normalize(entry.executable).toLowerCase();
        return roots.includes(entry.pid) || installRoots.some((directory) => executable.startsWith(`${directory}\\`)) || /^(?:herdr|codex-code-mode-host|node_repl|conhost)(?:\.exe)?$/i.test(entry.name);
      };
      return { complete: false, processes: entries.filter((entry) => owned.has(entry.pid) && !infrastructure(entry)), evidence: [`已核对 pane ${helper.paneId} 的当前进程根 ${roots.join(",")} 及可确认任务子进程；保留 Codex 基础设施、helper 根与 herdr 服务`, "当前进程树不包含已退出父进程的历史关系，无法排除孤儿任务进程；实际停止状态待核实"] };
    },
    async stop(taskProcess) {
      if (process.platform !== "win32") throw new Error("当前平台没有已确认的任务进程停止接口");
      // Pass values as base64 data, never interpolate task text into shell syntax.
      const data = Buffer.from(JSON.stringify(taskProcess)).toString("base64");
      await powershell(`$ErrorActionPreference='Stop'; $wanted=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${data}'))|ConvertFrom-Json; $actual=Get-CimInstance Win32_Process -Filter ('ProcessId='+[int]$wanted.pid); if($null -ne $actual){if($actual.CreationDate.ToUniversalTime().ToString('o') -ne $wanted.started -or [string]$actual.CommandLine -ne $wanted.command){throw '任务 PID 身份已改变，拒绝终止'}; $task=Get-Process -Id ([int]$wanted.pid) -ErrorAction Stop; $task.Kill(); if(-not $task.WaitForExit(3000)){throw '任务进程退出尚未确认'}}; '[]'`);
    },
  };
}

/** Finite, per-helper control lane. External effects are journalled before submission. */
export class HelperControlDispatcher {
  private readonly lanes = new Map<string, Promise<unknown>>();
  private readonly processes: HelperProcesses;
  constructor(private readonly options: HelperControlOptions) { this.processes = options.processes ?? helperProcesses(options.client); }

  /** Only the caller that inspected actual execution evidence may confirm adoption. */
  async confirmAdoption(conversation: string, actionId: string, evidence: { helperId: string; actionId: string; executionRef: string; detail: string }): Promise<HelperControlRecord> {
    const record = await this.options.load(conversation, actionId);
    if (!record || record.kind !== "supplement" || !["sent", "unknown", "adopted"].includes(record.state) || evidence.helperId !== record.helperId || evidence.actionId !== actionId || !evidence.executionRef.trim() || !evidence.detail.trim())
      throw new Error("补充采纳证据必须对应已提交动作及真实执行来源");
    if (record.state !== "adopted") {
      record.state = "adopted";
      record.evidence.push(`已独立核对补充 ${actionId} 的实际执行 ${evidence.executionRef}：${evidence.detail}`);
      await this.options.save(conversation, record);
    }
    return record;
  }

  control(conversation: string, helper: HelperRecord, action: HelperControlAction): Promise<HelperControlRecord> {
    const lane = JSON.stringify([conversation, helper.id]);
    const previous = this.lanes.get(lane) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(() => this.dispatch(conversation, helper, action));
    this.lanes.set(lane, next);
    void next.finally(() => { if (this.lanes.get(lane) === next) this.lanes.delete(lane); }).catch(() => {});
    return next;
  }

  private async dispatch(conversation: string, helper: HelperRecord, action: HelperControlAction): Promise<HelperControlRecord> {
    const prior = await this.options.load(conversation, action.id);
    if (prior) {
      if (prior.helperId !== helper.id || prior.target !== action.target || prior.kind !== action.kind || prior.text !== action.text)
        throw new Error("帮手控制身份与已保存动作不一致");
      if (prior.state === "sending") {
        prior.state = "unknown";
        prior.evidence.push("服务恢复时存在未确认发送；先核对，不重复提交");
        await this.options.save(conversation, prior);
      }
      if (prior.state !== "pending") return prior;
    }
    const record: HelperControlRecord = prior ?? { ...action, helperId: helper.id, state: "pending", evidence: [] };
    const finish = async (state: HelperControlRecord["state"], evidence: string) => {
      record.state = state; record.evidence.push(evidence);
      await this.options.save(conversation, record);
      return record;
    };
    await this.options.save(conversation, record);
    if (!helper.targetIds?.includes(action.target)) return finish("rejected", "帮手缺少该目标的可核实关联；未发送");
    let inspected: Awaited<ReturnType<typeof inspectHelper>>;
    try { inspected = await inspectHelper(this.options.client, helper); }
    catch (error) { return finish("rejected", `帮手身份复核失败；未发送：${String(error)}`); }
    if (inspected.launchPending || inspected.status === "unknown") return finish("rejected", "帮手接收状态未知；未发送，保留原输入核查");
    if (inspected.status === "blocked") return finish("rejected", "帮手等待决定；未发送，保留原输入核查");
    if (action.kind === "supplement" && ["idle", "done"].includes(inspected.status)) return finish("settled", "原帮手轮次已结束；补充交主 Bot 基于成果续接");
    await finish("sending", `已核对 ${helper.session}/${helper.agent}/${helper.paneId}/${helper.workspaceId}/${helper.cwd}；即将提交`);
    try {
      if (action.kind === "supplement") {
        const prompt = `用户补充（稳定身份 ${action.id}；目标 ${action.target}）。请按原要求处理，采纳后在实际处理输出中标明此身份；回显不代表采纳。\n${action.text}`;
        const receipt = await this.options.client.run(helper.session, ["agent", "prompt", helper.agent, prompt]);
        try {
          const parsed = JSON.parse(receipt);
          if (parsed.error) throw Object.assign(new Error(parsed.error.message ?? "herdr 提交错误"), { code: parsed.error.code });
        } catch (error) { if (!(error instanceof SyntaxError)) throw error; }
        return finish("sent", `CLI 已接受发送；尚无采纳证据：${receipt.slice(0, 2048)}`);
      }
      let before: HelperProcessInspection;
      try { before = await this.processes.inspect(helper); }
      catch (error) { before = { complete: false, processes: [], evidence: [`进程归属核查失败：${String(error)}`] }; }
      record.processes = before.processes;
      record.evidence.push(...before.evidence);
      await this.options.save(conversation, record);
      if (!["idle", "done"].includes(inspected.status))
        await this.options.client.run(helper.session, ["agent", "send-keys", helper.agent, "esc"]);
      for (const process of before.processes) await this.processes.stop(process);
      const after = await this.processes.inspect(helper);
      record.evidence.push(...after.evidence);
      const checked = await inspectHelper(this.options.client, helper);
      if (before.complete && after.complete && !after.processes.length && !checked.launchPending && ["idle", "done"].includes(checked.status))
        return finish("stopped", "Escape 后已核对任务进程退出、当前进程树无剩余任务进程，helper 已退出工作状态；保留已有成果");
      return finish("unknown", "Escape 已发送；进程或 helper 状态尚不能证明任务全部停止，保留现场核查");
    } catch (error) {
      if (action.kind === "supplement" && (error as { code?: string }).code === "agent_blocked")
        return finish("rejected", "herdr 确认 agent_blocked，未发送；保留原输入核查");
      return finish("unknown", `外部提交可能发生；不盲目重发：${String(error)}`);
    }
  }
}
