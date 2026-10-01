import { createTelegramOutput } from "./telegram-output.js";
import { createEventReader } from "../runtime/event-reader.js";
import type { RuntimeLog } from "../runtime/runtime-types.js";
import type { TelegramTransport } from "./telegram-types.js";
import { createLegacyTelegramProjection } from "./telegram-legacy.js";
export type { TelegramTransport } from "./telegram-types.js";
export { splitTelegramText } from "./telegram-legacy.js";

/** Old records keep their original delivery semantics; new records use immutable pages. */
export function createTelegramProjection(options: { log: RuntimeLog; chatId: number } & TelegramTransport) {
  options = { ...options, log: { ...options.log, read: createEventReader(options.log) } };
  const legacy = createLegacyTelegramProjection(options);
  const current = createTelegramOutput(options);
  async function output(id: string) {
    const snapshot = (await options.log.read()).findLast((event) => event.type === "text_snapshot" && event.textSegmentId === id);
    return snapshot?.protocolVersion === "json-text-v2" ? current : legacy;
  }
  return {
    async reconcile(id: string, visibleText?: string) {
      const selected = await output(id);
      return selected === legacy ? legacy.reconcile(id, visibleText) : current.reconcile(id);
    },
    async stream(id: string) { await (await output(id)).stream(id); },
    async finalDelivered(id: string) { return (await output(id)).finalDelivered(id); },
    async requestDelivered(id: string) { return current.requestDelivered(id); },
    async finish() { await Promise.all([legacy.finish(), current.finish()]); },
    async stop() { await Promise.all([legacy.stop(), current.stop()]); },
    interrupt() { legacy.interrupt(); current.interrupt(); },
    resume() { legacy.resume(); current.resume(); },
  };
}
