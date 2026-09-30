import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BASELINE_LABEL, percentiles, runBaseline } from './baseline.js';

// Keeps the baseline harness honest without recording numbers: a tiny run must exercise the real pipeline, produce
// the outcomes the case mix implies, add injected latency where asked and label everything as a fixture baseline.

test('[BASELINE] percentiles use nearest-rank on the sorted samples', () => {
  const samples = Array.from({ length: 100 }, (_, index) => 100 - index); // unsorted on purpose
  assert.deepEqual(percentiles(samples), { count: 100, meanMs: 50.5, p50Ms: 50, p95Ms: 95, p99Ms: 99, maxMs: 100 });
  assert.deepEqual(percentiles([7]), { count: 1, meanMs: 7, p50Ms: 7, p95Ms: 7, p99Ms: 7, maxMs: 7 });
  assert.throws(() => percentiles([]), /no samples/);
});

test('[BASELINE] a small baseline run drives the real pipeline, injects latency, and labels itself a fixture baseline', async () => {
  const report = await runBaseline({ cases: 6, workers: 2, suite: 2, latencyRuns: 2, targetLatencyMs: 8, judgeLatencyMs: 8 });
  assert.equal(report.label, BASELINE_LABEL);
  assert.match(report.label, /NOT a live 100-case result/);
  assert.deepEqual(report.claims, { liveTarget: false, paidProviders: false, modelInference: false, network: '127.0.0.1 only', liveAcceptance: false, liveHundredCaseResult: false, capacityClaim: false });
  assert.match(report.revision.head, /^[0-9a-f]{40}$/);
  assert.ok(report.knownLimits.some(text => /not the 100-case fixture baseline/.test(text)) && report.knownLimits.some(text => /No live target/.test(text)));

  const { sequential, parallel, regressionSuite, apiReads } = report.profiles.overheadOnly;
  // The first six pool entries are injection cases whose scripted Judge says safe: every run must finish exactly so.
  assert.deepEqual(sequential.outcomes, { safe: 6 });
  assert.equal(sequential.runs, 6);
  assert.ok(sequential.throughputRunsPerSecond > 0 && sequential.resources.cpuMs > 0 && sequential.resources.peakRssMb > 0);
  for (const stats of [sequential.launchLatency, sequential.workerLatency, sequential.endToEndLatency, parallel.laneCycleLatency]) {
    assert.ok(stats.p50Ms <= stats.p95Ms && stats.p95Ms <= stats.p99Ms && stats.p99Ms <= stats.maxMs && stats.meanMs > 0, JSON.stringify(stats));
  }
  assert.equal(sequential.endToEndLatency.count, 6);
  assert.ok(sequential.endToEndLatency.meanMs >= sequential.workerLatency.meanMs, 'end-to-end includes launch and worker time');
  assert.equal(parallel.lanes, 2);
  assert.equal(parallel.runs, 6);
  assert.equal(Object.values(parallel.outcomes).reduce((sum, value) => sum + value, 0), 6);
  assert.deepEqual([regressionSuite.identities, regressionSuite.suiteReplays], [2, 2]);
  assert.ok(regressionSuite.suiteWallMs > 0 && regressionSuite.replayLatency.count === 2);
  for (const name of ['runs_history_25', 'findings', 'scoped_coverage_target', 'regression_identities', 'operations_health', 'cases']) assert.ok(apiReads[name as keyof typeof apiReads].bytes > 2, `${name} returned a body`);

  // Injected latency is really applied: every worker pass now includes at least one target request and one Judge call.
  const slow = report.profiles.syntheticLatency;
  assert.ok(slow?.sequential && slow.parallel);
  assert.ok(slow.sequential.workerLatency.p50Ms >= 16, `worker p50 ${slow.sequential.workerLatency.p50Ms} ms includes the injected 8 ms target and 8 ms Judge latency`);
  assert.ok(slow.sequential.workerLatency.p50Ms > sequential.workerLatency.p50Ms, 'latency profile is slower than the overhead-only profile');
});
