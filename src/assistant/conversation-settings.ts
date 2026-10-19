import type { ModelConfig, ModelConfiguration } from "../agent/model-config.js";
import type { createDurableExecutor } from "./durable-executor.js";
import { createMagpieControl, type MagpieControl, type MagpieSnapshot, type MagpieRoutingSnapshot } from "./magpie.js";

type SettingsAction =
  | {type:"model";model:string} | {type:"thinking";level:string}
  | {type:"routing_model";model:string}
  | {type:"favorite";model:string;enabled:boolean} | {type:"draft";enabled:boolean};

/** Coordinates saved Conversation settings with future Durable request preparation. */
export async function createConversationSettings(options: {
  dataDir: string;
  magpie?: {configPath?:string;primaryConversationId?:string;catalogTimeoutMs?:number};
  modelConfiguration?: ModelConfiguration;
  conversations: () => Array<{id:string}>;
  onRunnable: (id: string) => void;
  reportFailure: (error: unknown) => void;
}) {
  const snapshots = new Map<string, MagpieSnapshot>();
  const lanes = new Map<string, Promise<MagpieSnapshot>>();
  const runnable = new Set<string>();
  let stopped = false;
  let magpie: MagpieControl | undefined;
  let executor: Pick<Awaited<ReturnType<typeof createDurableExecutor>>, "configureModel"> | undefined;

  function staticSnapshot(): MagpieSnapshot {
    const config = options.modelConfiguration;
    return {
      connected:true,catalogStatus:"ready",
      catalog:(config?.models ?? []).map(model => ({id:model.model,displayName:model.alias,reasoning:model.reasoning,contextWindow:model.contextWindow})),
      selectedModel:config?.models.find(model => model.alias === config.defaultModel)?.model,
      selectedAvailable:true,thinkingAdjusted:false,favorites:[],drafts:true,
    };
  }

  function synchronize(id: string, refresh = false): Promise<MagpieSnapshot> {
    if (!magpie) return Promise.resolve(staticSnapshot());
    const pending = (lanes.get(id) ?? Promise.resolve()).catch(options.reportFailure).then(async () => {
      if (stopped || !magpie) throw new Error("Magpie 控制服务不可用");
      const snapshot = await magpie.snapshot(id, refresh);
      snapshots.set(id, snapshot);
      if (snapshot.connected && snapshot.selectedModel && snapshot.selectedAvailable) {
        const prepared = await magpie.prepareRequest(id);
        await executor!.configureModel(id, prepared, prepared.availableModels);
        runnable.add(id);
      } else {
        runnable.delete(id);
        await executor!.configureModel(id);
      }
      if (!stopped && runnable.has(id)) options.onRunnable(id);
      return snapshot;
    });
    lanes.set(id, pending);
    void pending.then(() => { if (lanes.get(id) === pending) lanes.delete(id); }, () => { if (lanes.get(id) === pending) lanes.delete(id); });
    return pending;
  }

  const useMagpie = options.magpie !== undefined || options.modelConfiguration === undefined;
  if (useMagpie) magpie = await createMagpieControl({dataDir:options.dataDir,...options.magpie,onChange(id) {
    // Initial Magpie observations precede Durable creation and are restored by the normal subscription path.
    if (!executor || stopped) return;
    const affected = id ? [id] : options.conversations().map(item => item.id);
    for (const conversationId of affected) void synchronize(conversationId).catch(options.reportFailure);
  }});

  return {
    enabled: !!magpie,
    initialModelConfiguration: magpie ? {defaultModel:"",models:[]} : options.modelConfiguration!,
    attachExecutor(value: NonNullable<typeof executor>) { executor = value; },
    synchronize,
    async synchronizeRegistered() {
      if (magpie) for (const {id} of options.conversations()) await synchronize(id);
    },
    async query(id: string, refresh = false) {
      const saved = await synchronize(id, refresh);
      // Connection/catalog observations are global, including tasks created while a query is waiting.
      while (lanes.size) await Promise.all(lanes.values());
      return saved;
    },
    cached(id: string) { return snapshots.get(id); },
    async routingSnapshot(): Promise<MagpieRoutingSnapshot> {
      return magpie ? magpie.routingSnapshot() : {scope:"service",connected:false,catalog:[],catalogStatus:"unavailable",selectedAvailable:false};
    },
    async prepareRoutingRequest() {
      return magpie ? magpie.prepareRoutingRequest() : {reason:"not_configured"};
    },
    async prepareMainRequest(id: string): Promise<{model:ModelConfig;thinking?:string}|undefined> {
      if (!magpie) {
        const model = options.modelConfiguration?.models.find(item=>item.alias===options.modelConfiguration?.defaultModel);
        return model ? {model:{...model}} : undefined;
      }
      const current = await magpie.snapshot(id);
      if (!current.connected || !current.selectedModel || !current.selectedAvailable) return undefined;
      const prepared = await magpie.prepareRequest(id);
      return {model:{...prepared.model},thinking:prepared.thinking};
    },
    canRun(id: string) { return !magpie || runnable.has(id); },
    async update(id: string, action: SettingsAction) {
      if (!magpie) throw new Error("旧主模型配置已退役，请连接 Magpie 后从模型目录选择。");
      if (action.type === "routing_model") { await magpie.selectRoutingModel(action.model); return; }
      if (action.type === "model") await magpie.selectModel(id,action.model);
      if (action.type === "thinking") await magpie.setThinking(id,action.level);
      if (action.type === "favorite") await magpie.setFavorite(id,action.model,action.enabled);
      if (action.type === "draft") await magpie.setDraft(id,action.enabled);
      await synchronize(id);
    },
    assertRequestAllowed(model: ModelConfig) { magpie?.assertRequestAllowed(model); },
    async waitForIdle() { await Promise.allSettled(lanes.values()); },
    stop() { stopped = true; },
    async drain() { while (lanes.size) await Promise.allSettled(lanes.values()); },
    close() { magpie?.close(); },
  };
}
