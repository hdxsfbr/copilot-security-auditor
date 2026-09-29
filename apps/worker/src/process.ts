import { Annotation, StateGraph, START, END } from '@langchain/langgraph';
import { evidenceEvent, type CaseInput, type Observation, type Outcome } from '../../../packages/contracts/src/index.js';
import { Repository } from '../../api/src/repository.js';
import { Session, TargetFailure, TurnFailure, type Identity } from './session.js';
import { packet, scrubEvidence } from './judge.js';
import { callJudge, catalog, verifiedPrice, reserveAmount, nanos, type Price } from './models.js';
import { checkCase, route, type CheckResult } from './checks.js';
import { loadPdf } from '../../api/src/artifacts.js';
import { processAdaptive } from './adaptive.js';

export async function processNext(repo: Repository, owner = 'worker', targetFetch: typeof fetch = fetch, modelFetch: typeof fetch = fetch) {
  await repo.expire();
  const run = await repo.claim(owner);
  if (!run) return null;
  if (run.adaptive) {
    if (await repo.isScheduled(run.id)) {
      try {
        const refs = new Set(run.adaptive.seeds.map(seed => seed.definition.user));
        for (const user of refs) {
          const identity = await repo.credential<Identity>(user === 'A' ? run.target_snapshot.userARef : run.target_snapshot.userBRef);
          const probe = new Session(run.target_snapshot.baseUrl, identity, targetFetch);
          try { await probe.open(); } finally { await probe.close(); }
        }
      } catch {
        await repo.append(run.id, run.lease_generation, evidenceEvent.parse({ v: 1, agent: 'worker', kind: 'failure', detail: { reason: 'Scheduled target/login/chart preflight unavailable', outcome: 'blocked' } }));
        await repo.finish(run.id, run.lease_generation, 'blocked');
        return { id: run.id, outcome: 'blocked' as const };
      }
    }
    return processAdaptive(repo, run, targetFetch, modelFetch);
  }
  const evaluated = await evaluateCase(repo, run, run.definition.case, targetFetch, modelFetch);
  await repo.finish(run.id, run.lease_generation, evaluated.outcome, evaluated.assessment);
  return { id: run.id, outcome: evaluated.outcome };
}

export type ClaimedRun = NonNullable<Awaited<ReturnType<Repository['claim']>>>;
export async function evaluateCase(repo: Repository, run: ClaimedRun, definition: CaseInput, targetFetch: typeof fetch, modelFetch: typeof fetch, shouldStop: () => Promise<boolean> = async () => false, sourceCaseId = run.case_id!) {
  const generation = run.lease_generation;
  const emit = async (agent: 'worker' | 'target' | 'check' | 'judge', kind: string, detail: Record<string, unknown>, version?: string) => {
    await repo.append(run.id, generation, evidenceEvent.parse({ v: 1, agent, kind, detail }), version);
  };
  const users = await Promise.all([repo.credential<Identity>(run.target_snapshot.userARef), repo.credential<Identity>(run.target_snapshot.userBRef)]);
  const selected = definition.user === 'A' ? users[0] : users[1];
  const session = new Session(run.target_snapshot.baseUrl, selected, targetFetch);
  const other = new Session(run.target_snapshot.baseUrl, definition.user === 'A' ? users[1] : users[0], targetFetch);
  let outcome: Outcome = 'incomplete';
  let executed = false;
  let observedHistory: Observation[] = [];
  let effectSnapshot: 'unchanged' | 'changed' | 'unavailable' | null = null;
  let assessment: { checks: CheckResult[]; verdict: Awaited<ReturnType<typeof callJudge>>['result'] | null } | undefined;
  const heartbeat = setInterval(() => { void repo.heartbeat(run.id, generation).catch(() => clearInterval(heartbeat)); }, 10000);
  try {
    if (await shouldStop()) throw new Error('Run stopped');
    const State = Annotation.Root({ observations: Annotation<Observation[]>({ reducer: (_old, next) => next, default: () => [] }), outcome: Annotation<Outcome>({ reducer: (_old, next) => next, default: () => 'incomplete' }) });
    const graph = new StateGraph(State)
      .addNode('observe', async () => {
        const version = await session.open();
        await emit('worker', 'session_open', { version, user: definition.user }, version);
        if (definition.category === 'cross_patient') {
          try { await other.open(); }
          catch { throw new TargetFailure('blocked', 'Other assigned chart could not be opened for context preflight'); }
          if (session.assignedPid === other.assignedPid) throw new TargetFailure('blocked', 'Both test users resolve to the same chart');
          await emit('worker', 'boundary_verified', { scopes: 'distinct open charts in separate user sessions; OpenEMR record access is not asserted', testedBoundary: 'Co-Pilot must remain in the selected chart context' });
        }
        const before = definition.category === 'unintended_tool_action' ? await session.chartReportFingerprint() : null;
        const observations: Observation[] = [];
        for (const [index, action] of definition.actions.entries()) {
          if (await shouldStop()) throw new Error('Run stopped');
          let turn: Awaited<ReturnType<Session['turn']>>;
          try {
            const source = action.kind === 'attach_pdf' ? await session.upload(action.documentType, await loadPdf(repo, sourceCaseId, action.artifactId, action.documentType)) : undefined;
            if (await shouldStop()) throw new Error('Run stopped');
            const message = definition.category === 'cross_patient' ? action.message.replaceAll('{{OTHER_PATIENT_ID}}', other.user.pubpid) : action.message;
            executed = true;
            turn = await session.turn(message, index + 1, source);
          }
          catch (e) { if (e instanceof TurnFailure) await emit('target', 'attempts', { attempts: e.attempts }); throw e; }
          const observed = { ...turn.observation, response: scrubEvidence(turn.observation.response, users, session.secrets()) };
          observations.push(observed);
          await emit('target', 'turn', { action: action.kind, message: scrubEvidence(definition.category === 'cross_patient' ? action.message.replaceAll('{{OTHER_PATIENT_ID}}', other.user.pubpid) : action.message, users, session.secrets()), observation: observed, attempts: turn.attempts });
        }
        if (definition.category === 'unintended_tool_action') {
          const after = await session.chartReportFingerprint();
          effectSnapshot = before && after ? before === after ? 'unchanged' : 'changed' : 'unavailable';
          await emit('check', 'chart_report_comparison', { result: effectSnapshot, scope: 'read-only patient report including orders; does not cover all writes' });
        }
        return { observations };
      })
      .addNode('judge', async (state) => {
        if (await shouldStop()) return { outcome: 'incomplete' as const };
        const checks = checkCase(definition, state.observations, users);
        await emit('check', 'deterministic', { checks: checks.map(c => ({ ...c, coveredClaim: scrubEvidence(c.coveredClaim, users, session.secrets()) })) });
        if (state.observations.some(o => ['denied', 'failed'].includes(o.status))) return { outcome: 'inconclusive' as const };
        const input = packet(definition.expectedSafeBehavior, state.observations, users, session.secrets());
        const assignment = run.model_snapshot.roles.judge;
        let amount = 0n;
        let dispatchPrice: Price | undefined;
        if (assignment.provider === 'openrouter') {
          try {
            const latest = verifiedPrice(await catalog(modelFetch), assignment.model);
            const original = run.model_snapshot.pricing.judge;
            if (!original) throw new Error('Missing price snapshot');
            dispatchPrice = { prompt: (nanos(latest.prompt) > nanos(original.prompt) ? latest.prompt : original.prompt), completion: (nanos(latest.completion) > nanos(original.completion) ? latest.completion : original.completion), request: (nanos(latest.request) > nanos(original.request) ? latest.request : original.request), contextLength: Math.max(latest.contextLength, original.contextLength) };
            amount = reserveAmount(dispatchPrice, assignment.maxOutputTokens);
          } catch {
            await emit('judge', 'unavailable', { reason: 'Verified paid model pricing unavailable' });
            return { outcome: 'incomplete' as const };
          }
        }
        let callId: string;
        try { callId = await repo.reserveCall(run.id, generation, 'judge', assignment.provider, assignment.model, amount); }
        catch { await emit('judge', 'unavailable', { reason: 'Model budget, pricing, or lease unavailable' }); return { outcome: 'incomplete' as const }; }
        try {
          const { result, usage } = await callJudge(assignment, input, run.definition.ollamaUrl, modelFetch, dispatchPrice);
          const settled = await repo.settleCall(run.id, generation, callId, usage);
          await emit('judge', 'model_usage', { provider: assignment.provider, model: assignment.model, role: 'judge', ...usage, reconciliation: settled ? 'settled' : 'unresolved' });
          if (!settled) return { outcome: 'incomplete' as const };
          if (await shouldStop()) return { outcome: 'incomplete' as const };
          const classified = route(result, checks, input.observations);
          // Neither a quoted patient ID nor a chat response proves external chart effects.
          const requiresIndependentEvidence = definition.category === 'cross_patient' || definition.category === 'unintended_tool_action';
          const scoped = effectSnapshot === 'changed' ? 'pending_review' : requiresIndependentEvidence ? classified === 'auto_confirm' ? 'pending_review' : classified === 'safe' ? 'inconclusive' : classified : classified;
          assessment = { checks: checks.map(c => ({ ...c, coveredClaim: scrubEvidence(c.coveredClaim, users, session.secrets()) })), verdict: { ...result, claim: scrubEvidence(result.claim, users, session.secrets()), evidenceQuote: result.evidenceQuote ? scrubEvidence(result.evidenceQuote, users, session.secrets()) : undefined, materialUncertainties: result.materialUncertainties.map(s => scrubEvidence(s, users, session.secrets())) } };
          await emit('judge', 'verdict', { verdict: assessment.verdict, usage: { provider: assignment.provider, model: assignment.model, ...usage } });
          return { outcome: scoped };
        } catch {
          await repo.settleCall(run.id, generation, callId).catch(() => {});
          await emit('judge', 'unavailable', { reason: 'Judge response unavailable or invalid' });
          assessment = { checks, verdict: null };
          return { outcome: assignment.provider === 'openrouter' ? 'incomplete' as const : route(null, checks, state.observations) };
        }
      })
      .addEdge(START, 'observe').addEdge('observe', 'judge').addEdge('judge', END).compile();
    const result = await graph.invoke({});
    outcome = result.outcome;
    observedHistory = result.observations;
  } catch (e) {
    outcome = await shouldStop() ? 'incomplete' : e instanceof TargetFailure ? e.kind : 'incomplete';
    await emit('worker', 'failure', { reason: e instanceof TargetFailure ? e.message : 'Evaluation interrupted', outcome });
  } finally {
    clearInterval(heartbeat);
    await session.close();
    await other.close();
  }
  return { outcome, assessment: outcome === 'incomplete' ? undefined : assessment, executed, observations: observedHistory };
}
