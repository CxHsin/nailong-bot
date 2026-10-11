import { execFile } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

/** Numeric OS evidence only; no process arguments, environment or credentials. */
export function processExists(pid: number) {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH'; }
}
export async function processTree(pid: number): Promise<number[]> {
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('Invalid process identity');
  if (process.platform === 'win32') {
    const script = `$all=Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId; $ids=[System.Collections.Generic.HashSet[uint32]]::new(); [void]$ids.Add(${pid}); do { $added=$false; foreach($p in $all) { if($ids.Contains($p.ParentProcessId) -and $ids.Add($p.ProcessId)) { $added=$true } } } while($added); ConvertTo-Json -Compress -InputObject @($ids)`;
    const ids: unknown = JSON.parse(await controlCommand('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script]));
    if (!Array.isArray(ids) || !ids.every(id => Number.isSafeInteger(id) && id > 0)) throw new Error('Invalid process identity evidence');
    return ids;
  }
  const rows = (await controlCommand('ps', ['-eo', 'pid=,ppid='])).trim().split('\n').map(row => row.trim().split(/\s+/).map(Number));
  const found = new Set([pid]); let added = true;
  while (added) {
    added = false;
    for (const [id, parent] of rows) if (id && parent && found.has(parent) && !found.has(id)) { found.add(id); added = true; }
  }
  return [...found];
}
export async function waitForTermination(ids: number[], checks = 20, intervalMs = 50): Promise<boolean> {
  if (!ids.length) return false;
  for (let check = 0; check < checks; check++) {
    if (ids.every(id => !processExists(id))) return true;
    await delay(intervalMs);
  }
  return false;
}
export async function stopProcessTree(pid: number | undefined): Promise<boolean> {
  if (!pid || !Number.isSafeInteger(pid) || pid < 1) return false;
  try {
    const ids = await processTree(pid);
    if (process.platform === 'win32') {
      if (processExists(pid)) await controlCommand('taskkill.exe', ['/PID', String(pid), '/T', '/F']).catch(() => {});
    } else {
      for (const id of [...ids].reverse()) try { process.kill(id, 'SIGKILL'); } catch { /* confirmed below */ }
    }
    return waitForTermination(ids);
  } catch {
    try { process.kill(pid, 'SIGKILL'); } catch { /* failed inspection still means unknown */ }
    return false;
  }
}
function controlCommand(command: string, args: string[]): Promise<string> {
  return new Promise((accept, reject) => execFile(command, args, { windowsHide: true, timeout: 5000, maxBuffer: 128 * 1024 }, (error, stdout) => error ? reject(error) : accept(stdout)));
}
