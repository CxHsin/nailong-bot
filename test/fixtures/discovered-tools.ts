import type { ServerResponse } from "node:http";

type PlannedCall = { name: string; args: unknown };
/** Simulated Provider executes its planned deferred action through the public discovery protocol. */
export function discoveredToolPlan() {
  let pending: PlannedCall | undefined;
  return {
    continue(data: { messages: Array<{ role: string; content?: unknown }> }, res: ServerResponse): boolean {
      if (!pending || data.messages.at(-1)?.role !== "tool") return false;
      const call = pending; pending = undefined;
      const delta = { tool_calls: [{ index: 0, id: `invoke_${Date.now()}_${Math.random().toString(36).slice(2)}`, type: "function", function: { name: "tool_call", arguments: JSON.stringify({ name: call.name, arguments: call.args }) } }] };
      res.writeHead(200, { "content-type": "text/event-stream" }); res.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: "tool_calls" }] })}\n\ndata: [DONE]\n\n`); return true;
    },
    select(name: string, args: unknown) {
      if (!["ls", "grep", "find", "memory_search", "memory_read", "web_fetch"].includes(name)) return { name, args };
      pending = { name, args }; return { name: "tool_search", args: { query: name, limit: 1 } };
    },
  };
}
