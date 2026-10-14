import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type ServerResponse } from "node:http";
import {
  createAssistant,
  type AssistantOptions,
  type AssistantOutput,
} from "../../src/assistant/runtime.js";

export type Wire = {
  messages: Array<{ role: string; content: unknown; tool_call_id?: string }>;
  tools: Array<{ function: { name: string } }>;
};
export async function assistantFixture(
  provider: (wire: Wire, response: ServerResponse) => void | Promise<void>,
  configure?: (cwd: string) => Promise<Partial<AssistantOptions>>,
) {
  const directory = await mkdtemp(join(tmpdir(), "assistant-behavior-"));
  const server = createServer(async (request, response) => {
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
  const overrides = await configure?.(directory);
  const options: AssistantOptions = {
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
