import type { ServerResponse } from 'node:http';

/** Controlled external Provider response shared by the current Host acceptance tests. */
export function sendChatCompletion(res: ServerResponse, content: string, toolCalls?: unknown[]) {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  res.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content, ...(toolCalls ? { tool_calls: toolCalls } : {}) }, finish_reason: toolCalls ? 'tool_calls' : 'stop' }] })}\n\ndata: [DONE]\n\n`);
}
