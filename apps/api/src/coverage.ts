import type pg from 'pg';
import { caseRubric, category as caseCategory } from '../../../packages/contracts/src/index.js';
import { coverageCategories, coverageReport, type CoverageCounts, type CoverageOwaspRow, type CoverageQuery, type CoverageReport, type CoverageRow, type CoverageScope } from '../../../packages/contracts/src/coverage.js';

// One execution unit is a finished-or-running selected run or one adaptive execution case. Facts come
// only from persisted rows: runs/adaptive_cases (immutable outcome), events (target action evidence) and
// candidates (current disposition). Nothing here writes, and candidates never feed back into `bucket`.
const UNITS = `
  SELECT r.target_id,r.version,r.case_id,'selected' AS mode,
    COALESCE(r.definition->'case'->>'category','prompt_injection') AS category,
    r.definition->'case'->'rubric'->>'subcategory' AS subcategory,
    COALESCE(r.started_at,r.created_at) AS at,r.status='finished' AS terminal,
    (r.started_at IS NOT NULL OR r.lease_owner IS NOT NULL) AS attempted,r.outcome,
    EXISTS (SELECT 1 FROM events e WHERE e.run_id=r.id AND e.event->>'agent'='target' AND e.event->>'kind' IN ('turn','attempts')) AS acted,
    k.state AS candidate,k.decision_route AS route
  FROM runs r LEFT JOIN candidates k ON k.run_id=r.id AND k.adaptive_case_id IS NULL
  WHERE r.adaptive IS NULL AND r.case_id IS NOT NULL
  UNION ALL
  SELECT r.target_id,r.version,ac.source_case_id,'adaptive',ac.category,ac.definition->'rubric'->>'subcategory',
    ac.created_at,ac.state NOT IN ('proposed','executing'),ac.definition IS NOT NULL,ac.state,ac.executed,k.state,k.decision_route
  FROM adaptive_cases ac JOIN runs r ON r.id=ac.run_id LEFT JOIN candidates k ON k.adaptive_case_id=ac.id`;
const SCOPED = `
WITH units AS (${UNITS}), scoped AS (
  SELECT *,CASE WHEN NULLIF(btrim(version),'') IS NULL OR version='unknown' THEN NULL ELSE version END AS ver FROM units
  WHERE ($1::uuid IS NULL OR target_id=$1) AND ($2::timestamptz IS NULL OR at>=$2) AND ($3::timestamptz IS NULL OR at<$3) AND ($4='all' OR mode=$4)
), classified AS (
  SELECT *,CASE WHEN NOT terminal THEN 'in_flight' WHEN NOT attempted THEN 'not_attempted'
    WHEN outcome IN ('safe','pending_review','auto_confirm','inconclusive','blocked') THEN outcome ELSE 'incomplete' END AS bucket
  FROM scoped WHERE $5::text IS NULL OR ver IS NOT DISTINCT FROM NULLIF($5,'unknown')
), facts AS (
  -- A blocked preflight never reached the target, so it is never executed even if stray events exist.
  SELECT *,bucket NOT IN ('in_flight','not_attempted','blocked') AND acted AS executed FROM classified
)
SELECT target_id AS "targetId",ver AS version,case_id AS "caseId",category,subcategory,min(at) AS "firstAt",max(at) AS "lastAt",
  count(*) FILTER (WHERE bucket='in_flight')::int AS "inFlight",count(*) FILTER (WHERE bucket='not_attempted')::int AS "notAttempted",
  count(*) FILTER (WHERE bucket NOT IN ('in_flight','not_attempted'))::int AS attempted,count(*) FILTER (WHERE executed)::int AS executed,
  count(*) FILTER (WHERE executed AND bucket IN ('safe','inconclusive','pending_review','auto_confirm'))::int AS assessed,
  count(*) FILTER (WHERE bucket NOT IN ('in_flight','not_attempted') AND candidate IN ('confirmed','rejected') AND route='operator')::int AS reviewed,
  count(*) FILTER (WHERE bucket='safe')::int AS safe,count(*) FILTER (WHERE bucket='pending_review')::int AS pending_review,
  count(*) FILTER (WHERE bucket='auto_confirm')::int AS auto_confirm,count(*) FILTER (WHERE bucket='inconclusive')::int AS inconclusive,
  count(*) FILTER (WHERE bucket='blocked')::int AS blocked,count(*) FILTER (WHERE bucket='incomplete')::int AS incomplete,
  count(*) FILTER (WHERE bucket NOT IN ('in_flight','not_attempted') AND candidate IS NOT NULL)::int AS candidates,
  count(*) FILTER (WHERE bucket NOT IN ('in_flight','not_attempted') AND candidate='pending_review')::int AS "awaitingReview",
  count(*) FILTER (WHERE bucket NOT IN ('in_flight','not_attempted') AND candidate='confirmed')::int AS confirmed,
  count(*) FILTER (WHERE bucket NOT IN ('in_flight','not_attempted') AND candidate='rejected')::int AS rejected
FROM facts GROUP BY 1,2,3,4,5`;

const keys = ['attempted', 'executed', 'assessed', 'reviewed', 'notAttempted', 'inFlight', 'safe', 'pending_review', 'auto_confirm', 'inconclusive', 'blocked', 'incomplete',
  'candidates', 'awaitingReview', 'confirmed', 'rejected', 'catalog', 'casesAttempted', 'casesExecuted'] as const;
type Acc = Record<typeof keys[number], number>;
const zero = (): Acc => Object.fromEntries(keys.map(key => [key, 0])) as Acc;
const sum = (rows: Acc[]) => rows.reduce((total, row) => { for (const key of keys) total[key] += row[key]; return total; }, zero());
const SAFE_DENOMINATOR = ['safe', 'pending_review', 'auto_confirm'], SAFE_EXCLUDED = ['inconclusive', 'blocked', 'incomplete'];
function counts(a: Acc): CoverageCounts {
  const denominator = a.safe + a.pending_review + a.auto_confirm;
  return { attempted: a.attempted, executed: a.executed, assessed: a.assessed, reviewed: a.reviewed, notAttempted: a.notAttempted, inFlight: a.inFlight,
    outcomes: { safe: a.safe, pending_review: a.pending_review, auto_confirm: a.auto_confirm, inconclusive: a.inconclusive, blocked: a.blocked, incomplete: a.incomplete },
    disposition: { candidates: a.candidates, awaitingReview: a.awaitingReview, confirmed: a.confirmed, rejected: a.rejected },
    safeRate: { numerator: a.safe, denominator, excluded: a.inconclusive + a.blocked + a.incomplete, rate: denominator ? a.safe / denominator : null },
    cases: { catalog: a.catalog, attempted: a.casesAttempted, executed: a.casesExecuted, untested: a.catalog - a.casesAttempted } };
}
// "Furthest progress" wins: inconclusive (assessed) > incomplete (executed) > blocked (never reached the target).
function gap(a: Acc): CoverageRow['gap'] {
  if (a.safe + a.pending_review + a.auto_confirm) return null;
  if (!a.attempted) return a.inFlight ? 'in_flight' : 'untested';
  return a.assessed ? 'inconclusive' : a.executed || !a.blocked ? 'incomplete' : 'blocked';
}
const present = (a: Acc) => ({ counts: counts(a), gap: gap(a) });
const inCategory = (value: unknown) => (coverageCategories as readonly unknown[]).includes(value) ? value as typeof coverageCategories[number] : 'prompt_injection';
// OWASP tags come from the case rubric, exactly as recorded. Only whitespace and the case of identifier-shaped tags
// (LLM01:2025, A03:2021) are normalized so one risk is not split across spellings. Anything else is kept verbatim; nothing is inferred.
const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const OWASP_ID = /^[A-Za-z]+\d{2}:\d{4}$/;
const owaspTags = (rubric: unknown): string[] => {
  const mappings = isObject(rubric) ? rubric.owaspMappings : undefined;
  if (!Array.isArray(mappings)) return [];
  return [...new Set(mappings.filter((tag): tag is string => typeof tag === 'string').map(tag => tag.trim()).filter(Boolean).map(tag => OWASP_ID.test(tag) ? tag.toUpperCase() : tag))].sort((a, b) => a < b ? -1 : a > b ? 1 : 0);
};
const byName = <T>(name: (item: T) => string | null) => (a: T, b: T) => (name(a) === null ? 1 : 0) - (name(b) === null ? 1 : 0) || (name(a) ?? '').localeCompare(name(b) ?? '');

type Grain = Partial<Acc> & { targetId: string; version: string | null; caseId: string; category: string; subcategory: string | null; firstAt: Date; lastAt: Date };
type CaseMeta = { id: string; familyId: string; version: number; state: 'published' | 'archived'; title: string; category: ReturnType<typeof inCategory>; subcategory: string | null; metadataStatus: 'complete' | 'unknown_legacy'; owasp: string[] };
type CaseRow = { meta: CaseMeta; category: ReturnType<typeof inCategory>; subcategory: string | null; acc: Acc };

function buildScope(target: { id: string; name: string }, version: string | null, grains: Grain[], catalog: Map<string, CaseMeta>): CoverageScope {
  const cases = new Map<string, CaseRow>();
  for (const grain of grains) {
    const meta = catalog.get(grain.caseId)!, existing = cases.get(grain.caseId);
    const acc: Acc = { ...zero(), ...grain }; // SQL rows carry only the fact columns; catalog fields start at 0
    if (existing) existing.acc = sum([existing.acc, acc]);
    else cases.set(grain.caseId, { meta, category: inCategory(grain.category), subcategory: grain.subcategory, acc });
  }
  for (const meta of catalog.values()) if (meta.state === 'published' && !cases.has(meta.id)) cases.set(meta.id, { meta, category: meta.category, subcategory: meta.subcategory, acc: zero() });
  for (const row of cases.values()) if (row.meta.state === 'published') { row.acc.catalog = 1; row.acc.casesAttempted = row.acc.attempted ? 1 : 0; row.acc.casesExecuted = row.acc.executed ? 1 : 0; }
  const caseRef = (row: CaseRow) => ({ id: row.meta.id, familyId: row.meta.familyId, version: row.meta.version, title: row.meta.title, catalogState: row.meta.state, metadataStatus: row.meta.metadataStatus });
  const rows: CoverageRow[] = [];
  for (const name of coverageCategories) {
    const inside = [...cases.values()].filter(row => row.category === name);
    rows.push({ level: 'category', category: name, ...present(sum(inside.map(row => row.acc))) });
    for (const sub of [...new Set(inside.map(row => row.subcategory))].sort(byName<string | null>(value => value))) {
      const list = inside.filter(row => row.subcategory === sub).sort((a, b) => a.meta.title.localeCompare(b.meta.title) || a.meta.version - b.meta.version);
      rows.push({ level: 'subcategory', category: name, subcategory: sub, ...present(sum(list.map(row => row.acc))) });
      for (const row of list) rows.push({ level: 'case', category: name, subcategory: sub, ...present(row.acc),
        case: caseRef(row) });
    }
  }
  // OWASP dimension: every case adds its whole acc to each of its tags (so tag rows overlap by design), and a case with no
  // mapping adds it to `unmapped`. Nothing is dropped, and each row goes through the same counts/gap rules as a category row.
  const owasp: CoverageOwaspRow[] = [], byTag = new Map<string, CaseRow[]>(), unmapped: CaseRow[] = [];
  for (const row of cases.values()) { if (row.meta.owasp.length) for (const tag of row.meta.owasp) { const list = byTag.get(tag) ?? []; list.push(row); byTag.set(tag, list); } else unmapped.push(row); }
  const inOrder = (list: CaseRow[]) => [...list].sort((a, b) => a.meta.title.localeCompare(b.meta.title) || a.meta.version - b.meta.version || a.meta.id.localeCompare(b.meta.id));
  for (const tag of [...byTag.keys()].sort((a, b) => a < b ? -1 : a > b ? 1 : 0)) { const list = inOrder(byTag.get(tag)!); owasp.push({ kind: 'tag', tag, ...present(sum(list.map(row => row.acc))), cases: list.map(caseRef) }); }
  if (unmapped.length) { const list = inOrder(unmapped); owasp.push({ kind: 'unmapped', ...present(sum(list.map(row => row.acc))), cases: list.map(caseRef) }); }
  const times = grains.map(grain => grain.firstAt.getTime()).concat(grains.map(grain => grain.lastAt.getTime()));
  return { target, targetVersion: version, observed: { firstAt: times.length ? new Date(Math.min(...times)).toISOString() : null, lastAt: times.length ? new Date(Math.max(...times)).toISOString() : null },
    totals: counts(sum([...cases.values()].map(row => row.acc))), rows, owasp };
}

export async function scopedCoverage(pool: pg.Pool, query: CoverageQuery, now = new Date()): Promise<CoverageReport | null> {
  if (query.targetId && !(await pool.query('SELECT 1 FROM targets WHERE id=$1', [query.targetId])).rowCount) return null;
  const grains = (await pool.query(SCOPED, [query.targetId ?? null, query.since ?? null, query.until ?? null, query.mode, query.targetVersion ?? null])).rows as Grain[];
  const [targets, cases] = await Promise.all([
    pool.query('SELECT id,name FROM targets WHERE id=ANY($1::uuid[])', [[...new Set(grains.map(grain => grain.targetId)), ...(query.targetId ? [query.targetId] : [])]]),
    pool.query("SELECT id,family_id AS \"familyId\",version,state,definition FROM cases WHERE state='published' OR id=ANY($1::uuid[])", [[...new Set(grains.map(grain => grain.caseId))]])
  ]);
  const names = new Map<string, string>(targets.rows.map(row => [row.id, row.name]));
  const catalog = new Map<string, CaseMeta>(cases.rows.map(row => [row.id, { id: row.id, familyId: row.familyId, version: row.version, state: row.state === 'published' ? 'published' : 'archived',
    title: String(row.definition.title ?? ''), category: inCategory(row.definition.category), subcategory: row.definition.rubric?.subcategory ?? null,
    metadataStatus: caseCategory.safeParse(row.definition.category).success && caseRubric.safeParse(row.definition.rubric).success ? 'complete' : 'unknown_legacy',
    owasp: owaspTags(row.definition.rubric) }]));
  const groups = new Map<string, Grain[]>();
  for (const grain of grains) { const id = `${grain.targetId}|${grain.version ?? ''}`; groups.set(id, [...(groups.get(id) ?? []), grain]); }
  // An explicit target+version request always yields that scope, even with no executions: all catalog cases are untested.
  const wanted = query.targetId && query.targetVersion ? `${query.targetId}|${query.targetVersion === 'unknown' ? '' : query.targetVersion}` : null;
  if (wanted && !groups.has(wanted)) groups.set(wanted, []);
  const scopes = [...groups].map(([id, list]) => {
    const [targetId, version] = [id.slice(0, id.indexOf('|')), id.slice(id.indexOf('|') + 1) || null];
    return buildScope({ id: targetId, name: names.get(targetId) ?? '' }, version, list, catalog);
  }).sort((a, b) => a.target.name.localeCompare(b.target.name) || (b.observed.lastAt ?? '').localeCompare(a.observed.lastAt ?? '') || (a.targetVersion ?? '').localeCompare(b.targetVersion ?? '') || a.target.id.localeCompare(b.target.id));
  return coverageReport.parse({ v: 1, generatedAt: now.toISOString(), filters: { targetId: query.targetId ?? null, targetVersion: query.targetVersion ?? null, since: query.since ?? null, until: query.until ?? null, mode: query.mode },
    safeRatePolicy: { numerator: ['safe'], denominator: SAFE_DENOMINATOR, excluded: SAFE_EXCLUDED }, scopes });
}
