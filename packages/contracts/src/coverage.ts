import { z } from 'zod';

// Scoped coverage (V01). One response is a set of *compatible scopes*: each scope is exactly one
// target and one recorded target version. Executions are never pooled across scopes, so a UI can
// compare like with like and an Orchestrator can ask what remains untested on a version.
// v1 semantics (fixed for this version; change requires v: 2):
//  attempted    terminal execution the worker began (run claimed / adaptive proposal admitted).
//  executed     attempted and at least one target action was sent; never a blocked preflight.
//  assessed     executed and deterministic policy returned safe|inconclusive|pending_review|auto_confirm.
//  reviewed     an operator (not the automatic route) confirmed or rejected the finding candidate.
// `outcomes` is the immutable execution outcome and partitions `attempted`. `disposition` is the
// current human/automatic finding state and never rewrites `outcomes`.
// `scope.owasp` (additive to v1, HDX-45) re-reads the same scope by OWASP tag. A case contributes its whole
// facts to every tag in its rubric's `owaspMappings`, so tag rows overlap and must never be summed: use
// `scope.totals`. A case with no mapping (legacy, or an empty mapping) lands in the explicit `unmapped` row. Each row
// uses the same counts and gap as a category row, so the safe-rate rules are identical.
export const coverageCategories = ['prompt_injection', 'cross_patient', 'unintended_tool_action'] as const;
const count = z.number().int().nonnegative();
const timestamp = z.iso.datetime({ offset: true });
export const coverageOutcomes = z.object({ safe: count, pending_review: count, auto_confirm: count, inconclusive: count, blocked: count, incomplete: count }).strict();
export const coverageCounts = z.object({
  attempted: count, executed: count, assessed: count, reviewed: count,
  notAttempted: count, // terminal without ever reaching the target (stopped in queue, rejected/abandoned proposal)
  inFlight: count, // queued/running work: reported, never counted in any fact or rate
  outcomes: coverageOutcomes,
  disposition: z.object({ candidates: count, awaitingReview: count, confirmed: count, rejected: count }).strict(),
  // rate = numerator / denominator, null when denominator is 0. Inconclusive, blocked and incomplete
  // executions (assertion unknown) are excluded and reported in `excluded`, never counted as safe.
  safeRate: z.object({ numerator: count, denominator: count, excluded: count, rate: z.number().min(0).max(1).nullable() }).strict(),
  // Distinct published catalog case versions (archived versions are excluded here, listed as rows).
  cases: z.object({ catalog: count, attempted: count, executed: count, untested: count }).strict()
}).strict();
// Why a bucket has no determinate (safe/unsafe) result; null when it has one. Derived from counts.
export const coverageGap = z.enum(['untested', 'in_flight', 'blocked', 'incomplete', 'inconclusive']).nullable();
const rowFields = { counts: coverageCounts, gap: coverageGap };
const category = z.enum(coverageCategories);
export const coverageCaseRef = z.object({
  id: z.uuid(), familyId: z.uuid(), version: z.number().int().positive(), title: z.string(),
  catalogState: z.enum(['published', 'archived']), metadataStatus: z.enum(['complete', 'unknown_legacy'])
}).strict();
// The published or executed case versions behind an OWASP row, so a tag stays joinable to its cases.
const owaspRowFields = { ...rowFields, cases: z.array(coverageCaseRef) };
export const coverageOwaspRow = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('tag'), tag: z.string().min(1), ...owaspRowFields }).strict(),
  z.object({ kind: z.literal('unmapped'), ...owaspRowFields }).strict() // present only when at least one case has no mapping
]);
export const coverageRow = z.discriminatedUnion('level', [
  z.object({ level: z.literal('category'), category, ...rowFields }).strict(),
  z.object({ level: z.literal('subcategory'), category, subcategory: z.string().nullable(), ...rowFields }).strict(),
  z.object({ level: z.literal('case'), category, subcategory: z.string().nullable(), case: coverageCaseRef, ...rowFields }).strict()
]);
export const coverageScope = z.object({
  target: z.object({ id: z.uuid(), name: z.string() }).strict(),
  targetVersion: z.string().nullable(), // null: version never established (blocked before session open)
  observed: z.object({ firstAt: timestamp.nullable(), lastAt: timestamp.nullable() }).strict(),
  totals: coverageCounts,
  rows: z.array(coverageRow), // category, then its subcategories, each followed by its cases
  owasp: z.array(coverageOwaspRow) // OWASP tags in ascending order, then `unmapped` last; rows overlap, see above
}).strict();
export const coverageQuery = z.object({
  targetId: z.uuid().optional(),
  targetVersion: z.string().min(1).max(100).optional(), // exact match; "unknown" selects never-established versions
  since: timestamp.optional(), until: timestamp.optional(), // execution start time, since inclusive / until exclusive
  mode: z.enum(['all', 'selected', 'adaptive']).default('all')
}).strict().refine(query => !query.since || !query.until || Date.parse(query.since) < Date.parse(query.until), 'since must be before until');
export const coverageReport = z.object({
  v: z.literal(1), generatedAt: timestamp,
  filters: z.object({ targetId: z.uuid().nullable(), targetVersion: z.string().nullable(), since: timestamp.nullable(), until: timestamp.nullable(), mode: z.enum(['all', 'selected', 'adaptive']) }).strict(),
  safeRatePolicy: z.object({ numerator: z.array(z.string()), denominator: z.array(z.string()), excluded: z.array(z.string()) }).strict(),
  scopes: z.array(coverageScope)
}).strict();
export type CoverageQuery = z.infer<typeof coverageQuery>;
export type CoverageCounts = z.infer<typeof coverageCounts>;
export type CoverageRow = z.infer<typeof coverageRow>;
export type CoverageOwaspRow = z.infer<typeof coverageOwaspRow>;
export type CoverageScope = z.infer<typeof coverageScope>;
export type CoverageReport = z.infer<typeof coverageReport>;
