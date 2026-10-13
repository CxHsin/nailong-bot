import { writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { modelEnvironment, nativeToolSearch, type ModelConfig } from '../../../src/agent/model-config.js';
import { runExperiment, scenarios, type Scenario, type RunReport } from './harness.js';
import type { Variant } from './interface.js';

const args = process.argv.slice(2);
const allowed = new Set(['--live', '--model', '--scenario', '--output', '--repeat', '--help']);
for (let index = 0; index < args.length; index++) {
  const flag = args[index]!; if (!allowed.has(flag)) throw new Error(`Unknown option: ${flag}`);
  if (!['--live', '--help'].includes(flag)) { if (!args[++index] || args[index]!.startsWith('--')) throw new Error(`Missing value: ${flag}`); }
}
if (args.includes('--help')) {
  console.log(`npm run experiment:tools -- [--scenario ${scenarios.join('|')}|all] [--repeat 1..10] [--output PATH]\nExplicit remote model: --live --model ALIAS (MODEL_* environment must already be loaded).\nDefault is synthetic local Provider; it does not load .env or establish model-quality results.`);
} else {
  const value = (flag: string) => { const index = args.indexOf(flag); return index < 0 ? undefined : args[index + 1]; };
  const repeat = Number(value('--repeat') ?? 1); if (!Number.isSafeInteger(repeat) || repeat < 1 || repeat > 10) throw new Error('repeat must be 1..10');
  const chosen = value('--scenario') ?? 'all'; if (chosen !== 'all' && !scenarios.includes(chosen as Scenario)) throw new Error('Unknown scenario');
  let model: ModelConfig | undefined;
  if (args.includes('--live')) {
    const alias = value('--model'); if (!alias) throw new Error('Live runs require an explicit --model alias');
    model = modelEnvironment(process.env).models.find(profile => profile.alias === alias);
    if (!model || !nativeToolSearch(model)) throw new Error('Choose a configured native Responses/Anthropic model and endpoint');
  } else if (value('--model')) throw new Error('--model requires --live');
  const runs: RunReport[] = [];
  if (model && chosen === 'stale') throw new Error('stale is a scripted failure regression, not a live task');
  const selectedScenarios = chosen === 'all' ? scenarios.filter(scenario => !model || scenario !== 'stale') : [chosen as Scenario];
  for (let trial = 0; trial < repeat; trial++) for (const scenario of selectedScenarios) {
    // Counterbalance order between repetitions. Never share a Host or materials between variants.
    const variants: Variant[] = trial % 2 ? ['skill_cli', 'independent'] : ['independent', 'skill_cli'];
    for (const variant of variants) {
      const run = await runExperiment(variant, scenario, model); runs.push(run);
      console.log(`${run.mode} ${variant} ${scenario}: ${run.passed ? 'PASS' : 'FAIL'}; requests=${run.requests}; ${run.elapsedMs}ms`);
    }
  }
  const output = value('--output') ?? join(tmpdir(), `nailong-tool-experiment-${Date.now()}.json`);
  await writeFile(output, JSON.stringify({ mode: model ? 'live' : 'fixture', model: model?.model, verdict: model ? 'pilot-only; inspect paired outcomes' : 'mechanism verification only; no model-quality verdict', runs }, null, 2));
  console.log(`Report: ${output}`); if (runs.some(run => !run.passed)) process.exitCode = 1;
}
