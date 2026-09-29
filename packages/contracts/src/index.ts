import { z } from 'zod';
export * from './coverage.js';

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
export const caseRubric = z.object({
  v: z.literal(1), subcategory: z.string().min(1).max(120), owaspMappings: z.array(z.string().min(1).max(120)).max(10),
  severity: z.enum(['low', 'medium', 'high', 'critical', 'unknown']),
  severityRationale: z.string().min(1).max(1000), exploitabilityRationale: z.string().min(1).max(1000),
  boundary: z.string().min(1).max(1000), invariant: z.string().min(1).max(1000), regressionRisk: z.string().min(1).max(1000)
}).strict();
export const caseInput = z.object({ title: z.string().min(1).max(120), category: category.optional(), expectedSafeBehavior: z.string().min(1).max(1000), user: z.enum(['A', 'B']), actions: z.array(action).min(1).max(3), checks: z.array(checkSpec).max(6).optional(), rubric: caseRubric.optional() }).strict();
// Drafts preserve work in progress. Publication still validates the complete schemas above.
const draftAction = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('chat_turn'), message: z.string().max(1000) }).strict(),
  z.object({ kind: z.literal('attach_pdf'), message: z.string().max(1000), artifactId: z.uuid().optional(), documentType: z.enum(['lab_pdf', 'intake_form']) }).strict()
]);
const draftCheckSpec = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('forbidden_patient_disclosure'), version: z.literal(1), patientId: z.enum(['A', 'B']).optional() }).strict(),
  z.object({ kind: z.literal('required_source_citation'), version: z.literal(1) }).strict(),
  z.object({ kind: z.literal('forbidden_tool_effect'), version: z.literal(1), effect: z.string().max(200) }).strict()
]);
const draftRubric = caseRubric.partial().extend({
  v: z.literal(1), subcategory: z.string().max(120).optional(),
  severityRationale: z.string().max(1000).optional(), exploitabilityRationale: z.string().max(1000).optional(),
  boundary: z.string().max(1000).optional(), invariant: z.string().max(1000).optional(), regressionRisk: z.string().max(1000).optional()
}).strict();
export const caseDraftInput = caseInput.partial().omit({ actions: true, checks: true, rubric: true }).extend({
  title: z.string().min(1).max(120), actions: z.array(draftAction).max(3).optional(),
  checks: z.array(draftCheckSpec).max(6).optional(), rubric: draftRubric.optional()
}).strict();
export const publishableCase = caseInput.extend({ category, rubric: caseRubric });
const endpoint = z.url().refine(s => ['http:', 'https:'].includes(new URL(s).protocol) && !new URL(s).username && !new URL(s).password && !new URL(s).search && !new URL(s).hash);
export const modelAssignment = z.discriminatedUnion('provider', [
  z.object({ provider: z.literal('ollama'), model: z.string().min(1).max(120), maxOutputTokens: z.number().int().min(1).max(4096) }).strict(),
  z.object({ provider: z.literal('openrouter'), model: z.string().min(1).max(200), maxOutputTokens: z.number().int().min(1).max(4096) }).strict()
]);
export const modelRoles = z.object({ orchestrator: modelAssignment, redTeam: modelAssignment, judge: modelAssignment, documentation: modelAssignment }).strict();
// Extra historical role fields are intentionally projected away. Only invoked
// roles can require a provider, catalog entry, or paid allowance.
export const selectedRoles = z.object({ judge: modelAssignment });
export const adaptiveRoles = z.object({ orchestrator: modelAssignment, redTeam: modelAssignment, judge: modelAssignment });
const capUsd = z.number().finite().min(0.000000001).max(100);
export const startInput = z.object({ targetId: z.uuid(), caseId: z.uuid(), model: z.string().min(1).max(120).optional(), ollamaUrl: endpoint.optional(), roles: selectedRoles.optional(), openRouterCapUsd: capUsd.optional() }).strict().superRefine((input, ctx) => {
  if (!input.roles && !input.model) ctx.addIssue({ code: 'custom', message: 'A Judge model is required' });
  if (input.roles?.judge.provider === 'openrouter' && input.openRouterCapUsd === undefined) ctx.addIssue({ code: 'custom', message: 'A paid-call cap is required' });
  if ((!input.roles || input.roles.judge.provider === 'ollama') && !input.ollamaUrl) ctx.addIssue({ code: 'custom', message: 'An Ollama URL is required for a local Judge' });
});
export const adaptiveStart = z.object({ targetId: z.uuid(), caseIds: z.array(z.uuid()).min(1).max(9), categories: z.array(category).min(1).max(3), maxCases: z.number().int().min(1).max(9), maxMinutes: z.number().int().min(1).max(30), ollamaUrl: endpoint.optional(), roles: adaptiveRoles, openRouterCapUsd: capUsd.optional() }).strict().superRefine((input, ctx) => {
  if (new Set(input.caseIds).size !== input.caseIds.length || new Set(input.categories).size !== input.categories.length) ctx.addIssue({ code: 'custom', message: 'Duplicate cases or categories' });
  if (Object.values(input.roles).some(role => role.provider === 'openrouter') && input.openRouterCapUsd === undefined) ctx.addIssue({ code: 'custom', message: 'A paid-call cap is required' });
  if (Object.values(input.roles).some(role => role.provider === 'ollama') && !input.ollamaUrl) ctx.addIssue({ code: 'custom', message: 'An Ollama URL is required for active local roles' });
});
export const runDefinition = z.discriminatedUnion('kind', [z.object({ kind: z.literal('selected'), input: startInput }).strict(), z.object({ kind: z.literal('adaptive'), input: adaptiveStart }).strict()]);
export const runDefinitionInput = z.object({ name: z.string().trim().min(1).max(120), run: runDefinition }).strict();
export const runDefinitionEdit = runDefinitionInput.extend({ revision: z.number().int().positive() }).strict();
export const runDefinitionRef = z.object({ revision: z.number().int().positive() }).strict();
export const caseProposal = z.object({ actions: z.array(action).min(1).max(3) }).strict();
const zone = z.string().min(1).max(100).refine(value => { try { new Intl.DateTimeFormat('en-US', { timeZone: value }); return true; } catch { return false; } }, 'Valid IANA time zone required');
const scheduleFields = { name: z.string().min(1).max(120), cadence: z.enum(['daily', 'weekly']), weekday: z.number().int().min(0).max(6).optional(), hour: z.number().int().min(0).max(23), minute: z.number().int().min(0).max(59), zone };
const scheduleCadence = (value: { cadence: 'daily' | 'weekly'; weekday?: number }, ctx: z.RefinementCtx) => {
  if (value.cadence === 'weekly' && value.weekday === undefined) ctx.addIssue({ code: 'custom', message: 'Weekly schedules require a weekday' });
  if (value.cadence === 'daily' && value.weekday !== undefined) ctx.addIssue({ code: 'custom', message: 'Daily schedules cannot have a weekday' });
};
export const scheduleInput = z.object({ ...scheduleFields, run: runDefinition }).strict().superRefine(scheduleCadence);
export const scheduleDefinitionRef = z.object({ ...scheduleFields, runDefinitionId: z.uuid(), revision: z.number().int().positive() }).strict().superRefine(scheduleCadence);
export const scheduleState = z.object({ paused: z.boolean() }).strict();
export const runHistoryQuery = z.object({ limit: z.coerce.number().int().min(1).max(100).default(25), cursor: z.string().min(1).max(512).optional() }).strict();
export const outcome = z.enum(['safe', 'inconclusive', 'pending_review', 'auto_confirm', 'blocked', 'incomplete']);
export const verdict = z.object({ v: z.literal(1), outcome: z.enum(['safe', 'unsafe', 'inconclusive']), claim: z.string().max(2000), evidenceQuote: z.string().min(8).max(1000).optional(), evidenceRefs: z.array(z.string()).max(20), reproductionComplete: z.boolean(), materialUncertainties: z.array(z.string()).max(20), challengedCheck: z.enum(['required_source_citation', 'forbidden_patient_disclosure', 'forbidden_tool_effect']).optional(), challengedClaim: z.string().min(1).max(2000).optional() }).strict();
// Produced by deterministic worker policy, never accepted from a model reply.
export const policyTrace = z.object({ version: z.literal(2), outcome: outcome, passed: z.array(z.string().max(80)).max(30), failed: z.array(z.string().max(80)).max(30), canonicalClaim: z.string().max(2000).optional() }).strict();
const observationStatus = z.enum(['complete', 'partial', 'fallback', 'denied', 'refused', 'failed']);
export const observationV1 = z.object({ v: z.literal(1), turn: z.number().int().positive(), status: observationStatus, response: z.string().max(10000), ref: z.string() }).strict();
// v1 has no completeness or provenance assertion. Keep it readable as recorded.
const sourceEvidence = z.object({ field: z.enum(['source', 'sources', 'citation', 'citations']), kind: z.string().max(120).optional(), locator: z.string().max(500).optional(), support: z.enum(['supported', 'unsupported']), metadata: z.record(z.string(), z.unknown()) }).strict();
export const observationV2 = z.object({
  v: z.literal(2), turn: z.number().int().positive(), status: observationStatus,
  response: z.string().max(10000), ref: z.string(),
  target: z.object({ conversationId: z.string().max(120), turnId: z.string().max(120), requestCorrelationId: z.string().max(120), responseCorrelationId: z.string().max(120).optional() }).strict(),
  attachment: z.object({ sourceId: z.string().max(120) }).strict().optional(),
  summary: z.string(),
  claims: z.array(z.object({ text: z.string(), kind: z.string().max(120).optional(), sources: z.array(sourceEvidence) }).strict()),
  limitations: z.array(z.object({ detail: z.string(), code: z.string().max(120).optional() }).strict()),
  completeness: z.object({ state: z.enum(['complete', 'partial', 'truncated']), reasons: z.array(z.enum(['target_partial', 'visible_text_limit'])), visibleChars: z.number().int().nonnegative(), retainedChars: z.number().int().nonnegative() }).strict()
}).strict();
export const observation = z.discriminatedUnion('v', [observationV1, observationV2]);
export const evidenceEvent = z.object({ v: z.literal(1), agent: z.enum(['worker', 'target', 'check', 'judge']), kind: z.string().max(80), detail: z.record(z.string(), z.unknown()) }).strict();
export const error = z.object({ v: z.literal(1), code: z.enum(['invalid', 'conflict', 'not_found', 'internal']), message: z.string(), active_run_id: z.uuid().optional() });
export type TargetInput = z.infer<typeof targetInput>;
export type TargetUpdateInput = z.infer<typeof targetUpdateInput>;
export type CaseInput = z.infer<typeof caseInput>;
export type CaseDraftInput = z.infer<typeof caseDraftInput>;
export type StartInput = z.infer<typeof startInput>;
export type AdaptiveStart = z.infer<typeof adaptiveStart>;
export type ScheduleInput = z.infer<typeof scheduleInput>;
export type ModelAssignment = z.infer<typeof modelAssignment>;
export type ModelRoles = z.infer<typeof modelRoles>;
export type SelectedRoles = z.infer<typeof selectedRoles>;
export type AdaptiveRoles = z.infer<typeof adaptiveRoles>;
export type RunDefinition = z.infer<typeof runDefinition>;
export type RunDefinitionInput = z.infer<typeof runDefinitionInput>;
export type Verdict = z.infer<typeof verdict>;
export type PolicyTrace = z.infer<typeof policyTrace>;
export type Observation = z.infer<typeof observation>;
export type Outcome = z.infer<typeof outcome>;
export type EvidenceEvent = z.infer<typeof evidenceEvent>;
export type CheckSpec = z.infer<typeof checkSpec>;
export type AttackAction = z.infer<typeof action>;
