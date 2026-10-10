import { createInterface } from "node:readline/promises";
import { stdin, stdout, stderr } from "node:process";
import { resolve } from "node:path";
import { createRuntimeEventLog } from "../runtime/event-log.js";
import { createPiAgent } from "../agent/pi-agent.js";
import { modelEnvironment } from "../agent/model-config.js";
import { createAgentHost } from "../application/agent-host.js";
import { createCliChannel, parseCliArgs } from "./cli-channel.js";
import { capabilityEnvironment } from "../agent/capability-config.js";

async function main() {
  const args = parseCliArgs(process.argv.slice(2));
  const dataDir = resolve(process.env.AGENT_DATA_DIR?.trim() || "data");
  const promptFile = resolve(process.env.AGENT_PROMPT_FILE?.trim() || "system-prompt.md");
  const modelConfiguration = modelEnvironment(process.env);
  const log = await createRuntimeEventLog(dataDir);
  const agent = await createPiAgent({ ...await capabilityEnvironment(process.env), dataDir, promptFile, modelConfiguration, tinyfishKey: process.env.TINYFISH_API_KEY?.trim() });
  const host = createAgentHost({ log, dataDir, promptFile, agent });
  await host.recoverInterrupted();
  const cli = createCliChannel({ host, actor: { id: process.env.AGENT_ACTOR_ID?.trim() || "cli", kind: "user" }, stdout: (line) => stdout.write(`${line}\n`), stderr: (line) => stderr.write(`${line}\n`),
    onDelivered: (event) => host.recordDelivery(event, { channel: "cli" }) });
  try {
    if (args.command === "send") await cli.send(args.text, { json: args.json, conversationId: args.conversationId, imagePath: args.imagePath });
    else {
      const reader = createInterface({ input: stdin, output: stdout });
      try { await cli.chat((async function* () { for await (const line of reader) yield line; })(), { json: args.json, conversationId: args.conversationId }); }
      finally { reader.close(); }
    }
  } finally { await agent.close(); }
}

main().catch((error) => { stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; });
