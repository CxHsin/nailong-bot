// Integration probe only. The production assistant does not import this file.
import { createModels, createProvider } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { openAIResponsesApi } from "@earendil-works/pi-ai/api/openai-responses.lazy";
import { anthropicMessagesApi } from "@earendil-works/pi-ai/api/anthropic-messages.lazy";
import { defineTool, section } from "@earendil-works/pi-durable";
import {
  formatSkillsForPrompt, loadSkills, loadProjectContextFiles,
} from "@mariozechner/pi-coding-agent";
import { configuredModel } from "../../../src/agent/model-config.ts";
import { durableHerdrWatch } from "../../../src/assistant/herdr.ts";

export function adaptedModels(configuration) {
  const models = createModels();
  const aliases = new Map();
  const apis = {
    "openai-completions": openAICompletionsApi,
    "openai-responses": openAIResponsesApi,
    "anthropic-messages": anthropicMessagesApi,
  };
  for (const config of configuration.models) {
    const model = configuredModel(config);
    models.setProvider(createProvider({
      id: model.provider, name: config.alias, baseUrl: model.baseUrl,
      auth: { apiKey: { name: config.alias,
        resolve: async () => ({ auth: { apiKey: config.apiKey } }),
      } },
      models: [model], api: apis[config.api](),
    }));
    aliases.set(config.alias, { provider: model.provider, modelId: model.id });
  }
  return { models, aliases };
}

export function resourceSections(cwd, agentDir, skillPaths) {
  const project = loadProjectContextFiles({ cwd, agentDir });
  const { skills, diagnostics } = loadSkills({ cwd, agentDir, skillPaths, includeDefaults: false });
  return {
    project, skills, diagnostics,
    sections: [
      section("project", () => project.map(f => `${f.path}\n${f.content}`).join("\n\n")),
      section("skills", () => formatSkillsForPrompt(skills)),
    ],
  };
}

// Reuse the real herdr_watch validation/identity implementation. This adapter is
// deliberately limited to that extension, not a generic legacy extension host.
export function adaptedHerdrWatch(client, records, save) {
  return durableHerdrWatch(client, records, save);
}
