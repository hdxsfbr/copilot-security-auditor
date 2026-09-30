import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

// Turns the recorded fixture evidence into the bottleneck list the P01 acceptance asks for: each bottleneck with the measurements
// that show it and the architectural response they support. Pure derivation from the four recorded JSON files, so every number in
// the output is the number in the evidence and the list can be regenerated (`npm run perf:bottlenecks`) whenever the evidence is.
//
// FIXTURE evidence only. "estimate" marks the few inputs that are not measured here (the planning document's ~70 s live case and the
// target's daily token cap); nothing below is a live result.

export const BOTTLENECKS_LABEL = 'FIXTURE BOTTLENECK ANALYSIS (HDX-32 / P01): derived from fixture measurements. Not a live result; items marked "estimate" rest on the planning document, not on a measurement.';

type Evidence = { basis: 'measured fixture' | 'measured synthetic database' | 'estimate'; text: string; source: string };
export type Bottleneck = { id: string; title: string; evidence: Evidence[]; response: string; bindsAt: string };
export type EvidenceFiles = { baseline: any; plans: any; memory: any; contention: any };

const f = (value: number, digits = 1) => value.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });
const pct = (value: number) => `${f(value * 100)}%`;
const LIVE_CASE_SECONDS = 70; // the planning document's assumption for a live case with a paid Judge (estimate)

export function deriveBottlenecks({ baseline, plans, memory, contention }: EvidenceFiles): { label: string; derivedFrom: Record<string, string>; bottlenecks: Bottleneck[] } {
  const over = baseline.profiles.overheadOnly, seq = over.sequential, lat = baseline.profiles.syntheticLatency, cadence = baseline.profiles.deployedWorkerCadence;
  const commit = seq.topStatements.find((row: { sql: string }) => row.sql === 'COMMIT');
  assert.ok(commit && seq.workerPassBreakdown && cadence && lat && plans.regressionsRouteSweep && memory.growth, 'the evidence files are complete');
  const pass = seq.workerPassBreakdown, cpuPerCaseMs = seq.resources.cpuMs / seq.runs, lanes = over.laneCurve, latLanes = lat.laneCurve, widest = lanes.at(-1), latWidest = latLanes.at(-1);
  const sweep = plans.regressionsRouteSweep.points, first = sweep[0], last = sweep.at(-1), scale = plans.regressionsAtFullScale;
  const q = (name: string) => plans.queries.find((item: { name: string }) => item.name === name);
  const reads = over.apiReads, tables = over.storage.tables;
  const liveLane = LIVE_CASE_SECONDS + cadence.pauseMs / 1000;

  const bottlenecks: Bottleneck[] = [
    {
      id: 'B1', title: 'The target, not the auditor, sets live throughput',
      evidence: [
        { basis: 'measured fixture', text: `The auditor spends ${f(cpuPerCaseMs)} ms CPU and ${f(seq.perCase.workerStatements.mean + seq.perCase.launchStatements.mean, 0)} SQL statements per case; a worker pass is ${f(pass.postgres.meanMs + pass.targetHttp.meanMs + pass.judgeHttp.meanMs + pass.orchestration.meanMs)} ms.`, source: 'fixture-baseline-100.json#profiles.overheadOnly.sequential' },
        { basis: 'measured fixture', text: `With injected latency (+${baseline.method.injectedLatency.targetPerRequestMs} ms per target request, +${baseline.method.injectedLatency.judgePerCallMs} ms per Judge call, illustrative) ${pct(lat.sequential.workerPassBreakdown.meanShare.targetHttp)} of a worker pass is waiting on the target and ${pct(lat.sequential.workerPassBreakdown.meanShare.judgeHttp)} on the Judge; ${latWidest.lanes} lanes reach ${f(lat.speedup.throughputRatio, 2)}x the sequential rate at ${f(latWidest.resources.cpuUtilization, 2)} of one core.`, source: 'fixture-baseline-100.json#profiles.syntheticLatency' },
        { basis: 'estimate', text: `At an assumed ${LIVE_CASE_SECONDS} s live case plus the ${cadence.pauseMs / 1000} s pause, one lane uses ${f(cpuPerCaseMs / 1000 / liveLane * 100, 3)}% of a core and 100 lanes ${f(cpuPerCaseMs / 1000 / liveLane * 100 * 100, 1)}%. The target's 2M-token daily halt allows about 110 cases a day per instance.`, source: 'docs/submission/cost-and-scale.md (planning assumptions)' }
      ],
      response: 'Scale live throughput with lanes, not by optimizing auditor CPU: one target row and synthetic user pair per lane, more worker processes when one approaches a core, per-target concurrency limits, an incomplete-rate circuit breaker, and negotiated target token headroom or a multi-day schedule.',
      bindsAt: 'every live scale from 100 cases up'
    },
    {
      id: 'B2', title: 'Fixed 1.5 s worker pause after every cycle',
      evidence: [
        { basis: 'measured fixture', text: `${cadence.runs} queued runs drained by the deployed loop cadence in ${cadence.wallMs} ms = ${f(cadence.secondsPerRun, 2)} s per run (${f(cadence.throughputRunsPerSecond, 2)} runs/s); the pause is ${pct(cadence.pauseMs / (cadence.secondsPerRun * 1000))} of each cycle at fixture speed.`, source: 'fixture-baseline-100.json#profiles.deployedWorkerCadence' },
        { basis: 'estimate', text: `At an assumed ${LIVE_CASE_SECONDS} s live case the pause is ${pct(cadence.pauseMs / 1000 / liveLane)} of the cycle.`, source: 'docs/submission/cost-and-scale.md (planning assumptions)' }
      ],
      response: 'Sleep only when processNext returned nothing; loop at once after a cycle that ran a case (apps/worker/src/main.ts:24). One line; not worth doing for live cases, worth doing before running bursts of fast runs.',
      bindsAt: 'negligible for live cases; dominant for bursts of fast runs'
    },
    {
      id: 'B3', title: 'Commit-bound persistence: one durable transaction per event',
      evidence: [
        { basis: 'measured fixture', text: `${f(commit.callsPerCase, 2)} COMMITs per case (launch and worker together) cost ${f(commit.msPerCase, 2)} ms: ${pct(commit.shareOfDbTime)} of all database time and ${pct(commit.msPerCase / seq.latency.endToEnd.meanMs)} of the ${f(seq.latency.endToEnd.meanMs)} ms launch-plus-worker time. Within the worker pass alone, PostgreSQL wait is ${pct(pass.meanShare.postgres)} (${f(pass.postgres.meanMs)} ms) against ${f(pass.orchestration.meanMs)} ms of orchestration CPU.`, source: 'fixture-baseline-100.json#profiles.overheadOnly.sequential.topStatements[0]' },
        { basis: 'measured fixture', text: `${f(seq.perCase.eventRows, 2)} events per case, each appended in its own transaction (BEGIN, lease SELECT, UPDATE runs SET version, INSERT, COMMIT).`, source: 'fixture-baseline-100.json#profiles.overheadOnly.sequential.topStatements' }
      ],
      response: 'Group the events one pipeline stage produces into a single transaction and skip the version UPDATE when unchanged; keep durable commits for verdicts and terminal events. Removing about 5 of the 12.65 commits and their paired statements saves on the order of 5 ms per fixture case (estimate from the per-statement costs). Also why the CI timed limits are wide: commit latency on the runner disk is unmeasured.',
      bindsAt: 'only when per-case wall time is well under a second; immaterial at live case times, so not recommended now'
    },
    {
      id: 'B4', title: 'One process saturates one core at about a hundred fixture cases per second',
      evidence: [
        { basis: 'measured fixture', text: `Throughput ${f(lanes[0].throughputRunsPerSecond)} to ${f(widest.throughputRunsPerSecond)} cases/s from 1 to ${widest.lanes} lanes (${f(widest.throughputRunsPerSecond / lanes[0].throughputRunsPerSecond, 2)}x) while CPU rises from ${f(lanes[0].resources.cpuUtilization, 2)} to ${f(widest.resources.cpuUtilization, 2)} cores; lane-cycle p95 ${f(lanes[0].laneCycleLatency.p95Ms)} to ${f(widest.laneCycleLatency.p95Ms)} ms.`, source: 'fixture-baseline-100.json#profiles.overheadOnly.laneCurve' },
        { basis: 'measured fixture', text: `Event-loop delay p99 stays at timer resolution (${f(seq.resources.eventLoopDelay.p99Ms, 2)} ms at one lane, ${f(widest.resources.eventLoopDelay.p99Ms, 2)} ms at ${widest.lanes}).`, source: 'fixture-baseline-100.json#profiles.overheadOnly.laneCurve[].resources.eventLoopDelay' }
      ],
      response: 'Add worker processes (the worker is already a separate deployable) once one process approaches a core; claiming is SKIP LOCKED-safe. This curve is conservative because API, worker, target and Judge share one event loop here.',
      bindsAt: 'only with calls fast enough to keep a process busy; not reachable with live targets on one process'
    },
    {
      id: 'B5', title: 'Unbounded, quadratic list reads',
      evidence: [
        { basis: 'measured synthetic database', text: `GET /api/regressions: payload ${f(first.payloadMb)} MB at ${first.runs.toLocaleString('en-US')} runs to ${f(last.payloadMb)} MB at ${last.runs.toLocaleString('en-US')} (about x4 per doubling), ${f(first.medianMsWithoutIndex)} ms to ${f(last.medianMsWithoutIndex, 0)} ms. A candidate index (runs_case_target) speeds it only ${f(Math.min(...sweep.map((p: { speedup: number }) => p.speedup)), 2)}x to ${f(Math.max(...sweep.map((p: { speedup: number }) => p.speedup)), 2)}x because the payload is the cost.`, source: 'query-plan-evidence.json#regressionsRouteSweep' },
        ...(scale ? [{ basis: 'measured synthetic database' as const, text: `At ${scale.runs.toLocaleString('en-US')} runs (${scale.regressions.toLocaleString('en-US')} regressions) the SQL takes ${f(scale.sqlMs / 1000, 1)} s and serialization ${scale.serialization.ok ? `produces ${f(scale.serialization.bytes / 1048576, 0)} MB` : `fails with ${scale.serialization.error}`}; the route therefore ${scale.serialization.ok ? 'answers' : 'returns HTTP 500'}.`, source: 'query-plan-evidence.json#regressionsAtFullScale' }] : []),
        { basis: 'measured fixture', text: `After ${tables.runs.rows} runs, GET /api/coverage/scoped without a target returns ${f(reads.scoped_coverage_all_targets.bytes / 1048576)} MB (every scope lists the whole case catalog) in ${f(reads.scoped_coverage_all_targets.p50Ms)} ms p50; GET /api/cases returns ${f(reads.cases.bytes / 1024, 0)} KB for ${tables.cases.rows} cases.`, source: 'fixture-baseline-100.json#profiles.overheadOnly.apiReads' },
        { basis: 'measured synthetic database', text: `GET /api/findings returns ${f(plans.routeTimings.withMigration.findings.bytes / 1048576)} MB for ${plans.synthetic.counts.candidates.toLocaleString('en-US')} candidates.`, source: 'query-plan-evidence.json#routeTimings' }
      ],
      response: 'Cursor pagination and caps (the pattern already exists for run history, identities and suites); return the latest N replays per regression with a count; page coverage scopes or serve coverage from counts maintained when a run finishes. An index does not fix these.',
      bindsAt: 'from about 10K runs; /api/regressions is unusable before 100K'
    },
    {
      id: 'B6', title: 'Coverage reads all history and nothing is indexable',
      evidence: [
        { basis: 'measured synthetic database', text: `Scoped coverage over all targets takes ${f(q('coverage_scoped_all_targets').withMigration.medianExecutionMs, 0)} ms at ${plans.synthetic.counts.runs.toLocaleString('en-US')} runs, ${f(q('coverage_scoped_all_targets').withoutMigration.medianExecutionMs, 0)} ms without migration 024: no predicate to index. Category and subcategory are extracted from JSONB per row and events are probed per run.`, source: 'query-plan-evidence.json#queries' },
        { basis: 'measured synthetic database', text: `An expression index on the JSONB category was tried and the planner did not choose it (${plans.rejectedCandidates.find((c: { name: string }) => c.name === 'runs_selected_category_expr').medianExecutionMsWithCandidate} ms against ${plans.rejectedCandidates.find((c: { name: string }) => c.name === 'runs_selected_category_expr').medianExecutionMsWithout} ms).`, source: 'query-plan-evidence.json#rejectedCandidates' }
      ],
      response: 'A rollup table keyed by target, version and case, updated at run finish, and category and subcategory promoted to real columns so they can be indexed. Migration 024 deliberately does not pretend an index fixes this.',
      bindsAt: 'from about 10K runs'
    },
    {
      id: 'B7', title: 'Storage growth',
      evidence: [
        { basis: 'measured fixture', text: `${f(seq.perCase.storageBytes / 1024)} KB of database growth per case at the floor (fixture responses are short): events ${tables.events.rows.toLocaleString('en-US')} rows and ${f(tables.events.totalBytes / 1048576)} MB, runs ${f(tables.runs.totalBytes / 1048576)} MB, assessments ${f(tables.assessments.totalBytes / 1048576)} MB for ${tables.runs.rows} runs.`, source: 'fixture-baseline-100.json#profiles.overheadOnly.storage' },
        { basis: 'estimate', text: `${f(111111 * seq.perCase.storageBytes / 1e9)} GB for 100K finished cases at the floor (111,111 attempts), ${f(111111 * 25000 / 1e9)} GB at the 25 KB planning value.`, source: 'docs/submission/cost-and-scale.md (scenario model)' }
      ],
      response: 'Partition events by month and archive finished-run events past retention to object storage, keeping hashes in PostgreSQL; read replica for the UI.',
      bindsAt: 'from about 10K runs; real responses are larger than the fixture floor'
    },
    {
      id: 'B8', title: 'Memory of a long-lived process',
      evidence: [
        { basis: 'measured fixture', text: `${memory.totalCases.toLocaleString('en-US')} cases in one process with the old-space heap capped: JS heap used ${memory.series[1].heapUsedMb} to ${memory.series.at(-1).heapUsedMb} MB (${f(memory.growth.heapUsedKbPerCase)} KB per case) while RSS went ${memory.series[1].rssMb} to ${memory.series.at(-1).rssMb} MB. Uncapped recordings peak higher from lazy garbage collection.`, source: 'memory-stability.json' }
      ],
      response: 'No leak in the JS heap at this scale; the slow RSS creep is unattributed, so watch worker RSS through the worker-health metrics and restart on a threshold instead of assuming it is flat.',
      bindsAt: 'only for long-lived workers'
    },
    {
      id: 'B9', title: 'CI runner headroom for the regression SLO',
      evidence: [
        { basis: 'measured fixture', text: `With Node starved to about a third of a core, the timed metrics were ${f(Math.min(...Object.values<any>(contention.comparison).filter((c: any) => c.limit > 100).map((c: any) => c.ratioToReference)), 2)}x to ${f(Math.max(...Object.values<any>(contention.comparison).filter((c: any) => c.limit > 100).map((c: any) => c.ratioToReference)), 2)}x the uncontended reference and still had ${f(Math.min(...Object.values<any>(contention.comparison).filter((c: any) => c.limit > 100).map((c: any) => c.limitOverContended)), 1)}x to ${f(Math.max(...Object.values<any>(contention.comparison).filter((c: any) => c.limit > 100).map((c: any) => c.limitOverContended)), 1)}x headroom under the SLO limits; the deterministic metrics did not move.`, source: 'slo-contention-emulation.json' }
      ],
      response: 'Keep the work-count limits as the precise tier and the wall-clock limits as a coarse tripwire; re-record the reference if the runner class changes.',
      bindsAt: 'CI only'
    }
  ];
  return { label: BOTTLENECKS_LABEL, derivedFrom: { baselineHead: baseline.revision.head, plansHead: plans.revision.head, memoryHead: memory.revision.head, contentionHead: contention.headAtRecording }, bottlenecks };
}

export async function loadEvidence(dir: string): Promise<EvidenceFiles> {
  const read = async (name: string) => JSON.parse(await readFile(join(dir, name), 'utf8'));
  return { baseline: await read('fixture-baseline-100.json'), plans: await read('query-plan-evidence.json'), memory: await read('memory-stability.json'), contention: await read('slo-contention-emulation.json') };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const dir = resolve(process.argv[2] ?? 'evals/results/performance/2026-09-30');
  const derived = deriveBottlenecks(await loadEvidence(dir));
  await writeFile(join(dir, 'bottlenecks.json'), `${JSON.stringify({ schema: 'performance-bottlenecks/v1', recordedAt: new Date().toISOString(), ...derived }, null, 2)}\n`);
  console.log(BOTTLENECKS_LABEL);
  for (const item of derived.bottlenecks) console.log(`${item.id} ${item.title} (${item.evidence.length} evidence items)`);
  console.log(`wrote ${join(dir, 'bottlenecks.json')}`);
}
