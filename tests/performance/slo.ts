import { instrumentPg, round } from './measure.js';
import { phaseRegression, phaseSequential, publishPool, safeJudges, workloadStack } from './workload.js';

// The regression SLO for the fixture pipeline (HDX-32 / P01): what is measured, how it is judged, and why the limits are what
// they are. Everything measured here is a FIXTURE measurement (local stand-in target, scripted Judge, disposable PostgreSQL). It
// says nothing about live target latency, model latency or capacity. Its job is to catch the auditor's own orchestration and
// persistence regressing (an accidental extra query per case, an unbounded table scan, a memory leak), not to predict production.

export type SloMeasurement = {
  cases: number; suiteReplays: number;
  deterministic: { workerStatementsPerCase: number; launchStatementsPerCase: number; eventRowsPerCase: number; eventBytesPerCase: number; replayStatementsPerReplay: number; targetRequestsPerCase: number };
  timed: { sequentialWallMs: number; workerPassP95Ms: number; suiteWallMs: number; peakRssMb: number };
  informational: { throughputRunsPerSecond: number; workerPassP50Ms: number; cpuMs: number; storageBytesPerCase: number; suiteReplayP95Ms: number };
};

/** One fresh stack, one 100-case sequential pass and one full 25-replay regression suite. The same workload CI runs. */
export async function measureSloWorkload(options: { cases?: number; suiteReplays?: number; warmup?: number } = {}): Promise<SloMeasurement> {
  const cases = options.cases ?? 100, suiteReplays = options.suiteReplays ?? 25, warmup = options.warmup ?? 10;
  const pg = instrumentPg();
  const s = await workloadStack();
  try {
    const judges = await safeJudges(s), safe = await s.judge('safe'), unsafe = await s.judge('unsafe');
    const pool = await publishPool(s, Math.max(cases, 20));
    if (warmup > 0) await phaseSequential(s, pg, pool, warmup, judges); // JIT, connection pool and plan caches; not reported
    const sequential = await phaseSequential(s, pg, pool, cases, judges);
    const regression = await phaseRegression(s, pg, suiteReplays, suiteReplays, unsafe.url, safe.url);
    const suite = regression.firstSuite;
    return {
      cases, suiteReplays,
      deterministic: {
        workerStatementsPerCase: sequential.perCase.workerStatements.mean, launchStatementsPerCase: sequential.perCase.launchStatements.mean, eventRowsPerCase: sequential.perCase.eventRows,
        eventBytesPerCase: sequential.perCase.eventBytes, replayStatementsPerReplay: suite.statementsPerReplay, targetRequestsPerCase: sequential.perCase.targetRequests.mean
      },
      timed: { sequentialWallMs: sequential.resources.wallMs, workerPassP95Ms: sequential.latency.worker.p95Ms, suiteWallMs: suite.wallMs, peakRssMb: Math.max(sequential.resources.peakRssMb, suite.peakRssMb) },
      informational: { throughputRunsPerSecond: sequential.throughputRunsPerSecond, workerPassP50Ms: sequential.latency.worker.p50Ms, cpuMs: sequential.resources.cpuMs, storageBytesPerCase: sequential.perCase.storageBytes, suiteReplayP95Ms: suite.replayLatency.p95Ms }
    };
  } finally { await s.close(); pg.restore(); }
}

export type SloCheck = { name: string; kind: 'deterministic' | 'timed'; unit: string; measured: number; limit: number; pass: boolean; headroom: number };
export type SloLimits = { deterministic: Record<keyof SloMeasurement['deterministic'], number>; timed: Record<keyof SloMeasurement['timed'], number> };
const units: Record<string, string> = { workerStatementsPerCase: 'statements', launchStatementsPerCase: 'statements', eventRowsPerCase: 'rows', eventBytesPerCase: 'bytes', replayStatementsPerReplay: 'statements', targetRequestsPerCase: 'requests',
  sequentialWallMs: 'ms', workerPassP95Ms: 'ms', suiteWallMs: 'ms', peakRssMb: 'MB' };

/** Every limit is an upper bound. `headroom` is limit / measured: 4 means the run used a quarter of what the SLO allows. */
export function evaluateSlo(measurement: SloMeasurement, limits: SloLimits): SloCheck[] {
  const checks: SloCheck[] = [];
  for (const kind of ['deterministic', 'timed'] as const) {
    for (const [name, value] of Object.entries(measurement[kind])) {
      const limit = (limits[kind] as Record<string, number>)[name];
      checks.push({ name, kind, unit: units[name] ?? '', measured: value, limit, pass: value <= limit, headroom: value > 0 ? round(limit / value) : Infinity });
    }
  }
  return checks;
}
