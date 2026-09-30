import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { runSlo } from './slo-check.js';
import { deriveLimits, SLO, SLO_LABEL, SLO_LIMITS, SLO_MULTIPLIERS, SLO_REFERENCE } from './slo-definition.js';
import { evaluateSlo, measureSloWorkload, type SloMeasurement } from './slo.js';

// The regression SLO (HDX-32 / P01). These tests prove the SLO is internally consistent, tied to recorded evidence, honest about
// being a fixture measurement, and that its decision policy (what fails CI, what is re-measured) does what the rationale says.
// They do NOT assert timings: the timed check lives in `npm run perf:slo`, not in this suite, so a slow machine cannot fail it.

const at = (factor: number): SloMeasurement => ({
  cases: 100, suiteReplays: 25,
  deterministic: Object.fromEntries(Object.entries(SLO_REFERENCE.deterministic).map(([name, value]) => [name, value * factor])) as SloMeasurement['deterministic'],
  timed: Object.fromEntries(Object.entries(SLO_REFERENCE.timed).map(([name, value]) => [name, value * factor])) as SloMeasurement['timed'],
  informational: { throughputRunsPerSecond: 1, workerPassP50Ms: 1, cpuMs: 1, storageBytesPerCase: 1, suiteReplayP95Ms: 1 }
});

test('[P01] the SLO is labeled a fixture measurement, never a live claim', () => {
  assert.match(SLO_LABEL, /FIXTURE/);
  assert.match(SLO_LABEL, /NOT a live performance claim/);
});

test('[P01] limits are exactly the recorded reference times the stated tolerance', () => {
  assert.deepEqual(SLO_LIMITS, deriveLimits(SLO_REFERENCE, SLO_MULTIPLIERS));
  assert.deepEqual(SLO.limits, SLO_LIMITS);
  for (const kind of ['deterministic', 'timed'] as const) for (const [name, value] of Object.entries(SLO_REFERENCE[kind])) assert.ok(value > 0, `${kind}.${name} reference was recorded`);
});

test('[P01] tolerance is tight for deterministic work counts and generous for timings', () => {
  for (const [name, multiplier] of Object.entries(SLO_MULTIPLIERS.deterministic)) assert.ok(multiplier > 1 && multiplier <= 1.5, `${name} tolerates a legitimate feature but not a doubling`);
  // The runner is a shared 1 vCPU machine: timed wall-clock limits must leave an order of magnitude, memory (not CPU-speed bound) less.
  for (const name of ['sequentialWallMs', 'workerPassP95Ms', 'suiteWallMs'] as const) assert.ok(SLO_MULTIPLIERS.timed[name] >= 10, `${name} is at least 10x the reference`);
  assert.ok(SLO_MULTIPLIERS.timed.peakRssMb >= 1.5 && SLO_MULTIPLIERS.timed.peakRssMb <= 3);
});

test('[P01] the reference equals the recorded baseline evidence (repeatability median)', async () => {
  const path = SLO_REFERENCE.recordedFrom.split(',')[0];
  const recorded = JSON.parse(await readFile(new URL(`../../${path}`, import.meta.url), 'utf8'));
  assert.match(recorded.label, /NOT a live 100-case result/);
  const r = recorded.repeatability;
  assert.ok(r, 'the baseline recorded its repeatability block');
  const median = (name: string) => r[name].median as number;
  assert.deepEqual(SLO_REFERENCE.deterministic, {
    workerStatementsPerCase: median('workerStatementsPerCase'), launchStatementsPerCase: median('launchStatementsPerCase'), eventRowsPerCase: median('eventRowsPerCase'),
    eventBytesPerCase: median('eventBytesPerCase'), replayStatementsPerReplay: median('replayStatementsPerReplay'), targetRequestsPerCase: recorded.profiles.overheadOnly.sequential.perCase.targetRequests.mean
  });
  assert.deepEqual(SLO_REFERENCE.timed, { sequentialWallMs: median('sequentialWallMs'), workerPassP95Ms: median('workerPassP95Ms'), suiteWallMs: median('suiteWallMs'), peakRssMb: median('peakRssMb') });
});

test('[P01] evaluateSlo passes the reference, passes the limit itself, and fails one unit over, per metric', () => {
  assert.ok(evaluateSlo(at(1), SLO_LIMITS).every(check => check.pass));
  const total = Object.keys(SLO_REFERENCE.deterministic).length + Object.keys(SLO_REFERENCE.timed).length;
  assert.equal(evaluateSlo(at(1), SLO_LIMITS).length, total);
  for (const kind of ['deterministic', 'timed'] as const) {
    for (const name of Object.keys(SLO_LIMITS[kind])) {
      const limit = (SLO_LIMITS[kind] as Record<string, number>)[name];
      const base = at(1);
      (base[kind] as Record<string, number>)[name] = limit;
      assert.ok(evaluateSlo(base, SLO_LIMITS).find(check => check.name === name)!.pass, `${name} exactly at its limit passes`);
      (base[kind] as Record<string, number>)[name] = limit + 1;
      const failed = evaluateSlo(base, SLO_LIMITS).filter(check => !check.pass);
      assert.deepEqual(failed.map(check => [check.name, check.kind]), [[name, kind]], `${name} one over its limit fails alone`);
    }
  }
});

test('[P01] CI policy: a deterministic breach fails at once, a timed-only breach is re-measured once, and a repeated breach fails', async () => {
  const slow = at(1000), fast = at(1), extraStatements = at(1);
  extraStatements.deterministic.workerStatementsPerCase = SLO_LIMITS.deterministic.workerStatementsPerCase + 1;
  const script = (...runs: SloMeasurement[]) => { let calls = 0; return { measure: async () => runs[Math.min(calls++, runs.length - 1)], get calls() { return calls; } }; };

  let s = script(fast);
  assert.deepEqual(await runSlo(s.measure).then(run => [run.pass, run.outcome, run.attempts.length]), [true, 'pass', 1]);
  s = script(extraStatements, fast);
  assert.deepEqual(await runSlo(s.measure).then(run => [run.pass, run.outcome, run.attempts.length]), [false, 'deterministic_breach', 1], 'work counts do not flake, so there is no second chance');
  assert.equal(s.calls, 1);
  s = script(slow, fast);
  assert.deepEqual(await runSlo(s.measure).then(run => [run.pass, run.outcome, run.attempts.length]), [true, 'pass', 2], 'a transient timing spike passes on the re-measurement');
  s = script(slow, slow);
  assert.deepEqual(await runSlo(s.measure).then(run => [run.pass, run.outcome, run.attempts.length]), [false, 'timed_breach', 2], 'a sustained slowdown fails');
  s = script(slow, extraStatements);
  assert.deepEqual(await runSlo(s.measure).then(run => [run.pass, run.outcome]), [false, 'deterministic_breach'], 'a work-count breach on the re-measurement still fails');
  s = script(slow, fast);
  assert.deepEqual(await runSlo(s.measure, false).then(run => [run.pass, run.attempts.length]), [false, 1], 'retry can be disabled');
});

test('[P01] the real pipeline meets every deterministic limit on a 20-case run (same mix proportions as the 100-case baseline)', async () => {
  const measurement = await measureSloWorkload({ cases: 20, suiteReplays: 3, warmup: 0 });
  const checks = evaluateSlo(measurement, SLO_LIMITS).filter(check => check.kind === 'deterministic');
  assert.ok(checks.length > 0 && checks.every(check => check.pass), JSON.stringify(checks.filter(check => !check.pass)));
  assert.ok(measurement.timed.sequentialWallMs > 0 && measurement.informational.throughputRunsPerSecond > 0);
});

test('[P01] `slo-check.ts --measure-only` prints exactly one JSON measurement from a fresh process', async () => {
  const { stdout } = await promisify(execFile)(process.execPath, ['--import', 'tsx', 'tests/performance/slo-check.ts', '--measure-only', '--cases', '20', '--suite', '2', '--warmup', '0'], { env: process.env, cwd: new URL('../../', import.meta.url) });
  const lines = stdout.trim().split('\n');
  assert.equal(lines.length, 1, 'nothing but the measurement on stdout');
  const measurement = JSON.parse(lines[0]) as SloMeasurement;
  assert.equal(measurement.cases, 20);
  assert.equal(measurement.suiteReplays, 2);
  assert.ok(measurement.deterministic.workerStatementsPerCase > 20 && measurement.timed.peakRssMb > 50);
});
