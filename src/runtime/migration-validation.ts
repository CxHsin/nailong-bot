import type { StoredEvent } from "./runtime-types.js";

export type MigrationAssociations = { checkedReferences: number; referencesVerified: boolean;
  exceptions: Array<{ eventId: string; relation: string; reason: string }> };

/** Missing old facts are reported, never invented. Contradictory recorded facts stop handover. */
export function validateMigrationAssociations(events: StoredEvent[]): MigrationAssociations {
  const exceptions: MigrationAssociations["exceptions"] = [];
  let checkedReferences = 0;
  const absent = (event: StoredEvent, relation: string) => exceptions.push({ eventId: String(event.eventId), relation, reason: "旧事实源缺少对应记录，原样保留，不推定成功" });
  const byId = new Map(events.map((event) => [event.eventId, event]));
  const key = (event: StoredEvent, field: string) => `${event.requestId ?? event.runId}:${String(event[field])}`;
  const steps = new Map(events.filter((event) => event.type === "model_message").map((event) => [event.modelStepId, event]));
  const segments = new Map<string, StoredEvent>(); const dispatch = new Map<string, StoredEvent>();
  const pages = new Map<string, StoredEvent>(); const attempts = new Map<unknown, StoredEvent>();
  const results = new Set<string>(); const ownership = new Map<string, string>();
  let previousSequence = 0;
  for (const event of events) {
    if (!Number.isSafeInteger(event.sequence) || Number(event.sequence) <= previousSequence) throw new Error("迁移存储序号无效或倒退");
    previousSequence = Number(event.sequence);
    const runId = event.requestId ?? event.runId;
    if (runId && typeof event.conversationId === "string") {
      const owner = ownership.get(String(runId));
      if (owner && owner !== event.conversationId) throw new Error("迁移 Run 归属冲突");
      ownership.set(String(runId), event.conversationId);
    }
    if (event.type === "text_finalized") {
      if (segments.has(String(event.textSegmentId))) throw new Error("迁移文字身份重复");
      segments.set(String(event.textSegmentId), event);
      if (event.modelStepId) {
        const step = steps.get(event.modelStepId);
        if (!step) absent(event, "model-step");
        else if (step.requestId !== event.requestId) throw new Error("迁移模型步骤关联冲突");
        else checkedReferences++;
      }
    }
    if (event.type === "tool_dispatch" || event.type === "tool_blocked") {
      const identity = key(event, "toolCallId");
      if (dispatch.has(identity)) throw new Error("迁移工具关联重复");
      dispatch.set(identity, event);
    }
    if (event.type === "tool_result") {
      const identity = key(event, "toolCallId"); const start = dispatch.get(identity);
      if (results.has(identity)) throw new Error("迁移工具关联结果重复");
      results.add(identity);
      if (!start) absent(event, "tool-dispatch");
      else if (start.toolName !== event.toolName) throw new Error("迁移工具关联名称冲突");
      else checkedReferences++;
    }
    if (event.type === "telegram_page") {
      const identity = `${key(event, "textSegmentId")}:${event.partIndex}`;
      if (pages.has(identity) || !Number.isSafeInteger(event.partIndex) || Number(event.partIndex) < 0) throw new Error("迁移交付页面身份无效");
      pages.set(identity, event);
      const segment = segments.get(String(event.textSegmentId));
      if (!segment) absent(event, "content-unit");
      else if (segment.requestId !== event.requestId) throw new Error("迁移页面内容归属冲突");
      else checkedReferences++;
    }
    if (event.type === "telegram_delivery_attempt") {
      if (attempts.has(event.attemptId)) throw new Error("迁移交付尝试身份重复");
      attempts.set(event.attemptId, event);
      if (!pages.has(`${key(event, "textSegmentId")}:${event.partIndex}`)) absent(event, "delivery-page");
      else checkedReferences++;
    }
    if (["telegram_delivery_succeeded", "telegram_delivery_failed", "telegram_delivery_unknown"].includes(event.type)) {
      const attempt = attempts.get(event.attemptId);
      if (!attempt) absent(event, "delivery-attempt");
      else if (key(attempt, "textSegmentId") !== key(event, "textSegmentId") || attempt.partIndex !== event.partIndex ||
        attempt.target !== event.target) throw new Error("迁移交付尝试关联冲突");
      else checkedReferences++;
    }
    const archiveSource = (event.result as { details?: { archiveSourceId?: string } } | undefined)?.details?.archiveSourceId;
    if (archiveSource) { if (!byId.has(archiveSource)) absent(event, "archive-source"); else checkedReferences++; }
    // Walk only persisted reference objects; never interpret model text as schema.
    const checkRanges = (value: unknown) => {
      if (!value || typeof value !== "object") return;
      if (Array.isArray(value)) { value.forEach(checkRanges); return; }
      const item = value as Record<string, unknown>;
      if (typeof item.messageId === "string" && (item.offset !== undefined || item.end !== undefined)) {
        if (!Number.isSafeInteger(item.offset) || !Number.isSafeInteger(item.end) || Number(item.offset) < 0 || Number(item.end) < Number(item.offset)) throw new Error("迁移记忆来源区间无效");
        const source = byId.get(item.messageId);
        const text = source?.originalText === null ? "" : source?.originalText ?? source?.text;
        if (typeof text !== "string") absent(event, "memory-source");
        else if (Number(item.end) > Array.from(text).length) throw new Error("迁移记忆来源区间超出原文");
        else checkedReferences++;
      }
      Object.values(item).forEach(checkRanges);
    };
    checkRanges(event.shown); checkRanges(event.activated); checkRanges(event.replyContext);
    if (Array.isArray(event.deliveredSources)) for (const id of event.deliveredSources) {
      if (!byId.has(id)) absent(event, "learned-source"); else checkedReferences++;
    }
  }
  for (const [identity, event] of dispatch) if (event.type === "tool_dispatch" && !results.has(identity)) absent(event, "tool-outcome");
  return { checkedReferences, referencesVerified: !exceptions.length, exceptions };
}
