import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHost } from "../src/host/host.js";
import { createRuntimeLog } from "../src/runtime/runtime-log.js";
import { normalizeTelegramInput } from "../src/channel/telegram/index.js";
import { createCliChannel } from "../src/cli/cli-channel.js";
import { contextItemsFromEvents, projectProviderContext } from "../src/context/provider-aware.js";

test("Telegram and CLI continue one conversation and redeliver a result without another model call", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "cross-channel-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const log = createRuntimeLog(dir); let executions = 0;
  const host = createHost({ log, execute: async (input) => { executions++; return { text: `ok:${input.conversationId}` }; } });
  const telegram = normalizeTelegramInput({ fromId: 42, chatId: 42, chatType: "private", messageId: 1, text: "来自 Telegram" });
  const telegramRun = host.submit(telegram); const telegramEvents: Awaited<ReturnType<typeof log.read>> = [];
  for await (const _event of telegramRun.events()) { /* consume */ }
  const telegramTerminal = await telegramRun.done;
  const cliOutput: string[] = [];
  const cli = createCliChannel({ host, actor: { id: "cli", kind: "user" }, stdout: (line) => cliOutput.push(line), stderr: () => {} });
  const cliTerminal = await cli.send("来自 CLI", { json: true, conversationId: telegram.conversationId });
  assert.equal(cliTerminal.conversationId, telegram.conversationId);
  assert.equal(executions, 2);
  const resultId = String((telegramTerminal.result as { resultId: string }).resultId);
  const redelivered: string[] = [];
  await host.redeliver(resultId, async (result) => { redelivered.push(String(result.text)); });
  assert.equal(executions, 2);
  assert.deepEqual(redelivered, [`ok:${telegram.conversationId}`]);
  const projected = projectProviderContext({ conversationId: telegram.conversationId, capabilities: {
    provider: "fake", model: "m", promptProfile: "default", reasoningReplay: false, promptCaching: true, images: true, compaction: true, appendConfigurationUpdates: true,
  }, items: contextItemsFromEvents(await log.read()) });
  assert.equal(projected.messages.filter((message) => message.role === "user").length, 2);
  assert.ok(cliOutput.every((line) => JSON.parse(line).runId));
  void telegramEvents;
});
