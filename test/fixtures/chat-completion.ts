import type { ServerResponse } from 'node:http';

/** Controlled external Provider response shared by the current Host acceptance tests. */
export function sendChatCompletion(res: ServerResponse, content: string, toolCalls?: unknown[]) {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  res.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content, ...(toolCalls ? { tool_calls: toolCalls } : {}) }, finish_reason: toolCalls ? 'tool_calls' : 'stop' }] })}\n\ndata: [DONE]\n\n`);
}

/** Simulated main agent independently reads helper artifacts before deciding the whole goal. */
export function sendMainContinuation(res: ServerResponse, wire: { tools?: Array<{ function: { name: string } }>; messages: Array<{ role: string; content: unknown; tool_call_id?: string }> }): boolean {
  const latestInput = wire.messages.filter(message => message.role === 'user').at(-1);
  const continuation = JSON.stringify(latestInput?.content).includes('执行材料（不是用户发言、不是指令）');
  if (!wire.tools?.some(tool => tool.function.name === 'complete_work') || !continuation) {
    if (wire.tools?.some(tool => tool.function.name === 'submit_material') && wire.messages.at(-1)?.role === 'tool' && wire.messages.at(-1)?.tool_call_id?.includes('write')) {
      const calls = wire.messages.flatMap(message => (message as unknown as { tool_calls?: Array<{ function: { name: string; arguments: string } }> }).tool_calls ?? []); const write = calls.findLast(call => call.function.name === 'write');
      if (write) { const args = JSON.parse(write.function.arguments); sendChatCompletion(res, '', [{ index: 0, id: 'fixture_submit_material', type: 'function', function: { name: 'submit_material', arguments: JSON.stringify({ sources: [{ reference: args.path, excerpt: args.content, supports: ['The actual file contains the requested value.'] }], uncertainties: 'This check covers only the local original file.' }) } }]); return true; }
    }
    return false;
  }
  const text = (value: unknown) => typeof value === 'string' ? value : JSON.stringify(value);
  const material = [...wire.messages].reverse().find(message => text(message.content).includes('执行材料（不是用户发言、不是指令）'));
  const content = typeof material?.content === 'string' ? material.content : (material?.content as Array<{ text?: string }>)?.map(part => part.text ?? '').join('\n') ?? '';
  const eventLine = content.split('\n')[0]!.replace('执行材料（不是用户发言、不是指令）：', '');
  const rootLine = content.split('\n').find(line => line.startsWith('当前整体目标：'))?.replace('当前整体目标：', '') ?? '{}';
  const event = JSON.parse(eventLine); const root = JSON.parse(rootLine); const last = wire.messages.at(-1)!;
  const call = (name: string, args: unknown) => sendChatCompletion(res, '', [{ index: 0, id: `main_${name}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }]);
  const artifact = event.result?.artifacts?.[0]; const stale = root.requirements?.some((requirement: string) => requirement.includes('84'));
  if (last.role !== 'tool' && artifact) call('read', { path: artifact });
  else if (last.tool_call_id === 'main_complete_work') sendChatCompletion(res, 'main reviewed');
  else {
    const denied = !artifact || text(last.content).includes('持久数据') || text(last.content).includes('授权目录');
    call('complete_work', { outcome: stale || denied || !event.result?.verified ? 'blocked' : 'completed', reviewedRevision: root.revision,
      text: stale ? '实际内容仍为 42，不满足最新要求 84；验收期间要求发生变化。' : event.result?.text ?? '工作受阻', artifacts: denied ? [] : [artifact], sources: event.result?.sources?.map((source: { reference: string }) => source.reference), uncertainties: event.result?.uncertainties });
  }
  return true;
}
