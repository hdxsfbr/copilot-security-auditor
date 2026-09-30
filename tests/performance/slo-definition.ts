import type { SloLimits, SloMeasurement } from './slo.js';

// The regression SLO, as data (HDX-32 / P01).
//
//   reference    what the fixture pipeline measured when this SLO was set (median of 5 fresh-process runs of the SLO workload)
//   multipliers  how far above the reference each metric may go
//   limits       the resulting hard numbers CI enforces, written out so a reviewer reads the threshold itself
//
// tests/performance/slo.test.ts proves limits === deriveLimits(reference, multipliers) and that the reference equals the recorded
// evidence, so none of the three can be edited alone. To change the SLO: re-record the baseline (`npm run perf:baseline`), paste the
// new medians into `reference`, and the test names which limits must move with them.

export const SLO_LABEL = 'FIXTURE REGRESSION SLO (HDX-32 / P01): a measured threshold on local stand-ins (fixture target, scripted Judge, disposable PostgreSQL). It is NOT a live performance claim and says nothing about live target or model latency.';

type Reference = { deterministic: SloMeasurement['deterministic']; timed: SloMeasurement['timed'] };

export const SLO_REFERENCE = {
  recordedFrom: 'evals/results/performance/2026-09-30/fixture-baseline-100.json, repeatability block (median of 5 fresh-process runs of the SLO workload)',
  deterministic: { workerStatementsPerCase: 64.2, launchStatementsPerCase: 9, eventRowsPerCase: 6.65, eventBytesPerCase: 2981, replayStatementsPerReplay: 84.08, targetRequestsPerCase: 11.3 },
  timed: { sequentialWallMs: 1921, workerPassP95Ms: 22.82, suiteWallMs: 453, peakRssMb: 374 }
} satisfies Reference & { recordedFrom: string };

/**
 * How far above the reference each metric may go before CI fails, and why.
 *
 * DETERMINISTIC metrics count work, not time: SQL statements, event rows and event bytes per case, and target requests per case. The
 * same code does the same work on any machine; five fresh-process runs were identical to the last digit. The tolerance (25%, 50% for
 * bytes) exists only so a legitimate new feature (one more audit row, one more check) does not fail main. An accidental N+1, an
 * extra round trip per event or a bloated event body moves them past it. These are the precise part of the SLO and cannot flake.
 *
 * TIMED metrics are deliberately coarse. The CI runner is a small shared 1 vCPU machine on which the fixture job already takes
 * about ten minutes; the Node process, PostgreSQL and the operating system all compete for that one core, and a database commit pays
 * a real disk flush there. The reference was taken on a 32-thread workstation where PostgreSQL ran on other cores and commits cost
 * about half a millisecond. Reasoning from the recorded breakdown (per case: 9.7 ms Node CPU, 12.3 ms awaiting PostgreSQL, of which
 * 7.2 ms is 12.65 commits), and ASSUMING a 1 vCPU runner with a core 4x slower, PostgreSQL CPU as large as Node's and serialized with
 * it, and 5-10 ms commit flushes (none of which is measured), a case takes about 140-200 ms against the reference 19 ms: roughly
 * 7-11x the reference wall time. The limits sit at 30x: room for that plus a noisy neighbour, while still failing
 * a real regression such as an added 0.5 s sleep or backoff per case (100 cases would take 50 s more, past the 57.6 s limit) or a
 * query that became a scan of growing history. Timed breaches are also re-measured once on the same runner (slo-check.ts), so a
 * transient spike cannot fail the job; a sustained slowdown still does. Peak memory does not scale with CPU speed, so it gets 2x.
 *
 * What the timed limits cannot do is catch a 2x slowdown; that is the job of the deterministic tier and of the recorded baseline
 * when someone compares it by hand. They are a fixture tripwire, not a performance prediction.
 */
export const SLO_MULTIPLIERS = {
  deterministic: { workerStatementsPerCase: 1.25, launchStatementsPerCase: 1.25, eventRowsPerCase: 1.25, eventBytesPerCase: 1.5, replayStatementsPerReplay: 1.25, targetRequestsPerCase: 1.25 },
  timed: { sequentialWallMs: 30, workerPassP95Ms: 30, suiteWallMs: 30, peakRssMb: 2 }
} satisfies SloLimits;

export function deriveLimits(reference: Reference, multipliers: SloLimits): SloLimits {
  const out = { deterministic: {} as Record<string, number>, timed: {} as Record<string, number> };
  for (const kind of ['deterministic', 'timed'] as const) for (const [name, value] of Object.entries(reference[kind])) out[kind][name] = Math.ceil(value * (multipliers[kind] as Record<string, number>)[name]);
  return out as unknown as SloLimits;
}

/** The numbers CI enforces (upper bounds). statements/rows/requests are per case or per replay; bytes per case; times in ms; memory in MB. */
export const SLO_LIMITS: SloLimits = {
  deterministic: { workerStatementsPerCase: 81, launchStatementsPerCase: 12, eventRowsPerCase: 9, eventBytesPerCase: 4472, replayStatementsPerReplay: 106, targetRequestsPerCase: 15 },
  timed: { sequentialWallMs: 57630, workerPassP95Ms: 685, suiteWallMs: 13590, peakRssMb: 748 }
};

export const SLO = { version: 1, reference: SLO_REFERENCE, multipliers: SLO_MULTIPLIERS, limits: SLO_LIMITS };
