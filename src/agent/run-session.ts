import type { AgentSession } from "@mariozechner/pi-coding-agent";
import type { UserMessage } from "@mariozechner/pi-ai";
import type { Message, Request } from "../application/app-types.js";
import type { SteeringInput } from "../host/host.js";
import { appendRuntimeFact } from "../runtime/facts.js";
import type { attachExecution } from "./execution.js";
import { explicitSkills, type skillRead, type SkillSnapshot } from "./skills.js";
import { attachToolRecording } from "./tool-recording.js";

type RunSessionOptions = {
  session: AgentSession;
  execution: Pick<Awaited<ReturnType<typeof attachExecution>>, "failure" | "finalText" | "invalidateFinal">;
  reader: Pick<ReturnType<typeof skillRead>, "registerSkills">;
  skills: SkillSnapshot;
  current: Message;
  request?: Request;
  userId: unknown;
  abort: () => void;
};

function steerContent(parts: SteeringInput["input"]["parts"]) {
  const text = parts.filter((part) => part.type === "text").map((part) => part.text).join("\n") || "请分析这张图片。";
  const images = parts.flatMap((part) => part.type === "image" && part.data ? [{ type: "image" as const, mimeType: part.mimeType, data: part.data }] : []);
  return { text, images };
}

/** One Run owns SDK steering queues, durable consumption and Provider acceptance barriers. */
export async function runSession({ session, execution, reader, skills, current, request, userId, abort }: RunSessionOptions): Promise<string> {
  session.agent.toolExecution = "sequential";
  const toolFailure = request ? attachToolRecording(session.agent, request) : () => undefined;
  session.agent.steeringMode = "all";
  const pendingSteers = new Map<UserMessage, SteeringInput>();
  const appliedSteers: SteeringInput[] = [];
  const closeSteering = request?.bindSteering?.((steer) => {
    const { text, images } = steerContent(steer.input.parts);
    const message: UserMessage = { role: "user", content: [{ type: "text", text }, ...images], timestamp: Date.now() };
    pendingSteers.set(message, steer); session.agent.steer(message);
  });
  let steeringWrites = Promise.resolve();
  // SDK subscribers run independently; serialize facts before replaying them.
  session.agent.subscribe((event) => {
    if (event.type === "message_end" && event.message.role === "user") {
      const steer = pendingSteers.get(event.message);
      if (!steer) return;
      pendingSteers.delete(event.message);
      steeringWrites = steeringWrites.then(async () => {
        if (!await steer.consume()) return;
        execution.invalidateFinal();
        session.agent.clearFollowUpQueue();
        if (request) await appendRuntimeFact(request.log, { type: "protocol_feedback_superseded", requestId: request.id, reason: "user_steer", contextPolicy: "exclude" });
        const { text, images } = steerContent(steer.input.parts);
        if (request) {
          const fact = { type: "message" as const, role: "user" as const, text, originalText: text, requestId: request.id, inputId: steer.id,
            chatId: userId, messageId: steer.input.metadata?.messageId, inputKind: "steer" as const, ...(images.length ? { images } : {}) };
          if (typeof userId === "number" || userId === undefined) await appendRuntimeFact(request.log, { ...fact, chatId: userId });
          // Preserve an unproven historical source identity without normalizing its accepted payload.
          else await request.log.append(fact);
          const selected = await explicitSkills(steer.input.metadata?.skillSnapshot as SkillSnapshot ?? skills, text, { ...request, inputId: steer.id });
          reader.registerSkills(selected);
        }
        appliedSteers.push(steer);
      });
    }
  });
  const executionStream = session.agent.streamFn;
  session.agent.streamFn = async (...args) => {
    await steeringWrites;
    return executionStream(...args);
  };
  if (request) request.onModelInput = async () => {
    // Claim the whole accepted payload before durable writes can interleave Stop.
    await Promise.all(appliedSteers.splice(0).map((steer) => steer.applied()));
  };
  try {
    try {
      await session.prompt(current.text, { images: current.images });
      while (pendingSteers.size && !request?.signal?.aborted && !execution.failure()) await session.agent.continue();
      closeSteering?.();
    }
    catch (error) { throw toolFailure() ?? execution.failure() ?? error; }
    if (toolFailure()) throw toolFailure();
    if (execution.failure()) throw execution.failure();
    const last = session.messages.at(-1);
    if (last?.role === "assistant" && (last.stopReason === "error" || last.stopReason === "aborted")) {
      throw new Error("模型调用失败");
    }
    if (execution.finalText() === undefined) throw new Error("模型未提交最终答复，本轮未完成");
    return execution.finalText()!;
  } finally {
    closeSteering?.();
    await steeringWrites;
    for (const steer of appliedSteers) if (request) await appendRuntimeFact(request.log, { type: "steer_unapplied", inputId: steer.id, requestId: request.id, contextPolicy: "exclude" });
    request?.signal?.removeEventListener("abort", abort); session.dispose();
  }
}
