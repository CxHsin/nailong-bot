import { readFile, readdir, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { createHash } from "node:crypto";
import { parseFrontmatter, type ToolDefinition } from "@mariozechner/pi-coding-agent";
import type { Request } from "../application/app-types.js";

export type SkillSource = { name: string; path: string };
export type Skill = { name: string; description: string; source: string; path: string; root: string; digest: string; body: string };
export type SkillSnapshot = { skills: Skill[]; metadata: string; digest: string };
export class SkillReferenceError extends Error {}
export const skillDigest = (text: string) => createHash("sha256").update(text).digest("hex");
/** Only consecutive references at the start of the first line select Telegram skills. */
function telegramSkillReferences(text: string): string[] {
  let firstLine = text.replace(/^[\t ]+/, "").split(/\r?\n/, 1)[0]!;
  const names: string[] = [];
  for (;;) {
    const match = /^\/((?:[a-z][a-z0-9_-]{0,24}:)?[a-z0-9]+(?:-[a-z0-9]+)*)(?=[\t ]|$)/.exec(firstLine);
    if (!match) return names;
    names.push(match[1]!);
    firstLine = firstLine.slice(match[0].length).replace(/^[\t ]+/, "");
  }
}
export function skillMetadata(body: string) {
  if (!/^---\r?\n/.test(body)) throw new Error("SKILL.md 缺少 YAML 元数据");
  const { frontmatter } = parseFrontmatter(body);
  const { name, description } = frontmatter;
  if (typeof name !== "string" || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name) || name.length > 64) throw new Error("skill 名称必须为不超过 64 字符的小写字母、数字和单连字符");
  if (typeof description !== "string" || !description.trim() || description.length > 1024) throw new Error("skill description 必须为 1–1024 字符");
  return { name, description: description.trim() };
}
export async function scanSkills(sources: SkillSource[]): Promise<SkillSnapshot> {
  const skills: Skill[] = [];
  for (const source of sources) {
    if (!/^[a-z][a-z0-9_-]{0,24}$/.test(source.name)) throw new Error("skill 来源名称无效");
    const visited = new Set<string>();
    const scan = async (path: string) => {
      const physical = await realpath(path); if (visited.has(physical)) return; visited.add(physical);
      try {
        const skillPath = join(physical, "SKILL.md");
        const body = await readFile(skillPath, "utf8");
        const metadata = skillMetadata(body);
        if (metadata.name !== physical.split(/[\\/]/).at(-1)) throw new Error(`skill 名称和目录不一致：${skillPath}`);
        skills.push({ ...metadata, source: source.name, path: skillPath, root: physical, digest: skillDigest(body), body });
        return;
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      for (const entry of (await readdir(physical, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name, "en")))
        if (entry.isDirectory() && !entry.name.startsWith(".")) await scan(join(physical, entry.name));
    };
    await scan(resolve(source.path));
  }
  skills.sort((a, b) => `${a.source}:${a.name}`.localeCompare(`${b.source}:${b.name}`, "en"));
  if (new Set(skills.map((skill) => `${skill.source}:${skill.name}`)).size !== skills.length) throw new Error("skill 来源限定名称重复");
  const items = skills.map(({ body: _body, root: _root, ...skill }) => ({ ...skill, name: skills.filter((item) => item.name === skill.name).length > 1 ? `${skill.source}:${skill.name}` : skill.name }));
  const metadata = skills.length ? `\n\n可用 skills（指令）：${JSON.stringify(items)}\n任务匹配时先用 read 读取对应 SKILL.md 全文，按继续读取提示取得所有分页后再遵循。资源路径相对于 skill 根目录；仅按任务需要读取引用的文件。读取脚本不等于执行，脚本需通过已配置的执行工具运行；缺少执行能力时明确说明。` : "";
  return { skills, metadata, digest: skillDigest(JSON.stringify(items)) };
}
export function resolveExplicitSkills(snapshot: SkillSnapshot, text: string, channel?: string) {
  const prefix = channel === "telegram" ? "/" : "@";
  const references = [...new Set(channel === "telegram" ? telegramSkillReferences(text) :
    [...text.matchAll(/(?:^|\s)@([a-z0-9][a-z0-9:_-]*)(?=$|\s|[，。！？,!?])/g)].map((match) => match[1]!))];
  // Resolve every name before recording any successful injection.
  const resolved = references.map((name) => {
    const found = snapshot.skills.filter((skill) => name === skill.name || name === `${skill.source}:${skill.name}`);
    if (!found.length) throw new SkillReferenceError(`未知 skill：${prefix}${name}；可用技能：${snapshot.skills.map((skill) => `${prefix}${skill.source}:${skill.name}`).join("、") || "无"}。`);
    if (found.length > 1) throw new SkillReferenceError(`skill 名称有歧义：${prefix}${name}；请选择 ${found.map((skill) => `${prefix}${skill.source}:${skill.name}`).join("、")}。`);
    return found[0]!;
  });
  return resolved.filter((skill, index) => resolved.findIndex((candidate) => candidate.path === skill.path) === index);
}
export async function explicitSkills(snapshot: SkillSnapshot, text: string, request: Request) {
  const selected = resolveExplicitSkills(snapshot, text, request.channel);
  for (const skill of selected) await request.log.append({ type: "skill_loaded", requestId: request.id, ...(request.inputId ? { inputId: request.inputId } : {}), name: skill.name, source: skill.source,
    path: skill.path, root: skill.root, digest: skill.digest, body: skill.body, mode: "explicit" });
  return selected;
}
export function skillRead(ordinary: ToolDefinition, snapshot: SkillSnapshot, request?: Request): ToolDefinition & { registerSkills: (loaded: SkillSnapshot["skills"]) => void } {
  const selected = new Set<string>(request?.loadedSkillPaths);
  const skills = new Map(snapshot.skills.map((skill) => [resolve(skill.path), skill]));
  const pages = new Map<string, Set<number>>();
  return { ...ordinary, registerSkills(loaded: SkillSnapshot["skills"]) {
    for (const skill of loaded) {
      skills.set(resolve(skill.path), skill); selected.add(skill.path); pages.delete(skill.path);
    }
  }, async execute(id, args: { path: string; offset?: number; limit?: number }, signal, update, context) {
    let path = resolve(context.cwd, args.path);
    let relativeResource = false;
    let skill = skills.get(path);
    if (!skill && !isAbsolute(args.path)) {
      const candidates = [...skills.values()].filter((skill) => selected.has(skill.path)).map((skill) => resolve(skill.root, args.path));
      const existing: string[] = [];
      for (const candidate of candidates) { try { await realpath(candidate); existing.push(candidate); } catch {} }
      if (existing.length > 1) throw new Error("资源路径有歧义，请提供 skill 根目录下的完整路径");
      if (existing[0]) { path = existing[0]; relativeResource = true; }
      skill = skills.get(path);
    }
    if (!skill) return ordinary.execute(id, relativeResource ? { ...args, path } : args, signal, update, context);
    signal?.throwIfAborted(); selected.add(skill.path);
    const lines = skill.body.split("\n"); const offset = args.offset ?? 1; const limit = args.limit ?? 120;
    if (!Number.isInteger(offset) || offset < 1 || offset > lines.length || !Number.isInteger(limit) || limit < 1) throw new Error("skill 读取分页参数无效");
    let end = Math.min(lines.length, offset - 1 + Math.min(limit, 120));
    while (end > offset && Buffer.byteLength(lines.slice(offset - 1, end).join("\n")) > 5000) end--;
    if (Buffer.byteLength(lines.slice(offset - 1, end).join("\n")) > 6500) throw new Error(`skill 单行超过读取预算，请显式 ${request?.channel === "telegram" ? "/" : "@"}${skill.source}:${skill.name} 加载完整正文`);
    const loaded = pages.get(skill.path) ?? new Set<number>(); for (let i = offset - 1; i < end; i++) loaded.add(i); pages.set(skill.path, loaded);
    const complete = loaded.size === lines.length;
    const text = lines.slice(offset - 1, end).join("\n") + (end < lines.length ? `\n[继续读取：read(${JSON.stringify({ path: skill.path, offset: end + 1, limit })})；尚未加载完整 skill]` : complete ? "\n[skill 正文已完整读取]" : "\n[仍有未读取的 skill 分页]");
    await request?.log.append({ type: "skill_read", requestId: request.id, name: skill.name, path: skill.path, digest: skill.digest, offset, end, complete, text });
    return { content: [{ type: "text", text }], details: { skill: skill.name, digest: skill.digest, complete } };
  } };
}

export function insideSkill(root: string, path: string) { const part = relative(root, path); return !part || (!part.startsWith("..") && !isAbsolute(part)); }
