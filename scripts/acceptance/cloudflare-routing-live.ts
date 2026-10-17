import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { createIntentClassifier, type IntentAction, type IntentRequest } from "../../src/assistant/intent.js";

// Synthetic input only: production classifier, no Telegram or helper execution.
const [destination, selected = "qwen"] = process.argv.slice(2);
if (!destination || !["qwen", "glm"].includes(selected)) throw new Error("Usage: cloudflare-routing-live.ts NEW_EXTERNAL_DIRECTORY [qwen|glm]");
const account = process.env.CLOUDFLARE_ACCOUNT_ID?.trim();
const apiKey = process.env.CLOUDFLARE_API_TOKEN?.trim();
if (!account || !apiKey) throw new Error("Cloudflare credentials are required");
const model = selected === "qwen" ? "@cf/qwen/qwen3-30b-a3b-fp8" : "@cf/zai-org/glm-4.7-flash";
const directory = resolve(destination);
await mkdir(directory); // Preserve existing evidence.
type Scenario = { name: string; text: string; works?: IntentRequest["works"]; recent?: Array<{ role: "user" | "assistant"; text: string }>; replyTargets?: string[]; incomplete?: boolean; cohort: string; expected: { kind: string; target: string } };
const cases = JSON.parse(await readFile(new URL("./contextual-routing-cases.json", import.meta.url), "utf8")) as Scenario[];
await writeFile(join(directory, "cases.json"), JSON.stringify(cases, null, 2));
const configuration = { defaultModel: "router", models: [{ alias: "router", api: "openai-completions" as const, apiKey,
  baseUrl: `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(account)}/ai/v1`, model,
  contextWindow: selected === "qwen" ? 32768 : 131072, maxTokens: 16384, reasoning: false, images: false }] };
const classifier = createIntentClassifier(configuration, { model: "router" });
const works = [{ id: "report", summary: "生成本月销售报表", status: "running" }, { id: "chart", summary: "生成季度收入图表", status: "queued" }];
const originalFetch = globalThis.fetch;
type Evidence = { httpStatus: number; payload: unknown; raw: unknown };
const captured: { evidence?: Evidence } = {};
const readEvidence = (): Evidence | undefined => captured.evidence;
globalThis.fetch = async (url, init) => {
  const response = await originalFetch(url, init);
  const raw = await response.clone().json().catch(() => undefined);
  captured.evidence = { httpStatus: response.status, payload: JSON.parse(String(init?.body)), raw };
  return response;
};
type Result = { index: number; name: string; cohort: string; expected: Scenario["expected"]; passed: boolean; wrongControl: boolean; elapsedMs: number; actions: IntentAction[]; reason?: string; snapshot: unknown; evidence?: Evidence };
const results: Result[] = [];
const startedAt = new Date().toISOString();
let stoppedReason: string | undefined;
try {
  for (const [index, scenario] of cases.entries()) {
    captured.evidence = undefined;
    const start = performance.now();
    const result = await classifier.classify({ input: { conversationId: "synthetic", inputId: `case-${index + 1}`, text: scenario.text }, works: scenario.works ?? works,
      recent: (scenario.recent ?? []).map((entry, i) => ({ ...entry, inputId: `recent-${i}` })), replyTargets: scenario.replyTargets, incomplete: scenario.incomplete });
    const actions = result.actions;
    const expected = scenario.expected;
    // General models must actually extract every ordered action, not just recognize compound.
    const compound = scenario.name === "复合动作识别" ? [{ kind: "cancel", target: "chart" }, { kind: "request" }] :
      scenario.name === "两目标复合修改" ? [{ kind: "supplement", target: "report" }, { kind: "supplement", target: "chart" }] :
      scenario.name === "同目标先取消后新建" ? [{ kind: "cancel", target: "report" }, { kind: "request" }] : undefined;
    const matches = (action: IntentAction | undefined, kind: string, target?: string) => action?.kind === kind && action.target === target;
    const passed = compound ? actions.length === compound.length && compound.every((item, i) => matches(actions[i], item.kind, item.target)) :
      actions.length === 1 && matches(actions[0], expected.kind, ["none", "ambiguous"].includes(expected.target) ? undefined : expected.target);
    const wrongControl = actions.some((action, i) => ["cancel", "supplement"].includes(action.kind) && (compound ? !matches(action, compound[i]?.kind ?? "", compound[i]?.target) : !matches(action, expected.kind, expected.target)));
    const evidence = readEvidence();
    results.push({ index: index + 1, name: scenario.name, cohort: scenario.cohort, expected, passed, wrongControl, elapsedMs: Math.round(performance.now() - start), ...result, evidence });
    await writeFile(join(directory, "results.json"), JSON.stringify({ startedAt, model, results }, null, 2));
    console.log(`${index + 1} ${scenario.name}: ${passed ? "PASS" : "FAIL"} ${JSON.stringify(actions.map(({ kind, target }) => ({ kind, target })))} ${result.reason ?? ""}`);
    if (evidence && [401, 403, 429].includes(evidence.httpStatus)) { stoppedReason = `http_${evidence.httpStatus}`; break; }
  }
} finally { globalThis.fetch = originalFetch; }
const durations = results.map(row => row.elapsedMs).sort((a, b) => a - b);
const summary = { startedAt, finishedAt: new Date().toISOString(), model, casesSha256: createHash("sha256").update(JSON.stringify(cases)).digest("hex"),
  planned: cases.length, attempted: results.length, stoppedReason, groups: Object.fromEntries(["original", "fresh"].map(cohort => { const rows = results.filter(row => row.cohort === cohort); return [cohort, { total: rows.length, passed: rows.filter(row => row.passed).length, wrongControls: rows.filter(row => row.wrongControl).length }]; })),
  reasons: Object.fromEntries([...new Set(results.map(row => row.reason ?? "accepted"))].map(reason => [reason, results.filter(row => (row.reason ?? "accepted") === reason).length])),
  p50Ms: durations[Math.ceil(durations.length * .5) - 1], p95Ms: durations[Math.ceil(durations.length * .95) - 1],
  note: "Production classifier defaults: 8s timeout, 8192 estimated input tokens, 1024 output tokens. No retries, no tools. Synthetic API evaluation only; compound cases require all ordered actions. No production bot configuration changes." };
await writeFile(join(directory, "summary.json"), JSON.stringify(summary, null, 2));
console.log(JSON.stringify(summary));
if (results.length !== cases.length || results.some(row => !row.passed)) process.exitCode = 1;
