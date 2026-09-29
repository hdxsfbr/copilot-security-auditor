import { z } from 'zod';

// Spend reconciliation (M02). Amounts are decimal strings of integer billionths of a dollar ("nanos"),
// never floats. Only paid (OpenRouter) calls carry spend; local inference has no price and no row here.
// The four totals never merge:
//  providerReportedNanos    settled by the worker from the provider's own usage.cost.
//  operatorReconciledNanos  settled by an operator attestation (spend_reconciliations); not provider data.
//  reservedNanos            in-flight reservations (status reserved).
//  unresolvedNanos          reserve still held for calls whose billing is unknown. Never released implicitly.
// Reconciliation bound (enforced by the API): 0 <= charge <= min(10 x the call's reserve, $100). A charge
// above the reserve is possible because unresolved includes provider-reported overruns; the ceiling only
// rejects implausible attestations. Report-job calls must also keep the job's held total within its funds.
export const MAX_RECONCILE_MULTIPLE = 10;
export const MAX_RECONCILE_NANOS = '100000000000';
const nanosText = z.string().regex(/^(0|[1-9]\d*)$/);
const timestamp = z.iso.datetime({ offset: true });
export const reconcileResolution = z.enum(['settled_by_operator', 'confirmed_not_billed']);
const usd = z.union([z.string(), z.number()]).transform(value => typeof value === 'number' ? String(value) : value.trim())
  .pipe(z.string().regex(/^(0|[1-9]\d*)(\.\d{1,9})?$/, 'Use a decimal dollar amount with at most 9 decimal places'));
const hasValue = (value: string) => /[1-9]/.test(value);
export const reconcileInput = z.object({
  resolution: reconcileResolution,
  chargeUsd: usd.optional(),
  // Provider dashboard reference, generation id or invoice line. Single line, no control or format characters.
  evidence: z.string().trim().min(1).max(500).regex(/^[^\p{Cc}\p{Cf}]+$/u, 'Evidence must be a single line of plain text'),
  idempotencyKey: z.string().min(8).max(128).regex(/^[A-Za-z0-9._:-]+$/),
}).strict().superRefine((value, ctx) => {
  const charged = value.chargeUsd !== undefined && hasValue(value.chargeUsd);
  if (value.resolution === 'settled_by_operator' && !charged) ctx.addIssue({ code: 'custom', path: ['chargeUsd'], message: 'A recorded charge must be greater than zero' });
  if (value.resolution === 'confirmed_not_billed' && charged) ctx.addIssue({ code: 'custom', path: ['chargeUsd'], message: 'A call confirmed not billed has no charge' });
});
export const unresolvedSpendQuery = z.object({ limit: z.coerce.number().int().min(1).max(100).default(50) }).strict();
// Not strict: this endpoint has always ignored unknown query parameters.
export const usageQuery = z.object({ include: z.enum(['totals']).optional() });
export const spendTotals = z.object({ providerReportedNanos: nanosText, operatorReconciledNanos: nanosText, reservedNanos: nanosText, unresolvedNanos: nanosText, unresolvedCalls: z.number().int().nonnegative() }).strict();
export const unresolvedCall = z.object({
  id: z.uuid(), runId: z.uuid(), targetId: z.uuid(), targetName: z.string().nullable(), reportJobId: z.uuid().nullable(),
  role: z.enum(['orchestrator', 'redTeam', 'judge', 'documentation']), provider: z.literal('openrouter'), model: z.string(),
  reservedNanos: nanosText, reportedChargeNanos: nanosText.nullable(), providerGenerationId: z.string().nullable(),
  createdAt: timestamp, ageSeconds: z.number().int().nonnegative(), maxChargeNanos: nanosText,
}).strict();
export const unresolvedSpendReport = z.object({ v: z.literal(1), totals: spendTotals, calls: z.array(unresolvedCall).max(100), truncated: z.boolean(), bounds: z.object({ maxChargeMultiple: z.literal(MAX_RECONCILE_MULTIPLE), maxChargeNanos: z.literal(MAX_RECONCILE_NANOS) }).strict() }).strict();
export const spendReconciliation = z.object({
  id: z.uuid(), callId: z.uuid(), resolution: reconcileResolution, chargeNanos: nanosText, evidence: z.string(),
  previousStatus: z.literal('unresolved'), previousReservedNanos: nanosText, previousChargeNanos: nanosText.nullable(), createdAt: timestamp,
}).strict();
export const reconcileResult = z.object({ v: z.literal(1), replayed: z.boolean(), reconciliation: spendReconciliation, call: z.object({ id: z.uuid(), status: z.literal('settled'), chargeNanos: nanosText, reservedNanos: nanosText, providerGenerationId: z.string().nullable() }).strict() }).strict();
export type ReconcileInput = z.infer<typeof reconcileInput>;
export type SpendTotals = z.infer<typeof spendTotals>;
export type UnresolvedCall = z.infer<typeof unresolvedCall>;
export type SpendReconciliation = z.infer<typeof spendReconciliation>;
export type ReconcileResult = z.infer<typeof reconcileResult>;
