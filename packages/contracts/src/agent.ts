// Inter-role contract envelopes: the typed, Zod-validated messages passed between the
// orchestrator, red team, judge and documentation roles, published as the contracts/v1
// JSON Schema. These schemas are the trust boundary between roles — parseAgentMessage
// enforces them (shape, version, context and cross-field evidence consistency) BEFORE
// any target or provider transport happens.
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { category, observation, policyTrace } from './index.js';

// Shared id primitive: a short slug-safe string reused for run/case/attempt ids.
const stableId = z
  .string()
  .min(1)
  .max(120)
  .regex(/^[A-Za-z0-9_-]+$/);
// A reference to one of a case's at-most-three turns: the string `turn-1|2|3`.
const turnRef = z.string().regex(/^turn-[1-3]$/);
// The common header on every inter-role message: the contract version (always 1), this
// message's id and its parent message id, and the run/case/attempt ids that pin the
// message to one execution. `.strict()` forbids unknown fields.
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
// A pointer to one observed turn used as evidence: the run/attempt it belongs to, the
// turn ref, the observation schema version, its completeness, and (for v2) the target's
// turn id. parseAgentMessage later checks these refs map one-to-one onto real observations.
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
// Describes a stage that hit its time limit: which stage, how long it ran vs. its limit,
// and whether the work was actually attempted before the deadline fired.
export const agentDeadline = z
  .object({
    stage: z.string().min(1).max(80),
    elapsedMs: z.number().int().nonnegative(),
    limitMs: z.number().int().nonnegative(),
    attempted: z.boolean(),
  })
  .strict();
// The closed set of reasons a role can fail a case (unreachable target, exhausted
// budget, judge/provider unavailable, incomplete evidence, invalid contract, stopped).
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
// The error payload carried by an 'error' envelope: a failure code, the stage that
// produced it, and optional deadline detail.
export const agentFailure = z
  .object({
    code: agentFailureCode,
    stage: z.enum(['orchestrator', 'red_team', 'target', 'judge', 'documentation']),
    deadline: agentDeadline.optional(),
  })
  .strict();
const header = agentHeader;
// One policy check the red team ran against the target's reply: which rule, its outcome
// (safe/violation/undecidable), the claim it covered, up to three evidence turn refs, and
// an optional present/absent/unknown signal.
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
// One action the red team performed in a case, discriminated by `kind`: a plain
// `chat_turn` (just a message) or `attach_pdf` (a message plus the uploaded artifact's
// document type and source id). `turn` is 1-3, matching the observation it produced.
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
// The evidence bundle the red team hands the judge (packet v2): the category, the
// expected-safe behavior, the 1-3 actions taken and their observations, the policy
// checks, an effect result (did the chart change?) and any limitations. Overall size is
// bounded separately via MAX_AGENT_JUDGE_PACKET_CHARS at validation time.
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

// Builds the two-variant discriminated union shared by every channel: an 'ok' message
// carrying a channel-specific payload, or an 'error' message carrying an agentFailure.
// Both variants are `.strict()` and share the common header. Each channel below is an
// instance of this with its own payload schema.
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
// A17 `selection`: why the orchestrator chose this seed case — the triggering reason plus
// optional regression/severity/gap detail and the target version in play.
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
// A17 `feedback` entry: a sanitized outcome of an earlier executed case in this run (its
// execution/seed ids, ordinal, outcome/verdict, claim and any failed gates), shown to the
// red team so a mutation can trace back to a verdict it actually saw.
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
// A17 `mutation`: what this proposal derives from — the seed case and, when one exists,
// the earlier execution case it was mutated from.
export const mutationParent = z
  .object({ seedCaseId: stableId, parentExecutionCaseId: z.uuid().nullable() })
  .strict();
// Channel 1 (orchestrator -> red team): assigns the seed case and category, the bounds
// the red team must stay within (max actions, remaining cases, remaining ms), prior
// evidence refs, and the optional A17 selection/feedback/mutation context. The 'ok'
// variant carries this payload; 'error' carries a failure.
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
// Channel 2 (red team -> judge): the completed judge packet, the evidence refs that must
// map one-to-one onto its observations, and the policy version. The 'ok' variant carries
// this payload; 'error' carries a failure.
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
// Whether a finding is new, recurring, fixed, resurfaced, unknown or not applicable
// relative to prior runs.
const regressionStatus = z.enum([
  'new',
  'recurring',
  'fixed',
  'resurfaced',
  'unknown',
  'not_applicable',
]);
// Channel 3 (judge -> documentation), a three-way union by status: 'ok' records a finding
// (auto_confirmed -> sourceOutcome auto_confirm, or human_confirmed -> pending_review)
// with its evidence refs, policy trace and regression status; 'no_findings' reports a
// clean outcome (safe/inconclusive/incomplete/blocked); 'error' carries a failure. Each
// 'ok' basis pins sourceOutcome so parseAgentMessage can cross-check it against the policy.
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

// The three channel schemas exported together as the published contracts/v1 JSON Schema.
export const publishedAgentSchemas = {
  orchestratorToRedTeam,
  redTeamToJudge,
  judgeToDocumentation,
} as const;
// The expected identity a message must match: the run/case/attempt it belongs to and,
// optionally, the parent message id it must reference.
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

// Thrown when a message fails the contract, before any target/provider transport. The
// `code` says which stage failed (bad shape, incompatible version, context mismatch, or
// cross-field evidence mismatch) and `channel` names where.
export class AgentContractError extends Error {
  constructor(
    readonly code:
      'invalid_shape' | 'incompatible_version' | 'context_mismatch' | 'evidence_mismatch',
    readonly channel: string,
  ) {
    super(`Agent contract ${code} at ${channel}`);
  }
}
// Builds a fresh, validated header for a new outgoing message from the given context,
// generating a new messageId and defaulting parentMessageId to null.
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
// Projects a list of observations into the evidence refs that describe them (run/attempt,
// turn ref, version, completeness and the v2 target turn id), so a packet's refs stay in
// lockstep with its observations.
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
// The validation core and trust boundary: turns untrusted input into a typed, verified
// message or throws AgentContractError, ALWAYS before any target/provider transport. Runs
// the checks in order — version, shape, header context, then per-channel cross-field
// evidence consistency — and returns the parsed value only if every check passes.
export function parseAgentMessage<
  S extends z.ZodType<{ header: AgentHeader; status: string; channel: string }>,
>(schema: S, input: unknown, context: AgentContext): z.infer<S> {
  const candidate = input && typeof input === 'object' ? (input as Record<string, unknown>) : null;
  // 1. Reject an incompatible contract version up front (before schema parsing), so a
  //    future version produces a clear error rather than a confusing shape failure.
  if (
    candidate &&
    candidate.header &&
    typeof candidate.header === 'object' &&
    'version' in candidate.header &&
    candidate.header.version !== 1
  )
    throw new AgentContractError('incompatible_version', String(candidate.channel ?? 'unknown'));
  // 2. Structural validation against the channel schema; any mismatch is 'invalid_shape'.
  const parsed = schema.safeParse(input);
  if (!parsed.success)
    throw new AgentContractError('invalid_shape', String(candidate?.channel ?? 'unknown'));
  const value = parsed.data;
  // 3. The header must name the run/case/attempt we expect (and the parent message id
  //    when the caller pinned one); otherwise this message belongs to another execution.
  if (
    value.header.runId !== context.runId ||
    value.header.caseId !== context.caseId ||
    value.header.attemptId !== context.attemptId ||
    (context.parentMessageId !== undefined &&
      value.header.parentMessageId !== context.parentMessageId)
  )
    throw new AgentContractError('context_mismatch', value.channel);
  // 4. orchestrator -> red team cross-field checks: the selected seed must BE this case,
  //    every history ref must share this run/attempt, and a mutation's seed must match the
  //    case. (The parent-traceability + unique-feedback check follows just below.)
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
  // 5. red team -> judge cross-field checks: the packet is size-bounded and its
  //    observations, actions and evidence refs must line up one-to-one by turn — each ref
  //    matches its observation's version/completeness/target id, each action matches its
  //    observation (an attach_pdf must point at a v2 attachment's sourceId; a chat_turn
  //    must have none), and every check's refs must name a real observation.
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
  // 6. judge -> documentation cross-field checks: evidence refs are unique and share this
  //    run/attempt, and the recorded policy outcome must equal the declared sourceOutcome.
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
// Convenience builder for an 'error' envelope on a given channel: assembles the message
// with a fresh header and the supplied failure, then runs it back through
// parseAgentMessage so even error messages are contract-validated before being sent.
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
