import type { RuntimeLog, StoredEvent } from "./runtime-types.js";

export type DeliveryOutcome = "pending" | "succeeded" | "rejected" | "unknown";
export type DeliveryFact = { resultId: string; channel: string; target: string; idempotencyKey: string; outcome: DeliveryOutcome; at: string; error?: string };
export type RunDeliveryState = { runState: "running" | "succeeded" | "failed" | "cancelled" | "blocked" | "recovered" | "unknown"; delivery: Map<string, DeliveryFact>; resultReusable: boolean };

export function createDeliveryFactStore(log: RuntimeLog) {
  const facts = async () => (await log.read()).filter((event) => event.type.startsWith("delivery_"));
  return {
    async recordAttempt(input: Omit<DeliveryFact, "outcome" | "at">) {
      const existing = (await facts()).find((event) => event.type === "delivery_attempt" && event.idempotencyKey === input.idempotencyKey && event.resultId === input.resultId && event.channel === input.channel);
      if (existing) return existing;
      return log.append({ type: "delivery_attempt", ...input });
    },
    async recordOutcome(resultId: string, channel: string, outcome: Exclude<DeliveryOutcome, "pending">, extra: { error?: string } = {}) {
      return log.append({ type: `delivery_${outcome}`, resultId, channel, outcome, ...extra });
    },
    async recover() { return (await facts()) as StoredEvent[]; },
  };
}

export function reduceRunDelivery(events: StoredEvent[], runId: string, resultId?: string): RunDeliveryState {
  const runEvents = events.filter((event) => event.runId === runId || (resultId && event.resultId === resultId));
  let runState: RunDeliveryState["runState"] = "unknown";
  if (runEvents.some((event) => event.type === "run_started" || event.type === "request_started")) runState = "running";
  if (runEvents.some((event) => event.type === "run_blocked")) runState = "blocked";
  if (runEvents.some((event) => event.type === "run_recovered")) runState = "recovered";
  if (runEvents.some((event) => event.type === "run_failed" || event.type === "request_failed")) runState = "failed";
  if (runEvents.some((event) => event.type === "run_cancelled" || event.type === "request_interrupted")) runState = "cancelled";
  if (runEvents.some((event) => event.type === "run_succeeded" || event.type === "request_completed")) runState = "succeeded";
  const delivery = new Map<string, DeliveryFact>();
  for (const event of events.filter((entry) => entry.type === "delivery_attempt" || entry.type.startsWith("delivery_") && entry.type !== "delivery_attempt")) {
    const key = typeof event.idempotencyKey === "string" ? event.idempotencyKey : `${event.resultId}:${event.channel}`;
    const current = delivery.get(key) ?? { resultId: String(event.resultId ?? resultId ?? ""), channel: String(event.channel ?? ""), target: String(event.target ?? ""), idempotencyKey: key, outcome: "pending" as const, at: event.at };
    if (event.type === "delivery_attempt") Object.assign(current, { target: event.target, at: event.at });
    else if (event.type === "delivery_succeeded" || event.type === "delivery_rejected" || event.type === "delivery_unknown") Object.assign(current, { outcome: event.type.slice("delivery_".length) as DeliveryOutcome, error: event.error });
    delivery.set(key, current);
  }
  return { runState, delivery, resultReusable: Boolean(resultId && events.some((event) => event.resultId === resultId || event.type === "result_finalized" && event.resultId === resultId || event.type === "run_succeeded" && event.resultId === resultId)) };
}
