import { createInterface } from 'node:readline/promises';
import { stdin, stdout, stderr } from 'node:process';
import { readFile } from 'node:fs/promises';
import { createPersonalRuntime } from '../personal/runtime.js';
import { createPlainChannel, cliInput } from '../personal/channels.js';
import { parseCliArgs } from './cli-channel.js';

async function main() {
  const args = parseCliArgs(process.argv.slice(2));
  const actorId = process.env.AGENT_ACTOR_ID?.trim() || 'cli';
  const conversationId = args.conversationId ?? `cli:${actorId}`;
  const runtime = await createPersonalRuntime();
  const channel = createPlainChannel({ host: runtime.host, accepts: id => id === conversationId,
    sendText: async (text, delivery) => { stdout.write(`${args.json ? JSON.stringify({ type: 'message', ...delivery, text }) : text}\n`); return delivery.id; },
    sendFile: async (path, delivery) => { stdout.write(`${args.json ? JSON.stringify({ type: 'file', path, taskId: delivery.taskId }) : `文件：${path}`}\n`); return delivery.id; },
    onDelivered: runtime.onDelivered, reportFailure: error => stderr.write(`${String(error)}\n`) });
  let tickTail = Promise.resolve();
  const timer = setInterval(() => { tickTail = tickTail.then(async () => { await runtime.plans.tick(); await channel.recover(); }).catch(error => { stderr.write(`${String(error)}\n`); }); }, 1000);
  timer.unref();
  try {
    await channel.recover();
    if (args.command === 'send') {
      const input = cliInput(args.text ?? '', conversationId, actorId);
      if (args.imagePath) {
        const bytes = await readFile(args.imagePath);
        input.images = [{ type: 'image', mimeType: args.imagePath.toLowerCase().endsWith('.png') ? 'image/png' : 'image/jpeg', data: bytes.toString('base64') }];
      }
      await channel.receive(input); await runtime.host.waitForIdle();
    } else {
      const reader = createInterface({ input: stdin, output: stdout });
      const pending = new Set<Promise<unknown>>();
      const interrupt = () => reader.close();
      reader.on('SIGINT', interrupt);
      try {
        for await (const text of reader) {
          const result = channel.receive(cliInput(text, conversationId, actorId)); pending.add(result);
          void result.catch(error => stderr.write(`${String(error)}\n`)).finally(() => pending.delete(result));
        }
        await Promise.allSettled(pending);
      } finally { reader.off('SIGINT', interrupt); reader.close(); }
    }
    await channel.flush();
  } finally { clearInterval(timer); await tickTail; await channel.close(); await runtime.close(); }
}

main().catch(error => { stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; });
