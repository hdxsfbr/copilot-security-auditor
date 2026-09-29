import { agentMessageHeader, agentRefs, judgeToDocumentation, parseAgentMessage, MAX_AGENT_JUDGE_PACKET_CHARS, type AgentContext } from '../../../packages/contracts/src/agent.js';
import { documentationReport, reportContent } from '../../../packages/contracts/src/report.js';
import { buildFacts, loadEvidence, redactorFor, sequenceFingerprint, sequenceState, validationHistory, type FindingEvidence } from '../../api/src/findings.js';
import { ReportLeaseLost } from '../../api/src/report-jobs.js';
import { commitDraft, narrativeProblem } from '../../api/src/report-revisions.js';
import type { Repository } from '../../api/src/repository.js';
import { DeadlineExceeded } from './deadlines.js';
import { callDocumentation, catalog, nanos, reserveAmount, verifiedPrice, type Price } from './models.js';
import type { ReportJobHandler } from './report-jobs.js';

const failed = (reason: string) => ({ status: 'failed' as const, reason });
// A lease loss aborts the signal; every transport request (catalog and model) carries it.
const fenced = (transport: typeof fetch, signal: AbortSignal): typeof fetch => ((input, init) => transport(input, { ...init, signal: init?.signal ? AbortSignal.any([init.signal, signal]) : signal })) as typeof fetch;
const higher = (latest: string, original: string) => nanos(latest) > nanos(original) ? latest : original;

// The Documentation handler: persisted, validated evidence in; a redacted draft revision out, committed atomically with
// job completion. It cannot create a finding, add evidence or widen the job's model or funds. Any evidence or output
// problem fails the job with a reason and no revision; there is no deterministic substitute for the model's draft.
export function createDocumentationHandler(repo: Repository, modelFetch: typeof fetch = fetch): ReportJobHandler {
  return async ({ job, signal, reserveCall, settleCall }) => {
    const evidence: FindingEvidence | null = await loadEvidence(repo.pool, job.candidateId);
    if (!evidence || evidence.state !== 'confirmed') return failed('not_confirmed');
    if (evidence.missing.length) return failed(`missing_required_evidence:${evidence.missing.join(',')}`);
    const fingerprint = sequenceFingerprint(evidence.definition!);
    const sequence = await sequenceState(repo.pool, evidence, fingerprint);
    if (sequence.duplicateOf) return failed(`duplicate_attack_sequence:${sequence.duplicateOf}`);
    let input: unknown, facts: ReturnType<typeof buildFacts>, redactor: Awaited<ReturnType<typeof redactorFor>>;
    try {
      redactor = await redactorFor(repo, evidence.runId);
      facts = buildFacts(evidence, redactor, { evidenceRevision: job.evidenceRevision, regression: sequence.regression, validationHistory: await validationHistory(repo.pool, evidence.id) });
      // Rebuild the Judge->Documentation envelope from persisted decisions and evidence, then validate it against this attempt.
      const context: AgentContext = { runId: evidence.runId, caseId: evidence.sourceCaseId!, attemptId: `${evidence.runId}-${job.id}` };
      const human = facts.basis === 'human_confirmed';
      const policy = human && facts.policy.outcome !== 'pending_review' ? { ...facts.policy, outcome: 'pending_review' as const, failed: [...facts.policy.failed, 'routed_to_human_review'] } : facts.policy;
      const handoff = parseAgentMessage(judgeToDocumentation, { channel: 'judge_to_documentation', status: 'ok', header: agentMessageHeader(context), payload: { findingId: evidence.id, basis: facts.basis, sourceOutcome: human ? 'pending_review' : 'auto_confirm', evidenceRefs: agentRefs(evidence.observations, context), policy, regression: facts.regression } }, context);
      if (handoff.status !== 'ok') return failed('invalid_documentation_input');
      input = { v: 1, handoff: handoff.payload, allowedCitations: ['case', 'verdict', ...facts.evidence.map(item => item.ref), ...facts.checks.map(item => item.ref)], finding: facts };
      if (JSON.stringify(input).length > MAX_AGENT_JUDGE_PACKET_CHARS) return failed('evidence_bounds_exceeded');
    } catch { return failed('invalid_documentation_input'); }
    if (job.model.provider === 'openrouter' ? !process.env.OPENROUTER_API_KEY || !job.price : !job.ollamaUrl) return failed('model_endpoint_unavailable');
    const transport = fenced(modelFetch, signal);
    let price: Price | undefined, amount = 0n;
    if (job.model.provider === 'openrouter') {
      try {
        const latest = verifiedPrice(await catalog(transport), job.model.model), original = job.price!;
        price = { prompt: higher(latest.prompt, original.prompt), completion: higher(latest.completion, original.completion), request: higher(latest.request, original.request), contextLength: Math.max(latest.contextLength, original.contextLength) };
        amount = reserveAmount(price, job.model.maxOutputTokens);
      } catch { return failed('verified_pricing_unavailable'); }
    }
    let callId: string;
    try { callId = await reserveCall(amount); }
    catch (error) { if (error instanceof ReportLeaseLost) throw error; return failed(error instanceof Error && error.message === 'Report allowance exhausted' ? 'report_allowance_exhausted' : 'reservation_unavailable'); }
    let call: Awaited<ReturnType<typeof callDocumentation>>;
    try { call = await callDocumentation(job.model, input, job.ollamaUrl, transport, price); }
    catch (error) {
      // Only a provably unsent request settles at zero; a sent request with unknown outcome stays held as unresolved.
      if (error instanceof DeadlineExceeded && !error.info.attempted) await settleCall(callId, { latencyMs: 0, chargeNanos: '0' });
      // A reply that arrived but is not JSON (for example truncated by the output bound) stays held like any sent request.
      return failed(signal.aborted ? 'lease_lost' : error instanceof DeadlineExceeded ? 'model_timeout' : error instanceof SyntaxError || error instanceof Error && error.message === 'Model response invalid' ? 'invalid_output:unparseable' : 'model_unavailable');
    }
    if (!(await settleCall(callId, call.usage))) return failed('model_settlement_unresolved');
    // Never trust the model to redact: alias and scrub the reply, then validate the strict schema and every citation and quote.
    const parsed = documentationReport.safeParse(redactor.deep(call.result));
    if (!parsed.success) return failed('invalid_output:schema');
    const problem = narrativeProblem(parsed.data, facts, 'documentation');
    if (problem) return failed(`invalid_output:${problem}`);
    const content = reportContent.parse({ v: 1, facts, narrative: parsed.data });
    if (redactor.leaks(content)) return failed('redaction_failed');
    return { status: 'completed', commit: async db => { await commitDraft(db, { evidence, evidenceRevision: job.evidenceRevision, jobId: job.id, content, fingerprint }); } };
  };
}
