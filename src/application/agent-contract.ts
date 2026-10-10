import type { Message, Request } from "./app-types.js";
import type { SkillSnapshot } from "../agent/skills.js";
import type { ProgressSummaryGenerator } from "./progress-summaries.js";

/** The execution and capability operations actually consumed by the application. */
export type AgentExecution = {
  answer(messages: Message[], request: Request): Promise<string>;
  purgeEmbeddingCache?: () => void;
  prepareCapabilities?: (text: string, request: Request) => Promise<void>;
  validateInput?: (text: string, channel?: string) => Promise<SkillSnapshot>;
  installSkill?: (text: string, request: Request) => Promise<string | undefined>;
  summarizeProgress?: ProgressSummaryGenerator;
  defaultModel?: string;
  models?: ReadonlyArray<{ alias: string; name: string }>;
  memoryVector?: (text: string) => number[] | undefined;
};
