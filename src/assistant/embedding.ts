import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

export type EmbeddingConfig = { id:string; displayName:string; baseUrl:string; model:string; apiKeyEnv:string;
  timeoutMs?:number; maxInputChars?:number; version?:string };
export type EmbeddingOptions = { configPath?:string; configs?:EmbeddingConfig[]; env?:NodeJS.ProcessEnv };
export type EmbeddingProgress = {status:"not_started"|"preparing"|"ready"|"degraded";total:number;completed:number;failed:number;learned?:number;reason?:string};
export type EmbeddingTest = {status:"success"|"failed";configId?:string;model?:string;at:string;durationMs:number;dimensions?:number;reason?:string};
export type EmbeddingSnapshot = {scope:"service";catalog:Array<{id:string;displayName:string;model:string;available:boolean;error?:string}>;
  selectedId?:string;selectedAvailable:boolean;connectionStatus:"not_configured"|"invalid_config"|"untested"|"ready"|"unavailable";
  reason?:string;test?:EmbeddingTest;progress:EmbeddingProgress};
export type EmbeddingSpace = {id:string;configId:string;model:string;version?:string;dimensions:number;preprocessing:string;normalization:"l2"};
export type EmbeddingResult = {vectors:number[][];space:EmbeddingSpace;configId:string};
type ReadyConfig = EmbeddingConfig & {apiKey:string;timeoutMs:number;maxInputChars:number;fingerprint:string;connectionFingerprint:string};
type ConnectionReceipt = {fingerprint:string;status:"ready"|"unavailable";reason?:string};
type TestReceipt = {fingerprint?:string;result:EmbeddingTest};
const syntheticText = "Nailong Embedding connection test. 奶龙连接测试。";
const preprocessing = "unicode-codepoint-weighted-mean-v1";
const hash = (value:unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const object = (value:unknown):value is Record<string,unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const initialProgress = ():EmbeddingProgress => ({status:"not_started",total:0,completed:0,failed:0});

export class EmbeddingError extends Error {
  constructor(public readonly code:"not_configured"|"invalid_config"|"authentication"|"timeout"|"network"|"invalid_response"|"cancelled"|"http", message:string) {super(message);}
}

/** Owns local configuration, service-wide selection and bounded embedding requests. No generation or memory writes. */
export class EmbeddingService {
  private readonly db:DatabaseSync;
  private readonly env:NodeJS.ProcessEnv;
  private closed = false;
  private readonly requests = new Set<Promise<unknown>>();
  private readonly controllers = new Set<AbortController>();
  constructor(dataDir:string, private readonly options:EmbeddingOptions = {}) {
    this.env = options.env ?? process.env;
    this.db = new DatabaseSync(join(dataDir,"assistant.sqlite"));
    this.db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS embedding_meta(key TEXT PRIMARY KEY,payload TEXT NOT NULL)");
  }
  private load<T>(key:string):T|undefined {
    const row = this.db.prepare("SELECT payload FROM embedding_meta WHERE key=?").get(key) as {payload:string}|undefined;
    return row ? JSON.parse(row.payload) as T : undefined;
  }
  private save(key:string,value:unknown) {this.db.prepare("INSERT OR REPLACE INTO embedding_meta VALUES(?,?)").run(key,JSON.stringify(value));}
  private configurations():{catalog:EmbeddingSnapshot["catalog"];ready:ReadyConfig[];error?:string} {
    try {
      let raw:unknown = this.options.configs;
      if (this.options.configPath) {
        const file:unknown = JSON.parse(readFileSync(resolve(this.options.configPath),"utf8"));
        if (!object(file) || !Array.isArray(file.models)) throw new Error("invalid list");
        raw = file.models;
      }
      if (raw === undefined) {
        const {EMBEDDING_BASE_URL:baseUrl,EMBEDDING_MODEL:model,EMBEDDING_API_KEY:apiKey} = this.env;
        raw = baseUrl?.trim() && model?.trim() && apiKey?.trim() ? [{id:"environment",displayName:model.trim(),baseUrl:baseUrl.trim(),model:model.trim(),apiKeyEnv:"EMBEDDING_API_KEY",
          timeoutMs:this.env.EMBEDDING_TIMEOUT_MS ? Number(this.env.EMBEDDING_TIMEOUT_MS) : undefined,
          maxInputChars:this.env.EMBEDDING_MAX_INPUT_CHARS ? Number(this.env.EMBEDDING_MAX_INPUT_CHARS) : undefined}] : [];
        if (!(raw as unknown[]).length && [baseUrl,model,apiKey].some(value=>value?.trim())) throw new Error("incomplete environment");
      }
      if (!Array.isArray(raw)) throw new Error("invalid list");
      const ids = new Set<string>(); const ready:ReadyConfig[] = []; const catalog:EmbeddingSnapshot["catalog"] = [];
      for (const item of raw) {
        if (!object(item) || typeof item.id !== "string" || !item.id.trim() || ids.has(item.id)) throw new Error("invalid identity");
        ids.add(item.id);
        const displayName = typeof item.displayName === "string" && item.displayName.trim() ? item.displayName : item.id;
        const model = typeof item.model === "string" ? item.model : "";
        try {
          if (!model.trim() || typeof item.baseUrl !== "string" || typeof item.apiKeyEnv !== "string" || !item.apiKeyEnv.trim() || (item.version !== undefined && typeof item.version !== "string")) throw new Error("invalid config");
          const url = new URL(item.baseUrl);
          if (!["http:","https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error("invalid URL");
          const timeoutMs = item.timeoutMs ?? 3000; const maxInputChars = item.maxInputChars ?? 6000;
          if (typeof timeoutMs !== "number" || !Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || typeof maxInputChars !== "number" || !Number.isSafeInteger(maxInputChars) || maxInputChars <= 0) throw new Error("invalid limits");
          const apiKey = this.env[item.apiKeyEnv]?.trim(); if (!apiKey) throw new Error("missing credential");
          const config = {id:item.id,displayName,model,baseUrl:url.href.replace(/\/$/,""),apiKeyEnv:item.apiKeyEnv,timeoutMs,maxInputChars,version:item.version as string|undefined};
          const fingerprint = hash([config.id,config.baseUrl,config.model,config.version ?? null,preprocessing,maxInputChars,"l2"]);
          ready.push({...config,apiKey,fingerprint,connectionFingerprint:hash([fingerprint,apiKey,timeoutMs,maxInputChars])});
          catalog.push({id:item.id,displayName,model,available:true});
        } catch {catalog.push({id:item.id,displayName,model,available:false,error:"Embedding 配置无效或本地凭据缺失。"});}
      }
      return {catalog,ready};
    } catch {return {catalog:[],ready:[],error:"Embedding 本地配置无效，请检查配置文件、环境引用和限制。"};}
  }
  private current() {
    if (this.closed) throw new EmbeddingError("cancelled","Embedding 服务已关闭。");
    const configs = this.configurations();
    let selectedId = this.load<string>("selected");
    if (selectedId === undefined && configs.ready[0]) {selectedId = configs.ready[0].id;this.save("selected",selectedId);}
    return {...configs,selectedId,selected:configs.ready.find(config=>config.id===selectedId)};
  }
  snapshot():EmbeddingSnapshot {
    const current = this.current(); const selected = current.selected;
    const connection = this.load<ConnectionReceipt>("connection");
    const test = this.load<TestReceipt>("test");
    const connectionStatus = !selected ? current.error || current.selectedId || current.catalog.length ? "invalid_config" : "not_configured" :
      connection?.fingerprint === selected.connectionFingerprint ? connection.status : "untested";
    return {scope:"service",catalog:current.catalog,selectedId:current.selectedId,selectedAvailable:!!selected,connectionStatus,
      reason:current.error ?? (!selected && current.selectedId ? "已保存的 Embedding 选择不可用。" : connection?.fingerprint===selected?.connectionFingerprint ? connection?.reason : undefined),
      test:test && test.result.configId===current.selectedId && test.fingerprint===selected?.connectionFingerprint ? test.result : undefined,
      progress:this.load<EmbeddingProgress>("progress") ?? initialProgress()};
  }
  select(id:string) {
    const current = this.current();
    if (!current.catalog.some(config=>config.id===id)) throw new EmbeddingError("invalid_config","Embedding 选项已不可用，请刷新列表。");
    if (current.selectedId !== id) {this.save("selected",id);this.save("progress",initialProgress());}
  }
  setProgress(progress:EmbeddingProgress) {if (!this.closed) this.save("progress",progress);}
  /** Freeze configuration and credentials before any await. Space dimension is learned from the validated response. */
  prepare() {
    const current = this.current();
    if (!current.selected) throw new EmbeddingError(current.error || current.selectedId || current.catalog.length ? "invalid_config" : "not_configured","Embedding 未配置或当前选择不可用。");
    const config = {...current.selected};
    return {configId:config.id,model:config.model,fingerprint:config.fingerprint,timeoutMs:config.timeoutMs,
      embed:(texts:readonly string[],options:{signal?:AbortSignal}={})=>this.request(config,texts,options.signal)};
  }
  embed(texts:readonly string[],options:{signal?:AbortSignal}={}) {return this.prepare().embed(texts,options);}
  async test():Promise<EmbeddingTest> {
    const started = Date.now(); const current = this.current(); const selected = current.selected;
    let result:EmbeddingTest;
    try {
      const embedded = await this.embed([syntheticText]);
      result = {status:"success",configId:embedded.configId,model:embedded.space.model,at:new Date().toISOString(),durationMs:Date.now()-started,dimensions:embedded.space.dimensions};
    } catch (error) {
      result = {status:"failed",configId:current.selectedId,model:selected?.model,at:new Date().toISOString(),durationMs:Date.now()-started,
        reason:error instanceof EmbeddingError ? error.message : "Embedding 连接失败。"};
    }
    if (!this.closed) this.save("test",{fingerprint:selected?.connectionFingerprint,result} satisfies TestReceipt);
    return result;
  }
  private request(config:ReadyConfig,texts:readonly string[],signal?:AbortSignal):Promise<EmbeddingResult> {
    if (this.closed) return Promise.reject(new EmbeddingError("cancelled","Embedding 服务已关闭。"));
    const controller = new AbortController(); this.controllers.add(controller);
    let timedOut = false;
    const timer = setTimeout(()=>{timedOut=true;controller.abort();},config.timeoutMs);
    const cancel = ()=>controller.abort(); signal?.addEventListener("abort",cancel,{once:true}); if (signal?.aborted) cancel();
    const pending = (async () => {
      try {
        const input:string[] = []; const ranges:Array<{offset:number;lengths:number[]}> = [];
        for (const text of texts) {
          const points = Array.from(text); if (!points.length) throw new EmbeddingError("invalid_response","Embedding 输入不能为空。");
          const lengths:number[] = []; const offset = input.length;
          for (let index=0;index<points.length;index+=config.maxInputChars) {
            const slice = points.slice(index,index+config.maxInputChars); input.push(slice.join(""));lengths.push(slice.length);
          }
          ranges.push({offset,lengths});
        }
        if (!input.length) throw new EmbeddingError("invalid_response","Embedding 输入不能为空。");
        const chunks:number[][] = [];let dimensions:number|undefined;
        // Aliyun text-embedding-v3/v4 accept at most ten strings per call. All batches share the operation deadline.
        for (let offset=0;offset<input.length;offset+=10) {
          const batch=input.slice(offset,offset+10);
          const response = await fetch(`${config.baseUrl}/embeddings`,{method:"POST",headers:{"content-type":"application/json",authorization:`Bearer ${config.apiKey}`},
            body:JSON.stringify({model:config.model,input:batch,encoding_format:"float"}),signal:controller.signal});
          if (!response.ok) throw new EmbeddingError(response.status===401 || response.status===403 ? "authentication" : "http",
            response.status===401 || response.status===403 ? "Embedding 认证失败，请检查本地凭据。" : `Embedding 服务返回 HTTP ${response.status}。`);
          let body:unknown;try {body=await response.json();} catch {throw new EmbeddingError("invalid_response","Embedding 响应不是有效 JSON。");}
          if (!object(body) || !Array.isArray(body.data) || body.data.length!==batch.length) throw new EmbeddingError("invalid_response","Embedding 响应条数无效。");
          for (const [index,row] of body.data.entries()) {
            if (!object(row) || row.index!==index || !Array.isArray(row.embedding) || !row.embedding.length || !row.embedding.every(value=>typeof value==="number" && Number.isFinite(value)) || !row.embedding.some(value=>value!==0)) throw new EmbeddingError("invalid_response","Embedding 向量或顺序无效。");
            dimensions ??= row.embedding.length;
            if (row.embedding.length!==dimensions) throw new EmbeddingError("invalid_response","Embedding 向量维度不一致。");
            chunks.push(row.embedding as number[]);
          }
        }
        // Character-weighted mean of contiguous chunks, followed by one L2 normalization per original input.
        const vectors = ranges.map(({offset,lengths})=>{
          const total=lengths.reduce((sum,length)=>sum+length,0); const vector=new Array<number>(dimensions!).fill(0);
          for (const [slice,length] of lengths.entries()) for (let j=0;j<vector.length;j++) vector[j]!+=chunks[offset+slice]![j]!*(length/total);
          let norm=0;for(const value of vector) norm=Math.hypot(norm,value);
          if (!Number.isFinite(norm) || norm===0) throw new EmbeddingError("invalid_response","Embedding 合成向量无效。");
          return vector.map(value=>value/norm);
        });
        const space:EmbeddingSpace={id:hash([config.fingerprint,dimensions]),configId:config.id,model:config.model,version:config.version,dimensions:dimensions!,preprocessing,normalization:"l2"};
        if (!this.closed) this.save("connection",{fingerprint:config.connectionFingerprint,status:"ready"} satisfies ConnectionReceipt);
        return {vectors,space,configId:config.id};
      } catch (error) {
        const safe = timedOut ? new EmbeddingError("timeout","Embedding 请求超时，当前使用本地降级。") : controller.signal.aborted ? new EmbeddingError("cancelled","Embedding 请求已取消。") :
          error instanceof EmbeddingError ? error : new EmbeddingError("network","Embedding 网络连接失败，当前使用本地降级。");
        if (!this.closed) this.save("connection",{fingerprint:config.connectionFingerprint,status:"unavailable",reason:safe.message} satisfies ConnectionReceipt);
        throw safe;
      } finally {clearTimeout(timer);signal?.removeEventListener("abort",cancel);this.controllers.delete(controller);}
    })();
    this.requests.add(pending);void pending.then(()=>this.requests.delete(pending),()=>this.requests.delete(pending));return pending;
  }
  async close() {if(this.closed)return;this.closed=true;for(const controller of this.controllers)controller.abort();await Promise.allSettled(this.requests);this.db.close();}
}
