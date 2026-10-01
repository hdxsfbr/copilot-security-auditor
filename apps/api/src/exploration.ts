import type pg from 'pg';
import { scopedCoverage } from './coverage.js';
import { listRegressionIdentities } from './regression-identity.js';

// A17 read model: what the Orchestrator may weigh when choosing the next seed for one target. It only reads V01 scoped coverage,
// G02 regression states and unresolved finding severity; it never writes and never turns missing evidence into a positive claim.
export type Gap = 'untested' | 'blocked' | 'inconclusive' | 'incomplete';
export type Severity = 'critical' | 'high' | 'medium' | 'low' | 'unknown';
export type Regression = 'resurfaced' | 'recurring';
export type SeedSignal = {
  regression: Regression | null;
  severity: Severity | null;
  gap: Gap | null;
};
export type CategorySignal = { regression: Regression | null; severity: Severity | null };
export type ExplorationSignals = {
  targetVersion: string | null;
  seeds: Record<string, SeedSignal>;
  categories: Record<string, CategorySignal>;
};

const severities: Severity[] = ['unknown', 'low', 'medium', 'high', 'critical'];
const stronger = (a: Severity | null, b: Severity | null) =>
  a === null ? b : b === null ? a : severities.indexOf(b) > severities.indexOf(a) ? b : a;
const worse = (a: Regression | null, b: Regression | null) =>
  a === 'resurfaced' || b === 'resurfaced' ? ('resurfaced' as const) : (a ?? b);

// `version` is the target version the run has observed so far (null before its first case opens a session). With no version the
// newest observed scope of the target stands in, so coverage is never pooled across versions.
export async function explorationSignals(
  pool: pg.Pool,
  input: { targetId: string; version: string | null; seeds: { id: string; category: string }[] },
): Promise<ExplorationSignals> {
  const { targetId, version } = input;
  const coverage = await scopedCoverage(pool, {
    targetId,
    mode: 'all',
    ...(version ? { targetVersion: version } : {}),
  });
  const scope = coverage?.scopes.find(item => item.target.id === targetId);
  const gaps = new Map<string, Gap | null>();
  for (const row of scope?.rows ?? [])
    if (row.level === 'case') gaps.set(row.case.id, row.gap === 'in_flight' ? null : row.gap);

  const regressions = await listRegressionIdentities(pool, { limit: 100, targetId });
  const seedRegression = new Map<string, Regression>(),
    categoryRegression = new Map<string, Regression>(),
    fixedFindings = new Set<string>();
  for (const item of regressions.items) {
    const state = item.targetStates.find(entry => entry.targetId === targetId);
    if (!state) continue;
    const entry =
      version === null
        ? state.current
        : (state.scopes.find(scoped => scoped.targetVersion === version) ?? state.current);
    if (entry.state === 'fixed')
      for (const finding of item.sourceFindings) fixedFindings.add(finding.findingId);
    if (entry.state !== 'resurfaced' && entry.state !== 'recurring') continue;
    if (item.category)
      categoryRegression.set(
        item.category,
        worse(categoryRegression.get(item.category) ?? null, entry.state)!,
      );
    for (const finding of item.sourceFindings)
      for (const id of [finding.sourceCaseId, finding.replayCaseId])
        if (id) seedRegression.set(id, worse(seedRegression.get(id) ?? null, entry.state)!);
  }

  // Unresolved: awaiting review or confirmed, and not derived as fixed. Severity is the case rubric's, `unknown` when it recorded none.
  const unresolved = (
    await pool.query(
      `SELECT c.id AS "findingId",CASE WHEN c.adaptive_case_id IS NULL THEN r.case_id ELSE ac.source_case_id END AS "caseId",
    COALESCE(d.definition->>'category','prompt_injection') AS category,COALESCE(d.definition->'rubric'->>'severity','unknown') AS severity
    FROM candidates c JOIN runs r ON r.id=c.run_id LEFT JOIN adaptive_cases ac ON ac.id=c.adaptive_case_id,
    LATERAL (SELECT CASE WHEN c.adaptive_case_id IS NULL THEN r.definition->'case' ELSE ac.definition END AS definition) d
    WHERE r.target_id=$1 AND c.state IN ('pending_review','confirmed') ORDER BY c.created_at DESC,c.id LIMIT 500`,
      [targetId],
    )
  ).rows as { findingId: string; caseId: string | null; category: string; severity: string }[];
  const seedSeverity = new Map<string, Severity>(),
    categorySeverity = new Map<string, Severity>();
  for (const row of unresolved) {
    if (fixedFindings.has(row.findingId)) continue;
    const severity = (severities as string[]).includes(row.severity)
      ? (row.severity as Severity)
      : 'unknown';
    if (row.caseId)
      seedSeverity.set(row.caseId, stronger(seedSeverity.get(row.caseId) ?? null, severity)!);
    categorySeverity.set(
      row.category,
      stronger(categorySeverity.get(row.category) ?? null, severity)!,
    );
  }

  const seeds: Record<string, SeedSignal> = {},
    categories: Record<string, CategorySignal> = {};
  for (const seed of input.seeds) {
    seeds[seed.id] = {
      regression: seedRegression.get(seed.id) ?? null,
      severity: seedSeverity.get(seed.id) ?? null,
      gap: gaps.get(seed.id) ?? (gaps.has(seed.id) ? null : 'untested'),
    };
    categories[seed.category] = {
      regression: categoryRegression.get(seed.category) ?? null,
      severity: categorySeverity.get(seed.category) ?? null,
    };
  }
  return { targetVersion: scope?.targetVersion ?? version, seeds, categories };
}
