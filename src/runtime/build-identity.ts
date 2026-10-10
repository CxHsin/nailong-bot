import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join, parse } from "node:path";
import { fileURLToPath } from "node:url";

const exec = promisify(execFile);
export type BuildIdentity = { mode: "source" | "build"; gitSha: string | null; trackedDirty: boolean | null; builtAt: string | null };

export function safeBuildIdentity(value: unknown): BuildIdentity | null {
  if (!value || typeof value !== "object") return null;
  const item = value as Record<string, unknown>;
  if (item.mode !== "source" && item.mode !== "build") return null;
  return { mode: item.mode, gitSha: typeof item.gitSha === "string" && /^[a-f0-9]{40}$/.test(item.gitSha) ? item.gitSha : null,
    trackedDirty: typeof item.trackedDirty === "boolean" ? item.trackedDirty : null,
    builtAt: typeof item.builtAt === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(item.builtAt) && Number.isFinite(Date.parse(item.builtAt)) ? item.builtAt : null };
}

export async function sourceBuildIdentity(root: string): Promise<BuildIdentity> {
  const results = await Promise.allSettled([
    exec("git", ["rev-parse", "HEAD"], { cwd: root, timeout: 3000, maxBuffer: 1024 }),
    exec("git", ["diff", "--quiet", "HEAD"], { cwd: root, timeout: 3000, maxBuffer: 1024 }),
  ]);
  const [sha, diff] = results;
  return { mode: "source", gitSha: sha.status === "fulfilled" && /^[a-f0-9]{40}$/.test(sha.value.stdout.trim()) ? sha.value.stdout.trim() : null,
    trackedDirty: diff.status === "fulfilled" ? false : (diff.reason as { code?: unknown }).code === 1 ? true : null, builtAt: null };
}

/** Capture once at process startup; built processes use the artifact stamp, never today's checkout HEAD. */
export async function readBuildIdentity(): Promise<BuildIdentity> {
  let root = dirname(fileURLToPath(import.meta.url));
  while (!existsSync(join(root, "package.json")) && root !== parse(root).root) root = dirname(root);
  if (import.meta.url.endsWith(".ts")) return sourceBuildIdentity(root);
  return readArtifactIdentity(root);
}

export async function readArtifactIdentity(root: string): Promise<BuildIdentity> {
  try {
    const identity = safeBuildIdentity(JSON.parse(await readFile(join(root, "dist", "build-info.json"), "utf8")));
    if (identity?.mode === "build") return identity;
  } catch { /* A missing artifact stamp is unknown, not the current checkout identity. */ }
  return { mode: "build", gitSha: null, trackedDirty: null, builtAt: null };
}
