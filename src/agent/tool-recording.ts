import type { AgentSession } from "@mariozechner/pi-coding-agent";
import type { Request } from "../application/app-types.js";
import type { ToolResult } from "../runtime/runtime-types.js";
import { toolResultView, TOOL_RESULT_PROJECTION_VERSION } from "../context/tool-result-projection.js";

export function attachToolRecording(agent: AgentSession["agent"], request: Request) {
  let logFailure: Error | undefined;
  agent.toolExecution = "sequential";
  {
    const originalBefore = agent.beforeToolCall;
    const originalAfter = agent.afterToolCall;
    const recordResult = async (toolCallId: string, toolName: string, result: ToolResult, args?: unknown) => {
      let archive: Awaited<ReturnType<Request["log"]["archive"]>> | undefined;
      let archiveError: string | undefined;
      try { archive = await request.log.archive(result); }
      catch (error) { archiveError = String(error); }
      const view = toolResultView(toolName, result, archive, request.log.isArchiveRead(toolName, args));
      await request.log.append({ type: "tool_result", requestId: request.id,
        toolCallId, toolName, isError: result.isError,
        modelVisible: view.modelVisible, modelProjectionVersion: TOOL_RESULT_PROJECTION_VERSION,
        result, ...(archive ? { archive } : { archiveError }) });
      request.onProgress?.({ type: "tool", name: toolName, state: result.isError ? "failed" : "completed" });
      return view;
    };
    agent.subscribe(async (event) => {
      if (event.type !== "tool_execution_end") return;
      try {
        const events = await request.log.read();
        if (events.some((e) => e.type === "tool_result" && e.requestId === request.id && e.toolCallId === event.toolCallId)) return;
        if (!events.some((e) => (e.type === "tool_dispatch" || e.type === "tool_blocked") &&
          e.requestId === request.id && e.toolCallId === event.toolCallId))
          await request.log.append({ type: "tool_blocked", requestId: request.id,
            toolCallId: event.toolCallId, toolName: event.toolName });
        await recordResult(event.toolCallId, event.toolName,
          { ...event.result, isError: event.isError }, events.findLast((e) => e.toolCallId === event.toolCallId && e.args)?.args);
      } catch (error) {
        logFailure = error instanceof Error ? error : new Error(String(error));
        agent.abort();
      }
    });
    agent.beforeToolCall = async (context, signal) => {
      if (logFailure) return { block: true, reason: "运行日志写入失败" };
      const previous = await originalBefore?.(context, signal);
      if (previous?.block) {
        request.onProgress?.({ type: "tool", name: context.toolCall.name, state: "blocked" });
        return previous;
      }
      if (request.log.isArchiveRead(context.toolCall.name, context.args)) {
        const args = context.args as { limit?: number };
        args.limit = Math.min(Math.max(1, args.limit ?? 120), 120);
      }
      try {
        await request.log.append({ type: "tool_dispatch", requestId: request.id,
          toolCallId: context.toolCall.id, toolName: context.toolCall.name, args: context.args });
        request.onProgress?.({ type: "tool", name: context.toolCall.name, state: "started" });
      } catch (error) {
        logFailure = error instanceof Error ? error : new Error(String(error));
        agent.abort();
        return { block: true, reason: "运行日志写入失败" };
      }
      return previous;
    };
    agent.afterToolCall = async (context, signal) => {
      if (logFailure) return { content: [{ type: "text", text: "运行日志写入失败" }], terminate: true };
      const previous = await originalAfter?.(context, signal);
      const result = {
        content: previous?.content ?? context.result.content,
        details: previous?.details ?? context.result.details,
        isError: previous?.isError ?? context.isError,
      };
      let view: ReturnType<typeof toolResultView>;
      try {
        view = await recordResult(context.toolCall.id, context.toolCall.name, result, context.args);
      } catch (error) {
        logFailure = error instanceof Error ? error : new Error(String(error));
        agent.abort();
        return { content: [{ type: "text", text: "工具结果未能写入运行日志；本轮已停止。" }], terminate: true };
      }
      if (view.modelVisible === "original") return previous;
      return { content: view.content, details: {} };
    };
  }
  return () => logFailure;
}
