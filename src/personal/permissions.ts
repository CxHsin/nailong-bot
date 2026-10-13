import { mkdir, realpath, lstat, link, unlink, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { defineTool, createReadToolDefinition, createWriteToolDefinition, createEditToolDefinition, createBashToolDefinition, type ToolDefinition } from '@mariozechner/pi-coding-agent';
import { Type } from 'typebox';
import type { Task, PermissionGrant, WorkToolContext } from './types.js';
export function permissionError(message: string): Error { const error = new Error(message); error.name = 'ExecutorAttentionError'; return error; }
export function within(root: string, path: string) { const part = relative(root, path); return !part || (!part.startsWith('..') && !isAbsolute(part)); }
export async function physicalPath(path: string): Promise<string> {
  try { return await realpath(path); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    try { await lstat(path); throw new Error('不能解析文件链接'); } catch (linkError) { if ((linkError as NodeJS.ErrnoException).code !== 'ENOENT') throw linkError; }
    const parent = dirname(path); if (parent === path) throw error;
    return join(await physicalPath(parent), relative(parent, path));
  }
}
export function requirePermission(task: Task, now = Date.now()): PermissionGrant {
  const grant = task.permission;
  if (!grant || grant.expiresAt <= now || grant.revision !== task.revision || task.cancelRequested || task.contextExcluded) throw permissionError('工作权限缺失、过期或要求已变化，需要明确授权');
  return grant;
}
export function permissionSnapshot(task: Task) { return JSON.stringify([task.id, task.revision, task.cwd, task.permission]); }
export function assertPermissionSnapshot(task: Task, expected: string) { requirePermission(task); if (permissionSnapshot(task) !== expected) throw permissionError('权限范围或执行目录在后端检查期间改变；未派发'); }
export interface ExecutionBackend {
  id: string; verified: boolean; identity: string;
  capabilities: { readIsolation: boolean; writeIsolation: boolean; networkIsolation: boolean; processTreeStop: boolean };
  supports(request: { cwd: string; grant: PermissionGrant }): Promise<{ supported: boolean; reasons: string[] }>;
  execute(request: { command: string; cwd: string; grant: PermissionGrant; signal?: AbortSignal; timeout?: number }): Promise<unknown>;
}
export async function matchesExecutionBackend(task: Task, backend?: Pick<ExecutionBackend, 'verified' | 'identity' | 'capabilities' | 'supports'>): Promise<boolean> {
  const grant = requirePermission(task);
  return !!backend?.verified && !!backend.identity && backend.capabilities.readIsolation && backend.capabilities.writeIsolation && (grant.network || backend.capabilities.networkIsolation) && backend.capabilities.processTreeStop && (await backend.supports({ cwd: task.cwd!, grant })).supported;
}
export async function selectBackend(task: Task, backends: ExecutionBackend[] = []): Promise<ExecutionBackend> {
  requirePermission(task);
  for (const backend of backends) if (await matchesExecutionBackend(task, backend)) return backend;
  throw permissionError('没有匹配当前目录、读写、网络及停止边界的已验证后端；未派发命令。可信本机执行需要用户明确授予。');
}
export async function checkFile(task: Task, path: string, mutation: boolean, dataDir: string, skillRoots: string[] = []): Promise<string> {
  const grant = requirePermission(task); const target = await physicalPath(resolve(task.cwd!, path));
  const roots = await Promise.all((mutation ? grant.writeRoots : [...grant.readRoots, ...grant.writeRoots, ...skillRoots]).map(root => physicalPath(root)));
  if (!roots.some(root => within(root, target))) throw permissionError('文件路径超出本工作授权目录');
  const data = await physicalPath(dataDir); const workspace = await physicalPath(task.cwd!);
  if (within(data, target) && (!within(join(data, 'workspaces'), workspace) || !within(workspace, target))) throw permissionError('不能读取或修改 Agent 持久数据');
  // A hardlink has no resolvable original path: even reads could expose history
  // or another work's data through a name inside the granted directory.
  try { const entry = await lstat(target); if (entry.isFile() && entry.nlink > 1) throw permissionError('不能读取或修改有硬链接别名的文件'); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  return target;
}
const response = (value: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(value) }], details: undefined });
export function createWorkTools(get: () => WorkToolContext, options: { dataDir: string; shellPath?: string; backends?: ExecutionBackend[]; skillRoots?: string[] }): ToolDefinition[] {
  const tools: ToolDefinition[] = [createReadToolDefinition(options.dataDir), createWriteToolDefinition(options.dataDir), createEditToolDefinition(options.dataDir)].map(template => ({ ...template,
    async execute(id, args: any, signal, update, context) {
      const work = get(); const task = work.current(); await mkdir(task.cwd!, { recursive: true });
      const path = await checkFile(task, args.path, template.name !== 'read', options.dataDir, options.skillRoots);
      const factory = template.name === 'read' ? createReadToolDefinition : template.name === 'write' ? createWriteToolDefinition : createEditToolDefinition;
      const run = async () => { const checked = await checkFile(work.current(), args.path, template.name !== 'read', options.dataDir, options.skillRoots); if (checked !== path) throw permissionError('操作期间物理路径变化'); return factory(task.cwd!).execute(id, { ...args, path }, signal, update, context); };
      return template.name === 'read' ? run() : work.dispatch(id, { kind: template.name, target: path, parameters: args, content: template.name }, run);
    } } as ToolDefinition));
  tools.push(defineTool({ name: 'work_permission', label: 'Propose work permission', description: 'Propose concrete work read/write/network/expiry or trusted host permission. This only requests confirmation; model arguments never grant authority. Trusted commands inherit Host authority. Deleting originals and external sending require separate authorization.',
    parameters: Type.Object({ mode: Type.Union([Type.Literal('restricted'), Type.Literal('trusted')]), readRoots: Type.Array(Type.String()), writeRoots: Type.Array(Type.String()), network: Type.Boolean(), expiresAt: Type.Number(), deleteOriginal: Type.Optional(Type.Boolean()), externalSend: Type.Optional(Type.Boolean()) }),
    async execute(_id, args) { return response({ granted: await get().proposePermission(args), note: '等待用户确认具体权限，当前权限未扩大' }); } }));
  tools.push(defineTool({ name: 'file_operation', label: 'Controlled file operations', description: 'Create directory, move a file without overwriting, or delete an explicitly authorized original. All paths checked against work permission.',
    parameters: Type.Object({ operation: Type.Union([Type.Literal('mkdir'), Type.Literal('move'), Type.Literal('delete')]), path: Type.String(), destination: Type.Optional(Type.String()) }),
    async execute(id, args) {
      const work = get(); const task = work.current(); const path = await checkFile(task, args.path, true, options.dataDir);
      const destination = args.destination ? await checkFile(task, args.destination, true, options.dataDir) : undefined;
      if (args.operation === 'move') { if (!destination) throw new Error('缺少目标路径'); try { await lstat(destination); throw new Error('目标已经存在，不能覆盖'); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; } }
      const action = { kind: `file-${args.operation}`, target: path, parameters: args, content: args.operation };
      if (args.operation === 'delete' && !await work.requestAction(action)) throw permissionError('删除原件需要明确确认；未执行');
      return work.dispatch(id, action, async () => {
        await checkFile(work.current(), args.path, true, options.dataDir);
        const snapshot = async (target: string) => { try { return { path: target, sha256: createHash('sha256').update(await readFile(target)).digest('hex') }; } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { path: target, sha256: null }; throw error; } };
        const paths = [path, ...(destination ? [destination] : [])];
        const before = args.operation === 'mkdir' ? [] : await Promise.all(paths.map(snapshot));
        if (args.operation === 'mkdir') await mkdir(path, { recursive: true });
        else if (args.operation === 'move') { await checkFile(work.current(), args.destination!, true, options.dataDir); if (!(await lstat(path)).isFile()) throw permissionError('受控移动仅支持普通文件'); await link(path, destination!); await unlink(path); }
        else await unlink(path);
        const after = args.operation === 'mkdir' ? [] : await Promise.all(paths.map(snapshot));
        return response({ operation: args.operation, path, destination, completed: true, materialOperation: { operation: args.operation, before, after } });
      });
    } }));
  tools.push(defineTool({ name: 'bash', label: 'Authorized command', description: 'Run within a verified restricted backend or explicitly confirmed trusted host mode. Trusted Shell inherits Host authority; it cannot enforce no-delete or no-send semantics. For deleting originals or external sending use the controlled interfaces and obtain explicit authorization.',
    parameters: Type.Object({ command: Type.String(), timeout: Type.Optional(Type.Number()) }),
    async execute(id, args, signal, update, context) {
      const work = get(); const task = work.current(); const grant = requirePermission(task);
      if (grant.mode === 'restricted') await selectBackend(task, options.backends);
      const action = { kind: 'command', target: task.cwd!, parameters: args, content: `本机命令可能删除原件或对外发送，实际继承权限：${args.command}` };
      return work.dispatch(id, action, async () => {
        const latest = work.current(); const currentGrant = requirePermission(latest);
        if (currentGrant.mode === 'restricted') { const snapshot = permissionSnapshot(latest); const backend = await selectBackend(latest, options.backends); const actual = work.current(); assertPermissionSnapshot(actual, snapshot); return response(await backend.execute({ command: args.command, cwd: actual.cwd!, grant: requirePermission(actual), signal, timeout: args.timeout })); }
        return createBashToolDefinition(latest.cwd!, { shellPath: options.shellPath }).execute(id, args, signal, update, context);
      });
    } }));
  tools.push(defineTool({ name: 'send_message', label: 'Explicit delivery', description: 'Report completion, blockage or a required decision to this work owner in the current conversation through durable Delivery. This never sends to other recipients or uploads files. Unknown delivery is never automatically resent.',
    parameters: Type.Object({ text: Type.String() }), async execute(id, args) {
      const work = get(); const task = work.current(); requirePermission(task);
      const action = { kind: 'external-send', target: task.conversationId, parameters: args, content: args.text };
      return work.dispatch(id, action, async () => response({ deliveryId: work.send(args.text).id }));
    } }));
  return tools;
}
