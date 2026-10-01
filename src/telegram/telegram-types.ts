export type TelegramTransport = {
  send(text: string, chatId: number, parseMode?: "HTML"): Promise<number>;
  edit(messageId: number, text: string, chatId: number, parseMode?: "HTML"): Promise<void>;
  draft?(draftId: number, text: string, chatId: number, parseMode?: "HTML"): Promise<void>;
  isRejected?: (error: unknown) => boolean;
  retryAfter?: (error: unknown) => number | undefined;
};
