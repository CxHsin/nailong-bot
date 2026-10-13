import { writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { modelEnvironment, nativeToolSearch, type ModelConfig } from '../../../src/agent/model-config.js';
import { runExperiment, scenarios, type Scenario, type RunReport, type ExperimentOptions } from './harness.js';
import type { Variant } from './interface.js';

const args = process.argv.slice(2);
const allowed = new Set(['--live', '--model', '--scenario', '--output', '--repeat', '--help', '--permission', '--helper', '--source', '--factor', '--plan']);
for (let index = 0; index < args.length; index++) {
  const flag = args[index]!; if (!allowed.has(flag)) throw new Error(`Unknown option: ${flag}`);
  if (!['--live', '--help', '--plan'].includes(flag)) { if (!args[++index] || args[index]!.startsWith('--')) throw new Error(`Missing value: ${flag}`); }
}
if (args.includes('--help')) {
  console.log(`npm run experiment:tools -- [--scenario ${scenarios.join('|')}|all] [--repeat 1..10] [--output PATH]\nSingle factor: --factor interface (A vs CLI, inline guidance) | workflow (CLI inline vs Skill).\nSeparate scenarios: --permission trusted|restricted --helper fast|delayed|zero-permission --source retrieved|injected\nExplicit remote model: --live --model ALIAS (MODEL_* environment must already be loaded).\nDefault is synthetic local Provider; it does not load .env or establish model-quality results.`);
} else if (args.includes('--plan')) {
  const value = (flag: string) => { const index = args.indexOf(flag); return index < 0 ? undefined : args[index + 1]; };
  if (value('--factor') !== 'discovery') throw new Error('--plan requires --factor discovery');
  if (args.some(flag => ['--live', '--model', '--repeat', '--permission', '--helper', '--source'].includes(flag))) throw new Error('Discovery plan exports design only; execution options are unavailable');
  const scenario = value('--scenario') ?? 'organize'; if (!scenarios.includes(scenario as Scenario) || scenario === 'stale') throw new Error('Choose a normal single scenario');
  const output = value('--output') ?? join(tmpdir(), `nailong-discovery-plan-${Date.now()}.json`);
  await writeFile(output, JSON.stringify({ batch: 'foundation-20261013-v2', factor: 'discovery', scenario, executable: false,
    variants: ['resident-independent-tools', 'native-deferred-independent-tools'],
    fixed: { interface: 'independent', workflow: 'inline', permissionMode: ['approval', 'denial'].includes(scenario) ? 'restricted' : 'trusted', helper: 'fast', source: 'retrieved', approval: 'exact-action-paths-v2', scoringVersion: 2 },
    prerequisites: ['connect native resident/deferred configuration and verify actual Provider wire requests', 'freeze paired initial facts, scoring and budgets before execution', 'obtain separate authorization for paid runs'] }, null, 2));
  console.log(`Design only: ${output}`);
} else {
  const value = (flag: string) => { const index = args.indexOf(flag); return index < 0 ? undefined : args[index + 1]; };
  const repeat = Number(value('--repeat') ?? 1); if (!Number.isSafeInteger(repeat) || repeat < 1 || repeat > 10) throw new Error('repeat must be 1..10');
  const chosen = value('--scenario') ?? 'all'; if (chosen !== 'all' && !scenarios.includes(chosen as Scenario)) throw new Error('Unknown scenario');
  const choice = <T extends string>(flag: string, choices: readonly T[], fallback?: T): T | undefined => {
    const selected = value(flag) ?? fallback; if (selected && !choices.includes(selected as T)) throw new Error(`Invalid ${flag}`); return selected as T | undefined;
  };
  const factor = choice('--factor', ['interface', 'workflow'], 'interface')!;
  const options: ExperimentOptions = { permissionMode: choice('--permission', ['trusted', 'restricted']), helper: choice('--helper', ['fast', 'delayed', 'zero-permission']), source: choice('--source', ['retrieved', 'injected']) };
  if (options.permissionMode === 'trusted' && (chosen === 'all' || ['approval', 'denial'].includes(chosen))) throw new Error('approval/denial are restricted scenarios; select a full-access scenario separately');
  if (options.helper && chosen !== 'delegation') throw new Error('--helper requires --scenario delegation');
  if (options.source && chosen !== 'memory') throw new Error('--source requires --scenario memory');
  let model: ModelConfig | undefined;
  if (args.includes('--live')) {
    const alias = value('--model'); if (!alias) throw new Error('Live runs require an explicit --model alias');
    model = modelEnvironment(process.env).models.find(profile => profile.alias === alias);
    if (!model || !nativeToolSearch(model)) throw new Error('Choose a configured native Responses/Anthropic model and endpoint');
  } else if (value('--model')) throw new Error('--model requires --live');
  const runs: RunReport[] = [];
  const output = value('--output') ?? join(tmpdir(), `nailong-tool-experiment-${Date.now()}.json`);
  let lastRequestAt = 0;
  const requestIntervalMs = model ? 15_000 : 0;
  const pace = async () => {
    const started = performance.now();
    const waitMs = Math.max(0, lastRequestAt + requestIntervalMs - Date.now());
    if (waitMs) await delay(waitMs);
    lastRequestAt = Date.now();
    return Math.round(performance.now() - started);
  };
  if (model && chosen === 'stale') throw new Error('stale is a scripted failure regression, not a live task');
  const selectedScenarios = chosen === 'all' ? scenarios.filter(scenario => !model || scenario !== 'stale') : [chosen as Scenario];
  const save = (complete: boolean) => writeFile(output, JSON.stringify({ batch: 'foundation-20261013-v2', factor, mode: model ? 'live' : 'fixture', model: model?.model, requestIntervalMs, complete, verdict: model ? 'pilot-only; inspect paired dimensions' : 'mechanism verification only; no model-quality verdict', runs }, null, 2));
  for (let trial = 0; trial < repeat; trial++) for (const scenario of selectedScenarios) {
    // Counterbalance order between repetitions. Never share a Host or materials between variants.
    const variants: Array<{ variant: Variant; workflow: 'inline' | 'skill' }> = factor === 'interface' ? [{ variant: 'independent', workflow: 'inline' }, { variant: 'skill_cli', workflow: 'inline' }] : [{ variant: 'skill_cli', workflow: 'inline' }, { variant: 'skill_cli', workflow: 'skill' }];
    if (trial % 2) variants.reverse();
    for (const { variant, workflow } of variants) {
      const run = await runExperiment(variant, scenario, model, pace, { ...options, workflow, async onFrozen(report) { runs.push(report); await save(false); } });
      await save(false);
      console.log(`${run.mode} ${variant}/${workflow} ${scenario}/${run.calibration.permissionMode}: ${run.passed ? 'PASS' : 'FAIL'}; scores=${JSON.stringify(run.scores)}; requests=${run.requests}; ${run.elapsedMs}ms`);
    }
  }
  await save(true);
  console.log(`Report: ${output}`); if (runs.some(run => !run.passed)) process.exitCode = 1;
}
