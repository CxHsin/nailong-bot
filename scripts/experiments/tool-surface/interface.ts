// EXPERIMENT ONLY: bounded command adapter, not an operating-system shell.
import { realpath, lstat } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { Value } from 'typebox/value';
import type { ToolDefinition } from '@mariozechner/pi-coding-agent';
import type { PersonalPiOptions } from '../../../src/personal/pi.js';
import { checkFile } from '../../../src/personal/permissions.js';

export type Variant = 'independent' | 'skill_cli';
export type Trace = { sessionId: string; operation: string; status: 'ok' | 'error'; target?: string };
export type Surface = { sessionId: string; names: string[]; schemaBytes: number; instructionBytes: number };
const hidden = new Set(['file_operation', 'work_permission', 'send_message', 'task_control', 'delegate_work', 'complete_work', 'child_control', 'memory_search', 'memory_read']);
const commands: Record<string, [string, Record<string, unknown>]> = {
  'work start': ['task_control', { kind: 'start' }], 'work query': ['task_control', { kind: 'query' }],
  'work steer': ['task_control', { kind: 'steer' }], 'work cancel': ['task_control', { kind: 'cancel' }],
  'work delegate': ['delegate_work', {}], 'work complete': ['complete_work', {}],
  'work notify': ['send_message', {}], 'memory search': ['memory_search', {}], 'memory read': ['memory_read', {}],
  'work child': ['child_control', {}],
};
const reply = (text: string) => ({ content: [{ type: 'text' as const, text }], details: undefined });
function inside(root: string, path: string) { const part = relative(root, path); return !part || (!isAbsolute(part) && part !== '..' && !part.startsWith('..' + (process.platform === 'win32' ? '\\' : '/'))); }
async function physical(path: string): Promise<string> {
  try { return await realpath(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    try { await lstat(path); throw new Error('Unresolved symbolic link'); }
    catch (linkError) { if ((linkError as NodeJS.ErrnoException).code !== 'ENOENT') throw linkError; }
    return resolve(await physical(dirname(path)), relative(dirname(path), path));
  }
}
function words(command: string) {
  const result: string[] = []; let word = ''; let quote = ''; let started = false;
  for (const c of command) {
    if (quote) { if (c === quote) quote = ''; else word += c; }
    else if (c === "'" || c === '"') { quote = c; started = true; }
    else if (/\s/.test(c)) { if (started) { result.push(word); word = ''; started = false; } }
    else { if (';&|`<>'.includes(c)) throw new Error('Shell operators are outside this experiment'); word += c; started = true; }
  }
  if (quote) throw new Error('Unclosed quote'); if (started) result.push(word); return result;
}

export function experimentInterface(options: {
  variant: Variant; root: string; dataDir: string; skillFile: string; workflow?: 'inline' | 'skill'; surfaces: Surface[]; trace: Trace[];
  confirmPending: () => Promise<boolean>;
}): NonNullable<PersonalPiOptions['sessionInterface']> {
  return setup => {
    // Leave verifier/helper interfaces alone; both variants use the same synthetic helper.
    if (!setup.work || !setup.tools.some(tool => tool.name === 'complete_work')) return { tools: setup.tools, instructions: setup.instructions };
    const getWork = setup.work;
    const originals = new Map(setup.tools.map(tool => [tool.name, tool]));
    async function invoke(name: string, args: Record<string, unknown>, callId: string, signal: Parameters<ToolDefinition['execute']>[2], update: Parameters<ToolDefinition['execute']>[3], context: Parameters<ToolDefinition['execute']>[4], automatic = true) {
      try {
      const tool = originals.get(name); if (!tool) throw new Error(`Unavailable operation: ${name}`);
      if (!Value.Check(tool.parameters, args)) throw new Error(`Invalid arguments for ${name}`);
      const paths = name === 'file_operation' ? [args.path, args.destination].filter((path): path is string => typeof path === 'string') : ['read', 'write', 'edit'].includes(name) ? [String(args.path)] : [];
      const mutation = name !== 'read';
      for (const path of paths) {
        const target = await physical(resolve(getWork().current().cwd!, path));
        const skillRead = name === 'read' && target === await realpath(options.skillFile);
        if (!skillRead && (!inside(await realpath(options.root), target) || inside(await realpath(options.dataDir), target) && !inside(resolve(options.dataDir, 'workspaces'), target))) throw new Error('Path is outside synthetic experiment materials');
      }
      if (automatic && paths.length) {
        try { for (const path of paths) await checkFile(getWork().current(), path, mutation, options.dataDir, [dirname(options.skillFile)]); }
        catch (error) {
          if ((error as Error).name !== 'ExecutorAttentionError') throw error;
          const current = getWork().current(); const grant = current.permission!;
          const targets = await Promise.all(paths.map(path => physical(resolve(current.cwd!, path))));
          // The system derives exact paths from the operation; the model does not propose a broad grant.
          await getWork().proposePermission({ ...grant, mode: 'restricted', readRoots: [...new Set([...grant.readRoots, ...targets])], writeRoots: [...new Set([...grant.writeRoots, ...(mutation ? targets : [])])] });
          if (!await options.confirmPending()) throw new Error('System approval declined; operation was not executed');
        }
      }
        let result;
        try { result = await tool.execute(callId, args, signal, update, context); }
        catch (error) {
          // File deletion already requests exact action approval through the production Host.
          if (name !== 'file_operation' || args.operation !== 'delete' || !await options.confirmPending()) throw error;
          result = await tool.execute(callId, args, signal, update, context);
        }
        if (name === 'work_permission') {
          const approved = await options.confirmPending();
          result = reply(JSON.stringify({ granted: approved, note: approved ? '用户已批准本次具体权限；当前工作权限已更新' : '用户拒绝本次权限提案；权限未扩大' }));
        }
        options.trace.push({ sessionId: setup.scope.sessionId, operation: name, status: 'ok', ...(name === 'read' ? { target: await physical(resolve(getWork().current().cwd!, String(args.path))) } : {}) }); return result;
      } catch (error) { options.trace.push({ sessionId: setup.scope.sessionId, operation: name, status: 'error' }); throw error; }
    }
    const originalBash = originals.get('bash')!;
    const bash: ToolDefinition = { ...originalBash,
      description: options.variant === 'independent' ? 'Bounded experiment terminal. Run mkdir, mv or rm. Other commands and shell operators are rejected.' : 'Bounded experiment terminal. Run mkdir, mv, rm, or agentctl commands. Other commands and shell operators are rejected. Use agentctl --help to learn commands.',
      async execute(callId, args: { command: string }, signal, update, context) {
        try {
          const command = args.command.trim();
          if (options.variant === 'independent' && command.startsWith('agentctl')) throw new Error('Use the independent work/memory tools in this variant');
          if (command === 'agentctl --help') return reply('agentctl work --help | agentctl memory --help\nagentctl GROUP OPERATION \'JSON_OBJECT\'\nmkdir PATH | mv SOURCE DESTINATION | rm PATH\nApprovals are handled by the system; there is no permission command.');
          const help = /^agentctl (work|memory) --help$/.exec(command);
          if (help) return reply(JSON.stringify({ currentTask: { id: getWork().current().id, revision: getWork().current().revision }, commands: Object.fromEntries(Object.entries(commands).filter(([key, [name]]) => key.startsWith(help[1]! + ' ') && originals.has(name)).map(([key, [name]]) => [key, { description: originals.get(name)!.description, parameters: originals.get(name)!.parameters }])) }));
          const match = /^agentctl (work|memory) ([a-z]+)\s+([\s\S]+)$/.exec(command);
          let result;
          if (match) {
            const route = commands[`${match[1]} ${match[2]}`]; if (!route) throw new Error('Unknown agentctl operation');
            let raw = match[3]!.trim(); if (raw.startsWith("'") && raw.endsWith("'")) raw = raw.slice(1, -1);
            const parsed: unknown = JSON.parse(raw);
            if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') throw new Error('Expected a JSON object');
            result = await invoke(route[0], { ...parsed, ...route[1] }, callId, signal, update, context);
          } else {
            const [verb, ...paths] = words(command); if (verb === 'mkdir' && paths[0] === '-p') paths.shift();
            if (verb === 'mkdir' && paths.length === 1) result = await invoke('file_operation', { operation: 'mkdir', path: paths[0]! }, callId, signal, update, context);
            else if (verb === 'mv' && paths.length === 2) result = await invoke('file_operation', { operation: 'move', path: paths[0]!, destination: paths[1]! }, callId, signal, update, context);
            else if (verb === 'rm' && paths.length === 1) result = await invoke('file_operation', { operation: 'delete', path: paths[0]! }, callId, signal, update, context);
            else throw new Error('Unsupported experiment command; use agentctl --help');
          }
          options.trace.push({ sessionId: setup.scope.sessionId, operation: 'bash', status: 'ok' }); return result;
        } catch (error) { options.trace.push({ sessionId: setup.scope.sessionId, operation: 'bash', status: 'error' }); throw error; }
      },
    };
    const tools = setup.tools.filter(tool => options.variant === 'independent' || !hidden.has(tool.name)).map(tool => tool.name === 'bash' ? bash : {
      ...tool, execute: (callId, args, signal, update, context) => invoke(tool.name, args as Record<string, unknown>, callId, signal, update, context),
    } as ToolDefinition);
    const instructions = options.variant === 'independent' ? setup.instructions : setup.instructions
      .replace(/默认受限，没有满足边界的命令后端时受阻；可信模式仅通过向用户展示具体 work_permission 提案并获得随后明确确认授予。可信 Shell 继承 Host 权限，不能保证禁止删除或外发；删除原件和外发使用受控工具获得明确授权。/g, '实验终端执行帮助列出的有界命令。文件权限扩展由系统根据具体操作提出，获得用户确认后继续。')
      .replace(/delegate_work/g, 'agentctl work delegate').replace(/complete_work/g, 'agentctl work complete')
      + (options.workflow === 'skill' ? `\n实验工作接口：文件、历史、委派及结算按需读取 ${options.skillFile}。` : '\n实验工作接口：agentctl GROUP OPERATION \'JSON_OBJECT\'；用 agentctl work --help 或 agentctl memory --help 获取对应参数。')
      + '\n权限由系统根据具体操作提出，不能自行授权。';
    options.surfaces.push({ sessionId: setup.scope.sessionId, names: tools.map(tool => tool.name), schemaBytes: Buffer.byteLength(JSON.stringify(tools.map(tool => ({ name: tool.name, description: tool.description, parameters: tool.parameters })))), instructionBytes: Buffer.byteLength(instructions) });
    return { tools, instructions };
  };
}
