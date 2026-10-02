import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { sourceDigest } from "../runtime/event-digest.js";

export type EmbeddingConfig = { baseUrl: string; model: string; apiKey: string; timeoutMs?: number; maxInputChars?: number };
export function normalizeVector(vector: number[]): number[] {
  if (!vector.length || vector.some((value) => !Number.isFinite(value))) throw new Error("embedding 向量无效");
  const norm = Math.hypot(...vector);
  if (!norm || !Number.isFinite(norm)) throw new Error("embedding 向量无效");
  return vector.map((value) => value / norm);
}
export function cosineOfUnitVectors(left: number[], right: number[]): number {
  return left.length === right.length ? Math.max(-1, Math.min(1, left.reduce((sum, value, index) => sum + value * right[index]!, 0))) : 0;
}
export function averageVectors(vectors: number[][]): number[] | undefined {
  if (!vectors.length) return undefined;
  if (vectors.some((v) => v.length !== vectors[0]!.length)) return undefined;
  const sum = vectors[0]!.map((_, index) => vectors.reduce((total, vector) => total + vector[index]!, 0));
  return Math.hypot(...sum) ? normalizeVector(sum) : undefined;
}
export function createEmbeddingClient(dataDir: string, config: EmbeddingConfig) {
  const timeoutMs = config.timeoutMs ?? 3000; const maxChars = config.maxInputChars ?? 6000;
  if (!config.model.trim() || !config.apiKey.trim() || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 ||
    !Number.isSafeInteger(maxChars) || maxChars < 1) throw new Error("embedding 配置无效");
  const url = new URL(config.baseUrl.replace(/\/$/, "") + "/embeddings");
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw new Error("embedding 地址无效");
  mkdirSync(dataDir, { recursive: true });
  const db = new DatabaseSync(join(dataDir, "embeddings.sqlite"));
  db.exec("PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS vectors (key TEXT PRIMARY KEY, namespace TEXT NOT NULL, payload TEXT NOT NULL); CREATE TABLE IF NOT EXISTS embedding_meta (namespace TEXT PRIMARY KEY, dimension INTEGER NOT NULL)");
  const baseNamespace = sourceDigest({ url: url.href, model: config.model, maxChars, version: 2 });
  const savedDimension = db.prepare("SELECT dimension FROM embedding_meta WHERE namespace=?").get(baseNamespace) as { dimension: number } | undefined;
  let dimension = savedDimension?.dimension;
  const namespace = () => sourceDigest({ baseNamespace, dimension });
  const controllers = new Set<AbortController>();
  type Job = { text: string; eligible?: () => Promise<boolean> };
  const queued = new Map<string, Job>();
  const pending = new Map<string, Promise<number[]>>();
  let worker: Promise<void> | undefined; let stopped = false; let status: string | undefined;
  let retry: ReturnType<typeof setTimeout> | undefined; let backoff = 100;
  let generation = 0; let activeGeneration = 0;
  const key = (text: string, kind = "message") => sourceDigest({ namespace: namespace(), kind, text });
  function cached(text: string, kind = "message"): number[] | undefined {
    const row = db.prepare("SELECT payload FROM vectors WHERE key=? AND namespace=?").get(key(text, kind), namespace()) as { payload: string } | undefined;
    if (!row) return undefined;
    try {
      const vector = normalizeVector(JSON.parse(row.payload));
      return dimension === vector.length ? vector : undefined;
    } catch { return undefined; }
  }
  async function compute(jobs: Job[], background = false): Promise<number[][]> {
      const computation = ++generation;
      const input: Array<{ text: string; job: number }> = [];
      for (const [index, job] of jobs.entries()) {
        if (job.eligible && !await job.eligible()) continue;
        const points = Array.from(job.text || " ");
        for (let offset = 0; offset < points.length; offset += maxChars) input.push({ text: points.slice(offset, offset + maxChars).join(""), job: index });
      }
      const controller = new AbortController(); controllers.add(controller);
      let timer = background ? undefined : setTimeout(() => controller.abort(), timeoutMs);
      try {
        const chunks: number[][][] = jobs.map(() => []);
        let responseDimension: number | undefined;
        for (let offset = 0; offset < input.length; offset += 16) {
          const batch = [] as typeof input;
          for (const entry of input.slice(offset, offset + 16)) {
            const job = jobs[entry.job]!;
            if (!job.eligible || await job.eligible()) batch.push(entry);
          }
          if (!batch.length) continue;
          if (background) timer = setTimeout(() => controller.abort(), timeoutMs);
          const response = await fetch(url, { method: "POST", headers: { Authorization: `Bearer ${config.apiKey}`, "content-type": "application/json" },
            body: JSON.stringify({ model: config.model, input: batch.map((entry) => entry.text) }), signal: controller.signal });
          if (!response.ok) throw new Error("embedding 服务不可用");
          const result = await response.json() as { data?: Array<{ index: number; embedding: number[] }> };
          if (background) { clearTimeout(timer); timer = undefined; }
          if (!Array.isArray(result.data) || result.data.length !== batch.length) throw new Error("embedding 响应无效");
          const ordered = result.data.slice().sort((a, b) => a.index - b.index);
          if (ordered.some((entry, index) => entry.index !== index || !Array.isArray(entry.embedding))) throw new Error("embedding 顺序无效");
          for (const [index, entry] of ordered.entries()) {
            const vector = normalizeVector(entry.embedding);
            responseDimension ??= vector.length;
            if (responseDimension !== vector.length) throw new Error("embedding 维度无效");
            chunks[batch[index]!.job]!.push(vector);
          }
        }
        if (stopped) throw new Error("embedding 已关闭");
        const vectors = chunks.map((parts) => averageVectors(parts) ?? []);
        if (vectors.some((vector, index) => chunks[index]!.length > 0 && !vector.length)) throw new Error("embedding 聚合无效");
        const eligible = await Promise.all(jobs.map((job) => job.eligible ? job.eligible() : true));
        if (responseDimension && computation >= activeGeneration) {
          activeGeneration = computation; dimension = responseDimension;
          db.prepare("INSERT OR REPLACE INTO embedding_meta VALUES (?, ?)").run(baseNamespace, dimension);
        }
        const responseNamespace = sourceDigest({ baseNamespace, dimension: responseDimension });
        for (const [index, job] of jobs.entries()) {
          if (vectors[index]!.length && eligible[index]) storeVector(job.text, vectors[index]!, "message", responseNamespace);
        }
        status = undefined; return vectors;
      } catch { status = "embedding_unavailable"; throw new Error("embedding 暂不可用"); }
      finally { clearTimeout(timer); controllers.delete(controller); }
  }
  function storeVector(text: string, vector: number[], kind = "message", targetNamespace = namespace()) {
    const identity = sourceDigest({ namespace: targetNamespace, kind, text });
    db.prepare("INSERT OR REPLACE INTO vectors VALUES (?, ?, ?)").run(identity, targetNamespace, JSON.stringify(vector));
  }
  function turn(texts: string[]): number[] | undefined {
    const identity = JSON.stringify({ turn: texts });
    const previous = cached(identity, "turn"); if (previous) return previous;
    const vectors = texts.map((text) => cached(text));
    if (vectors.some((vector) => !vector)) return undefined;
    const vector = averageVectors(vectors as number[][]);
    if (vector) storeVector(identity, vector, "turn");
    return vector;
  }
  async function get(text: string): Promise<number[]> {
    if (stopped) throw new Error("embedding 已关闭");
    const previous = cached(text); if (previous) return previous;
    const identity = key(text); const running = pending.get(identity); if (running) return running;
    const work = compute([{ text }]).then((vectors) => {
      if (!vectors[0]?.length) throw new Error("embedding 向量无效");
      return vectors[0];
    });
    pending.set(identity, work);
    try { return await work; } finally { pending.delete(identity); }
  }
  function runWorker() {
    if (worker || retry || stopped || !queued.size) return;
    worker = (async () => {
      while (queued.size && !stopped) {
        const batch = [...queued.entries()].slice(0, 16);
        try {
          await compute(batch.map((entry) => entry[1]), true);
          for (const [identity, job] of batch) if (queued.get(identity) === job && (cached(job.text) || job.eligible && !await job.eligible())) queued.delete(identity);
          backoff = 100;
        } catch {
          if (!stopped) {
            retry = setTimeout(() => { retry = undefined; runWorker(); }, backoff);
            retry.unref(); backoff = Math.min(30_000, backoff * 2);
          }
          break;
        }
      }
    })().finally(() => { worker = undefined; });
  }
  function enqueue(jobs: Job[]) {
    for (const job of jobs) if (job.text && !cached(job.text)) queued.set(sourceDigest(job.text), job);
    runWorker();
  }
  return { cached, get, enqueue, turn, namespace, identity: baseNamespace, status: () => status,
    async close() { stopped = true; if (retry) clearTimeout(retry); queued.clear(); controllers.forEach((controller) => controller.abort());
      await Promise.allSettled([...pending.values()]); await worker; db.close(); },
  };
}
