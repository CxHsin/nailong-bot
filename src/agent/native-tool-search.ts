import { createHash } from 'node:crypto';
import { openSync, writeFileSync, fsyncSync, closeSync, renameSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Type } from 'typebox';
import { convertToLlm, defineTool, type ToolDefinition, type AgentSession, type ModelRegistry, type SettingsManager } from '@mariozechner/pi-coding-agent';
import { createAssistantMessageEventStream, type AssistantMessageEventStream, type AssistantMessage, type Context, type Message, type Model, type Api, type SimpleStreamOptions, type Usage } from '@mariozechner/pi-ai';
import { streamNativeResponses } from './native-openai-responses.js';
import { streamNativeAnthropic } from './native-anthropic.js';
import type { RetrievalAdapter } from '../personal/research-receipts.js';

export type CapabilityScope = { sessionId: string; conversationId?: string; cwd: string };
export type CapabilityCall = CapabilityScope & { toolName: string; callId: string; arguments: Record<string, unknown>; definitionVersion: string };
export type NativeCapability = { tool: ToolDefinition; definitionVersion?: string; authorize?: (call: CapabilityCall) => boolean | Promise<boolean>; retrieval?: RetrievalAdapter };
export type NativeSearchOptions = {
  mode?: 'client' | 'server'; maxPauseContinuations?: number; maxRequests?: number; maxTokens?: number;
  beforeRequest?: (event: CapabilityScope & { modelIdentity: string; requestNumber: number }) => void | Promise<void>;
  onUsage?: (event: CapabilityScope & { modelIdentity: string; usage: Usage }) => void | Promise<void>;
  beforeDispatch?: (call: CapabilityCall) => void | Promise<void>;
  afterDispatch?: (call: CapabilityCall & { outcome: 'succeeded' | 'failed' }) => void | Promise<void>;
};
export type NativeProtocol = 'openai-responses' | 'anthropic-messages';
export type NativeRecord = { version: 1; protocol: NativeProtocol; modelIdentity: string; scope: string; pages: Array<Record<string, unknown>[]>; definitions: Record<string, string>; recordId?: string; contextAnchor?: string; paused?: boolean };
export type NativeAssistant = AssistantMessage & { nativeToolSearch?: NativeRecord };
export type NativeDiscovery = { version: 1; modelIdentity: string; scope: string; definitions: Record<string, string>; output: Record<string, unknown> };
export type NativeRuntime = {
  scope: CapabilityScope; resident: ToolDefinition[]; deferred: NativeCapability[];
  identity: (model: Model<Api>) => string;
  definitions: () => Record<string, string>;
  valid: (record: { modelIdentity: string; scope: string; definitions: Record<string, string> }, model: Model<Api>) => boolean;
  options: NativeSearchOptions;
  beforeRequest: (model: Model<Api>, context: Context) => Promise<void>;
  account: (model: Model<Api>, usage: Usage) => Promise<void>;
  checkpoint: (context: Context, record: NativeRecord) => void;
  recovered: (context: Context, model: Model<Api>) => NativeRecord | undefined;
  complete: (record: NativeRecord) => void;
  anchor: (message: Message) => string;
};
export const modelIdentity = (model: Model<Api>) => `${model.provider}/${model.id}/${model.api}`;
export function canonical(value: unknown): string { if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`; if (value && typeof value === 'object') return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`; return JSON.stringify(value) ?? 'null'; }
const fingerprint = (entry: NativeCapability) => createHash('sha256').update(canonical([entry.definitionVersion, entry.tool.name, entry.tool.description, entry.tool.parameters, entry.retrieval && [entry.retrieval.provider, entry.retrieval.version]])).digest('hex');

/** An execution catalog is registered once; only native protocol discoveries expose deferred schemas. */
export function nativeCapabilityRuntime(scope: CapabilityScope, resident: ToolDefinition[], deferred: NativeCapability[], policy: NativeSearchOptions = {}) {
  let session: AgentSession; let selectedIdentity = '';
  let checkpointFile = '';
  let inputAnchor = ''; let requests = 0; let tokens = 0;
  const messageAnchor = (message: Message) => createHash('sha256').update(JSON.stringify(message)).digest('hex');
  const anchor = (context: Context) => { const user = context.messages.findLast(message => message.role === 'user'); return user ? messageAnchor(user) : ''; };
  for (const [name, value] of Object.entries({ maxPauseContinuations: policy.maxPauseContinuations ?? 3, maxRequests: policy.maxRequests ?? 40, maxTokens: policy.maxTokens ?? 200000 }))
    if (!Number.isSafeInteger(value) || value < (name === 'maxPauseContinuations' ? 0 : 1)) throw new Error('原生搜索预算必须为有限非负整数');
  const definitions = () => Object.fromEntries(deferred.map(entry => [entry.tool.name, fingerprint(entry)]));
  const runtime: NativeRuntime = { scope, resident, deferred, identity: modelIdentity, definitions, options: policy, anchor: messageAnchor,
    valid(record, model) { const current = definitions(); return record.scope === scope.sessionId && record.modelIdentity === modelIdentity(model) &&
      Object.entries(record.definitions).every(([name, version]) => current[name] === version); },
    async beforeRequest(model, context) {
      const current = anchor(context); if (current !== inputAnchor) { inputAnchor = current; requests = 0; tokens = 0; }
      if (++requests > (policy.maxRequests ?? 40)) throw new Error('原生工具搜索达到调用预算上限');
      await policy.beforeRequest?.({ ...scope, modelIdentity: modelIdentity(model), requestNumber: requests });
    },
    async account(model, usage) { tokens += usage.totalTokens; await policy.onUsage?.({ ...scope, modelIdentity: modelIdentity(model), usage });
      if (tokens > (policy.maxTokens ?? 200000)) throw new Error('原生工具搜索达到 token 预算上限'); },
    checkpoint(context, record) {
      record.paused = true;
      record.contextAnchor ??= anchor(context);
      const data = { anchor: record.contextAnchor, record, requests, tokens, messages: session.sessionManager.buildSessionContext().messages };
      session.sessionManager.appendCustomEntry('nailong_native_pause', data);
      const temporary = `${checkpointFile}.tmp`; const descriptor = openSync(temporary, 'w');
      try { writeFileSync(descriptor, JSON.stringify(data)); fsyncSync(descriptor); } finally { closeSync(descriptor); }
      renameSync(temporary, checkpointFile);
    },
    recovered(context, model) {
      let data: { anchor: string; record?: NativeRecord; requests?: number; tokens?: number };
      try { data = JSON.parse(readFileSync(checkpointFile, 'utf8')); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw new Error('原生搜索恢复记录损坏，需人工核对'); }
      if (!data.record || !context.messages.some(message => message.role === 'user' && messageAnchor(message) === data.anchor) || !runtime.valid(data.record, model)) return;
      if (context.messages.some(message => message.role === 'assistant' && (message as NativeAssistant).nativeToolSearch?.recordId === data.record!.recordId)) return;
      requests = data.requests ?? 0; tokens = data.tokens ?? 0; inputAnchor = anchor(context);
      return data.record;
    },
    complete() { /* Final assistant persistence settles the checkpoint by recordId. */ },
  };
  const activeDiscoveries = () => {
    const loaded: Record<string, string> = {};
    for (const message of session.agent.state.messages) {
      if (message.role === 'assistant') {
        const record = (message as NativeAssistant).nativeToolSearch;
        if (record && !['error', 'aborted', 'length'].includes(message.stopReason) && runtime.valid(record, session.model!)) Object.assign(loaded, record.definitions);
      } else if (message.role === 'toolResult') {
        const record = message.details?.nativeDiscovery as NativeDiscovery | undefined;
        if (record && runtime.valid(record, session.model!)) Object.assign(loaded, record.definitions);
      }
    }
    return loaded;
  };
  const search = defineTool({ name: 'tool_search', label: 'Capability discovery', description: 'Find available specialist tools for the current work. Discovery does not grant permission.',
    parameters: Type.Object({ query: Type.String(), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 10 })) }),
    async execute(callId, args) {
      const query = args.query.toLowerCase();
      const matches = deferred.filter(entry => `${entry.tool.name} ${entry.tool.description}`.toLowerCase().includes(query) || query.split(/\s+/).some(word => word.length > 2 && `${entry.tool.name} ${entry.tool.description}`.toLowerCase().includes(word))).slice(0, args.limit ?? 5);
      const tools = matches.map(({ tool }) => ({ type: 'function', name: tool.name, description: tool.description, parameters: tool.parameters, strict: false, defer_loading: true }));
      const record: NativeDiscovery = { version: 1, scope: scope.sessionId, modelIdentity: selectedIdentity,
        definitions: Object.fromEntries(matches.map(entry => [entry.tool.name, fingerprint(entry)])),
        output: { type: 'tool_search_output', execution: 'client', call_id: callId, status: 'completed', tools } };
      return { content: [{ type: 'text', text: JSON.stringify({ discovered: matches.map(entry => entry.tool.name) }) }], details: { nativeDiscovery: record } };
    } });
  const names = [...resident.map(tool => tool.name), 'tool_search', ...deferred.map(entry => entry.tool.name)];
  if (new Set(names).size !== names.length) throw new Error('能力目录存在重复工具名');
  const tools = [...resident, search, ...deferred.map(entry => ({ ...entry.tool,
    // Deferred tools cannot contribute descriptions or guidelines to Pi's system prompt.
    promptSnippet: undefined, promptGuidelines: undefined,
    async execute(...args: Parameters<ToolDefinition['execute']>) {
      if (activeDiscoveries()[entry.tool.name] !== fingerprint(entry)) throw new Error('工具未在当前工作有效上下文中发现，需重新搜索');
      const call: CapabilityCall = { ...scope, toolName: entry.tool.name, callId: args[0], arguments: args[1] as Record<string, unknown>, definitionVersion: fingerprint(entry) };
      if (entry.authorize && !await entry.authorize(call)) throw new Error('工具发现不授予执行权限；当前调用未获授权');
      await policy.beforeDispatch?.(call);
      let result: Awaited<ReturnType<ToolDefinition['execute']>>;
      try { result = await entry.tool.execute(...args); }
      catch (error) { await policy.afterDispatch?.({ ...call, outcome: 'failed' }); throw error; }
      await policy.afterDispatch?.({ ...call, outcome: 'succeeded' }); return result;
    } } as ToolDefinition))];
  return { runtime, tools, attach(current: AgentSession, registry: ModelRegistry, settings: SettingsManager, supports: (model: Model<Api>) => boolean = () => true) {
    session = current;
    checkpointFile = join(session.sessionManager.getSessionDir(), 'native-pause.json');
    // Pi delays the first physical JSONL flush until an assistant message exists.
    // A durable pause checkpoint also preserves that first input for crash recovery.
    if (!session.agent.state.messages.length) {
      try { const pending = JSON.parse(readFileSync(checkpointFile, 'utf8')) as { record: NativeRecord; messages: AgentSession['state']['messages'] };
        if (runtime.valid(pending.record, session.model!)) {
          for (const message of pending.messages) {
            if (message.role === 'user' || message.role === 'assistant' || message.role === 'toolResult' || message.role === 'custom' || message.role === 'bashExecution') session.sessionManager.appendMessage(message);
          }
          session.agent.state.messages = pending.messages;
        }
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('原生搜索恢复记录损坏，需人工核对'); }
    }
    try {
      const pending = JSON.parse(readFileSync(checkpointFile, 'utf8')) as { record: NativeRecord; anchor: string; requests?: number; tokens?: number };
      const current = session.agent.state.messages;
      if (runtime.valid(pending.record, session.model!) && convertToLlm(current).some(message => message.role === 'user' && messageAnchor(message) === pending.anchor) &&
        !current.some(message => message.role === 'assistant' && (message as NativeAssistant).nativeToolSearch?.recordId === pending.record.recordId)) {
        const confirmed = nativeOutput(session.model!); confirmed.nativeToolSearch = pending.record;
        for (const page of pending.record.pages) for (const block of page) if (block.type === 'text') confirmed.content.push({ type: 'text', text: String(block.text) });
        session.sessionManager.appendMessage(confirmed); session.agent.state.messages = [...current, confirmed];
        inputAnchor = pending.anchor; requests = pending.requests ?? 0; tokens = pending.tokens ?? 0;
      }
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('原生搜索恢复记录损坏，需人工核对'); }
    const ordinary = session.agent.streamFn;
    session.agent.streamFn = async (model, context, options) => {
      selectedIdentity = modelIdentity(model);
      if (!supports(model)) return ordinary(model, { ...context, tools: runtime.resident, messages: context.messages.map(message => {
        if (message.role !== 'assistant') return message;
        return { ...message, content: message.content.filter(block => block.type !== 'toolCall' || block.name !== 'tool_search'), nativeToolSearch: undefined };
      }).filter(message => message.role !== 'toolResult' || message.toolName !== 'tool_search') }, options);
      const auth = await registry.getApiKeyAndHeaders(model); if (!auth.ok) throw new Error(auth.error);
      const retry = settings.getProviderRetrySettings();
      const nativeOptions: SimpleStreamOptions = { ...retry, ...options, apiKey: auth.apiKey,
        headers: { ...model.headers, ...auth.headers, ...options?.headers } };
      if (model.api === 'openai-responses') return streamNativeResponses(model, context, nativeOptions, runtime);
      if (model.api === 'anthropic-messages') return streamNativeAnthropic(model, context, nativeOptions, runtime);
      throw new Error('当前接口没有原生工具搜索适配能力');
    };
  } };
}

export function nativeOutput(model: Model<Api>): NativeAssistant {
  return { role: 'assistant', content: [], api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(), stopReason: 'stop',
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
}
export function nativeStream(model: Model<Api>, options: SimpleStreamOptions, run: (output: NativeAssistant, stream: AssistantMessageEventStream) => Promise<void>) {
  const stream = createAssistantMessageEventStream(); const output = nativeOutput(model);
  void (async () => { try { stream.push({ type: 'start', partial: output }); await run(output, stream);
    if (options.signal?.aborted) throw new Error('原生搜索请求已停止');
    stream.push({ type: 'done', reason: output.stopReason as 'stop' | 'length' | 'toolUse', message: output });
  } catch (error) { output.stopReason = options.signal?.aborted ? 'aborted' : 'error';
    let cause = error; for (let depth = 0; depth < 5 && cause instanceof Error && cause.cause; depth++) cause = cause.cause;
    const status = typeof error === 'object' && error && 'status' in error ? Number(error.status) : undefined;
    output.errorMessage = [400, 404, 422].includes(status!) ? `端点拒绝原生工具搜索协议（HTTP ${status}）；当前原生能力不可用，未使用兼容目录替代。` :
      status ? `原生工具搜索请求失败（HTTP ${status}）。` : cause instanceof Error ? cause.message : '原生工具搜索请求失败';
    stream.push({ type: 'error', reason: output.stopReason, error: output }); } finally { stream.end(); } })();
  return stream;
}

export function textContent(message: Message): string { return typeof message.content === 'string' ? message.content : message.content.filter(block => block.type === 'text').map(block => block.text).join('\n'); }
