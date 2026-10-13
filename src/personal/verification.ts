import { execFile } from 'node:child_process';
import { resolve } from 'node:path';
import { stopProcessTree } from './process-control.js';
import type { ActionSpec, Task } from './types.js';

export interface VerificationCommand { command: string; args: string[]; cwd?: string }
export interface CheckEvidence {
  command: string; args: string[]; cwd: string; revision: number;
  status: 'passed' | 'failed' | 'timed_out' | 'cancelled' | 'output_limit' | 'unknown';
  exitCode: number | null; timedOut: boolean; stdout: string; stderr: string;
  terminationConfirmed: boolean;
}
export interface VerificationOptions {
  /** Only explicit operator configuration grants this permission; not model output. */
  preauthorized?: boolean; timeoutMs?: number; maxOutputBytes?: number;
  /** Production must supply a task-permission backend; configured checks are not
   * an escape hatch from the work's execution environment. */
  runCommand?: (task: Task, command: VerificationCommand, context: VerificationContext) => Promise<CheckEvidence>;
}
export interface VerificationContext { signal?: AbortSignal; requestAction?: (action: ActionSpec) => Promise<boolean> }

/** Runs exact, independently configured commands with inherited process authority.
 * Argument arrays prevent accidental shell interpolation; this is not a sandbox. */
export class VerificationChecks {
  private readonly commands: VerificationCommand[];
  constructor(commands: VerificationCommand[], private readonly options: VerificationOptions = {}) {
    if (!Number.isSafeInteger(options.timeoutMs ?? 30_000) || (options.timeoutMs ?? 30_000) < 1 || !Number.isSafeInteger(options.maxOutputBytes ?? 64 * 1024) || (options.maxOutputBytes ?? 64 * 1024) < 1 || (options.maxOutputBytes ?? 64 * 1024) > 4 * 1024 * 1024) throw new Error('Verification limits must be finite positive integers; output limit is at most 4 MiB');
    if (!Array.isArray(commands) || commands.length > 10) throw new Error('Verification checks must be an array of at most 10 commands');
    this.commands = commands.map(command => {
      if (!command || typeof command.command !== 'string' || !command.command.trim() || command.command.includes('\0') || !Array.isArray(command.args) || !command.args.every(arg => typeof arg === 'string' && !arg.includes('\0')) || (command.cwd !== undefined && typeof command.cwd !== 'string')) throw new Error('Invalid verification command; expected command, args array and optional cwd');
      return { command: command.command, args: [...command.args], ...(command.cwd !== undefined ? { cwd: resolve(command.cwd) } : {}) };
    });
  }
  async run(task: Task, context: VerificationContext = {}): Promise<CheckEvidence[]> {
    if (!this.commands.length) return [];
    if (!task.cwd) throw attention('Independent checks need an explicit task working directory');
    const cwd = resolve(task.cwd); const evidence: CheckEvidence[] = [];
    for (const command of this.commands) {
      // A fixed operator-configured project check cannot leak into another task.
      if (command.cwd && command.cwd.toLowerCase() !== cwd.toLowerCase()) continue;
      context.signal?.throwIfAborted();
      if (this.options.runCommand) {
        evidence.push(await this.options.runCommand(task, command, context));
        if (evidence.at(-1)?.status !== 'passed') break;
        continue;
      }
      if (!this.options.preauthorized && !(await context.requestAction?.({ kind: 'verification-command', target: cwd,
        parameters: { command: command.command, args: command.args, cwd },
        content: `Run independent check with this process's local permissions: ${JSON.stringify([command.command, ...command.args])}` }))) throw attention('Independent check has not run; exact command and working directory need approval');
      evidence.push(await new Promise<CheckEvidence>(accept => {
        const outputLimit = this.options.maxOutputBytes ?? 64 * 1024;
        let reason: 'timed_out' | 'cancelled' | 'output_limit' | undefined;
        let stopping: Promise<boolean> | undefined; let bytes = 0;
        const finishStop = (cause: NonNullable<typeof reason>) => {
          if (stopping) return;
          reason = cause; stopping = stopProcessTree(child.pid);
        };
        const abort = () => finishStop('cancelled');
        const child = execFile(command.command, command.args, { cwd, windowsHide: true, maxBuffer: Math.max(64 * 1024, outputLimit * 2) }, async (error, stdout, stderr) => {
          clearTimeout(timer); context.signal?.removeEventListener('abort', abort);
          const code = error && typeof error.code === 'number' ? error.code : error ? null : 0;
          const terminationConfirmed = stopping ? await stopping : !error || typeof error.code === 'number' || (error as NodeJS.ErrnoException).code === 'ENOENT';
          const status = reason ? terminationConfirmed ? reason : 'unknown' : error ? error.signal ? 'unknown' : 'failed' : 'passed';
          accept({ command: command.command, args: [...command.args], cwd, revision: task.revision,
            status, exitCode: code, timedOut: reason === 'timed_out',
            stdout: truncate(stdout, outputLimit), stderr: truncate(stderr, Math.max(0, outputLimit - Buffer.byteLength(truncate(stdout, outputLimit)))), terminationConfirmed });
        });
        const timer = setTimeout(() => finishStop('timed_out'), this.options.timeoutMs ?? 30_000);
        const track = (chunk: Buffer) => { bytes += chunk.length; if (bytes > outputLimit) finishStop('output_limit'); };
        child.stdout?.on('data', track); child.stderr?.on('data', track);
        context.signal?.addEventListener('abort', abort, { once: true });
        if (context.signal?.aborted) abort();
      }));
      if (context.signal?.aborted || evidence.at(-1)?.status !== 'passed') break;
    }
    return evidence;
  }
}
function attention(message: string) { const error = new Error(message); error.name = 'ExecutorAttentionError'; return error; }
function truncate(text: string, bytes: number) { return Buffer.from(text).subarray(0, bytes).toString('utf8'); }
