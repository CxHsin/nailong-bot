export type CliCommand = { command: "chat" | "send"; text?: string; conversationId?: string; json: boolean; imagePath?: string; mode?: 'trusted' | 'restricted' };
export function parseCliArgs(argv: string[]): CliCommand {
  const command = argv[0] === "chat" || argv[0] === "send" ? argv[0] : "chat";
  let text: string | undefined; let conversationId: string | undefined; let json = false; let imagePath: string | undefined; let mode: CliCommand['mode'];
  for (let index = command === "chat" || command === "send" ? 1 : 0; index < argv.length; index++) {
    const value = argv[index]!;
    if (value === "--json" || value === "--ndjson") json = true;
    else if (value === '--restricted') throw new Error('新 Pi 入口仅支持可信执行，未提供受限模式');
    else if (value === '--full-access') mode = 'trusted';
    else if (value === "--conversation-id") conversationId = argv[++index];
    else if (value === "--image") imagePath = argv[++index];
    else text = text ? `${text} ${value}` : value;
  }
  if (command === 'send' && mode) throw new Error('执行模式选项仅适用于本地交互 chat');
  return { command, ...(text ? { text } : {}), ...(conversationId ? { conversationId } : {}), json, ...(imagePath ? { imagePath } : {}), ...(mode ? { mode } : {}) };
}
