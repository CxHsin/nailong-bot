import Anthropic from '@anthropic-ai/sdk';
import { randomUUID } from 'node:crypto';
import { calculateCost, type Api, type Context, type Model, type SimpleStreamOptions } from '@mariozechner/pi-ai';
import { canonical, nativeStream, textContent, type NativeRuntime, type NativeAssistant, type NativeDiscovery } from './native-tool-search.js';

export function streamNativeAnthropic(model: Model<Api>, context: Context, options: SimpleStreamOptions, runtime: NativeRuntime) {
  return nativeStream(model, options, async (output, stream) => {
    const messages: Array<Record<string, unknown>> = [];
    const recovered = runtime.recovered(context, model);
    for (const message of context.messages) {
      if (message.role === 'user') { messages.push({ role: 'user', content: typeof message.content === 'string' ? message.content : message.content.map(block => block.type === 'text' ? block :
        { type: 'image', source: { type: 'base64', media_type: block.mimeType, data: block.data } }) });
        if (recovered?.contextAnchor === runtime.anchor(message)) for (const page of recovered.pages) messages.push({ role: 'assistant', content: page });
      }
      else if (message.role === 'assistant') {
        const native = (message as NativeAssistant).nativeToolSearch;
        if (native?.protocol === 'anthropic-messages' && runtime.valid(native, model)) for (const page of native.pages) messages.push({ role: 'assistant', content: page });
        else {
          const content = message.content.flatMap<Record<string, unknown>>(block => block.type === 'text' ? [{ type: 'text', text: block.text }] : block.type === 'toolCall' ?
            [{ type: 'tool_use', id: block.id, name: block.name, input: block.arguments }] : []);
          if (content.length) messages.push({ role: 'assistant', content });
        }
      } else {
        const discovery = message.details?.nativeDiscovery as NativeDiscovery | undefined;
        const content = discovery && runtime.valid(discovery, model) ? Object.keys(discovery.definitions).map(tool_name => ({ type: 'tool_reference', tool_name })) : textContent(message);
        messages.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: message.toolCallId, content, ...(message.isError ? { is_error: true } : {}) }] });
      }
    }
    const catalog = [...runtime.resident.map(tool => ({ name: tool.name, description: tool.description, input_schema: tool.parameters })),
      { name: 'tool_search', description: 'Find tools needed for the current work. Discovery does not grant permission.', input_schema: { type: 'object', properties: { query: { type: 'string' }, limit: { type: 'integer' } }, required: ['query'], additionalProperties: false } },
      ...runtime.deferred.map(({ tool }) => ({ name: tool.name, description: tool.description, input_schema: tool.parameters, defer_loading: true }))];
    if (runtime.options.mode === 'server') catalog.splice(runtime.resident.length, 1, { name: 'tool_search_tool_regex', type: 'tool_search_tool_regex_20251119' } as unknown as typeof catalog[number]);
    const client = new Anthropic({ apiKey: options.apiKey!, baseURL: model.baseUrl, defaultHeaders: options.headers,
      fetch: async (url, init) => { await runtime.beforeRequest(model, context); return fetch(url, init); } });
    output.nativeToolSearch = { version: 1, protocol: 'anthropic-messages', scope: runtime.scope.sessionId, modelIdentity: runtime.identity(model), pages: [], definitions: {}, recordId: randomUUID() };
    const previousNative = context.messages.findLast(message => message.role === 'assistant' && (message as NativeAssistant).nativeToolSearch) as NativeAssistant | undefined;
    let pauses = previousNative?.nativeToolSearch?.paused && runtime.valid(previousNative.nativeToolSearch, model) ? previousNative.nativeToolSearch.pages.length : 0;
    const calls = new Map<string, string>();
    if (pauses > (runtime.options.maxPauseContinuations ?? 3)) throw new Error('原生工具搜索 pause_turn 达到续接预算上限');
    while (true) {
      let payload: Record<string, unknown> = { model: model.id, messages: [...messages], tools: catalog, stream: true,
        max_tokens: options.maxTokens ?? Math.min(model.maxTokens, 32000), ...(context.systemPrompt ? { system: context.systemPrompt } : {}) };
      if (model.reasoning && options.reasoning) { payload.thinking = { type: 'adaptive' }; payload.output_config = { effort: options.reasoning === 'minimal' ? 'low' : options.reasoning }; }
      const replacement = await options.onPayload?.(payload, model); if (replacement !== undefined) payload = replacement as Record<string, unknown>;
      const { data: events, response } = await client.messages.create(payload as unknown as Anthropic.MessageCreateParamsStreaming,
        { signal: options.signal, timeout: options.timeoutMs, maxRetries: options.maxRetries }).withResponse();
      await options.onResponse?.({ status: response.status, headers: Object.fromEntries(response.headers) }, model);
      const blocks = new Map<number, Record<string, any>>(); const pending = new Map<number, string>(); const closed = new Set<number>(); const publicBlocks = new Map<number, number>(); let terminal = false; let reason = '';
      let pageInput = 0; let pageOutput = 0; let pageRead = 0; let pageWrite = 0;
      const previous = { ...output.usage };
      const updateUsage = () => { output.usage.input = previous.input + pageInput; output.usage.output = previous.output + pageOutput;
        output.usage.cacheRead = previous.cacheRead + pageRead; output.usage.cacheWrite = previous.cacheWrite + pageWrite;
        output.usage.totalTokens = output.usage.input + output.usage.output + output.usage.cacheRead + output.usage.cacheWrite; calculateCost(model, output.usage); };
      let interrupted: unknown;
      try { for await (const raw of events) {
        const event = raw as unknown as Record<string, any>;
        if (event.type === 'message_start') { output.responseId = event.message.id; const usage = event.message.usage;
          pageInput = usage?.input_tokens ?? 0; pageOutput = usage?.output_tokens ?? 0; pageRead = usage?.cache_read_input_tokens ?? 0; pageWrite = usage?.cache_creation_input_tokens ?? 0; }
        else if (event.type === 'content_block_start') { if (blocks.has(event.index)) throw new Error('重复原生内容块'); blocks.set(event.index, { ...event.content_block });
          if (event.content_block.type === 'text') { const index = output.content.length; publicBlocks.set(event.index, index); output.content.push({ type: 'text', text: event.content_block.text ?? '' }); stream.push({ type: 'text_start', contentIndex: index, partial: output }); }
        }
        else if (event.type === 'content_block_delta') {
          const block = blocks.get(event.index); if (!block || closed.has(event.index)) throw new Error('原生内容块顺序无效');
          if (event.delta.type === 'input_json_delta') pending.set(event.index, (pending.get(event.index) ?? '') + event.delta.partial_json);
          else if (event.delta.type === 'text_delta') { block.text = (block.text ?? '') + event.delta.text; const index = publicBlocks.get(event.index)!; const text = output.content[index]!; if (text.type === 'text') text.text = block.text;
            stream.push({ type: 'text_delta', contentIndex: index, delta: event.delta.text, partial: output }); }
          else if (event.delta.type === 'thinking_delta') block.thinking = (block.thinking ?? '') + event.delta.thinking;
          else if (event.delta.type === 'signature_delta') block.signature = (block.signature ?? '') + event.delta.signature;
        } else if (event.type === 'content_block_stop') {
          if (!blocks.has(event.index)) throw new Error('原生内容块结束顺序无效'); closed.add(event.index);
          if (pending.has(event.index)) blocks.get(event.index)!.input = JSON.parse(pending.get(event.index)!);
          const index = publicBlocks.get(event.index); if (index !== undefined) { const block = output.content[index]!; if (block.type === 'text') stream.push({ type: 'text_end', contentIndex: index, content: block.text, partial: output }); }
        } else if (event.type === 'message_delta') { reason = event.delta.stop_reason ?? reason; const usage = event.usage;
          pageInput = usage?.input_tokens ?? pageInput; pageOutput = usage?.output_tokens ?? pageOutput; pageRead = usage?.cache_read_input_tokens ?? pageRead; pageWrite = usage?.cache_creation_input_tokens ?? pageWrite;
        } else if (event.type === 'message_stop') terminal = true;
        else if (event.type === 'error') throw new Error('端点原生工具搜索请求失败');
        updateUsage();
      } } catch (error) { interrupted = error; }
      updateUsage();
      const pageUsage = { input: pageInput, output: pageOutput, cacheRead: pageRead, cacheWrite: pageWrite, totalTokens: pageInput + pageOutput + pageRead + pageWrite, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }; calculateCost(model, pageUsage);
      await runtime.account(model, pageUsage);
      if (interrupted) throw interrupted;
      if (!terminal || closed.size !== blocks.size || !reason) throw new Error('原生搜索响应断流：缺少结束事件');
      const ordered = [...blocks].sort(([a], [b]) => a - b).map(([, block]) => block).filter(block => {
        if (block.type !== 'tool_use' && block.type !== 'server_tool_use') return true;
        if (!block.id) throw new Error('原生工具调用缺少身份');
        const signature = canonical([block.type, block.name, block.input ?? {}]);
        const previous = calls.get(String(block.id));
        if (previous !== undefined && previous !== signature) throw new Error('原生工具调用身份内容冲突');
        if (previous !== undefined) return false;
        calls.set(String(block.id), signature); return true;
      });
      output.nativeToolSearch.pages.push(ordered);
      for (const block of ordered) {
        if (block.type === 'tool_search_tool_result' && block.content?.type === 'tool_search_tool_search_result') for (const ref of block.content.tool_references ?? []) {
          const version = runtime.definitions()[ref.tool_name]; if (version) output.nativeToolSearch.definitions[ref.tool_name] = version;
        }
        if (block.type === 'thinking') output.content.push({ type: 'thinking', thinking: block.thinking, thinkingSignature: block.signature });
        else if (block.type === 'redacted_thinking') output.content.push({ type: 'thinking', thinking: '', redacted: true, thinkingSignature: block.data });
        else if (block.type === 'tool_use') output.content.push({ type: 'toolCall', id: block.id, name: block.name, arguments: block.input ?? {} });
      }
      if (reason !== 'pause_turn') { output.nativeToolSearch.paused = false; output.stopReason = reason === 'tool_use' ? 'toolUse' : reason === 'max_tokens' ? 'length' : 'stop';
        if (reason === 'refusal') throw new Error('端点拒绝原生搜索请求'); break; }
      runtime.checkpoint(context, output.nativeToolSearch);
      if (++pauses > (runtime.options.maxPauseContinuations ?? 3)) throw new Error('原生工具搜索 pause_turn 达到续接预算上限');
      if (ordered.some(block => block.type === 'tool_use')) throw new Error('pause_turn 同时含本地动作，需核对后恢复');
      messages.push({ role: 'assistant', content: ordered });
    }
  });
}
