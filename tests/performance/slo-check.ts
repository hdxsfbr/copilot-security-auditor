import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { machineInfo, revisionInfo } from '../acceptance/evidence.js';
import { cpuProbe } from './measure.js';
import { SLO, SLO_LABEL } from './slo-definition.js';
import { evaluateSlo, measureSloWorkload, type SloCheck, type SloMeasurement } from './slo.js';

// The timed fixture SLO check (HDX-32 / P01), run by CI after the fixture tests:
//
//   TEST_DATABASE_URL=... npm run perf:slo [-- --out perf-slo-result.json]
//
// It measures the SLO workload (100 sequential fixture cases, then one 25-replay regression suite) and fails the job when a
// limit in slo-definition.ts is exceeded. Exit codes: 0 pass, 1 SLO breached, 2 the workload itself failed (a wrong outcome is a
// functional failure, never an SLO pass), 3 the watchdog fired.
//
// Noise policy (see the rationale in slo-definition.ts): the deterministic limits (statements, event rows and bytes per case) cannot
// flake and any breach fails at once. The timed limits are generous, and a breach of only timed limits triggers ONE full re-measurement
// on the same runner; the job fails only if the re-measurement also breaches. A transient noisy neighbour therefore cannot fail
// the pipeline, a sustained slowdown still does.

export type SloAttempt = { measurement: SloMeasurement; checks: SloCheck[]; failedDeterministic: string[]; failedTimed: string[] };
export type SloRun = { attempts: SloAttempt[]; pass: boolean; outcome: 'pass' | 'deterministic_breach' | 'timed_breach' };

async function attempt(measure: () => Promise<SloMeasurement>): Promise<SloAttempt> {
  const measurement = await measure();
  const checks = evaluateSlo(measurement, SLO.limits);
  return { measurement, checks, failedDeterministic: checks.filter(check => !check.pass && check.kind === 'deterministic').map(check => check.name), failedTimed: checks.filter(check => !check.pass && check.kind === 'timed').map(check => check.name) };
}

/** Measures, judges and (for timed-only breaches) re-measures once. `measure` is injectable so the policy is testable without the stack. */
export async function runSlo(measure: () => Promise<SloMeasurement> = () => measureSloWorkload(), retry = true): Promise<SloRun> {
  const first = await attempt(measure);
  if (first.failedDeterministic.length) return { attempts: [first], pass: false, outcome: 'deterministic_breach' };
  if (!first.failedTimed.length) return { attempts: [first], pass: true, outcome: 'pass' };
  if (!retry) return { attempts: [first], pass: false, outcome: 'timed_breach' };
  const second = await attempt(measure);
  if (second.failedDeterministic.length) return { attempts: [first, second], pass: false, outcome: 'deterministic_breach' };
  return { attempts: [first, second], pass: second.failedTimed.length === 0, outcome: second.failedTimed.length ? 'timed_breach' : 'pass' };
}

const table = (checks: SloCheck[]) => checks.map(check => `  ${check.pass ? 'ok  ' : 'FAIL'} ${check.kind.padEnd(13)} ${check.name.padEnd(26)} measured ${String(check.measured).padStart(9)} ${check.unit.padEnd(10)} limit ${String(check.limit).padStart(9)}  (limit is ${check.headroom}x measured)`).join('\n');

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const numberFlag = (name: string, fallback: number) => { const at = args.indexOf(name); if (at < 0) return fallback; const value = Number(args[at + 1]); if (!Number.isInteger(value) || value < 0) { console.error(`${name} needs a non-negative integer`); process.exit(2); } return value; };
  if (args.includes('--measure-only')) {
    // One measurement as JSON on stdout and nothing else. The baseline recorder runs this in a fresh process per repetition so each
    // repetition starts from a cold Node heap, exactly as the CI job does.
    try { process.stdout.write(`${JSON.stringify(await measureSloWorkload({ cases: numberFlag('--cases', 100), suiteReplays: numberFlag('--suite', 25), warmup: numberFlag('--warmup', 10) }))}\n`); process.exit(0); }
    catch (error) { console.error(`SLO workload failed: ${(error as Error).message}`); process.exit(2); }
  }
  const out = args.includes('--out') ? resolve(args[args.indexOf('--out') + 1]) : null;
  const retry = !args.includes('--no-retry');
  // A hung database or a stuck phase must not hold the shared runner: the whole check normally takes seconds.
  setTimeout(() => { console.error('SLO check exceeded its 10 minute watchdog'); process.exit(3); }, 600_000).unref();
  console.log(SLO_LABEL);
  let result: SloRun;
  try { result = await runSlo(() => measureSloWorkload(), retry); }
  catch (error) { console.error(`SLO workload failed before any limit was judged: ${(error as Error).message}`); process.exit(2); }
  result.attempts.forEach((item, index) => {
    console.log(`\nattempt ${index + 1} of ${result.attempts.length}: ${item.measurement.cases} sequential cases, then ${item.measurement.suiteReplays} regression replays`);
    console.log(table(item.checks));
  });
  console.log(`\nSLO ${result.pass ? 'PASSED' : `FAILED (${result.outcome})`}${result.attempts.length > 1 ? ' after one re-measurement' : ''}. Fixture measurement only: not live performance.`);
  if (out) {
    await mkdir(dirname(out), { recursive: true });
    const report = { schema: 'performance-slo-result/v1', label: SLO_LABEL, recordedAt: new Date().toISOString(), outcome: result.outcome, pass: result.pass, sloVersion: SLO.version, revision: revisionInfo(), machine: { ...machineInfo(), cpuProbe: await cpuProbe() }, limits: SLO.limits, attempts: result.attempts };
    await writeFile(out, `${JSON.stringify(report, null, 2)}\n`);
    console.log(`wrote ${out}`);
  }
  process.exit(result.pass ? 0 : 1);
}
