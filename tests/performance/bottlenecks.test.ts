import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BOTTLENECKS_LABEL, deriveBottlenecks, loadEvidence } from './bottlenecks.js';

// The bottleneck list is derived, not typed: every figure in it must come from the recorded evidence, and every bottleneck must
// carry a measurement and an architectural response. Reads the committed JSON; measures nothing.

const dir = new URL('../../evals/results/performance/2026-09-30/', import.meta.url).pathname;

test('[P01] each bottleneck names its evidence and an architectural response, and nothing claims to be live', async () => {
  const files = await loadEvidence(dir);
  const derived = deriveBottlenecks(files);
  assert.match(derived.label, /Not a live result/);
  assert.match(files.baseline.label, /NOT a live 100-case result/);
  assert.deepEqual(derived.bottlenecks.map(item => item.id), ['B1', 'B2', 'B3', 'B4', 'B5', 'B6', 'B7', 'B8', 'B9']);
  for (const item of derived.bottlenecks) {
    assert.ok(item.response.length > 40 && item.bindsAt.length > 5, `${item.id} has a response and a scale`);
    assert.ok(item.evidence.length > 0 && item.evidence.some(entry => entry.basis !== 'estimate'), `${item.id} rests on at least one measurement`);
    for (const entry of item.evidence) {
      assert.doesNotMatch(entry.text, /NaN|undefined|Infinity/, `${item.id}: ${entry.text}`);
      assert.match(entry.source, /^(fixture-baseline-100|query-plan-evidence|memory-stability|slo-contention-emulation)\.json|^docs\/submission\/cost-and-scale\.md/);
    }
  }
});

test('[P01] the headline bottleneck figures equal the recorded measurements', async () => {
  const files = await loadEvidence(dir);
  const text = JSON.stringify(deriveBottlenecks(files).bottlenecks);
  const seq = files.baseline.profiles.overheadOnly.sequential, cadence = files.baseline.profiles.deployedWorkerCadence;
  const commit = seq.topStatements[0];
  assert.equal(commit.sql, 'COMMIT');
  assert.ok(text.includes(`${commit.callsPerCase.toFixed(2)} COMMITs per case`));
  assert.ok(text.includes(`${(commit.shareOfDbTime * 100).toFixed(1)}% of all database time`));
  assert.ok(text.includes(`in ${cadence.wallMs} ms = ${cadence.secondsPerRun.toFixed(2)} s per run`));
  const scale = files.plans.regressionsAtFullScale;
  assert.ok(scale, 'the full-scale /api/regressions observation was recorded');
  if (!scale.serialization.ok) assert.ok(text.includes('returns HTTP 500') && text.includes(scale.serialization.error));
});
