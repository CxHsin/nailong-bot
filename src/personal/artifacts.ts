import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, realpath } from 'node:fs/promises';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';
import type { Task, TaskResult } from './types.js';
import { checkFile } from './permissions.js';

/** Freeze verified bytes so queued delivery cannot pick up a later task's modifications. */
export async function freezeArtifacts(dataDir: string, task: Task, result: TaskResult): Promise<TaskResult> {
  if (!result.artifacts?.length) return result;
  const root = await realpath(task.cwd!);
  const directory = join(dataDir, 'personal-artifacts', task.id, `${task.revision}-${randomUUID()}`);
  await mkdir(directory, { recursive: true });
  const artifacts: string[] = []; const artifactDigests: Record<string, string> = {};
  for (const [index, source] of result.artifacts.entries()) {
    const path = await realpath(resolve(source)); const part = relative(root, path);
    if (task.direct && task.permission) await checkFile(task, path, false, dataDir);
    else if (!part || part.startsWith('..') || isAbsolute(part)) throw new Error('成果文件超出任务目录');
    const bytes = await readFile(path);
    const digest = createHash('sha256').update(bytes).digest('hex');
    if (result.artifactDigests?.[resolve(source)] && result.artifactDigests[resolve(source)] !== digest)
      throw new Error('成果已在验收后变化，拒绝冻结不同内容');
    if (bytes.length > 50 * 1024 * 1024) throw new Error('成果文件超过首期 50 MiB 交付限制');
    const target = join(directory, `${index}-${basename(path)}`);
    const file = await open(target, 'wx');
    try { await file.writeFile(bytes); await file.sync(); } finally { await file.close(); }
    artifacts.push(target); artifactDigests[target] = digest;
  }
  return { ...result, artifacts, artifactDigests };
}
