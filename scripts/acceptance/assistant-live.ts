import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { randomUUID } from "node:crypto";
import { createAssistant } from "../../src/assistant/runtime.js";
import { modelEnvironment } from "../../src/agent/model-config.js";

// Explicit live acceptance entry. Outputs stay outside the project and contain no credentials.
const directory = resolve(process.argv[2] ?? "");
const promptPath = resolve(process.argv[3] ?? "");
if (process.argv.length < 4)
  throw new Error("Usage: assistant-live.ts OUTPUT_DIRECTORY PROMPT_FILE");
await mkdir(directory, { recursive: true });
const transcript: unknown[] = [];
const configuration = modelEnvironment(process.env);
if (process.argv[4]) configuration.defaultModel = process.argv[4];
const app = await createAssistant({
  cwd: directory,
  dataDir: join(directory, "pi-data"),
  modelConfiguration: configuration,
  prompt: await readFile(resolve("system-prompt.md"), "utf8"),
  skillPaths: [resolve(".agents/skills")],
});
let finished!: () => void;
const completion = new Promise<void>((resolve) => {
  finished = resolve;
});
app.subscribe(async (output) => {
  transcript.push({ at: new Date().toISOString(), ...output });
  await writeFile(
    join(directory, "transcript.json"),
    JSON.stringify(transcript, null, 2),
  );
  if (output.type === "text") {
    console.log(output.text);
    if (
      output.text.includes("LIVE_ACCEPTANCE_DONE") ||
      output.text.startsWith("模型调用失败：")
    )
      finished();
  }
});
const timeout = setTimeout(() => {
  console.error("Live acceptance timed out; preserve helper state.");
  finished();
}, 300_000);
try {
  await app.receive({
    conversationId: "acceptance",
    inputId: randomUUID(),
    text: await readFile(promptPath, "utf8"),
  });
  await completion;
  await app.waitForIdle();
} finally {
  clearTimeout(timeout);
  await app.close();
}
