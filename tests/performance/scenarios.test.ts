import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { ASSUMPTIONS, attemptsFor, inject, loadMeasured, measuredFrom, renderCost, renderWorkload, SIZES } from './scenarios.js';
import { SLO_LIMITS, SLO_REFERENCE } from './slo-definition.js';

// docs/submission/cost-and-scale.md (HDX-32 / P01): the generated scenario tables must match the model, the measured figures quoted in
// the prose must equal the recorded evidence, the SLO table must equal the enforced limits, and the development-spend section records the operator-provided figures. Reads committed files; measures nothing.

const read = (path: string) => readFile(new URL(`../../${path}`, import.meta.url), 'utf8');
const dir = 'evals/results/performance/2026-09-30/';
const fmt = (value: number, digits = 1) => value.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });
const section = (doc: string, heading: string) => doc.match(new RegExp(`^## ${heading}[\\s\\S]*?(?=^## |$(?![\\r\\n]))`, 'm'))?.[0] ?? '';

test('[P01] the generated scenario tables in cost-and-scale.md match the model and the recorded baseline', async () => {
  const doc = await read('docs/submission/cost-and-scale.md');
  assert.equal(inject(doc, await loadMeasured()), doc, 'run `npm run perf:scenarios -- --write`');
});

test('[P01] the scenario model accounts for retries, roles and scheduling, not only tokens', async () => {
  const m = measuredFrom(JSON.parse(await read(`${dir}fixture-baseline-100.json`)));
  assert.ok(Math.abs(attemptsFor(100) - 111.11) < 0.01 && ASSUMPTIONS.unusableAttemptShare === 0.10);
  const cost = renderCost(m), workload = renderWorkload(m);
  for (const role of ['Target-side inference', 'All-local auditor', 'Paid Judge only', 'All three roles paid']) assert.ok(cost.includes(role), role);
  for (const row of ['Attempts incl. reruns', 'Lanes needed to finish in 24 h', 'Target instances needed', 'Worker pause alone', 'Auditor SQL statements', 'Auditor storage', 'Operator review time']) assert.ok(workload.includes(row), row);
  assert.deepEqual([...SIZES], [100, 1000, 10000, 100000]);
  // Retries raise every linear row by exactly 1/(1-p): the 1K column is ten times the 100 column.
  const target = (cells: string[]) => Number(cells[1].replace(/[$,]/g, ''));
  const row = cost.split('\n').find(line => line.startsWith('| Target-side inference'))!.split('|').map(cell => cell.trim()).slice(2, 6);
  assert.ok(Math.abs(target(row.slice(1)) / target(row) - 10) < 0.2, 'target-side cost scales linearly with finished cases');
});

test('[P01] measured figures quoted in the document equal the recorded evidence', async () => {
  const doc = await read('docs/submission/cost-and-scale.md');
  const base = JSON.parse(await read(`${dir}fixture-baseline-100.json`)), seq = base.profiles.overheadOnly.sequential, reg = base.profiles.overheadOnly.regression, lat = base.profiles.syntheticLatency, rep = base.repeatability;
  const figures = [
    `${fmt(seq.throughputRunsPerSecond)} cases/s`, `${fmt(seq.latency.worker.p50Ms)} ms, p95 ${fmt(seq.latency.worker.p95Ms)} ms`, `${fmt(seq.resources.cpuMs / seq.runs)} ms per case`,
    `${fmt(seq.perCase.workerStatements.mean)} worker statements plus ${seq.perCase.launchStatements.mean} at launch`, `${fmt(seq.perCase.eventRows, 2)} events, ${seq.perCase.eventBytes.toLocaleString('en-US')} bytes`,
    `${seq.resources.peakRssMb} MB peak RSS`, `${fmt(seq.perCase.storageBytes / 1024)} KiB`, `${reg.replayWallMs.toLocaleString('en-US')} ms, ${fmt(reg.replayThroughputPerSecond)} replays/s`,
    base.profiles.overheadOnly.laneCurve.map((lane: { throughputRunsPerSecond: number }) => fmt(lane.throughputRunsPerSecond)).join(' / ') + ' cases/s',
    `${fmt(lat.sequential.throughputRunsPerSecond, 2)} cases/s sequential, ${fmt(lat.laneCurve.at(-1).throughputRunsPerSecond, 2)} at 8 lanes (${fmt(lat.speedup.throughputRatio, 2)}x)`,
    `${base.profiles.deployedWorkerCadence.wallMs.toLocaleString('en-US')} ms: ${fmt(base.profiles.deployedWorkerCadence.secondsPerRun, 2)} s per run, ${fmt(base.profiles.deployedWorkerCadence.throughputRunsPerSecond, 2)} runs/s`,
    `${rep.sequentialWallMs.median.toLocaleString('en-US')} ms median`, `p95 ${rep.workerPassP95Ms.median} ms`, `suite ${rep.suiteWallMs.median} ms`, `RSS ${rep.peakRssMb.median} MB`
  ];
  for (const figure of figures) assert.ok(doc.includes(figure), `the document should quote "${figure}"`);
  const suites: { wallMs: number }[] = reg.suites;
  assert.ok(doc.includes(`${Math.min(...suites.map(suite => suite.wallMs))}-${Math.max(...suites.map(suite => suite.wallMs))} ms`), 'suite wall range');
  assert.ok(doc.includes(base.revision.head.slice(0, 7)), 'the document names the revision it was measured at');
});

test('[P01] the SLO table in the document equals the enforced reference and limits', async () => {
  const doc = section(await read('docs/submission/cost-and-scale.md'), '9\\. Regression SLO');
  const n = (value: number) => value.toLocaleString('en-US');
  for (const [name, value] of [['Worker SQL statements per case', SLO_LIMITS.deterministic.workerStatementsPerCase], ['Launch SQL statements per case', SLO_LIMITS.deterministic.launchStatementsPerCase], ['Event rows per case', SLO_LIMITS.deterministic.eventRowsPerCase], ['Event bytes per case', SLO_LIMITS.deterministic.eventBytesPerCase], ['Statements per replay', SLO_LIMITS.deterministic.replayStatementsPerReplay], ['Target requests per case', SLO_LIMITS.deterministic.targetRequestsPerCase]] as const) {
    const line = doc.split('\n').find(row => row.startsWith(`| ${name}`));
    assert.ok(line?.includes(`| ${n(value)} |`), `${name} limit ${value}: ${line}`);
  }
  for (const [name, reference, limit, unit] of [['100 sequential cases, wall', SLO_REFERENCE.timed.sequentialWallMs, SLO_LIMITS.timed.sequentialWallMs, 'ms'], ['Worker pass p95', SLO_REFERENCE.timed.workerPassP95Ms, SLO_LIMITS.timed.workerPassP95Ms, 'ms'], ['25-replay suite, wall', SLO_REFERENCE.timed.suiteWallMs, SLO_LIMITS.timed.suiteWallMs, 'ms'], ['Peak RSS', SLO_REFERENCE.timed.peakRssMb, SLO_LIMITS.timed.peakRssMb, 'MB']] as const) {
    const line = doc.split('\n').find(row => row.startsWith(`| ${name}`));
    assert.ok(line?.includes(`| ${n(reference)} ${unit} |`) && line.includes(`| ${n(limit)} ${unit} |`), `${name}: ${line}`);
  }
  assert.match(doc, /not a live claim/);
});

test('[P01] the document separates measured fixture results from live, and records the operator-provided development spend', async () => {
  const doc = await read('docs/submission/cost-and-scale.md');
  assert.match(doc, /No live run produced any figure here/);
  assert.match(doc, /\*\*\[L\]\*\* live \| Measured against the live target or live models\. \*\*None exist yet\.\*\*/);
  assert.match(doc, /FIXTURE BASELINE: synthetic, in-process, local stand-ins only\. This is NOT a live 100-case result and NOT live performance\./);
  const spend = section(doc, '10\\. Actual development spend');
  assert.match(spend, /measured, operator-provided/i);
  assert.match(spend, /development window Sep 24 - Oct 1, 2026/);
  assert.match(spend, /about 2,159/);
  const rows = spend.split('\n').filter(line => /^\| (Coding agent|OpenRouter|Of which|Target-side|Infrastructure|Auditor host|\*\*Total)/.test(line));
  assert.equal(rows.length, 8);
});
