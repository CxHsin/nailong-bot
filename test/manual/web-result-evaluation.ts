/** Real-model controlled comparison. Uses a public-web tool-result capture as its seed.
 * node --env-file=.env --import tsx test/manual/web-result-evaluation.ts CAPTURE_JSON OUTPUT_DIR
 * API credentials stay in the environment; no Telegram or production log writes.
 */
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { getModel, streamSimple, type Context, type Usage } from "@mariozechner/pi-ai";
import { createGrepToolDefinition } from "@mariozechner/pi-coding-agent";
import { connectTinyfish } from "../../src/agent/tinyfish.js";
import { createBoundedRead } from "../../src/agent/archive-read.js";
import { createRuntimeLog } from "../../src/runtime/runtime-log.js";
import { archivePlaceholder, shouldPrune } from "../../src/runtime/tool-archive.js";
import { toolResultView } from "../../src/context/tool-result-projection.js";
import { PROGRESS_PROMPT } from "../../src/agent/progress-prompt.js";
import type { ToolResult } from "../../src/runtime/runtime-types.js";

const [capture, output] = process.argv.slice(2);
if (!capture || !output || !process.env.DEEPSEEK_API_KEY || !process.env.TINYFISH_API_KEY) throw new Error("Capture, output directory and API credentials required");
const seed: ToolResult = JSON.parse(await readFile(capture, "utf8"));
const outputDir = resolve(output);
await mkdir(outputDir, { recursive: true });
const baseModel = getModel("deepseek", "deepseek-v4-flash");
const model = { ...baseModel, id: "deepseek-flash", name: "deepseek-flash" };
const web = await connectTinyfish(process.env.TINYFISH_API_KEY);
const metrics: unknown[] = [];
try {
  for (let repetition = 1; repetition <= 3; repetition++) for (const mode of ["archive-only", "page-preview"] as const) {
    const dir = join(outputDir, `${mode}-${repetition}`);
    await mkdir(dir, { recursive: true });
    const log = createRuntimeLog(dir);
    // Reproduce legacy JSONL reads as well as archive-only previews in the baseline.
    const readLog = mode === "archive-only" ? { ...log, read: async () => (await log.read()).map((event) =>
      event.toolName === "web_fetch" ? { ...event, toolName: "legacy-web-fetch" } : event) } : log;
    const tools = [...web.tools, createBoundedRead(dir, readLog), createGrepToolDefinition(dir)];
    const context: Context = { systemPrompt: `你是中文私人助手，依据实际来源解释问题，附来源链接。\n${PROGRESS_PROMPT}`, tools,
      messages: [{ role: "user", content: "https://github.com/mattpocock/skills 仓库里的 chief-of-staff 是什么？请查它的实际定义。", timestamp: 0 }] };
    const usage: Omit<Usage, "cost"> = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 };
    const emptyUsage: Usage = { ...usage, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
    const seedArgs = { urls: ["https://github.com/mattpocock/skills/tree/main/skills", "https://github.com/mattpocock/skills/blob/main/CHANGELOG.md"], format: "markdown", links: false, image_links: false, page_metadata: false };
    context.messages.push({ role: "assistant", api: model.api, provider: model.provider, model: model.id, timestamp: 0,
      content: [{ type: "toolCall", id: "seed", name: "web_fetch", arguments: seedArgs }], stopReason: "toolUse", usage: emptyUsage });
    const seedArchive = await log.archive(seed);
    await log.append({ type: "tool_result", requestId: "evaluation", toolCallId: "seed", toolName: "web_fetch", result: seed, archive: seedArchive });
    context.messages.push({ role: "toolResult", toolCallId: "seed", toolName: "web_fetch", timestamp: 0, isError: false,
      content: mode === "archive-only" ? archivePlaceholder("web_fetch", seedArchive) : toolResultView("web_fetch", seed, seedArchive, false).content });
    const start = performance.now();
    const signal = AbortSignal.timeout(180_000);
    let toolCalls = 0;
    let final = "";
    let definitionRead = false;
    let terminal = "limit";
    for (let step = 0; step < 15; step++) {
      const stream = streamSimple(model, context, { apiKey: process.env.DEEPSEEK_API_KEY, maxTokens: 2048, signal, maxRetries: 0 });
      for await (const _ of stream) { /* consume to settle */ }
      const response = await stream.result();
      for (const key of ["input", "output", "cacheRead", "cacheWrite", "totalTokens"] as const) usage[key] += response.usage[key];
      context.messages.push(response);
      if (response.stopReason === "error" || response.stopReason === "aborted") { terminal = response.stopReason; break; }
      const calls = response.content.filter((part) => part.type === "toolCall");
      if (!calls.length) { final = response.content.filter((part) => part.type === "text").map((part) => part.text).join("\n"); terminal = response.stopReason; break; }
      for (const call of calls) {
        toolCalls++;
        const tool = tools.find((entry) => entry.name === call.name);
        let result: ToolResult;
        try {
          if (!tool) throw new Error("Unknown tool");
          const output = await Reflect.apply(tool.execute, tool, [call.id, call.arguments, signal]);
          result = { ...output, isError: false };
        } catch (error) { result = { content: [{ type: "text", text: String(error) }], details: {}, isError: true }; }
        const archive = await log.archive(result);
        await log.append({ type: "tool_result", requestId: "evaluation", toolCallId: call.id, toolName: call.name, result, archive });
        const archiveRead = log.isArchiveRead(call.name, call.arguments);
        const view = mode === "archive-only" && shouldPrune(result, archiveRead) ? archivePlaceholder(call.name, archive) : toolResultView(call.name, result, archive, archiveRead).content;
        const visible = view.filter((part) => part.type === "text").map((part) => part.text).join("\n");
        if (/name:\s*chief-of-staff/.test(visible)) definitionRead = true;
        context.messages.push({ role: "toolResult", toolCallId: call.id, toolName: call.name, timestamp: 0, content: view, isError: result.isError });
      }
    }
    const metric = { mode, repetition, terminal, definitionRead, toolCalls, seconds: Math.round((performance.now() - start) / 100) / 10, usage, final };
    metrics.push(metric);
    await writeFile(join(dir, "context.json"), JSON.stringify(context.messages, null, 2));
    await writeFile(join(outputDir, "metrics.json"), JSON.stringify(metrics, null, 2));
    console.log(JSON.stringify({ ...metric, final: final.slice(0, 160) }));
  }
} finally { await web.close(); }
