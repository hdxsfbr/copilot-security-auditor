import { z } from 'zod';
import { category, modelAssignment, policyTrace, verdict } from './index.js';
import { checkResult } from './agent.js';

// F01 report contracts. `documentationReport` is the only thing the Documentation model may author: narrative
// fields plus citations. Identity, reproduction, evidence excerpts and validation history are deterministic
// `reportFacts` built from persisted evidence, so a model reply cannot add a finding or an unseen fact.
export const severityLevel = z.enum(['low', 'medium', 'high', 'critical', 'unknown']);
const text = (max: number) => z.string().trim().min(1).max(max);
const turnRef = z.string().regex(/^turn-[1-3]$/);
// `case` cites the case definition's expected behavior; the rest cite persisted observations, the Judge verdict and checks.
export const citationId = z.string().regex(/^(case|verdict|turn-[1-3]|check-[1-6])$/);
const cited = { text: text(2000), citations: z.array(citationId).min(1).max(6) };
export const documentationReport = z.object({
  v: z.literal(1), title: text(160),
  severity: z.object({ level: severityLevel, rationale: text(1500) }).strict(),
  clinicalImpact: text(1500), description: text(2500),
  expectedBehavior: z.object(cited).strict(),
  // Quotes must be verbatim excerpts of a cited observation; the worker rejects anything else.
  observedBehavior: z.object({ ...cited, quotes: z.array(z.string().min(8).max(500)).max(3) }).strict(),
  reproductionNotes: z.array(text(600)).max(5),
  remediation: z.array(text(600)).min(1).max(8),
  uncertainty: z.array(text(600)).max(10)
}).strict();
export const assessedVerdict = verdict.extend({ policy: policyTrace }).strict();
export const assessedChecks = z.array(checkResult).max(6);
const regressionStatus = z.enum(['new', 'recurring', 'fixed', 'resurfaced', 'unknown', 'not_applicable']);
export const reportFacts = z.object({
  findingId: z.uuid(), runId: z.uuid(), evidenceRevision: z.number().int().positive(), category,
  target: z.object({ name: text(120), version: z.string().max(200).nullable() }).strict(),
  basis: z.enum(['auto_confirmed', 'human_confirmed']).nullable(), regression: regressionStatus,
  // Present only when the case carried a rubric; a legacy case has no manufactured severity.
  rubric: z.object({ severity: severityLevel, severityRationale: z.string(), exploitabilityRationale: z.string() }).strict().nullable(),
  expectedSafeBehavior: text(1000),
  reproduction: z.array(z.object({ step: z.number().int().min(1).max(3), kind: z.enum(['chat_turn', 'attach_pdf']), instruction: text(1200), attachment: z.object({ documentType: z.enum(['lab_pdf', 'intake_form']), artifactId: z.uuid() }).strict().optional() }).strict()).min(1).max(3),
  evidence: z.array(z.object({ ref: turnRef, turn: z.number().int().positive(), status: z.string().max(40), excerpt: z.string().max(3000) }).strict()).min(1).max(3),
  checks: z.array(z.object({ ref: z.string().regex(/^check-[1-6]$/), kind: z.string(), outcome: z.string(), coveredClaim: z.string().max(2000) }).strict()).max(6),
  verdict: z.object({ outcome: z.string(), claim: z.string().max(2000), evidenceQuote: z.string().max(1000).optional(), evidenceRefs: z.array(z.string()).max(20), reproductionComplete: z.boolean(), materialUncertainties: z.array(z.string().max(2000)).max(20) }).strict(),
  policy: policyTrace,
  status: z.literal('open'),
  validationHistory: z.array(z.object({ runId: z.uuid(), version: z.string().nullable(), outcome: z.string().nullable() }).strict()).max(50)
}).strict();
export const reportContent = z.object({ v: z.literal(1), facts: reportFacts, narrative: documentationReport }).strict();

const confirmCodes = ['evidence_confirms_violation'] as const;
const rejectCodes = ['evidence_insufficient', 'expected_behavior_met', 'target_behavior_acceptable', 'test_artifact', 'duplicate', 'out_of_scope'] as const;
export const reviewRationale = z.object({ code: z.enum([...confirmCodes, ...rejectCodes, 'other']), note: text(1000).optional(), evidenceRefs: z.array(turnRef).max(3).optional() }).strict();
export const rationaleFits = (decision: 'confirm' | 'reject', rationale?: z.infer<typeof reviewRationale>) =>
  !rationale || rationale.code === 'other' || (decision === 'confirm' ? (confirmCodes as readonly string[]) : (rejectCodes as readonly string[])).includes(rationale.code);
// Compatible extension of the original `{ decision }` body: the rationale is optional and recorded as absent when omitted.
export const findingReview = z.object({ decision: z.enum(['confirm', 'reject']), rationale: reviewRationale.optional() })
  .refine(input => rationaleFits(input.decision, input.rationale), { message: 'Rationale code does not fit the decision', path: ['rationale'] });
export const findingCorrection = z.object({ rationale: reviewRationale, reason: text(500) }).strict();
export const reportRevisionEdit = z.object({ parentRevisionId: z.uuid(), narrative: documentationReport }).strict();
export const reportApproval = z.object({ contentHash: z.string().regex(/^[0-9a-f]{64}$/) }).strict();
export const reportJobRequest = z.object({ evidenceRevision: z.number().int().min(1).max(1000).optional() }).strict();
export const reportAuthorization = z.object({ model: modelAssignment, allowanceUsd: z.number().finite().min(0.000000001).max(100).optional() }).strict().superRefine((input, ctx) => {
  if (input.model.provider === 'openrouter' && input.allowanceUsd === undefined) ctx.addIssue({ code: 'custom', message: 'A report allowance is required for a paid Documentation model' });
  if (input.model.provider === 'ollama' && input.allowanceUsd !== undefined) ctx.addIssue({ code: 'custom', message: 'A local Documentation model has no paid allowance' });
});
export type DocumentationReport = z.infer<typeof documentationReport>;
export type ReportFacts = z.infer<typeof reportFacts>;
export type ReportContent = z.infer<typeof reportContent>;
export type ReviewRationale = z.infer<typeof reviewRationale>;
