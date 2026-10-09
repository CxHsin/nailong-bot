import { createAssistantMessageEventStream, type Api, type Model, type Context, type SimpleStreamOptions, type AssistantMessage, type Tool } from "@mariozechner/pi-ai";
import type { createToolCatalog } from "./tool-catalog.js";

type Catalog = ReturnType<typeof createToolCatalog>;
const functionTool = (tool: Tool) => ({ type: "function", name: tool.name, description: tool.description, parameters: tool.parameters, strict: false });
const parseSearch = (message: Extract<Context["messages"][number], { role: "toolResult" }>) => {
  if (message.isError) return [];
  try { return JSON.parse(message.content.filter((part) => part.type === "text").map((part) => part.text).join("\n")).tools as Catalog["snapshot"]; }
  catch { return []; }
};

/** Native references are wire-only. Runtime facts remain ordinary search calls/results. */
export function anthropicSearchPayload(payload: unknown, catalog: Catalog, currentCalls: Set<string>) {
  const data = payload as { tools?: Array<Record<string, unknown>>; messages?: Array<{ role: string; content: Array<Record<string, unknown>> }> };
  if (!data || !Array.isArray(data.tools)) return payload;
  const tools = [...data.tools, ...catalog.entries.map((entry) => ({ name: entry.name, description: entry.description, input_schema: entry.parameters, defer_loading: true }))];
  const messages = data.messages?.map((message) => ({ ...message, content: Array.isArray(message.content) ? message.content.map((part) => {
    if (part.type !== "tool_result" || !currentCalls.has(String(part.tool_use_id)) || part.is_error) return part;
    try {
      const content = Array.isArray(part.content) ? part.content.map((item) => (item as { text?: string }).text ?? "").join("\n") : String(part.content);
      const found = JSON.parse(content).tools as Catalog["snapshot"];
      return { ...part, content: found.map((entry) => ({ type: "tool_reference", tool_name: entry.name })) };
    } catch { return part; }
  }) : message.content }));
  return { ...data, tools, messages };
}

function responsesInput(context: Context, currentCalls: Set<string>) {
  const input: Record<string, unknown>[] = [];
  if (context.systemPrompt) input.push({ role: "system", content: context.systemPrompt });
  for (const message of context.messages) {
    if (message.role === "user") input.push({ role: "user", content: typeof message.content === "string" ? message.content : message.content.map((part) => part.type === "text" ? { type: "input_text", text: part.text } : { type: "input_image", image_url: `data:${part.mimeType};base64,${part.data}` }) });
    else if (message.role === "assistant") for (const part of message.content) {
      if (part.type === "text") input.push({ role: "assistant", content: [{ type: "output_text", text: part.text }] });
      if (part.type === "thinking" && part.thinkingSignature) { try { input.push(JSON.parse(part.thinkingSignature)); } catch {} }
      if (part.type === "toolCall") {
        if (part.name === "tool_search" && currentCalls.has(part.id)) input.push({ type: "tool_search_call", call_id: part.id, execution: "client", status: "completed", arguments: part.arguments });
        else if (part.name === "tool_search") input.push({ role: "assistant", content: `历史工具搜索（不授权本轮调用）：${JSON.stringify(part.arguments)}` });
        else input.push({ type: "function_call", call_id: part.id, name: part.name, arguments: JSON.stringify(part.arguments) });
      }
    } else if (message.role === "toolResult") {
      if (message.toolName === "tool_search" && currentCalls.has(message.toolCallId)) {
        const found = parseSearch(message) ?? [];
        input.push({ type: "tool_search_output", call_id: message.toolCallId, execution: "client", status: "completed", tools: found.map((entry) => ({ ...functionTool(entry), defer_loading: true })) });
      } else if (message.toolName === "tool_search") input.push({ role: "user", content: `历史搜索结果（不授权本轮调用）：${JSON.stringify(message.content)}` });
      else {
        const text = message.content.filter((part) => part.type === "text").map((part) => part.text).join("\n");
        const images = message.content.filter((part) => part.type === "image");
        const output = images.length ? [
          ...(text ? [{ type: "input_text", text }] : []),
          ...images.map((part) => ({ type: "input_image", detail: "auto", image_url: `data:${part.mimeType};base64,${part.data}` })),
        ] : text;
        input.push({ type: "function_call_output", call_id: message.toolCallId, output });
      }
    }
  }
  return input;
}

async function* events(response: Response) {
  if (!response.body) throw new Error("Provider 未返回事件流");
  let buffer = ""; const decoder = new TextDecoder();
  for await (const chunk of response.body) {
    buffer += decoder.decode(chunk, { stream: true }).replace(/\r\n/g, "\n");
    let end: number;
    while ((end = buffer.indexOf("\n\n")) >= 0) {
      const frame = buffer.slice(0, end); buffer = buffer.slice(end + 2);
      const data = frame.split("\n").filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart()).join("\n");
      if (data && data !== "[DONE]") yield JSON.parse(data) as Record<string, any>;
    }
  }
}

/** Responses SDK currently ignores tool_search_call; decode the documented SSE boundary here. */
export function streamNativeResponses(model: Model<Api>, context: Context, options: SimpleStreamOptions, key: string, currentCalls: Set<string>) {
  const stream = createAssistantMessageEventStream();
  void (async () => {
    const output: AssistantMessage = { role: "assistant", api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(), content: [], stopReason: "stop",
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
    try {
      const tools = (context.tools ?? []).map((tool) => tool.name === "tool_search" ? { type: "tool_search", execution: "client", description: tool.description, parameters: tool.parameters } : functionTool(tool));
      const payload = { model: model.id, input: responsesInput(context, currentCalls), tools, stream: true, store: false, parallel_tool_calls: false,
        max_output_tokens: options.maxTokens ?? model.maxTokens, ...(options.sessionId ? { prompt_cache_key: options.sessionId } : {}),
        ...(model.reasoning ? { reasoning: { effort: options.reasoning ?? "low" }, include: ["reasoning.encrypted_content"] } : {}) };
      const customized = await options.onPayload?.(payload, model);
      const url = `${model.baseUrl.replace(/\/$/, "")}/responses`;
      const response = await fetch(url, { method: "POST", headers: { "content-type": "application/json", Authorization: `Bearer ${key}`, ...options.headers }, body: JSON.stringify(customized ?? payload), signal: options.signal });
      await options.onResponse?.({ status: response.status, headers: Object.fromEntries(response.headers) }, model);
      if (!response.ok) { await response.body?.cancel(); throw new Error(`Provider HTTP ${response.status}`); }
      stream.push({ type: "start", partial: output });
      const pending = new Map<number, { item: Record<string, any>; args: string; text: string }>();
      let completed = false;
      for await (const event of events(response)) {
        if (event.type === "response.output_item.added") pending.set(event.output_index, { item: event.item, args: "", text: "" });
        if (event.type === "response.function_call_arguments.delta") { const item = pending.get(event.output_index); if (item) item.args += event.delta; }
        if (event.type === "response.output_text.delta") {
          const item = pending.get(event.output_index); if (item) item.text += event.delta;
          let index = output.content.findIndex((part) => part.type === "text");
          if (index < 0) { index = output.content.length; output.content.push({ type: "text", text: "" }); stream.push({ type: "text_start", contentIndex: index, partial: output }); }
          const part = output.content[index]!; if (part.type === "text") part.text += event.delta;
          stream.push({ type: "text_delta", contentIndex: index, delta: event.delta, partial: output });
        }
        if (event.type === "response.output_item.done") {
          const item = event.item;
          if (item.type === "tool_search_call" || item.type === "function_call") {
            if (item.type === "tool_search_call" && item.execution !== "client") throw new Error("不支持的 Tool Search execution");
            const id = item.call_id; if (typeof id !== "string") throw new Error("工具调用缺少 call_id");
            const raw = item.arguments ?? pending.get(event.output_index)?.args ?? {};
            const args = typeof raw === "string" ? JSON.parse(raw) : raw;
            const name = item.type === "tool_search_call" ? "tool_search" : item.name;
            if (name === "tool_search") currentCalls.add(id);
            const toolCall = { type: "toolCall" as const, id, name, arguments: args };
            output.content.push(toolCall); output.stopReason = "toolUse";
            stream.push({ type: "toolcall_end", contentIndex: output.content.length - 1, toolCall, partial: output });
          }
          if (item.type === "reasoning" && item.encrypted_content) output.content.push({ type: "thinking", thinking: "", thinkingSignature: JSON.stringify(item) });
          if (item.type === "message" && !pending.get(event.output_index)?.text) {
            const text = (item.content ?? []).filter((part: any) => part.type === "output_text").map((part: any) => part.text).join("\n");
            if (text) output.content.push({ type: "text", text });
          }
        }
        if (event.type === "response.completed" || event.type === "response.incomplete") {
          completed = true; const usage = event.response.usage;
          if (usage) { output.usage.cacheRead = usage.input_tokens_details?.cached_tokens ?? 0; output.usage.input = Math.max(0, (usage.input_tokens ?? 0) - output.usage.cacheRead); output.usage.output = usage.output_tokens ?? 0; output.usage.totalTokens = (usage.input_tokens ?? 0) + output.usage.output; }
          if (event.type === "response.incomplete") output.stopReason = "length";
        }
        if (event.type === "error" || event.type === "response.failed") throw new Error("Provider 事件流失败");
      }
      if (!completed) throw new Error("Provider 事件流未完整结束");
      options.signal?.throwIfAborted(); stream.push({ type: "done", reason: output.stopReason as "stop" | "length" | "toolUse", message: output }); stream.end();
    } catch (error) {
      output.stopReason = options.signal?.aborted ? "aborted" : "error"; output.errorMessage = error instanceof Error ? error.message : "Provider 协议失败";
      stream.push({ type: "error", reason: output.stopReason, error: output }); stream.end();
    }
  })();
  return stream;
}
