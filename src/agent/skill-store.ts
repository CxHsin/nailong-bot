import { mkdir, readFile, writeFile, rename, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { skillMetadata, insideSkill, type SkillSource } from "./skills.js";
import type { Request } from "../application/app-types.js";

type InstalledSkill = { name: string; root: string; source: string; version?: string; digest: string; singleFile: boolean };
const safePath = (path: string) => !!path && !path.split("/").some((part) => !part || part === "." || part === ".." || /[\\:\x00-\x1f]/.test(part)) && !path.startsWith("/");

/** Managed immutable versions plus one atomically replaced catalog pointer. */
export function createSkillStore(dataDir: string, download: typeof fetch = fetch) {
  const root = resolve(dataDir, "skills"); const manifest = join(root, "catalog.json");
  let mutation = Promise.resolve();
  const catalog = async (): Promise<InstalledSkill[]> => {
    try {
      const values = JSON.parse(await readFile(manifest, "utf8"));
      if (!Array.isArray(values) || values.some((entry) => typeof entry.name !== "string" || typeof entry.root !== "string" || !insideSkill(root, entry.root))) throw new Error("已安装 skill 目录损坏");
      return values;
    } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
  };
  const get = async (url: string, signal?: AbortSignal) => {
    const response = await download(url, { signal: AbortSignal.any([AbortSignal.timeout(15000), ...(signal ? [signal] : [])]), redirect: "error", headers: { "User-Agent": "nailong-bot" } });
    if (!response.ok) throw new Error(`skill 下载失败（HTTP ${response.status}）`);
    return response;
  };
  const bytes = async (url: string, signal?: AbortSignal) => {
    const response = await get(url, signal); const chunks: Uint8Array[] = []; let size = 0;
    for await (const chunk of response.body!) { size += chunk.length; if (size > 5_000_000) throw new Error("skill 文件超过下载限制"); chunks.push(chunk); }
    return Buffer.concat(chunks);
  };
  const install = async (source: string, update: boolean, request: Request) => {
    let staging: string | undefined;
    try {
      const url = new URL(source);
      if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) throw new Error("不支持的 skill 链接");
      const parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
      const files: Array<{ path: string; content: Buffer }> = [];
      let version: string | undefined; let singleFile = true;
      if (url.hostname === "github.com" && ["tree", "blob"].includes(parts[2] ?? "")) {
        const [owner, repo, mode] = parts;
        if (!owner || !repo || !/^[\w.-]+$/.test(owner) || !/^[\w.-]+$/.test(repo)) throw new Error("GitHub 链接无效");
        let prefix = ""; let ref = "";
        // Resolve the longest valid ref so branch names containing '/' work too.
        for (let split = parts.length - 1; split >= 4; split--) {
          const candidate = parts.slice(3, split).join("/");
          try {
            const commit = await (await get(`https://api.github.com/repos/${owner}/${repo}/commits/${encodeURIComponent(candidate)}`, request.signal)).json() as { sha?: string };
            if (!commit.sha || !/^[0-9a-f]{40}$/.test(commit.sha)) throw new Error("GitHub commit 无效");
            ref = commit.sha; version = ref; prefix = parts.slice(split).join("/"); break;
          } catch (error) { request.signal?.throwIfAborted(); if (split === 4) throw error; }
        }
        if (!ref || !safePath(prefix)) throw new Error("GitHub skill 路径无效");
        if (mode === "blob") {
          if (!prefix.endsWith("/SKILL.md") && prefix !== "SKILL.md") throw new Error("单文件链接必须指向 SKILL.md");
          files.push({ path: "SKILL.md", content: await bytes(`https://raw.githubusercontent.com/${owner}/${repo}/${ref}/${prefix}`, request.signal) });
        } else {
          singleFile = false;
          const tree = await (await get(`https://api.github.com/repos/${owner}/${repo}/git/trees/${ref}?recursive=1`, request.signal)).json() as { truncated?: boolean; tree?: Array<{ path: string; type: string; mode: string }> };
          if (tree.truncated || !Array.isArray(tree.tree)) throw new Error("GitHub 目录列表不完整");
          for (const entry of tree.tree.filter((entry) => entry.path.startsWith(prefix + "/")).sort((a, b) => a.path.localeCompare(b.path, "en"))) {
            const path = entry.path.slice(prefix.length + 1);
            if (!safePath(path) || !["100644", "100755", "040000"].includes(entry.mode)) throw new Error("skill 包包含越界路径、链接或不支持的资源");
            if (entry.type === "tree") continue;
            if (entry.type !== "blob") throw new Error("skill 包资源类型无效");
            if (files.length >= 200) throw new Error("skill 资源超过 200 个文件");
            files.push({ path, content: await bytes(`https://raw.githubusercontent.com/${owner}/${repo}/${ref}/${entry.path}`, request.signal) });
            if (files.reduce((sum, file) => sum + file.content.length, 0) > 20_000_000) throw new Error("skill 包超过 20MB");
          }
        }
      } else if (url.hostname !== "github.com" && url.pathname.endsWith("/SKILL.md")) {
        // Direct SKILL.md sources contain only the instruction file, never inferred sibling resources.
        files.push({ path: "SKILL.md", content: await bytes(source, request.signal) });
      } else throw new Error("不支持的来源：请提供公开 GitHub skill 目录或直接 SKILL.md 链接");
      const instruction = files.find((file) => file.path === "SKILL.md"); if (!instruction) throw new Error("skill 目录缺少 SKILL.md");
      const metadata = skillMetadata(new TextDecoder("utf-8", { fatal: true }).decode(instruction.content));
      if (!singleFile && parts.at(-1) !== metadata.name) throw new Error("skill 名称与目录不一致");
      const current = await catalog(); const previous = current.find((entry) => entry.name === metadata.name);
      if (previous && !update) throw new Error(`skill 已存在：${metadata.name}；明确发送“更新 skill 链接”才能替换。`);
      if (!previous && update) throw new Error(`skill 尚未安装：${metadata.name}；请先安装。`);
      const hash = createHash("sha256"); for (const file of files.sort((a, b) => a.path.localeCompare(b.path, "en"))) { hash.update(file.path); hash.update("\0"); hash.update(file.content); hash.update("\0"); }
      const digest = hash.digest("hex");
      await mkdir(root, { recursive: true }); staging = join(root, `.staging-${randomUUID()}`); await mkdir(staging);
      const stagedSkill = join(staging, metadata.name);
      for (const file of files) {
        const target = resolve(stagedSkill, file.path); if (!insideSkill(stagedSkill, target)) throw new Error("skill 资源越界");
        await mkdir(resolve(target, ".."), { recursive: true }); await writeFile(target, file.content, { flag: "wx" });
      }
      request.signal?.throwIfAborted();
      const final = join(root, `version-${randomUUID()}`); await rename(staging, final); staging = final;
      const entry: InstalledSkill = { name: metadata.name, root: join(final, metadata.name), source, version, digest, singleFile };
      const temporary = join(root, `.catalog-${randomUUID()}.tmp`);
      try { await writeFile(temporary, JSON.stringify([...current.filter((item) => item.name !== metadata.name), entry].sort((a, b) => a.name.localeCompare(b.name, "en")))); await rename(temporary, manifest); }
      finally { await rm(temporary, { force: true }); }
      staging = undefined;
      await request.log.append({ type: "skill_installed", requestId: request.id, ...entry, updated: !!previous, result: "succeeded" });
      return `${previous ? "已更新" : "已安装"} skill：${metadata.name}。${singleFile ? "单文件安装仅含 SKILL.md 正文。" : "已保留附带资源。"}下次 Run 可通过 @${metadata.name} 调用。`;
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      await request.log.append({ type: "skill_install_failed", requestId: request.id, source, reason, result: "failed" });
      return `skill 安装失败：${reason}`;
    } finally { if (staging) { if (!insideSkill(root, staging) || staging === root) throw new Error("skill 临时目录越界"); await rm(staging, { recursive: true, force: true }); } }
  };
  return {
    async sources(): Promise<SkillSource[]> { return (await catalog()).map((entry) => ({ name: "installed", path: entry.root })); },
    async handle(text: string, request: Request): Promise<string | undefined> {
      const input = text.trim().replace(/^\/skill\s+(install|update)\s+/i, "$1 skill ");
      const match = /^(?:请|帮我|请帮我)?\s*(install|update|安装|更新)\s*(?:这个\s*)?(?:skill|技能)\s*[:：]?\s*(\S+:\/\/\S+)\s*$/i.exec(input);
      if (!match && /^\/skill(?:\s|$)/.test(text.trim())) return "用法：/skill install 链接；/skill update 链接";
      if (!match) return undefined;
      const work = mutation.then(() => install(match[2]!, /^(update|更新)$/i.test(match[1]!), request));
      mutation = work.then(() => {}, () => {}); return work;
    },
  };
}
