import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { category, observation, policyTrace } from './index.js';

const stableId = z
  .string()
  .min(1)
  .max(120)
  .regex(/^[A-Za-z0-9_-]+$/);
const turnRef = z.string().regex(/^turn-[1-3]$/);
export const agentHeader = z
  .object({
    version: z.literal(1),
    messageId: z.uuid(),
    parentMessageId: z.uuid().nullable(),
    runId: stableId,
    caseId: stableId,
    attemptId: stableId,
  })
  .strict();
export const agentEvidenceRef = z
  .object({
    runId: stableId,
    attemptId: stableId,
    ref: turnRef,
    observationVersion: z.union([z.literal(1), z.literal(2)]),
    completeness: z.enum(['complete', 'partial', 'truncated', 'unknown']),
    targetTurnId: z.string().min(1).max(120).optional(),
  })
  .strict();
export const agentDeadline = z
  .object({
    stage: z.string().min(1).max(80),
    elapsedMs: z.number().int().nonnegative(),
    limitMs: z.number().int().nonnegative(),
    attempted: z.boolean(),
  })
  .strict();
export const agentFailureCode = z.enum([
  'target_unreachable',
  'target_boundary_unavailable',
  'budget_exceeded',
  'judge_timeout',
  'reservation_unavailable',
  'provider_unavailable',
  'evidence_incomplete',
  'invalid_contract',
  'stopped',
]);
export const agentFailure = z
  .object({
    code: agentFailureCode,
    stage: z.enum(['orchestrator', 'red_team', 'target', 'judge', 'documentation']),
    deadline: agentDeadline.optional(),
  })
  .strict();
const header = agentHeader;
export const checkResult = z
  .object({
    kind: z.enum([
      'forbidden_patient_disclosure',
      'required_source_citation',
      'forbidden_tool_effect',
    ]),
    version: z.literal(1),
    outcome: z.enum(['safe', 'violation', 'undecidable']),
    coveredClaim: z.string().max(2000),
    evidenceRefs: z.array(turnRef).max(3),
    signal: z.enum(['present', 'absent', 'unknown']).optional(),
  })
  .strict();
const executedAction = z.discriminatedUnion('kind', [
  z
    .object({
      turn: z.number().int().min(1).max(3),
      kind: z.literal('chat_turn'),
      message: z.string().min(1).max(1000),
    })
    .strict(),
  z
    .object({
      turn: z.number().int().min(1).max(3),
      kind: z.literal('attach_pdf'),
      message: z.string().min(1).max(1000),
      artifactId: z.string().min(1).max(120),
      documentType: z.enum(['lab_pdf', 'intake_form']),
      sourceId: z.string().min(1).max(120),
    })
    .strict(),
]);
export const agentJudgePacket = z
  .object({
    v: z.literal(2),
    category,
    expectedSafeBehavior: z.string().min(1).max(1000),
    actions: z.array(executedAction).min(1).max(3),
    observations: z.array(observation).min(1).max(3),
    checks: z.array(checkResult).max(6),
    effect: z
      .object({
        result: z.enum(['unchanged', 'changed', 'unavailable', 'not_checked']),
        scope: z.string().min(1).max(500),
      })
      .strict(),
    limitations: z.array(z.string().max(2000)).max(30),
  })
  .strict();
export const MAX_AGENT_JUDGE_PACKET_CHARS = 100_000;

function envelope<S extends string, P extends z.ZodType>(channel: S, payload: P) {
  return z.discriminatedUnion('status', [
    z.object({ channel: z.literal(channel), status: z.literal('ok'), header, payload }).strict(),
    z
      .object({
        channel: z.literal(channel),
        status: z.literal('error'),
        header,
        error: agentFailure,
      })
      .strict(),
  ]);
}
// A17 optional v1 fields. `selection` says why the seed was chosen; `feedback` is the sanitized outcome of earlier cases in this run;
// `mutation` records what this proposal derives from (the seed and, when one exists, the earlier execution it was shown).
export const explorationBasis = z
  .object({
    reason: z.enum([
      'regression_resurfaced',
      'regression_recurring',
      'unresolved_severity',
      'coverage_untested',
      'coverage_inconclusive',
      'coverage_incomplete',
      'coverage_blocked',
      'least_executed',
    ]),
    regression: z.enum(['resurfaced', 'recurring']).optional(),
    severity: z.enum(['critical', 'high', 'medium', 'low', 'unknown']).optional(),
    gap: z.enum(['untested', 'blocked', 'inconclusive', 'incomplete']).optional(),
    targetVersion: z.string().max(200).nullable(),
  })
  .strict();
export const priorVerdict = z
  .object({
    executionCaseId: z.uuid(),
    ordinal: z.number().int().positive(),
    seedCaseId: stableId,
    outcome: z.enum([
      'safe',
      'inconclusive',
      'pending_review',
      'auto_confirm',
      'blocked',
      'incomplete',
      'rejected',
    ]),
    verdict: z.enum(['safe', 'unsafe', 'inconclusive']).optional(),
    claim: z.string().max(500).optional(),
    failedGates: z.array(z.string().max(80)).max(10),
  })
  .strict();
export const mutationParent = z
  .object({ seedCaseId: stableId, parentExecutionCaseId: z.uuid().nullable() })
  .strict();
export const orchestratorToRedTeam = envelope(
  'orchestrator_to_red_team',
  z
    .object({
      selectedSeedCaseId: stableId,
      category,
      bounds: z
        .object({
          maxActions: z.number().int().min(1).max(3),
          remainingCases: z.number().int().min(1).max(9),
          remainingMs: z.number().int().nonnegative().nullable(),
        })
        .strict(),
      historyRefs: z.array(agentEvidenceRef).max(3),
      selection: explorationBasis.optional(),
      feedback: z.array(priorVerdict).max(3).optional(),
      mutation: mutationParent.optional(),
    })
    .strict(),
);
export const redTeamToJudge = envelope(
  'red_team_to_judge',
  z
    .object({
      packet: agentJudgePacket,
      evidenceRefs: z.array(agentEvidenceRef).min(1).max(3),
      policyVersion: z.literal(2),
    })
    .strict(),
);
const regressionStatus = z.enum([
  'new',
  'recurring',
  'fixed',
  'resurfaced',
  'unknown',
  'not_applicable',
]);
export const judgeToDocumentation = z.discriminatedUnion('status', [
  z
    .object({
      channel: z.literal('judge_to_documentation'),
      status: z.literal('ok'),
      header,
      payload: z.discriminatedUnion('basis', [
        z
          .object({
            findingId: stableId,
            basis: z.literal('auto_confirmed'),
            sourceOutcome: z.literal('auto_confirm'),
            evidenceRefs: z.array(agentEvidenceRef).min(1).max(3),
            policy: policyTrace,
            regression: regressionStatus,
          })
          .strict(),
        z
          .object({
            findingId: stableId,
            basis: z.literal('human_confirmed'),
            sourceOutcome: z.literal('pending_review'),
            evidenceRefs: z.array(agentEvidenceRef).min(1).max(3),
            policy: policyTrace,
            regression: regressionStatus,
          })
          .strict(),
      ]),
    })
    .strict(),
  z
    .object({
      channel: z.literal('judge_to_documentation'),
      status: z.literal('no_findings'),
      header,
      payload: z
        .object({
          sourceOutcome: z.enum(['safe', 'inconclusive', 'incomplete', 'blocked']),
          regression: regressionStatus,
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      channel: z.literal('judge_to_documentation'),
      status: z.literal('error'),
      header,
      error: agentFailure,
    })
    .strict(),
]);

export const publishedAgentSchemas = {
  orchestratorToRedTeam,
  redTeamToJudge,
  judgeToDocumentation,
} as const;
export type AgentContext = {
  runId: string;
  caseId: string;
  attemptId: string;
  parentMessageId?: string | null;
};
export type AgentHeader = z.infer<typeof agentHeader>;
export type AgentEvidenceRef = z.infer<typeof agentEvidenceRef>;
export type AgentFailure = z.infer<typeof agentFailure>;
export type AgentFailureCode = z.infer<typeof agentFailureCode>;
export type AgentJudgePacket = z.infer<typeof agentJudgePacket>;
export type OrchestratorToRedTeam = z.infer<typeof orchestratorToRedTeam>;
export type ExplorationBasis = z.infer<typeof explorationBasis>;
export type PriorVerdict = z.infer<typeof priorVerdict>;
export type RedTeamToJudge = z.infer<typeof redTeamToJudge>;
export type JudgeToDocumentation = z.infer<typeof judgeToDocumentation>;

export class AgentContractError extends Error {
  constructor(
    readonly code:
      'invalid_shape' | 'incompatible_version' | 'context_mismatch' | 'evidence_mismatch',
    readonly channel: string,
  ) {
    super(`Agent contract ${code} at ${channel}`);
  }
}
export function agentMessageHeader(context: AgentContext): AgentHeader {
  return agentHeader.parse({
    version: 1,
    messageId: randomUUID(),
    parentMessageId: context.parentMessageId ?? null,
    runId: context.runId,
    caseId: context.caseId,
    attemptId: context.attemptId,
  });
}
export function agentRefs(
  observations: z.infer<typeof observation>[],
  context: AgentContext,
): AgentEvidenceRef[] {
  return observations.map(item =>
    agentEvidenceRef.parse({
      runId: context.runId,
      attemptId: context.attemptId,
      ref: item.ref,
      observationVersion: item.v,
      completeness: item.v === 2 ? item.completeness.state : 'unknown',
      ...(item.v === 2 ? { targetTurnId: item.target.turnId } : {}),
    }),
  );
}
export function parseAgentMessage<
  S extends z.ZodType<{ header: AgentHeader; status: string; channel: string }>,
>(schema: S, input: unknown, context: AgentContext): z.infer<S> {
  const candidate = input && typeof input === 'object' ? (input as Record<string, unknown>) : null;
  if (
    candidate &&
    candidate.header &&
    typeof candidate.header === 'object' &&
    'version' in candidate.header &&
    candidate.header.version !== 1
  )
    throw new AgentContractError('incompatible_version', String(candidate.channel ?? 'unknown'));
  const parsed = schema.safeParse(input);
  if (!parsed.success)
    throw new AgentContractError('invalid_shape', String(candidate?.channel ?? 'unknown'));
  const value = parsed.data;
  if (
    value.header.runId !== context.runId ||
    value.header.caseId !== context.caseId ||
    value.header.attemptId !== context.attemptId ||
    (context.parentMessageId !== undefined &&
      value.header.parentMessageId !== context.parentMessageId)
  )
    throw new AgentContractError('context_mismatch', value.channel);
  if (value.channel === 'orchestrator_to_red_team' && value.status === 'ok') {
    const handoff = value as OrchestratorToRedTeam & { status: 'ok' };
    if (
      handoff.payload.selectedSeedCaseId !== context.caseId ||
      handoff.payload.historyRefs.some(
        ref => ref.runId !== context.runId || ref.attemptId !== context.attemptId,
      )
    )
      throw new AgentContractError('context_mismatch', value.channel);
    const { mutation, feedback } = handoff.payload;
    if (mutation && mutation.seedCaseId !== context.caseId)
      throw new AgentContractError('context_mismatch', value.channel);
    // The parent must be traceable: it has to be one of the prior verdicts the Red Team was actually shown.
    if (
      (mutation?.parentExecutionCaseId &&
        !feedback?.some(item => item.executionCaseId === mutation.parentExecutionCaseId)) ||
      (feedback && new Set(feedback.map(item => item.executionCaseId)).size !== feedback.length)
    )
      throw new AgentContractError('evidence_mismatch', value.channel);
  }
  if (value.channel === 'red_team_to_judge' && value.status === 'ok') {
    const handoff = value as RedTeamToJudge & { status: 'ok' };
    const seen = new Map(handoff.payload.packet.observations.map(item => [item.ref, item]));
    const turns = new Set(handoff.payload.packet.observations.map(item => item.turn));
    const actionTurns = new Set(handoff.payload.packet.actions.map(item => item.turn));
    const referenceKeys = new Set(handoff.payload.evidenceRefs.map(item => item.ref));
    if (
      JSON.stringify(handoff.payload.packet).length > MAX_AGENT_JUDGE_PACKET_CHARS ||
      seen.size !== handoff.payload.packet.observations.length ||
      turns.size !== seen.size ||
      actionTurns.size !== handoff.payload.packet.actions.length ||
      referenceKeys.size !== handoff.payload.evidenceRefs.length ||
      handoff.payload.evidenceRefs.length !== seen.size ||
      handoff.payload.evidenceRefs.some(ref => {
        const item = seen.get(ref.ref);
        return (
          ref.runId !== context.runId ||
          ref.attemptId !== context.attemptId ||
          !item ||
          ref.observationVersion !== item.v ||
          ref.completeness !== (item.v === 2 ? item.completeness.state : 'unknown') ||
          ref.targetTurnId !== (item.v === 2 ? item.target.turnId : undefined)
        );
      }) ||
      handoff.payload.packet.actions.length !== seen.size ||
      handoff.payload.packet.actions.some(action => {
        const item = seen.get(`turn-${action.turn}`);
        return (
          !item ||
          item.turn !== action.turn ||
          (action.kind === 'attach_pdf' &&
            (item.v !== 2 || item.attachment?.sourceId !== action.sourceId)) ||
          (action.kind === 'chat_turn' && item.v === 2 && item.attachment !== undefined)
        );
      }) ||
      handoff.payload.packet.checks.some(check => check.evidenceRefs.some(ref => !seen.has(ref)))
    )
      throw new AgentContractError('evidence_mismatch', value.channel);
  }
  if (value.channel === 'judge_to_documentation' && value.status === 'ok') {
    const handoff = value as JudgeToDocumentation & { status: 'ok' };
    const refs = handoff.payload.evidenceRefs;
    if (
      new Set(refs.map(ref => ref.ref)).size !== refs.length ||
      refs.some(ref => ref.runId !== context.runId || ref.attemptId !== context.attemptId) ||
      handoff.payload.policy.outcome !== handoff.payload.sourceOutcome
    )
      throw new AgentContractError('evidence_mismatch', value.channel);
  }
  return value as z.infer<S>;
}
export function agentErrorMessage(
  channel: 'orchestrator_to_red_team' | 'red_team_to_judge' | 'judge_to_documentation',
  context: AgentContext,
  error: AgentFailure,
): OrchestratorToRedTeam | RedTeamToJudge | JudgeToDocumentation {
  const message = { channel, status: 'error', header: agentMessageHeader(context), error };
  const schema =
    publishedAgentSchemas[
      channel === 'orchestrator_to_red_team'
        ? 'orchestratorToRedTeam'
        : channel === 'red_team_to_judge'
          ? 'redTeamToJudge'
          : 'judgeToDocumentation'
    ];
  return parseAgentMessage(schema, message, context) as
    OrchestratorToRedTeam | RedTeamToJudge | JudgeToDocumentation;
}
