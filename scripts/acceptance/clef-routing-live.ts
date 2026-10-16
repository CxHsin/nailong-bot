import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { createIntentClassifier, type IntentWork, type IntentRecent } from "../../src/assistant/intent.js";
import { clefPayload, type ClefOptions, type ClefDecision, type ClefState } from "../../src/assistant/intent-clef.js";

// Synthetic live API evaluation of the production adapter; never starts a Bot or helper.
const [destination, model = "clef-flash"] = process.argv.slice(2);
if (!destination || (model !== "clef-flash" && model !== "clef")) throw new Error("Usage: clef-routing-live.ts NEW_EXTERNAL_DIRECTORY [clef-flash|clef]");
const accountId = process.env.CLOUDFLARE_ACCOUNT_ID?.trim();
const apiToken = process.env.CLOUDFLARE_API_TOKEN?.trim();
if (!accountId || !apiToken) throw new Error("Cloudflare credentials are required");
const clef: ClefOptions = { model, accountId, apiToken };
const directory = resolve(destination);
await mkdir(directory); // Refuse to overwrite earlier evidence.
type Scenario = { name: string; text: string; works?: IntentWork[]; recent?: Array<{ role: "user" | "assistant"; text: string }>; replyTargets?: string[]; incomplete?: boolean; cohort: string; semantic?: string; expected: { kind: string; target: string } };
const report = { id: "report", summary: "生成本月销售报表", status: "running" };
const chart = { id: "chart", summary: "生成季度收入图表", status: "queued" };
const original = JSON.parse(await readFile(new URL("./clef-routing-cases.json", import.meta.url), "utf8")) as Scenario[];
const cases: Scenario[] = [...original, ...[
  { name: "明确他指覆盖回复", text: "停止季度收入图表，销售报表继续。", replyTargets: ["report"], expected: { kind: "cancel", target: "chart" } },
  { name: "回复图表但独立新请求", text: "另外帮我翻译一句英文：Good morning。", replyTargets: ["chart"], expected: { kind: "request", target: "none" } },
  { name: "一条回复关联多项工作", text: "这个暂停一下。", replyTargets: ["report", "chart"], semantic: "cancel", expected: { kind: "clarify", target: "ambiguous" } },
  { name: "明确否定中断", text: "图表先别停，把背景改成白色。", expected: { kind: "supplement", target: "chart" } },
  { name: "无回复且单一工作", text: "这个先停下来。", works: [chart], expected: { kind: "cancel", target: "chart" } },
  { name: "中文省略补充", text: "图表用折线的，金额统一万元。", expected: { kind: "supplement", target: "chart" } },
  { name: "两目标复合修改", text: "报表改成 CSV，图表换成折线图。", expected: { kind: "compound", target: "multiple" } },
  { name: "同目标先取消后新建", text: "取消本月销售报表，再做一份下月的。", expected: { kind: "compound", target: "report" } },
  { name: "自然提问不是停止命令", text: "为什么季度收入图表还没有完成？", expected: { kind: "request", target: "none" } },
  { name: "引用取消不授权执行", text: "请把“取消销售报表”翻译成英文。", expected: { kind: "request", target: "none" } },
  { name: "完整名称支持不完整候选", text: "停止生成季度收入图表。", works: [chart], incomplete: true, expected: { kind: "cancel", target: "chart" } },
  { name: "未知对象不能取消已知工作", text: "那个视频压缩任务先别做了。", expected: { kind: "clarify", target: "ambiguous" }, semantic: "cancel" },
].map(c => ({ ...c, cohort: "fresh" }))];
const startedAt = new Date().toISOString();
await writeFile(join(directory, "cases.json"), JSON.stringify(cases, null, 2));
const classifier = createIntentClassifier({ defaultModel: "unused", models: [] }, { clef });
const results: Array<Record<string, unknown>> = [];
const originalFetch = globalThis.fetch;
let evidence: unknown;
let stoppedReason: string | undefined;
globalThis.fetch = async (url, init) => {
  const response = await originalFetch(url, init);
  const raw = await response.clone().json().catch(() => undefined) as { success?: boolean; result?: { answers?: unknown; usage?: unknown }; errors?: Array<{ code?: unknown }> } | undefined;
  evidence = { httpStatus: response.status, ray: response.headers.get("cf-ray"), success: raw?.success, answers: raw?.result?.answers, usage: raw?.result?.usage, errors: raw?.errors?.map(error => ({ code: error.code })), payload: JSON.parse(String(init?.body)) };
  return response;
};
for (const [index, scenario] of cases.entries()) {
  evidence = undefined;
  const start = performance.now();
  const recent: IntentRecent[] = (scenario.recent ?? []).map((entry, i) => ({ ...entry, inputId: `recent-${i}` }));
  const result = await classifier.classify({ input: { conversationId: "synthetic", inputId: `case-${index + 1}`, text: scenario.text }, works: scenario.works ?? [report, chart], recent, replyTargets: scenario.replyTargets, incomplete: scenario.incomplete });
  const snapshot = result.snapshot as ClefState & { decision?: ClefDecision };
  const payload = clefPayload(clef, snapshot);
  const choice = snapshot.decision?.choice;
  const selected = choice ? payload.actions.get(choice) : undefined;
  const rawKind = choice === "compound" ? "compound" : selected?.kind;
  const action = result.actions[0];
  const actual = action ? { kind: action.kind, target: action.target ?? (action.kind === "clarify" ? "ambiguous" : "none") } : { kind: "fallback", target: "none" };
  const passed = scenario.expected.kind === "compound" ? result.reason === "compound" && !result.actions.length : actual.kind === scenario.expected.kind && actual.target === scenario.expected.target;
  const semantic = scenario.semantic ?? (scenario.name === "多目标歧义" || scenario.name === "不完整候选不能按唯一性取消" ? "cancel" : scenario.name === "两份同主题报告需要澄清" ? "supplement" : scenario.expected.kind);
  const semanticOutcome = !rawKind ? "not_observed" : rawKind === "clarify" ? "unresolved" : rawKind === semantic ? "correct" : "wrong";
  const targetOutcome = !choice ? "not_observed" : scenario.expected.kind === "compound" ? "not_scored" : actual.kind === "clarify" ? scenario.expected.target === "ambiguous" ? "correct_ambiguity" : "unresolved" : action?.target ? action.target === scenario.expected.target ? "correct" : "wrong" : scenario.expected.target === "none" && action?.kind === "request" ? "correct" : "unresolved";
  const unsafeControl = Boolean(action && ["supplement", "cancel"].includes(action.kind) && (action.kind !== scenario.expected.kind || action.target !== scenario.expected.target));
  results.push({ index: index + 1, name: scenario.name, cohort: scenario.cohort, expected: scenario.expected, actual, passed, semantic, semanticOutcome, targetOutcome, unsafeControl, elapsedMs: Math.round(performance.now() - start), result, evidence });
  await writeFile(join(directory, "results.json"), JSON.stringify({ startedAt, model, results }, null, 2));
  console.log(`${index + 1} ${scenario.name}: ${passed ? "PASS" : "FAIL"} ${JSON.stringify(actual)} ${result.reason ?? ""}`);
  if (evidence && typeof evidence === "object" && "httpStatus" in evidence && [401, 403].includes(Number(evidence.httpStatus))) {
    stoppedReason = "authentication_or_permission_error";
    break;
  }
}
globalThis.fetch = originalFetch;
const countBy = (rows: typeof results, key: string) => Object.fromEntries([...new Set(rows.map(row => row[key]))].map(value => [String(value), rows.filter(row => row[key] === value).length]));
const groups = Object.fromEntries(["original", "fresh"].map(cohort => { const rows = results.filter(row => row.cohort === cohort); return [cohort, { total: rows.length, passed: rows.filter(row => row.passed).length, semantic: countBy(rows, "semanticOutcome"), target: countBy(rows, "targetOutcome"), unsafeControls: rows.filter(row => row.unsafeControl).length }]; }));
const durations = results.map(row => Number(row.elapsedMs)).sort((a, b) => a - b);
const summary = { startedAt, finishedAt: new Date().toISOString(), model, planned: cases.length, attempted: results.length, untested: cases.length - results.length, stoppedReason, casesSha256: createHash("sha256").update(JSON.stringify(cases)).digest("hex"), groups, p50Ms: durations[Math.ceil(durations.length * .5) - 1], p95Ms: durations[Math.ceil(durations.length * .95) - 1], errors: results.filter(row => ["timeout", "invalid_result", "classifier_error"].includes(String((row.result as { reason?: string }).reason))).length, note: "Synthetic API evaluation, not Bot end-to-end. Unresolved semantics are abstentions, not proven semantic errors. Safe fallbacks do not automatically count as correct routing. No universal confidence threshold is inferred." };
await writeFile(join(directory, "summary.json"), JSON.stringify(summary, null, 2));
console.log(JSON.stringify(summary));
if (results.some(row => !row.passed)) process.exitCode = 1;
