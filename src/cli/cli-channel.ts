export type CliCommand = { command: "chat" | "send"; text?: string; conversationId?: string; json: boolean; imagePath?: string };
export function parseCliArgs(argv: string[]): CliCommand {
  const command = argv[0] === "chat" || argv[0] === "send" ? argv[0] : "chat";
  let text: string | undefined; let conversationId: string | undefined; let json = false; let imagePath: string | undefined;
  for (let index = command === "chat" || command === "send" ? 1 : 0; index < argv.length; index++) {
    const value = argv[index]!;
    if (value === "--json" || value === "--ndjson") json = true;
    else if (value === "--conversation-id") conversationId = argv[++index];
    else if (value === "--image") imagePath = argv[++index];
    else text = text ? `${text} ${value}` : value;
  }
  return { command, ...(text ? { text } : {}), ...(conversationId ? { conversationId } : {}), json, ...(imagePath ? { imagePath } : {}) };
}
