import OpenAI from 'openai';
import { calculateCost, type Api, type Context, type Model, type SimpleStreamOptions } from '@mariozechner/pi-ai';
import { canonical, nativeStream, textContent, type NativeRuntime, type NativeAssistant, type NativeDiscovery } from './native-tool-search.js';

/** Responses owns schema loading at the search-output position; Pi owns local execution. */
export function streamNativeResponses(model: Model<Api>, context: Context, options: SimpleStreamOptions, runtime: NativeRuntime) {
  return nativeStream(model, options, async (output, stream) => {
    const input: Array<Record<string, unknown>> = [];
    const validSearchIds = new Set(context.messages.flatMap(message => {
      if (message.role !== 'toolResult') return [];
      const discovery = message.details?.nativeDiscovery as NativeDiscovery | undefined;
      return discovery && runtime.valid(discovery, model) ? [message.toolCallId] : [];
    }));
    if (context.systemPrompt) input.push({ role: 'system', content: context.systemPrompt });
    for (const message of context.messages) {
      if (message.role === 'user') {
        input.push({ role: 'user', content: typeof message.content === 'string' ? message.content : message.content.map(block => block.type === 'text' ?
          { type: 'input_text', text: block.text } : { type: 'input_image', image_url: `data:${block.mimeType};base64,${block.data}` }) });
      } else if (message.role === 'assistant') {
        const record = (message as NativeAssistant).nativeToolSearch;
        if (record?.protocol === 'openai-responses' && runtime.valid(record, model)) input.push(...record.pages.flat().filter(item => item.type !== 'tool_search_call' || item.execution !== 'client' || validSearchIds.has(String(item.call_id))));
        else for (const block of message.content) {
          if (block.type === 'text') input.push({ role: 'assistant', content: [{ type: 'output_text', text: block.text, annotations: [] }] });
          else if (block.type === 'toolCall' && block.name !== 'tool_search') input.push({ type: 'function_call', call_id: block.id.split('|')[0], name: block.name, arguments: JSON.stringify(block.arguments) });
        }
      } else {
        const discovery = message.details?.nativeDiscovery as NativeDiscovery | undefined;
        if (discovery && runtime.valid(discovery, model)) input.push(discovery.output);
        else if (message.toolName !== 'tool_search') input.push({ type: 'function_call_output', call_id: message.toolCallId.split('|')[0], output: textContent(message) });
      }
    }
    let payload: Record<string, unknown> = { model: model.id, input, stream: true, store: false, parallel_tool_calls: false,
      max_output_tokens: options.maxTokens ?? Math.min(model.maxTokens, 32000),
      tools: [...runtime.resident.map(tool => ({ type: 'function', name: tool.name, description: tool.description, parameters: tool.parameters, strict: false })),
        { type: 'tool_search', execution: 'client', description: 'Discover tools needed for the current work.', parameters: { type: 'object', properties: { query: { type: 'string' }, limit: { type: 'integer' } }, required: ['query'], additionalProperties: false } }] };
    if (model.reasoning && options.reasoning) { payload.reasoning = { effort: options.reasoning, summary: 'auto' }; payload.include = ['reasoning.encrypted_content']; }
    if (options.cacheRetention !== 'none' && options.sessionId) payload.prompt_cache_key = options.sessionId;
    const replacement = await options.onPayload?.(payload, model); if (replacement !== undefined) payload = replacement as Record<string, unknown>;
    const headers = { ...options.headers }; if (options.sessionId && options.cacheRetention !== 'none') {
      headers['x-client-request-id'] ??= options.sessionId; if (!model.compat || !('sendSessionIdHeader' in model.compat) || model.compat.sendSessionIdHeader !== false) headers.session_id ??= options.sessionId;
    }
    if (runtime.options.mode === 'server') payload.tools = [...runtime.resident.map(tool => ({ type: 'function', name: tool.name, description: tool.description, parameters: tool.parameters, strict: false })),
      ...runtime.deferred.map(({ tool }) => ({ type: 'function', name: tool.name, description: tool.description, parameters: tool.parameters, strict: false, defer_loading: true })), { type: 'tool_search' }];
    const client = new OpenAI({ apiKey: options.apiKey!, baseURL: model.baseUrl, defaultHeaders: headers,
      fetch: async (url, init) => { await runtime.beforeRequest(model, context); return fetch(url, init); } });
    const { data: events, response } = await client.responses.create(payload as unknown as OpenAI.Responses.ResponseCreateParamsStreaming,
      { signal: options.signal, timeout: options.timeoutMs, maxRetries: options.maxRetries }).withResponse();
    await options.onResponse?.({ status: response.status, headers: Object.fromEntries(response.headers) }, model);
    const items = new Map<number, Record<string, unknown>>(); const deltas = new Map<string, number>(); let terminal = false; let confirmedUsage = false;
    try { for await (const raw of events) {
      const event = raw as unknown as Record<string, any>;
      if (event.type === 'response.created') output.responseId = event.response.id;
      if (event.type === 'response.output_text.delta') {
        const key = `${event.output_index}:${event.content_index}`; let index = deltas.get(key);
        if (index === undefined) { index = output.content.length; deltas.set(key, index); output.content.push({ type: 'text', text: '' }); stream.push({ type: 'text_start', contentIndex: index, partial: output }); }
        const block = output.content[index]!; if (block.type === 'text') block.text += event.delta;
        stream.push({ type: 'text_delta', contentIndex: index, delta: event.delta, partial: output });
      }
      if (event.type === 'response.output_item.done') {
        const previous = items.get(event.output_index);
        if (previous && JSON.stringify(previous) !== JSON.stringify(event.item)) throw new Error('重复原生输出项内容冲突');
        items.set(event.output_index, event.item);
      }
      if (event.type === 'response.failed' || event.type === 'error') throw new Error('端点原生工具搜索请求失败');
      if (event.type === 'response.completed' || event.type === 'response.incomplete') {
        terminal = true; output.responseId = event.response.id;
        output.responseModel = event.response.model;
        const usage = event.response.usage;
        if (usage) { confirmedUsage = true; output.usage.cacheRead = usage.input_tokens_details?.cached_tokens ?? 0; output.usage.input = (usage.input_tokens ?? 0) - output.usage.cacheRead;
          output.usage.output = usage.output_tokens ?? 0; output.usage.totalTokens = usage.total_tokens ?? (usage.input_tokens ?? 0) + output.usage.output; calculateCost(model, output.usage); }
        if (event.response.output?.length) for (const [index, item] of event.response.output.entries()) items.set(index, item);
        if (event.type === 'response.incomplete') output.stopReason = 'length';
      }
    } } finally { if (confirmedUsage) await runtime.account(model, output.usage); }
    if (!terminal) throw new Error('原生搜索响应断流：缺少结束事件');
    if (!confirmedUsage) await runtime.account(model, output.usage);
    const calls = new Map<string, string>();
    const ordered = [...items].sort(([a], [b]) => a - b).map(([, item]) => item).filter(item => {
      if (item.type !== 'function_call' && !(item.type === 'tool_search_call' && item.execution === 'client')) return true;
      if (!item.call_id) throw new Error('原生工具调用缺少身份');
      const args = typeof item.arguments === 'string' ? JSON.parse(item.arguments) : item.arguments;
      const signature = canonical([item.type, item.name, item.execution, item.status, args]);
      const id = String(item.call_id); const previous = calls.get(id);
      if (previous !== undefined && previous !== signature) throw new Error('原生工具调用身份内容冲突');
      if (previous !== undefined) return false;
      calls.set(id, signature); return true;
    });
    output.content = [];
    output.nativeToolSearch = { version: 1, protocol: 'openai-responses', scope: runtime.scope.sessionId, modelIdentity: runtime.identity(model), pages: [ordered], definitions: {} };
    const seen = new Set<string>();
    for (const item of ordered) {
      if (item.type === 'message') for (const block of item.content as Array<Record<string, unknown>>) if (block.type === 'output_text') output.content.push({ type: 'text', text: String(block.text) });
      if (item.type === 'reasoning') { const summaries = item.summary as Array<{ text: string }> | undefined; output.content.push({ type: 'thinking', thinking: summaries?.map(block => block.text).join('\n') ?? '', thinkingSignature: JSON.stringify(item) }); }
      if (item.type === 'tool_search_output') for (const tool of item.tools as Array<{ name?: string; description?: string; parameters?: unknown }>) {
        const current = runtime.deferred.find(entry => entry.tool.name === tool.name);
        if (!current || canonical(tool.parameters) !== canonical(current.tool.parameters) || tool.description !== current.tool.description) throw new Error('服务端发现的工具定义与当前工作目录不一致，需重新发现');
        output.nativeToolSearch.definitions[current.tool.name] = runtime.definitions()[current.tool.name]!;
      }
      if (item.type === 'function_call' || item.type === 'tool_search_call' && item.execution === 'client') {
        if (output.stopReason === 'length') throw new Error('原生工具搜索响应不完整，未派发本地调用');
        if (item.status && item.status !== 'completed') throw new Error('原生工具调用尚未完整结束');
        const callId = String(item.call_id); if (!item.call_id || seen.has(callId)) continue; seen.add(callId);
        const args = typeof item.arguments === 'string' ? JSON.parse(item.arguments) : item.arguments;
        if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('原生工具调用参数无效');
        output.content.push({ type: 'toolCall', id: callId, name: item.type === 'tool_search_call' ? 'tool_search' : String(item.name), arguments: args as Record<string, unknown> }); output.stopReason = 'toolUse';
      }
    }
    for (const [contentIndex, block] of output.content.entries()) if (block.type === 'text') stream.push({ type: 'text_end', contentIndex, content: block.text, partial: output });
  });
}
