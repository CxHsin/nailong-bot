import { readFile, realpath } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { release } from 'node:os';
import { resolve } from 'node:path';
import { permissionError, physicalPath, type ExecutionBackend } from './permissions.js';
import type { PermissionGrant } from './types.js';

/** Deployment evidence is configuration, never model arguments. Only the sampled
 * unelevated profile is currently understood; it cannot establish full isolation. */
export interface CodexProbeEvidence {
  version: 1; mode: 'windows-unelevated'; adapterVersion: 'codex-unelevated-v1';
  executable: string; executableSha256: string; osRelease: string; measuredAt: number;
  scope: { cwd: string; readRoots: string[]; writeRoots: string[] };
  policyDigest: string;
  observations: { outsideReadDenied: boolean; outsideWriteDenied: boolean; networkDenied: boolean; detachedTreeStopped: boolean };
}
export interface BackendRegistry { backends: ExecutionBackend[]; diagnostics: Array<{ id: string; identity: string; reasons: string[] }> }
const digest = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
export async function loadExecutionBackends(env: NodeJS.ProcessEnv): Promise<BackendRegistry> {
  const evidenceFile = env.AGENT_CODEX_SANDBOX_EVIDENCE?.trim(); const executable = env.AGENT_CODEX_SANDBOX_EXECUTABLE?.trim();
  if (!evidenceFile && !executable) return { backends: [], diagnostics: [] };
  const id = 'codex-windows-unelevated';
  try {
    if (!evidenceFile || !executable) throw new Error('candidate needs executable and evidence file');
    const raw = await readFile(resolve(evidenceFile)); const evidence: CodexProbeEvidence = JSON.parse(raw.toString('utf8'));
    const path = await realpath(resolve(executable));
    const fresh = () => Number.isFinite(evidence.measuredAt) && evidence.measuredAt <= Date.now() && Date.now() - evidence.measuredAt <= 7 * 86_400_000;
    if (evidence.version !== 1 || evidence.mode !== 'windows-unelevated' || evidence.adapterVersion !== 'codex-unelevated-v1' || process.platform !== 'win32' || !fresh() || !/^[a-f0-9]{64}$/.test(evidence.policyDigest) || typeof evidence.scope?.cwd !== 'string' || !Array.isArray(evidence.scope.readRoots) || !evidence.scope.readRoots.length || !evidence.scope.readRoots.every(root => typeof root === 'string') || !Array.isArray(evidence.scope.writeRoots) || !evidence.scope.writeRoots.length || !evidence.scope.writeRoots.every(root => typeof root === 'string') || !evidence.observations || !['outsideReadDenied', 'outsideWriteDenied', 'networkDenied', 'detachedTreeStopped'].every(key => typeof evidence.observations[key as keyof typeof evidence.observations] === 'boolean')) throw new Error('unsupported or expired evidence');
    const identity = digest(JSON.stringify([path, evidence.executableSha256, evidence.osRelease, evidence.policyDigest, digest(raw)]));
    const matchIdentity = async () => (await realpath(evidence.executable)).toLowerCase() === path.toLowerCase() && evidence.osRelease === release() && digest(await readFile(path)) === evidence.executableSha256;
    if (!await matchIdentity()) throw new Error('executable or OS evidence mismatch');
    // Current actual probes disprove these boundaries. An operator boolean cannot
    // upgrade this implementation to an untested full restricted backend.
    const capabilities = { readIsolation: false, writeIsolation: evidence.observations?.outsideWriteDenied === true, networkIsolation: false, processTreeStop: false };
    const supports = async ({ cwd, grant }: { cwd: string; grant: PermissionGrant }) => {
      const reasons = ['read isolation unavailable', 'network isolation unavailable', 'generic process-tree stop unverified'];
      if (!fresh()) reasons.push('probe evidence expired');
      if (!await matchIdentity().catch(() => false)) reasons.push('executable/OS identity changed');
      if (grant.expiresAt <= Date.now()) reasons.push('grant expired');
      const canonical = async (roots: string[]) => (await Promise.all(roots.map(physicalPath))).map(root => root.toLowerCase()).sort().join('\n');
      if ((await physicalPath(cwd)).toLowerCase() !== (await physicalPath(evidence.scope.cwd)).toLowerCase() || await canonical(grant.readRoots) !== await canonical(evidence.scope.readRoots) || await canonical(grant.writeRoots) !== await canonical(evidence.scope.writeRoots)) reasons.push('scope differs from sampled roots');
      return { supported: false, reasons };
    };
    const backend: ExecutionBackend = { id, identity, verified: true, capabilities, supports,
      async execute(request) { const verdict = await supports(request); throw permissionError(`候选后端不满足授权；未派发：${verdict.reasons.join(', ')}`); } };
    return { backends: [backend], diagnostics: [{ id, identity, reasons: ['partial evidence only; restricted commands are blocked'] }] };
  } catch (error) { return { backends: [], diagnostics: [{ id, identity: '', reasons: [String(error)] }] }; }
}
