import { z } from 'zod';

const identityFields = { username: z.string().min(1).max(100), pubpid: z.string().regex(/^[A-Za-z0-9-]{1,64}$/, 'Use the exact external patient ID without search wildcards') };
export const identity = z.object({ ...identityFields, password: z.string().min(1) }).strict();
const targetFields = { name: z.string().min(1).max(120), baseUrl: z.url().refine(s => ['http:', 'https:'].includes(new URL(s).protocol) && !new URL(s).username && !new URL(s).password && !new URL(s).search && !new URL(s).hash) };
const distinctAssignments = (t: { userA: { username: string; pubpid: string }; userB: { username: string; pubpid: string } }) => t.userA.username !== t.userB.username && t.userA.pubpid !== t.userB.pubpid;
export const targetInput = z.object({ ...targetFields, userA: identity, userB: identity }).strict().refine(distinctAssignments, 'Distinct synthetic user and external patient ID assignments required');
const updateIdentity = z.object({ ...identityFields, password: z.string().min(1).optional() }).strict();
export const targetUpdateInput = z.object({ ...targetFields, userA: updateIdentity, userB: updateIdentity }).strict().refine(distinctAssignments, 'Distinct synthetic user and external patient ID assignments required');
const message = z.string().min(1).max(1000);
export const action = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('chat_turn'), message }).strict(),
  z.object({ kind: z.literal('attach_pdf'), message, artifactId: z.uuid(), documentType: z.enum(['lab_pdf', 'intake_form']) }).strict()
]);
export const checkSpec = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('forbidden_patient_disclosure'), version: z.literal(1), patientId: z.enum(['A', 'B']) }).strict(),
  z.object({ kind: z.literal('required_source_citation'), version: z.literal(1) }).strict(),
  z.object({ kind: z.literal('forbidden_tool_effect'), version: z.literal(1), effect: z.string().min(1).max(200) }).strict()
]);
export const category = z.enum(['prompt_injection', 'cross_patient', 'unintended_tool_action']);
export const caseInput = z.object({ title: z.string().min(1).max(120), category: category.optional(), expectedSafeBehavior: z.string().min(1).max(1000), user: z.enum(['A', 'B']), actions: z.array(action).min(1).max(3), checks: z.array(checkSpec).max(6).optional() }).strict();
export const startInput = z.object({ targetId: z.uuid(), caseId: z.uuid(), model: z.string().min(1).max(120), ollamaUrl: z.url().refine(s => ['http:', 'https:'].includes(new URL(s).protocol) && !new URL(s).username && !new URL(s).password && !new URL(s).search && !new URL(s).hash) }).strict();
export const outcome = z.enum(['safe', 'inconclusive', 'pending_review', 'auto_confirm', 'blocked', 'incomplete']);
export const verdict = z.object({ v: z.literal(1), outcome: z.enum(['safe', 'unsafe', 'inconclusive']), claim: z.string().max(2000), evidenceQuote: z.string().min(8).max(1000).optional(), evidenceRefs: z.array(z.string()).max(20), reproductionComplete: z.boolean(), materialUncertainties: z.array(z.string()).max(20) }).strict();
export const observation = z.object({ v: z.literal(1), turn: z.number().int().positive(), status: z.enum(['complete', 'partial', 'fallback', 'denied', 'refused', 'failed']), response: z.string().max(10000), ref: z.string() }).strict();
export const evidenceEvent = z.object({ v: z.literal(1), agent: z.enum(['worker', 'target', 'check', 'judge']), kind: z.string().max(80), detail: z.record(z.string(), z.unknown()) }).strict();
export const error = z.object({ v: z.literal(1), code: z.enum(['invalid', 'conflict', 'not_found', 'internal']), message: z.string(), active_run_id: z.uuid().optional() });
export type TargetInput = z.infer<typeof targetInput>;
export type TargetUpdateInput = z.infer<typeof targetUpdateInput>;
export type CaseInput = z.infer<typeof caseInput>;
export type StartInput = z.infer<typeof startInput>;
export type Verdict = z.infer<typeof verdict>;
export type Observation = z.infer<typeof observation>;
export type Outcome = z.infer<typeof outcome>;
export type EvidenceEvent = z.infer<typeof evidenceEvent>;
export type CheckSpec = z.infer<typeof checkSpec>;
export type AttackAction = z.infer<typeof action>;
