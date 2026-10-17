import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { RequestMetric } from "./durable-models.js";
import type { StoredBatch } from "./queue.js";

/** Read one snapshot; request IDs replace pending records rather than counting them twice. */
export async function cacheReport(dataDir: string, conversationId: string, batches: StoredBatch[]) {
  const directory = createHash("sha256").update(conversationId).digest("hex");
  let content: string;
  try { content = await readFile(join(dataDir, "executions", directory, "requests.jsonl"), "utf8"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    content = "";
  }
  const requests = new Map<string, RequestMetric>();
  let invalid = 0;
  for (const [index, line] of content.split("\n").entries()) {
    if (!line.trim()) continue;
    let metric: RequestMetric;
    try { metric = JSON.parse(line); }
    catch { invalid++; continue; }
    if (!metric || metric.conversationId !== conversationId || metric.purpose === "auxiliary") continue;
    requests.set(metric.requestId ?? `legacy:${index}`, metric);
  }
  const groups = new Map<string, RequestMetric[]>();
  for (const [id, metric] of requests) {
    const key = metric.batchId ?? id;
    const group = groups.get(key) ?? [];
    group.push(metric);
    groups.delete(key);
    groups.set(key, group);
  }
  const recent = [...groups.entries()].reverse().slice(0, 5);
  const rows = recent.map(([id, metrics], index) => {
    const batch = batches.find(batch => batch.id === id);
    const running = batch?.status === "running";
    const pending = metrics.filter(metric => metric.status === "pending").length;
    const settled = metrics.filter(metric => metric.status !== "pending");
    const valid = settled.filter(metric => token(metric.input) && token(metric.cacheRead) &&
      (metric.cacheWrite === null || token(metric.cacheWrite)));
    const missing = settled.length - valid.length + (running ? 0 : pending);
    const hit = valid.reduce((sum, metric) => sum + metric.cacheRead!, 0);
    const miss = valid.reduce((sum, metric) => sum + metric.input! + (metric.cacheWrite ?? 0), 0);
    const total = hit + miss;
    const rate = total ? hit / total * 100 : undefined;
    const notes = [!metrics[0]?.batchId ? "历史请求（未记录轮次/用途）" : "",
      running ? "进行中" : batch?.status === "paused" || batch?.status === "needs_confirmation" ? "已暂停" :
        batch?.status === "preempted" ? "已取消/抢占" : "",
      settled.some(metric => metric.status === "error") ? "含失败请求" : "",
      settled.some(metric => metric.status === "aborted") ? "含取消请求" : "",
      running && pending ? "待结算" : "", missing ? "数据缺失" : ""].filter(Boolean);
    const unavailable = rate === undefined || pending > 0 || missing > 0;
    const icon = unavailable ? "⚪" : rate > 90 ? "🟢" : rate > 70 ? "🟡" : rate > 40 ? "🟠" : "🔴";
    const taste = unavailable ? "" : rate > 90 ? "入口即化，嗷呜，一口就想起来啦！" :
      rate > 70 ? "完美反刍，熟悉的味道又回来啦！" : rate > 40 ? "半生不熟，这口还得嚼一嚼！" : "咯牙警告，这次新食材有点多！";
    return `${index + 1}. ${icon} 命中率：${rate === undefined ? "不可用" : `${rate.toFixed(1)}%`}${missing && valid.length ? "（仅已知用量）" : ""}\n` +
      (notes.length ? `${notes.join(" · ")}\n` : "") +
      `Hit：${valid.length ? hit : "不可用"}\nMiss：${valid.length ? miss : "不可用"}\n合计输入：${valid.length ? total : "不可用"}` +
      (taste ? `\n${taste}` : "");
  });
  return ["🦖 【奶龙赛博反刍胃囊报表】", ...rows,
    !recent.length ? "还没有模型请求的缓存记录，聊几句后再来看看吧。" : "",
    invalid ? "部分请求记录无法读取，未计入报表。" : ""].filter(Boolean).join("\n\n");
}

function token(value: number | null): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}
