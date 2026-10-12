import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { checkFile } from './permissions.js';
import type { Task, TaskResult, ActionDispatch } from './types.js';

export function operationMaterials(actions: ActionDispatch[]): NonNullable<TaskResult['operations']> {
  return actions.filter(action => action.status === 'succeeded' && action.action.kind.startsWith('file-')).flatMap(action => {
    try { const result = JSON.parse(action.evidence ?? '{}'); const payload = JSON.parse(result.content?.[0]?.text ?? '{}'); return payload.materialOperation ? [payload.materialOperation] : []; } catch { return []; }
  });
}

/** Material checks depend on its purpose; the main Session still owns the overall verdict. */
export async function inspectMaterial(task: Task, result: TaskResult, dataDir: string): Promise<TaskResult> {
  const manifest: NonNullable<TaskResult['manifest']> = [];
  for (const artifact of result.artifacts ?? []) {
    const path = await checkFile(task, artifact, false, dataDir); const bytes = await readFile(path);
    manifest.push({ path, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
  }
  const sources: NonNullable<TaskResult['sources']> = [];
  const canonical = (path: string) => process.platform === 'win32' ? path.toLowerCase() : path;
  const artifactDigests = Object.fromEntries(manifest.flatMap(item => { const expected = Object.entries(result.artifactDigests ?? {}).find(([path]) => canonical(path) === canonical(item.path)); return expected ? [[item.path, expected[1]]] : []; }));
  for (const source of result.sources ?? []) {
    try { const path = await checkFile(task, source.reference, false, dataDir); const text = await readFile(path, 'utf8'); if (source.excerpt.trim() && text.includes(source.excerpt) && source.supports?.some(claim => claim.trim())) sources.push({ ...source, reference: path }); } catch { /* Unchecked sources remain partial material. */ }
  }
  let operationsValid = !!result.operations?.length;
  for (const operation of result.operations ?? []) {
    if (!operation.before.length || operation.before.length !== operation.after.length || !operation.before.some(before => operation.after.some(after => after.path === before.path && after.sha256 !== before.sha256))) operationsValid = false;
    for (const after of operation.after) { try { const path = await checkFile(task, after.path, false, dataDir); let actual: string | null; try { actual = createHash('sha256').update(await readFile(path)).digest('hex'); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; actual = null; } if (actual !== after.sha256) operationsValid = false; } catch { operationsValid = false; } }
    if (operation.operation === 'move' && (operation.before.length !== 2 || operation.before[0]?.sha256 === null || operation.before[1]?.sha256 !== null || operation.after[0]?.sha256 !== null || operation.after[1]?.sha256 !== operation.before[0]?.sha256)) operationsValid = false;
  }
  const valid = task.purpose === 'organization' ? operationsValid : task.purpose === 'coding' ? manifest.length > 0 && manifest.every(item => artifactDigests[item.path] === item.sha256) && !!result.checks?.length && result.checks.every(check => check.status === 'passed' && (check.taskId && check.taskId !== task.id ? check.parentRevision === task.revision : check.revision === task.revision)) : task.purpose === 'research' ? sources.length > 0 && !!result.uncertainties?.trim() : manifest.length > 0 || sources.length > 0;
  return { ...result, artifactDigests, manifest, sources, verified: valid && !result.partial, partial: !valid || result.partial };
}
