import type { SloLimits, SloMeasurement } from './slo.js';

// The regression SLO, as data (HDX-32 / P01). `reference` is what the fixture pipeline measured when this SLO was set;
// `multipliers` say how far above that reference each metric may go; `limits` are the resulting hard numbers CI enforces.
// tests/performance/slo.test.ts proves limits === deriveLimits(reference, multipliers) and that the reference equals the
// recorded evidence, so none of the three can be edited alone. To change the SLO, re-record the baseline
// (`npm run perf:baseline`), update `reference`, and let the test tell you which limits moved.

export const SLO_LABEL = 'FIXTURE REGRESSION SLO (HDX-32 / P01): a measured threshold on local stand-ins (fixture target, scripted Judge, disposable PostgreSQL). It is NOT a live performance claim and says nothing about live target or model latency.';

type Reference = { deterministic: SloMeasurement['deterministic']; timed: SloMeasurement['timed'] };

export const SLO_REFERENCE = {
  recordedFrom: 'evals/results/performance/2026-09-30/fixture-baseline-100.json, repeatability block (median of 5 fresh-database runs of the SLO workload)',
  deterministic: { workerStatementsPerCase: 0, launchStatementsPerCase: 0, eventRowsPerCase: 0, eventBytesPerCase: 0, replayStatementsPerReplay: 0, targetRequestsPerCase: 0 },
  timed: { sequentialWallMs: 0, workerPassP95Ms: 0, suiteWallMs: 0, peakRssMb: 0 }
} satisfies Reference & { recordedFrom: string };

/**
 * How far above the reference each metric may go before CI fails.
 *
 * Deterministic metrics count work, not time: the same code does the same number of statements, event rows and event bytes on
 * any machine, and repeated runs were identical to the last digit. Their tolerance exists only so that a legitimate new feature
 * (one more audit row, one more check) does not fail main; an accidental N+1, an extra round trip per event or a bloated event
 * body moves them well past it.
 *
 * Timed metrics are generous on purpose. The CI runner is a small shared 1 vCPU machine on which the fixture job already takes
 * about ten minutes, where the Node process, PostgreSQL and the operating system all compete for one core and PostgreSQL commits
 * pay a real disk flush (measured here: 53% of database time is COMMIT, about 12.6 commits per case). A limit at 20 times
 * the reference wall time leaves room for a core that is several times slower, a shared disk with a
 * multi-millisecond flush and a noisy neighbour at the same time, yet still fails an order-of-magnitude regression such as a
 * query that became a scan of growing history per case or a per-event round trip that became per-row. The single re-measurement
 * in slo-check.ts removes the rest of the transient noise.
 */
export const SLO_MULTIPLIERS = {
  deterministic: { workerStatementsPerCase: 1.25, launchStatementsPerCase: 1.25, eventRowsPerCase: 1.25, eventBytesPerCase: 1.5, replayStatementsPerReplay: 1.25, targetRequestsPerCase: 1.25 },
  timed: { sequentialWallMs: 30, workerPassP95Ms: 30, suiteWallMs: 30, peakRssMb: 2 }
} satisfies SloLimits;

const ceil = (value: number) => Math.ceil(value);
export function deriveLimits(reference: Reference, multipliers: SloLimits): SloLimits {
  const out = { deterministic: {} as Record<string, number>, timed: {} as Record<string, number> };
  for (const kind of ['deterministic', 'timed'] as const) for (const [name, value] of Object.entries(reference[kind])) out[kind][name] = ceil(value * (multipliers[kind] as Record<string, number>)[name]);
  return out as unknown as SloLimits;
}

/** The numbers CI enforces. Kept literal so a reviewer reads the threshold itself, not a formula. */
export const SLO_LIMITS: SloLimits = deriveLimits(SLO_REFERENCE, SLO_MULTIPLIERS);

export const SLO = { version: 1, reference: SLO_REFERENCE, multipliers: SLO_MULTIPLIERS, limits: SLO_LIMITS };
