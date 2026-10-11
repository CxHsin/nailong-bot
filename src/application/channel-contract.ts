import type { HostEvent, HostInputLike, RunHandle } from "../host/host.js";
import type { DeliveryContent, ContentTransport } from "../runtime/content-delivery.js";

export type ChannelHost = { submit(input: HostInputLike): RunHandle };

/** Telegram's startup and delivery operations; unrelated application/Host operations stay private. */
export type TelegramChannelHost = ChannelHost & {
  notifyRecovery(channel: "cli" | "telegram", send: (text: string, id: string) => Promise<void>): Promise<void>;
  recordProgress(event: HostEvent, fact: Record<string, unknown>): Promise<void>;
  deliverContent(event: HostEvent, content: DeliveryContent, transport: ContentTransport, signal?: AbortSignal): Promise<{
    complete: boolean; messageId?: number;
  }>;
};
