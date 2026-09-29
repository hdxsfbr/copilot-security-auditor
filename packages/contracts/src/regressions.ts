import { z } from 'zod';

// G01 regression identity and replay lineage, v1.
// An identity groups confirmed findings whose normalized attack sequences are equivalent (see apps/api/src/regression-identity.ts
// for the exact rules); every finding stays listed under it, so grouping never discards evidence. A replay is one run of a
// regression's replay case, linked explicitly to the identity, the source finding and the exact target. Nothing here derives
// "fixed", "recurring" or "resurfaced": that judgement belongs to the G02 suites, which read `signal` and `outcome`.
export const regressionNormalizationVersion = 1;
const attackCategory = z.enum(['prompt_injection', 'cross_patient', 'unintended_tool_action']);
const timestamp = z.iso.datetime({ offset: true });
// 'unrecorded': the replay predates lineage recording, so how it was launched is unknown and is not guessed.
export const replayTrigger = z.enum(['manual', 'suite', 'version_change', 'unrecorded']);
// in_progress: queued or running. no_violation_observed: the run finished 'safe'. violation_observed: a finished run flagged
// the attack as pending_review/auto_confirm. unknown: inconclusive, blocked, incomplete or any outcome that cannot show a
// fix. Only no_violation_observed can ever support a fix, and even that is a single observation.
export const replaySignal = z.enum(['in_progress', 'no_violation_observed', 'violation_observed', 'unknown']);
export const canonicalAttackStep = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('chat_turn'), message: z.string() }).strict(),
  z.object({ kind: z.literal('attach_pdf'), message: z.string(), documentType: z.enum(['lab_pdf', 'intake_form']), artifactId: z.uuid() }).strict()
]);
export const canonicalAttack = z.object({ v: z.literal(regressionNormalizationVersion), category: attackCategory.nullable(), user: z.enum(['A', 'B']), actions: z.array(canonicalAttackStep).min(1).max(3) }).strict();

export const regressionIdentityQuery = z.object({
  limit: z.string().regex(/^[0-9]{1,3}$/).transform(Number).pipe(z.number().int().min(1).max(100)).default(25),
  cursor: z.string().regex(/^[0-9]{1,18}$/).optional(),
  category: attackCategory.optional(),
  targetId: z.uuid().optional() // identities with a source finding or a replay on this target
}).strict();

// One confirmed finding under an identity. `executionCaseId` is the exact adaptive execution the finding came from
// (null for a selected run); `sourceCaseId` is the catalog case (selected) or seed case (adaptive) it started from.
export const regressionSourceFinding = z.object({
  findingId: z.uuid(), regressionId: z.uuid(), state: z.string(), runId: z.uuid(),
  executionCaseId: z.uuid().nullable(), sourceCaseId: z.uuid().nullable(), replayCaseId: z.uuid().nullable(),
  targetId: z.uuid(), targetName: z.string().nullable(), targetVersion: z.string().nullable(), createdAt: timestamp
}).strict();
// `targetVersion` is null until a run observes one (a blocked or stopped replay may never learn it).
export const regressionReplay = z.object({
  id: z.uuid(), runId: z.uuid(), regressionId: z.uuid(), findingId: z.uuid(), replayCaseId: z.uuid(),
  targetId: z.uuid(), targetName: z.string().nullable(), targetVersion: z.string().nullable(),
  status: z.enum(['queued', 'running', 'finished']), outcome: z.string().nullable(), signal: replaySignal, trigger: replayTrigger,
  createdAt: timestamp, finishedAt: timestamp.nullable()
}).strict();
const identityFields = {
  id: z.uuid(), normalizationVersion: z.number().int().positive(), fingerprint: z.string().regex(/^[0-9a-f]{64}$/),
  category: attackCategory.nullable(), user: z.enum(['A', 'B']), title: z.string().nullable(), createdAt: timestamp, firstSeenFindingId: z.uuid(),
  sourceFindingCount: z.number().int().nonnegative(), replayCount: z.number().int().nonnegative(),
  // The newest replay for each distinct target and target version; never pooled across targets or versions.
  latestReplays: z.array(regressionReplay).max(20)
};
export const regressionIdentitySummary = z.object({
  ...identityFields, actionCount: z.number().int().min(1).max(3), attachmentCount: z.number().int().nonnegative(), firstMessage: z.string().max(160),
  sourceFindings: z.array(regressionSourceFinding).max(20)
}).strict();
export const regressionUnlinked = z.object({ regressionId: z.uuid(), findingId: z.uuid(), reason: z.string() }).strict();
export const regressionIdentityList = z.object({
  v: z.literal(1), items: z.array(regressionIdentitySummary), nextCursor: z.string().nullable(),
  // Legacy regressions whose stored definition cannot be normalized stay unlinked, with a reason.
  unlinked: z.object({ count: z.number().int().nonnegative(), items: z.array(regressionUnlinked).max(20) }).strict()
}).strict();
export const regressionIdentityDetail = z.object({
  v: z.literal(1), ...identityFields, canonical: canonicalAttack,
  sourceFindings: z.array(regressionSourceFinding).max(200), replays: z.array(regressionReplay).max(500), replaysTruncated: z.boolean()
}).strict();
export type CanonicalAttack = z.infer<typeof canonicalAttack>;
export type ReplayTrigger = z.infer<typeof replayTrigger>;
export type ReplaySignal = z.infer<typeof replaySignal>;
export type RegressionIdentityQuery = z.infer<typeof regressionIdentityQuery>;
export type RegressionIdentityList = z.infer<typeof regressionIdentityList>;
export type RegressionIdentityDetail = z.infer<typeof regressionIdentityDetail>;
