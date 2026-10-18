import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { ModelConfig } from "../agent/model-config.js";

export const MAGPIE_MODEL_PREFIX = "magpie/";
export const MAGPIE_USER_AGENT = "Nailong/0.1";
export const magpieConfigPath = (env: NodeJS.ProcessEnv = process.env) =>
  resolve(env.NAILONG_MAGPIE_CONFIG?.trim() || join(homedir(), ".config", "nailong", "magpie.json"));

export type MagpieModel = {
  id: string; displayName: string; ownedBy?: string; reasoning?: boolean; reasoningLevels?: string[];
  contextWindow?: number; maxOutputTokens?: number; modalities?: string[];
};
export type MagpieSnapshot = {
  connected: boolean; connectionError?: string; catalog: MagpieModel[];
  catalogStatus: "unavailable" | "ready" | "stale"; catalogError?: string; refreshedAt?: string;
  selectedModel?: string; selectedAvailable: boolean; thinking?: string; thinkingAdjusted: boolean;
  favorites: string[]; drafts: boolean;
};
export type MagpiePreparedRequest = { model: ModelConfig; thinking?: string; catalogModel: MagpieModel };
type Preferences = { selectedModel?: string; thinking: Record<string, string>; favorites: string[]; drafts: boolean };
type Connection = { baseUrl: string; apiKey: string };
type JsonObject = Record<string, unknown>;
const object = (value: unknown): value is JsonObject => value !== null && typeof value === "object" && !Array.isArray(value);
const positive = (value: unknown) => typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
const strings = (value: unknown) => Array.isArray(value) && value.every(item => typeof item === "string") ? [...new Set(value as string[])] : undefined;

function decodeCatalog(value: unknown): MagpieModel[] {
  if (!object(value) || !Array.isArray(value.data)) throw new Error("invalid catalog");
  const ids = new Set<string>();
  return value.data.map((item: unknown) => {
    if (!object(item) || typeof item.id !== "string" || !item.id || ids.has(item.id)) throw new Error("invalid model");
    ids.add(item.id);
    const levels = Array.isArray(item.supported_reasoning_levels)
      ? strings(item.supported_reasoning_levels.map(level => object(level) ? level.effort : level))
      : strings(item.reasoning_levels);
    return { id: item.id, displayName: typeof item.display_name === "string" ? item.display_name : item.id,
      ownedBy: typeof item.owned_by === "string" ? item.owned_by : undefined,
      reasoning: typeof item.reasoning === "boolean" ? item.reasoning : undefined,
      reasoningLevels: levels, contextWindow: positive(item.context_window), maxOutputTokens: positive(item.max_output_tokens),
      modalities: strings(item.modalities) };
  });
}

/** One service owns the data directory. Synchronous local patches reread the current JSON immediately before writing. */
export async function createMagpieControl(options: {
  dataDir: string; configPath?: string; primaryConversationId?: string;
  onChange?: (conversationId: string) => void; catalogTimeoutMs?: number;
}) {
  const configPath = resolve(options.configPath ?? magpieConfigPath());
  mkdirSync(options.dataDir, { recursive: true });
  mkdirSync(dirname(configPath), { recursive: true });
  const db = new DatabaseSync(join(options.dataDir, "assistant.sqlite"));
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
    CREATE TABLE IF NOT EXISTS conversation_preferences(conversation TEXT PRIMARY KEY,payload TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS magpie_control_meta(key TEXT PRIMARY KEY,payload TEXT NOT NULL);`);
  const meta = <T>(key: string): T | undefined => {
    const row = db.prepare("SELECT payload FROM magpie_control_meta WHERE key=?").get(key) as { payload: string } | undefined;
    return row ? JSON.parse(row.payload) as T : undefined;
  };
  const saveMeta = (key: string, value: unknown) => db.prepare("INSERT OR REPLACE INTO magpie_control_meta VALUES(?,?)").run(key, JSON.stringify(value));
  const preferences = (id: string): Preferences => {
    const row = db.prepare("SELECT payload FROM conversation_preferences WHERE conversation=?").get(id) as { payload: string } | undefined;
    return row ? JSON.parse(row.payload) as Preferences : { thinking: {}, favorites: [], drafts: true };
  };
  const save = (id: string, prefs: Preferences) => db.prepare("INSERT OR REPLACE INTO conversation_preferences VALUES(?,?)").run(id, JSON.stringify(prefs));
  let connection: Connection | undefined;
  let connectionError: string | undefined;
  let catalog = meta<{ models: MagpieModel[]; at: string; endpoint: string }>("catalog");
  let catalogError: string | undefined;
  let ready = false;
  let needsRefresh = true;
  let closed = false;
  let pendingRefresh: Promise<void> | undefined;
  const observedKey = `observed-model:${configPath}`;
  let observed = meta<{ value: unknown }>(observedKey);
  const notify = (id?: string) => { if (id && !closed) options.onChange?.(id); };

  function readConfig(): JsonObject {
    try {
      const value: unknown = JSON.parse(readFileSync(configPath, "utf8"));
      if (!object(value)) throw new Error("invalid config");
      return value;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
      throw new Error("Magpie 连接配置无效，修正 JSON 后可重新读取。");
    }
  }

  function reload() {
    const previous = JSON.stringify(connection);
    const previousError = connectionError;
    try {
      const config = readConfig();
      const hasBase = typeof config.baseUrl === "string" && config.baseUrl.length > 0;
      const hasKey = typeof config.apiKey === "string" && config.apiKey.length > 0;
      if (hasBase !== hasKey) throw new Error("Magpie 连接配置不完整。");
      if (hasBase && hasKey) {
        let url: URL;
        try { url = new URL(config.baseUrl as string); } catch { throw new Error("Magpie 网关地址无效。"); }
        if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash)
          throw new Error("Magpie 网关地址必须为不含凭据的 HTTP(S) 地址。");
        connection = { baseUrl: url.href.replace(/\/$/, ""), apiKey: config.apiKey as string };
      } else connection = undefined;
      if (config.model !== undefined && typeof config.model !== "string") throw new Error("Magpie 模型配置必须是字符串。");
      connectionError = undefined;
      // A malformed/intermediate field is not an explicit selection and must not erase the last observation.
      if (config.model === undefined || typeof config.model === "string") {
        const value = config.model ?? null;
        if (!observed || observed.value !== value) {
          let changedConversation: string | undefined;
          db.exec("BEGIN IMMEDIATE");
          try {
            if (connection && typeof value === "string" && value.startsWith(MAGPIE_MODEL_PREFIX) && options.primaryConversationId) {
              const prefs = preferences(options.primaryConversationId);
              const id = value.slice(MAGPIE_MODEL_PREFIX.length);
              if (id && prefs.selectedModel !== id) {
                prefs.selectedModel = id;
                save(options.primaryConversationId, prefs);
                changedConversation = options.primaryConversationId;
              }
            }
            saveMeta(observedKey, { value });
            db.exec("COMMIT");
            observed = { value };
          } catch (error) { db.exec("ROLLBACK"); throw error; }
          notify(changedConversation);
        }
      }
    } catch (error) {
      // Keep the last valid state for display, but block requests until this file is valid again.
      connectionError = (error as Error).message;
    }
    if (previous !== JSON.stringify(connection) || previousError !== connectionError) {
      ready = false;
      needsRefresh = true;
      notify(options.primaryConversationId);
    }
  }

  async function refresh() {
    if (pendingRefresh) return pendingRefresh;
    if (!connection || connectionError) return;
    const frozen = { ...connection };
    needsRefresh = false;
    pendingRefresh = (async () => {
      try {
        const response = await fetch(`${frozen.baseUrl}/models`, { headers: {
          Authorization: `Bearer ${frozen.apiKey}`, "User-Agent": MAGPIE_USER_AGENT,
        }, signal: AbortSignal.timeout(options.catalogTimeoutMs ?? 5_000) });
        if (!response.ok) throw new Error("catalog HTTP failure");
        const models = decodeCatalog(await response.json());
        if (closed) return;
        reload();
        if (JSON.stringify(connection) !== JSON.stringify(frozen) || connectionError || closed) return;
        catalog = { models, at: new Date().toISOString(), endpoint: frozen.baseUrl };
        saveMeta("catalog", catalog);
        catalogError = undefined;
        ready = true;
        notify(options.primaryConversationId);
      } catch {
        if (!closed) { ready = false; catalogError = "Magpie 模型目录刷新失败，可重试；保留上次成功列表。"; }
      }
    })().finally(() => { pendingRefresh = undefined; });
    return pendingRefresh;
  }

  function thinkingFor(id: string, prefs: Preferences, model?: MagpieModel) {
    const supported = model?.reasoning === true ? model.reasoningLevels : undefined;
    if (!supported?.length || !prefs.selectedModel) return { thinking: undefined, thinkingAdjusted: false };
    const previous = prefs.thinking[prefs.selectedModel];
    if (previous && supported.includes(previous)) return { thinking: previous, thinkingAdjusted: false };
    const order = ["off", "none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"];
    const lowest = [...supported].sort((a, b) => {
      const rank = (level: string) => order.includes(level) ? order.indexOf(level) : order.length;
      return rank(a) - rank(b);
    })[0]!;
    const thinking = supported.includes("medium") ? "medium" : supported.includes("low") ? "low" : lowest;
    prefs.thinking[prefs.selectedModel] = thinking;
    save(id, prefs);
    return { thinking, thinkingAdjusted: previous !== undefined };
  }

  async function snapshot(id: string, refreshCatalog = false): Promise<MagpieSnapshot> {
    reload();
    if (refreshCatalog || needsRefresh) await refresh();
    const prefs = preferences(id);
    const model = catalog?.models.find(item => item.id === prefs.selectedModel);
    const thinking = thinkingFor(id, prefs, model);
    return { connected: !!connection && !connectionError, connectionError,
      catalog: structuredClone(catalog?.models ?? []),
      catalogStatus: !catalog ? "unavailable" : ready && catalog.endpoint === connection?.baseUrl ? "ready" : "stale",
      catalogError, refreshedAt: catalog?.at, selectedModel: prefs.selectedModel,
      selectedAvailable: !!model && catalog?.endpoint === connection?.baseUrl,
      ...thinking, favorites: [...prefs.favorites], drafts: prefs.drafts };
  }

  await snapshot(options.primaryConversationId ?? "", true);
  const timer = setInterval(() => {
    if (!closed) { reload(); if (needsRefresh) void refresh(); }
  }, 1_000);
  timer.unref();
  return {
    snapshot,
    async selectModel(id: string, modelId: string) {
      const state = await snapshot(id);
      if (!state.connected) throw new Error(state.connectionError ?? "Magpie 未连接，请先在 Magpie 连接 Nailong。");
      if (catalog?.endpoint !== connection?.baseUrl || !state.catalog.some(model => model.id === modelId))
        throw new Error("模型已不在当前目录中，请刷新并重新选择。");
      const prefs = preferences(id);
      prefs.selectedModel = modelId;
      let writtenModel: string | undefined;
      if (id === options.primaryConversationId) {
        // No awaited operation between rereading and patching: preserve the newest unrelated fields.
        const current = readConfig();
        current.model = MAGPIE_MODEL_PREFIX + modelId;
        writeFileSync(configPath, JSON.stringify(current, null, 2) + "\n", { mode: 0o600 });
        writtenModel = current.model as string;
      }
      db.exec("BEGIN IMMEDIATE");
      try {
        save(id, prefs);
        if (writtenModel !== undefined) saveMeta(observedKey, { value: writtenModel });
        db.exec("COMMIT");
        if (writtenModel !== undefined) observed = { value: writtenModel };
      } catch (error) { db.exec("ROLLBACK"); throw error; }
      notify(id);
      return snapshot(id);
    },
    async setThinking(id: string, level: string) {
      const state = await snapshot(id);
      const model = state.catalog.find(item => item.id === state.selectedModel);
      if (!model || model.reasoning !== true || !model.reasoningLevels?.includes(level)) throw new Error("当前模型未声明支持此思考等级。");
      const prefs = preferences(id);
      prefs.thinking[model.id] = level;
      save(id, prefs); notify(id);
      return snapshot(id);
    },
    async setFavorite(id: string, modelId: string, enabled: boolean) {
      const state = await snapshot(id);
      if (enabled && !state.catalog.some(item => item.id === modelId)) throw new Error("模型已不在当前目录中。");
      const prefs = preferences(id);
      prefs.favorites = prefs.favorites.filter(item => item !== modelId);
      if (enabled) prefs.favorites.push(modelId);
      save(id, prefs);
      return snapshot(id);
    },
    async setDraft(id: string, enabled: boolean) {
      reload();
      const prefs = preferences(id);
      prefs.drafts = enabled;
      save(id, prefs);
      return snapshot(id);
    },
    async prepareRequest(id: string): Promise<MagpiePreparedRequest> {
      const state = await snapshot(id);
      if (!state.connected || !connection) throw new Error(state.connectionError ?? "Magpie 未连接，请先在 Magpie 连接 Nailong。");
      if (!state.selectedModel) throw new Error("尚未选择主模型，请在控制面板选择后继续。");
      const model = state.catalog.find(item => item.id === state.selectedModel);
      if (!model || !state.selectedAvailable) throw new Error("已选模型不在当前目录中，请重新选择模型。");
      return { model: { alias: "magpie", api: "openai-completions", baseUrl: connection.baseUrl,
        apiKey: connection.apiKey, model: model.id, contextWindow: model.contextWindow,
        maxTokens: model.maxOutputTokens, reasoning: model.reasoning,
        images: model.modalities?.includes("image") }, thinking: state.thinking, catalogModel: structuredClone(model) };
    },
    close() { closed = true; clearInterval(timer); db.close(); },
  };
}

export type MagpieControl = Awaited<ReturnType<typeof createMagpieControl>>;
