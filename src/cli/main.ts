import { createInterface } from "node:readline/promises";
import { stdin, stdout, stderr } from "node:process";
import { readFile } from "node:fs/promises";
import { randomUUID, createHash } from "node:crypto";
import { resolve } from "node:path";
import { assistantEnvironment } from "../assistant/environment.js";
import { parseCliArgs } from "./cli-channel.js";

async function main() {
  const args = parseCliArgs(process.argv.slice(2));
  const runtime = await assistantEnvironment();
  const actor = process.env.AGENT_ACTOR_ID?.trim() || "cli";
  const conversationId =
    args.conversationId ??
    `cli:${actor}:${createHash("sha256")
      .update(resolve(process.env.ASSISTANT_WORK_DIR || "."))
      .digest("hex")
      .slice(0, 24)}`;
  const unsubscribe = runtime.app.subscribe((output) => {
    if (output.conversationId === conversationId)
      stdout.write(
        `${args.json ? JSON.stringify(output) : output.type === "text" ? output.text : `文件：${output.path}`}\n`,
      );
  });
  let reader: ReturnType<typeof createInterface> | undefined;
  const stop = () => {
    reader?.close();
    void runtime.close().catch((error) => {
      stderr.write(`${String(error)}\n`);
    });
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  const receive = async (text: string) => {
    const images = args.imagePath
      ? [
          {
            type: "image" as const,
            mimeType: args.imagePath.toLowerCase().endsWith(".png")
              ? "image/png"
              : "image/jpeg",
            data: (await readFile(args.imagePath)).toString("base64"),
          },
        ]
      : undefined;
    await runtime.app.receive({
      conversationId,
      inputId: randomUUID(),
      source: "cli",
      text,
      images,
    });
  };
  try {
    if (args.command === "send") await receive(args.text ?? "");
    else {
      reader = createInterface({ input: stdin, output: stdout });
      try {
        for await (const text of reader) await receive(text);
      } finally {
        reader.close();
      }
    }
    await runtime.app.waitForIdle();
  } finally {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
    await runtime.close();
    unsubscribe();
  }
}
main().catch((error) => {
  stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
