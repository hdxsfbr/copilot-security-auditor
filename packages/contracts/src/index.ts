import { z } from 'zod';

export const identity = z.object({ username: z.string().min(1).max(100), password: z.string().min(1), pubpid: z.string().regex(/^[A-Za-z0-9-]{1,64}$/, 'Use the exact external patient ID without search wildcards') }).strict();
export const targetInput = z.object({ name: z.string().min(1).max(120), baseUrl: z.url().refine(s => ['http:', 'https:'].includes(new URL(s).protocol) && !new URL(s).username && !new URL(s).password && !new URL(s).search && !new URL(s).hash), userA: identity, userB: identity }).strict().refine(t => t.userA.username !== t.userB.username && t.userA.pubpid !== t.userB.pubpid, 'Distinct synthetic user and external patient ID assignments required');
export const action = z.object({ kind: z.literal('chat_turn'), message: z.string().min(1).max(1000) }).strict();
export const caseInput = z.object({ title: z.string().min(1).max(120), expectedSafeBehavior: z.string().min(1).max(1000), user: z.enum(['A', 'B']), actions: z.array(action).min(1).max(3) }).strict();
export const startInput = z.object({ targetId: z.uuid(), caseId: z.uuid(), model: z.string().min(1).max(120), ollamaUrl: z.url().refine(s => ['http:', 'https:'].includes(new URL(s).protocol) && !new URL(s).username && !new URL(s).password && !new URL(s).search && !new URL(s).hash) }).strict();
export const outcome = z.enum(['safe', 'inconclusive', 'pending_review', 'blocked', 'incomplete']);
export const verdict = z.object({ v: z.literal(1), outcome: z.enum(['safe', 'unsafe', 'inconclusive']), claim: z.string().max(2000), evidenceRefs: z.array(z.string()).max(20), reproductionComplete: z.boolean(), materialUncertainties: z.array(z.string()).max(20) }).strict();
export const observation = z.object({ v: z.literal(1), turn: z.number().int().positive(), status: z.enum(['complete', 'partial', 'fallback', 'denied', 'refused', 'failed']), response: z.string().max(10000), ref: z.string() }).strict();
export const evidenceEvent = z.object({ v: z.literal(1), agent: z.enum(['worker', 'target', 'check', 'judge']), kind: z.string().max(80), detail: z.record(z.string(), z.unknown()) }).strict();
export const error = z.object({ v: z.literal(1), code: z.enum(['invalid', 'conflict', 'not_found', 'internal']), message: z.string(), active_run_id: z.uuid().optional() });
export type TargetInput = z.infer<typeof targetInput>;
export type CaseInput = z.infer<typeof caseInput>;
export type StartInput = z.infer<typeof startInput>;
export type Verdict = z.infer<typeof verdict>;
export type Observation = z.infer<typeof observation>;
export type Outcome = z.infer<typeof outcome>;
export type EvidenceEvent = z.infer<typeof evidenceEvent>;
