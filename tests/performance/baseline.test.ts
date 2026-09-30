import { test } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { BASELINE_LABEL, runBaseline } from './baseline.js';
import { instrumentPg, summarize, topStatements } from './measure.js';
import { phaseDeployedCadence, publishPool, safeJudges, workloadStack } from './workload.js';
import { database } from '../support.js';

// Keeps the P01 baseline harness honest without recording or asserting any timing: a tiny run must exercise the real pipeline,
// produce the outcomes the case mix implies, account for where each worker pass went, and label everything a fixture baseline.

test('[P01] summarize uses nearest-rank percentiles and tolerates no samples', () => {
  const samples = Array.from({ length: 100 }, (_, index) => 100 - index); // unsorted on purpose
  assert.deepEqual(summarize(samples), { count: 100, meanMs: 50.5, p50Ms: 50, p95Ms: 95, p99Ms: 99, maxMs: 100 });
  assert.deepEqual(summarize([]), { count: 0, meanMs: 0, p50Ms: 0, p95Ms: 0, p99Ms: 0, maxMs: 0 });
});

test('[P01] the SQL instrument counts promise and callback statements, groups by shape, and restores the driver', async () => {
  const instrument = instrumentPg();
  const db = await database();
  try {
    instrument.reset();
    const before = instrument.snapshot();
    await db.repo.pool.query('SELECT 1 AS one');
    await db.repo.pool.query('SELECT $1::int AS n', [1]);
    await db.repo.pool.query('SELECT $1::int AS n', [2]);
    await new Promise<void>((resolve, reject) => db.repo.pool.query('SELECT 2 AS two', (error: Error | undefined) => error ? reject(error) : resolve()));
    const after = instrument.snapshot();
    assert.equal(after.statements - before.statements, 4);
    assert.ok(after.dbMs > 0);
    const top = topStatements(after, before, 4, 10);
    assert.equal(top.find(row => row.sql.startsWith('SELECT $1::int'))?.callsPerCase, 0.5, 'two executions of one shape over four cases');
    assert.ok(top.every(row => row.shareOfDbTime >= 0 && row.shareOfDbTime <= 1));
  } finally { await db.close(); instrument.restore(); }
  const restored = (pg.Client.prototype as unknown as { query: { name: string } }).query.name;
  assert.notEqual(restored, 'patched', 'the driver is no longer wrapped');
});

test('[P01] a small baseline drives the real pipeline, separates where the time went, and labels itself a fixture baseline', async () => {
  const report = await runBaseline({ cases: 20, identities: 4, suiteSize: 2, lanes: [1, 2], latencyCases: 4, latencyLanes: [1, 2], repeats: 0, cadenceRuns: 0, warmup: 0, targetLatencyMs: 6, judgeLatencyMs: 6 });
  assert.equal(report.label, BASELINE_LABEL);
  assert.match(report.label, /NOT a live 100-case result and NOT live performance/);
  assert.deepEqual(report.claims, { liveTarget: false, paidProviders: false, modelInference: false, network: '127.0.0.1 only', liveAcceptance: false, liveHundredCaseResult: false, liveLatencyOrThroughput: false, capacityClaim: false });
  assert.match(report.revision.head, /^[0-9a-f]{40}$/);
  assert.ok(report.machine.cpuProbe.medianMs > 0 && report.machine.logicalCpus > 0);
  assert.ok(report.knownLimits.some(text => /not the authorized live 100-case acceptance/.test(text)) && report.knownLimits.some(text => /No live target, paid provider or model inference/.test(text)));

  const { sequential, laneCurve, regression, apiReads, storage } = report.profiles.overheadOnly;
  // Per 20 cases: 17 end safe (10 + 3 + 4) and 3 tool cases end inconclusive, exactly as the asserted mix says.
  assert.deepEqual(sequential.outcomes, { safe: 17, inconclusive: 3 });
  assert.equal(sequential.runs, 20);
  const shares = sequential.workerPassBreakdown.meanShare;
  assert.ok(Math.abs(shares.postgres + shares.targetHttp + shares.judgeHttp + shares.orchestration - 1) < 0.02, `shares add up to the worker pass: ${JSON.stringify(shares)}`);
  assert.ok(sequential.perCase.workerStatements.mean > 10 && sequential.perCase.launchStatements.mean > 1 && sequential.perCase.eventRows > 3 && sequential.perCase.eventBytes > 500 && sequential.perCase.targetRequests.mean > 5);
  assert.equal(sequential.perCase.judgeRequests.max, 1, 'one Judge call per judged case');
  assert.ok(sequential.resources.cpuMs > 0 && sequential.resources.peakRssMb > 0 && sequential.resources.eventLoopDelay.p99Ms >= 0);
  assert.ok(sequential.topStatements.length > 0 && sequential.topStatements[0].shareOfDbTime > 0);
  assert.deepEqual(laneCurve.map(item => [item.lanes, item.runs]), [[1, 20], [2, 20]]);
  for (const item of laneCurve) assert.equal(Object.values(item.outcomes).reduce((sum, value) => sum + value, 0), 20);

  assert.equal(regression.identities, 4);
  assert.equal(regression.replays, 4);
  assert.deepEqual(regression.suites.map(suite => suite.size), [2, 2]);
  assert.ok(regression.suites.every(suite => suite.replayLatency.count === suite.size && suite.statementsPerReplay > 10 && suite.createMs > 0));
  for (const name of ['runs_history_25', 'findings', 'scoped_coverage_target', 'scoped_coverage_all_targets', 'coverage_summary', 'regression_identities', 'regressions', 'regression_suites', 'operations_health', 'cases']) assert.ok(apiReads[name as keyof typeof apiReads].bytes > 2, `${name} returned a body`);
  assert.ok(storage.tables.events.rows > 100 && storage.tables.runs.rows > 20 && storage.databaseBytes > 1_000_000);

  // Injected latency is really applied: a worker pass now includes at least one target request and one Judge call of 6 ms each.
  const slow = report.profiles.syntheticLatency;
  assert.ok(slow?.sequential && slow.laneCurve.length === 2);
  assert.ok(slow.sequential.workerPassBreakdown.targetHttp.meanMs >= 6 * slow.sequential.perCase.targetRequests.mean * 0.9, 'every target request carried the injected latency');
  assert.ok(slow.sequential.workerPassBreakdown.judgeHttp.meanMs >= 6 * 0.9);
  assert.equal(report.profiles.deployedWorkerCadence, null);
  assert.equal(report.repeatability, null);
});

test('[P01] the deployed-cadence phase pays the worker pause once per drained run', async () => {
  const s = await workloadStack();
  try {
    const judges = await safeJudges(s), pool = await publishPool(s, 20);
    const result = await phaseDeployedCadence(s, pool, 3, judges, 120);
    assert.equal(result.runs, 3);
    assert.ok(result.wallMs >= 3 * 120, 'three cycles, three pauses');
    assert.ok(result.secondsPerRun >= 0.12 && result.throughputRunsPerSecond > 0);
    assert.equal((await s.rows("SELECT count(*)::int AS count FROM runs WHERE status='finished'"))[0].count, 3);
  } finally { await s.close(); }
});

test('[P01] the memory-stability check reports a series per round and labels itself a fixture check', async () => {
  const { measureMemoryStability, MEMORY_LABEL } = await import('./memory-stability.js');
  const report = await measureMemoryStability({ rounds: 2, cases: 20 });
  assert.equal(report.label, MEMORY_LABEL);
  assert.equal(report.series.length, 3);
  assert.equal(report.totalCases, 40);
  assert.ok(report.series.every(point => point.rssMb > 50 && point.heapUsedMb > 5) && Number.isFinite(report.growth.heapUsedKbPerCase));
});
