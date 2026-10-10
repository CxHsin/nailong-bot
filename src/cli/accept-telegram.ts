import { Bot } from "grammy";
import { acceptanceOptions, acceptanceScenario, runTelegramAcceptance } from "./telegram-acceptance.js";
import { createGrammyRichTransport } from "../channel/telegram/grammy-rich-transport.js";
import { readBuildIdentity } from "../runtime/build-identity.js";

const usage = "npm run telegram:accept -- [--send --chat-id OWNER_ID]；默认只预览，--send 会留下正式测试消息。";
try {
  const options = acceptanceOptions(process.argv.slice(2), process.env);
  if (options.mode === "help") console.log(usage);
  else if (options.mode === "preview") console.log(JSON.stringify({ mode: "preview", identity: await readBuildIdentity(), scenario: acceptanceScenario, visualAcceptance: "pending" }, null, 2));
  else {
    const bot = new Bot(options.token, { client: { timeoutSeconds: 10 } });
    const report = await runTelegramAcceptance(createGrammyRichTransport(bot.api), options.chatId, await readBuildIdentity());
    console.log(JSON.stringify(report, null, 2));
    if (report.apiAcceptance !== "passed") process.exitCode = 1;
  }
} catch {
  // grammY errors can include the token URL or request content; never print them here.
  console.error(`Telegram 验收未完成。请检查参数、owner 配置和 API 可用性。${usage}`); process.exitCode = 1;
}
