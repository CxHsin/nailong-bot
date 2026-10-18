import { mkdir, mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type ServerResponse } from "node:http";
import { PersistentAssistantQueue } from "../../src/assistant/queue.js";
import {
  createAssistant,
  type AssistantOptions,
  type AssistantOutput,
} from "../../src/assistant/runtime.js";

export type Wire = {
  messages: Array<{ role: string; content: unknown; tool_call_id?: string }>;
  tools: Array<{ function: { name: string } }>;
};
// Classifier-specific scenarios need unfinished work; idle conversations bypass it.
export async function seedPendingAssistantWork(directory: string, conversationId: string) {
  const dataDir = join(directory, "fresh");
  await mkdir(dataDir, { recursive: true });
  const queue = new PersistentAssistantQueue(join(dataDir, "queue.sqlite"));
  try {
    queue.receive({ conversationId, inputId: "pending-context", text: "unfinished background report" });
    queue.settle(queue.claim(conversationId)!.id, "paused");
  } finally { queue.close(); }
}
export async function assistantFixture(
  provider: (wire: Wire, response: ServerResponse) => void | Promise<void>,
  configure?: (cwd: string) => Promise<Partial<AssistantOptions>>,
  magpie?: { catalog?: Array<Record<string, unknown>>; selectedModel?: string | null; primaryConversationId?: string },
) {
  const directory = await mkdtemp(join(tmpdir(), "assistant-behavior-"));
  let catalog = magpie?.catalog ?? [{ id: "local", display_name: "local", reasoning: false }];
  let catalogRequests = 0;
  const server = createServer(async (request, response) => {
    if (request.method === "GET" && request.url === "/v1/models") {
      catalogRequests++;
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ data: catalog }));
      return;
    }
    let body = "";
    for await (const part of request) body += part;
    try {
      await provider(JSON.parse(body), response);
    } catch (error) {
      response.writeHead(500);
      response.end(String(error));
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Fixture port missing");
  const baseUrl = `http://127.0.0.1:${address.port}/v1`;
  const magpieConfigPath = join(directory, "magpie.json");
  const selectedModel = magpie?.selectedModel === null ? undefined : magpie?.selectedModel ?? "local";
  await writeFile(magpieConfigPath, JSON.stringify({ baseUrl, apiKey: "test", ...(selectedModel ? { model: `magpie/${selectedModel}` } : {}) }));
  const overrides = await configure?.(directory);
  const options: AssistantOptions & {modelConfiguration: NonNullable<AssistantOptions["modelConfiguration"]>} = {
    cwd: directory,
    dataDir: join(directory, "fresh"),
    modelConfiguration: {
      defaultModel: "local",
      models: [
        {
          alias: "local",
          api: "openai-completions",
          baseUrl: "",
          model: "local",
          apiKey: "test",
        },
      ],
    },
    ...overrides,
    ...(magpie ? { magpie: { configPath: magpieConfigPath, primaryConversationId: magpie.primaryConversationId } } : {}),
  };
  options.modelConfiguration.models = options.modelConfiguration.models.map(
    (model) => ({ ...model, baseUrl: `http://127.0.0.1:${address.port}` }),
  );
  let app = await createAssistant(options);
  const outputs: AssistantOutput[] = [];
  app.subscribe((output) => {
    outputs.push(output);
  });
  return {
    directory,
    baseUrl,
    magpieConfigPath,
    get catalogRequests() { return catalogRequests; },
    setCatalog(models: Array<Record<string, unknown>>) { catalog = models; },
    async writeMagpie(patch: Record<string, unknown>) {
      const current = JSON.parse(await readFile(magpieConfigPath, "utf8"));
      await writeFile(magpieConfigPath, JSON.stringify({ ...current, ...patch }));
    },
    options,
    get app() {
      return app;
    },
    outputs,
    async reopen() {
      await app.close();
      app = await createAssistant(options);
      app.subscribe((output) => {
        outputs.push(output);
      });
    },
    async close() {
      await app.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(directory, { recursive: true, force: true });
    },
  };
}
