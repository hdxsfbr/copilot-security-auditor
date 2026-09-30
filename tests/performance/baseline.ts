import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { machineInfo, revisionInfo } from '../acceptance/evidence.js';
import { cpuProbe, instrumentPg, round } from './measure.js';
import { measureSloWorkload } from './slo.js';
import { phaseDeployedCadence, phaseLanes, phaseReads, phaseRegression, phaseSequential, publishPool, safeJudges, storageReport, workloadStack, type Profile } from './workload.js';

// The reproducible 100-case FIXTURE baseline (HDX-32 / P01).
//
//   TEST_DATABASE_URL=... node --import tsx tests/performance/baseline.ts [--cases 100] [--identities 100] [--suite-size 25] [--lanes 1,2,4,8]
//       [--latency-cases 100] [--latency-lanes 1,8] [--repeats 5] [--cadence-runs 5] [--out evals/results/performance/<date>]
//
// Everything runs in one Node process on 127.0.0.1: the real Express API, the real worker entry (processNext), a disposable
// PostgreSQL database, a local HTTP stand-in for the Co-Pilot target and scripted Judge stand-ins. There is NO live target, NO paid
// provider and NO model inference. The figures describe the auditor's own orchestration, persistence and serialization; they are
// not a live 100-case result (that is L02 / HDX-37), not live performance and not a capacity claim.

export const BASELINE_LABEL = 'FIXTURE BASELINE (HDX-32 / P01): synthetic, in-process, local stand-ins only. This is NOT a live 100-case result and NOT live performance.';

type Options = { cases: number; identities: number; suiteSize: number; lanes: number[]; latencyCases: number; latencyLanes: number[]; repeats: number; cadenceRuns: number; targetLatencyMs: number; judgeLatencyMs: number; warmup: number; out: string | null };
export const defaults: Options = { cases: 100, identities: 100, suiteSize: 25, lanes: [1, 2, 4, 8], latencyCases: 100, latencyLanes: [1, 8], repeats: 5, cadenceRuns: 5, targetLatencyMs: 50, judgeLatencyMs: 100, warmup: 10, out: null };

const stats = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b), mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const sd = Math.sqrt(values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length);
  return { values, min: sorted[0], median: sorted[Math.floor(sorted.length / 2)], max: sorted.at(-1)!, mean: round(mean), coefficientOfVariation: mean ? round(sd / mean, 3) : 0 };
};

export async function runBaseline(partial: Partial<Options> = {}) {
  const options = { ...defaults, ...partial };
  assert.ok(options.cases >= 20 && options.identities >= 1 && options.suiteSize >= 1 && options.suiteSize <= 25 && options.lanes.every(lanes => lanes >= 1 && lanes <= options.cases));
  const startedAt = new Date(), machine = machineInfo(), speed = await cpuProbe();
  const pg = instrumentPg();
  const s = await workloadStack();
  let closed = false;
  const close = async () => { if (!closed) { closed = true; await s.close(); } };
  try {
    const judges = await safeJudges(s), unsafe = await s.judge('unsafe'), safe = await s.judge('safe');
    const version = (await s.rows('SELECT version() AS v'))[0].v as string;
    const setupStarted = performance.now();
    const pool = await publishPool(s, options.cases);
    const publishMs = performance.now() - setupStarted;

    await phaseSequential(s, pg, pool, options.warmup, judges); // warm-up: JIT, connection pool, plan caches. Not reported.
    const sequential = await phaseSequential(s, pg, pool, options.cases, judges);
    const laneCurve = [];
    for (const lanes of options.lanes) laneCurve.push(await phaseLanes(s, pg, pool, options.cases, lanes, judges));
    const regression = await phaseRegression(s, pg, options.identities, options.suiteSize, unsafe.url, safe.url);
    const leadTarget = (await s.rows('SELECT id FROM targets ORDER BY created_at LIMIT 1'))[0].id as string;
    const reads = await phaseReads(s, 30, leadTarget);
    const storage = await storageReport(s);

    // The same pipeline with a fixed, illustrative latency added to every target request and Judge call. Arbitrary numbers,
    // chosen only to show which resource binds once calls are not free; they are not measurements of any real system.
    const profile: Profile = { targetLatencyMs: options.targetLatencyMs, judgeLatencyMs: options.judgeLatencyMs };
    const latencySequential = options.latencyCases > 0 ? await phaseSequential(s, pg, pool, options.latencyCases, judges, profile) : null;
    const latencyLanes = [];
    if (options.latencyCases > 0) for (const lanes of options.latencyLanes) latencyLanes.push(await phaseLanes(s, pg, pool, options.latencyCases, lanes, judges, profile));
    const cadence = options.cadenceRuns > 0 ? await phaseDeployedCadence(s, pool, options.cadenceRuns, judges) : null;

    await close(); pg.restore(); // the repeat runs below each own a fresh stack and their own instrumentation
    const repeatability = options.repeats > 0 ? await (async () => {
      const runs = [];
      for (let index = 0; index < options.repeats; index++) runs.push(await measureSloWorkload({ cases: options.cases, suiteReplays: options.suiteSize, warmup: options.warmup }));
      return {
        description: `The CI SLO workload (${options.cases} sequential cases, then one ${options.suiteSize}-replay regression suite) run ${options.repeats} times, each on a fresh database.`,
        sequentialWallMs: stats(runs.map(run => run.timed.sequentialWallMs)), workerPassP95Ms: stats(runs.map(run => run.timed.workerPassP95Ms)), suiteWallMs: stats(runs.map(run => run.timed.suiteWallMs)), peakRssMb: stats(runs.map(run => run.timed.peakRssMb)),
        workerStatementsPerCase: stats(runs.map(run => run.deterministic.workerStatementsPerCase)), launchStatementsPerCase: stats(runs.map(run => run.deterministic.launchStatementsPerCase)), eventRowsPerCase: stats(runs.map(run => run.deterministic.eventRowsPerCase)),
        eventBytesPerCase: stats(runs.map(run => run.deterministic.eventBytesPerCase)), replayStatementsPerReplay: stats(runs.map(run => run.deterministic.replayStatementsPerReplay)), throughputRunsPerSecond: stats(runs.map(run => run.informational.throughputRunsPerSecond))
      };
    })() : null;

    const single = latencyLanes.find(item => item.lanes === 1), widest = latencyLanes.at(-1);
    return {
      schema: 'performance-fixture-baseline/v1', label: BASELINE_LABEL, workItem: 'HDX-32 / P01 reproducible 100-case fixture baseline',
      claims: { liveTarget: false, paidProviders: false, modelInference: false, network: '127.0.0.1 only', liveAcceptance: false, liveHundredCaseResult: false, liveLatencyOrThroughput: false, capacityClaim: false },
      recordedAt: startedAt.toISOString(), revision: revisionInfo(), machine: { ...machine, cpuProbe: speed },
      database: { server: version.split(' on ')[0], service: 'disposable PostgreSQL service on 127.0.0.1 (container outside this process), one fresh database per stack, default settings', note: 'Database server CPU and memory are outside this process and are not reported; PostgreSQL time below is client-observed.' },
      method: {
        summary: 'One Node process hosts the API (Express), the worker entry (processNext), the fixture target, the scripted Judge stand-ins and the PostgreSQL client. Runs are launched through POST /api/runs (with model preflight) and executed by the real worker pipeline: session handshake, chart context, chat turns, deterministic checks, Judge call, policy gate and persistence.',
        caseMix: `${options.cases} distinct published cases. Per 20: 10 single-turn prompt injections, 3 three-turn injections, 4 chart-context cross_patient cases, 3 unintended_tool_action cases (1.3 target turns per case on average; tool cases also fetch the patient report twice). Expected outcomes are asserted for every run: safe for injection and cross_patient, inconclusive for tool cases.`,
        regression: `${options.identities} confirmed findings, each its own regression identity, replayed in suites of ${options.suiteSize} (the contract maximum) at a new target version.`,
        warmup: `${options.warmup} cases before the measured pass (not reported).`, publishCasesMs: Math.round(publishMs),
        cpuAndMemory: 'Process CPU time, sampled RSS/heap and event-loop delay of the whole in-process stack during each phase.',
        injectedLatency: { targetPerRequestMs: options.targetLatencyMs, judgePerCallMs: options.judgeLatencyMs, note: 'Arbitrary illustrative values used only in the synthetic-latency profile. Not measurements of any real target or model.' },
        instrumentation: 'Every statement through pg.Client#query is counted and timed; target and Judge fetches are timed to response headers. The wrappers add microseconds per call.'
      },
      profiles: {
        overheadOnly: { description: 'No injected latency: the auditor\'s own orchestration, serialization and persistence cost.', sequential, laneCurve, regression, apiReads: reads, storage },
        syntheticLatency: latencySequential ? {
          description: `Target requests +${options.targetLatencyMs} ms and Judge calls +${options.judgeLatencyMs} ms (illustrative).`, sequential: latencySequential, laneCurve: latencyLanes,
          speedup: single && widest ? { lanes: widest.lanes, throughputRatio: round(widest.throughputRunsPerSecond / single.throughputRunsPerSecond), note: 'Throughput at the widest lane count divided by one lane, same injected latency.' } : null
        } : null,
        deployedWorkerCadence: cadence
      },
      repeatability,
      derived: {
        auditorCpuPerCaseMs: round(sequential.resources.cpuMs / options.cases, 2),
        auditorDbStatementsPerCase: round(sequential.perCase.workerStatements.mean + sequential.perCase.launchStatements.mean),
        storageBytesPerCase: sequential.perCase.storageBytes,
        oneProcessLiveLaneEquivalent: {
          note: 'How many concurrent LIVE cases one auditor process could orchestrate if it were the only limit: a live case occupies a lane for its whole wall time (the planning doc assumes ~70 s with a paid Judge, an estimate not a measurement) while costing the auditor only its measured CPU per case. Illustrative arithmetic on fixture CPU, not a capacity claim.',
          assumedLiveCaseSeconds: 70, fixtureCpuSecondsPerCase: round(sequential.resources.cpuMs / options.cases / 1000, 4), lanesAtFullCpu: Math.floor(70 / (sequential.resources.cpuMs / options.cases / 1000))
        },
        deployedCadenceCeiling: cadence ? { runsPerSecondPerWorker: cadence.throughputRunsPerSecond, pauseShareOfCycle: round(cadence.pauseMs / (cadence.secondsPerRun * 1000), 3) } : null
      },
      knownLimits: [
        'Fixture only: a local HTTP stand-in replaces the Co-Pilot target and scripted stand-ins replace the Judge model. No live target, paid provider or model inference was called. This is not the authorized live 100-case acceptance (L02 / HDX-37).',
        'Latencies exclude real target turn time (the documented envelope is up to 90 s per turn) and real model latency, so throughput here is an upper bound on orchestration speed and says nothing about live throughput.',
        'API, worker, fixture target, Judge stand-in and database client share one Node process and one event loop; the deployment separates API and worker processes. CPU and memory include all of them; PostgreSQL server resources are not included.',
        'The lane curve serves several targets because a target admits one in-flight run (the reservation model); it does not measure contention on a single target, and lanes share one event loop so the curve understates a multi-process deployment.',
        'Fixture responses are short; event and storage sizes per case are a floor, not a forecast for real Co-Pilot responses (event payloads are bounded at 256,000 bytes per turn body).',
        'Adaptive exploration, PDF attachments, report drafting, schedules and paid-spend accounting are not part of this workload (they are covered functionally by the acceptance suite). Paid-model reservation and catalog downloads are therefore not measured.',
        'One recording on one shared workstation; the repeatability block shows run-to-run variation for the headline figures, nothing more rigorous than that.'
      ],
      repeat: 'TEST_DATABASE_URL=postgresql://auditor:fixture-only@127.0.0.1:55432/auditor_test npm run perf:baseline -- --out evals/results/performance/<date>'
    };
  } finally { pg.restore(); await close(); }
}

function parseArgs(argv: string[]): Partial<Options> {
  const numeric: Record<string, keyof Options> = { '--cases': 'cases', '--identities': 'identities', '--suite-size': 'suiteSize', '--latency-cases': 'latencyCases', '--repeats': 'repeats', '--cadence-runs': 'cadenceRuns', '--target-latency-ms': 'targetLatencyMs', '--judge-latency-ms': 'judgeLatencyMs', '--warmup': 'warmup' };
  const lists: Record<string, keyof Options> = { '--lanes': 'lanes', '--latency-lanes': 'latencyLanes' };
  const result: Partial<Options> = {};
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index], value = argv[index + 1];
    if (flag === '--out') result.out = value;
    else if (numeric[flag]) { const parsed = Number(value); assert.ok(Number.isInteger(parsed) && parsed >= 0, `${flag} needs a non-negative integer`); (result as Record<string, number>)[numeric[flag]] = parsed; }
    else if (lists[flag]) { const parsed = value.split(',').map(Number); assert.ok(parsed.every(item => Number.isInteger(item) && item >= 1), `${flag} needs comma-separated positive integers`); (result as Record<string, number[]>)[lists[flag]] = parsed; }
    else throw new Error(`Unknown argument ${flag}`);
  }
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = parseArgs(process.argv.slice(2));
  const report = await runBaseline(args);
  const out = resolve(args.out ?? join('evals/results/performance', new Date().toISOString().slice(0, 10)));
  await mkdir(out, { recursive: true });
  await writeFile(join(out, 'fixture-baseline-100.json'), `${JSON.stringify(report, null, 2)}\n`);
  const seq = report.profiles.overheadOnly.sequential, reg = report.profiles.overheadOnly.regression;
  console.log(BASELINE_LABEL);
  console.log(`revision ${report.revision.head} (application source dirty: ${report.revision.applicationSourceDirty})`);
  console.log(`sequential ${seq.runs} cases: ${seq.throughputRunsPerSecond}/s, worker p50 ${seq.latency.worker.p50Ms} ms, p95 ${seq.latency.worker.p95Ms} ms, cpu ${seq.resources.cpuMs} ms, peak RSS ${seq.resources.peakRssMb} MB`);
  console.log(`regression ${reg.replays} replays in suites of ${reg.suiteSize}: ${reg.replayWallMs} ms (${reg.replayThroughputPerSecond}/s)`);
  console.log(`wrote ${join(out, 'fixture-baseline-100.json')}`);
}
