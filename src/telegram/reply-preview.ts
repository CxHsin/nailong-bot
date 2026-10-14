import type { AgentSessionEvent } from '@mariozechner/pi-coding-agent';

/** Only public model text from the current assistant message, never reasoning or tool arguments. */
export function publicReplyText(event: AgentSessionEvent): string | undefined {
  if (event.type === 'message_start' && event.message.role === 'assistant') return '';
  if (event.type !== 'message_update' || event.message.role !== 'assistant' ||
      !['text_delta', 'text_end'].includes(event.assistantMessageEvent.type)) return;
  return event.message.content.filter(part => part.type === 'text').map(part => part.text).join('\n');
}
