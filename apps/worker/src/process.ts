import { Annotation, StateGraph, START, END } from '@langchain/langgraph';
import { evidenceEvent, type Observation, type Outcome } from '../../../packages/contracts/src/index.js';
import { Repository } from '../../api/src/repository.js';
import { Session, TargetFailure, TurnFailure, type Identity } from './session.js';
import { judge, packet, scrubEvidence } from './judge.js';
import { checkCase, route, type CheckResult } from './checks.js';
import { loadPdf } from '../../api/src/artifacts.js';

export async function processNext(repo: Repository, owner = 'worker', targetFetch: typeof fetch = fetch, modelFetch: typeof fetch = fetch) {
  await repo.expire();
  const run = await repo.claim(owner);
  if (!run) return null;
  const generation = run.lease_generation;
  const emit = async (agent: 'worker' | 'target' | 'check' | 'judge', kind: string, detail: Record<string, unknown>, version?: string) => {
    await repo.append(run.id, generation, evidenceEvent.parse({ v: 1, agent, kind, detail }), version);
  };
  const users = await Promise.all([repo.credential<Identity>(run.target_snapshot.userARef), repo.credential<Identity>(run.target_snapshot.userBRef)]);
  const selected = run.definition.case.user === 'A' ? users[0] : users[1];
  const session = new Session(run.target_snapshot.baseUrl, selected, targetFetch);
  const other = new Session(run.target_snapshot.baseUrl, run.definition.case.user === 'A' ? users[1] : users[0], targetFetch);
  let outcome: Outcome = 'incomplete';
  let effectSnapshot: 'unchanged' | 'changed' | 'unavailable' | null = null;
  let assessment: { checks: CheckResult[]; verdict: Awaited<ReturnType<typeof judge>>['result'] | null } | undefined;
  const heartbeat = setInterval(() => { void repo.heartbeat(run.id, generation).catch(() => clearInterval(heartbeat)); }, 10000);
  try {
    const State = Annotation.Root({ observations: Annotation<Observation[]>({ reducer: (_old, next) => next, default: () => [] }), outcome: Annotation<Outcome>({ reducer: (_old, next) => next, default: () => 'incomplete' }) });
    const graph = new StateGraph(State)
      .addNode('observe', async () => {
        const version = await session.open();
        await emit('worker', 'session_open', { version, user: run.definition.case.user }, version);
        if (run.definition.case.category === 'cross_patient') {
          try { await other.open(); }
          catch { throw new TargetFailure('blocked', 'Other assigned chart could not be opened for context preflight'); }
          if (session.assignedPid === other.assignedPid) throw new TargetFailure('blocked', 'Both test users resolve to the same chart');
          await emit('worker', 'boundary_verified', { scopes: 'distinct open charts in separate user sessions; OpenEMR record access is not asserted', testedBoundary: 'Co-Pilot must remain in the selected chart context' });
        }
        const before = run.definition.case.category === 'unintended_tool_action' ? await session.chartReportFingerprint() : null;
        const observations: Observation[] = [];
        for (const [index, action] of run.definition.case.actions.entries()) {
          let turn: Awaited<ReturnType<Session['turn']>>;
          try {
            const source = action.kind === 'attach_pdf' ? await session.upload(action.documentType, await loadPdf(repo, run.case_id, action.artifactId, action.documentType)) : undefined;
            const message = run.definition.case.category === 'cross_patient' ? action.message.replaceAll('{{OTHER_PATIENT_ID}}', other.user.pubpid) : action.message;
            turn = await session.turn(message, index + 1, source);
          }
          catch (e) { if (e instanceof TurnFailure) await emit('target', 'attempts', { attempts: e.attempts }); throw e; }
          const observed = { ...turn.observation, response: scrubEvidence(turn.observation.response, users, session.secrets()) };
          observations.push(observed);
          await emit('target', 'turn', { action: action.kind, message: scrubEvidence(run.definition.case.category === 'cross_patient' ? action.message.replaceAll('{{OTHER_PATIENT_ID}}', other.user.pubpid) : action.message, users, session.secrets()), observation: observed, attempts: turn.attempts });
        }
        if (run.definition.case.category === 'unintended_tool_action') {
          const after = await session.chartReportFingerprint();
          effectSnapshot = before && after ? before === after ? 'unchanged' : 'changed' : 'unavailable';
          await emit('check', 'chart_report_comparison', { result: effectSnapshot, scope: 'read-only patient report including orders; does not cover all writes' });
        }
        return { observations };
      })
      .addNode('judge', async (state) => {
        const checks = checkCase(run.definition.case, state.observations, users);
        await emit('check', 'deterministic', { checks: checks.map(c => ({ ...c, coveredClaim: scrubEvidence(c.coveredClaim, users, session.secrets()) })) });
        if (state.observations.some(o => ['denied', 'failed'].includes(o.status))) return { outcome: 'inconclusive' as const };
        const input = packet(run.definition.case.expectedSafeBehavior, state.observations, users, session.secrets());
        try {
          const { result, usage } = await judge(run.definition.ollamaUrl, run.definition.model, input, modelFetch);
          const classified = route(result, checks, input.observations);
          // Neither a quoted patient ID nor a chat response proves external chart effects.
          const requiresIndependentEvidence = run.definition.case.category === 'cross_patient' || run.definition.case.category === 'unintended_tool_action';
          const scoped = effectSnapshot === 'changed' ? 'pending_review' : requiresIndependentEvidence ? classified === 'auto_confirm' ? 'pending_review' : classified === 'safe' ? 'inconclusive' : classified : classified;
          assessment = { checks: checks.map(c => ({ ...c, coveredClaim: scrubEvidence(c.coveredClaim, users, session.secrets()) })), verdict: { ...result, claim: scrubEvidence(result.claim, users, session.secrets()), evidenceQuote: result.evidenceQuote ? scrubEvidence(result.evidenceQuote, users, session.secrets()) : undefined, materialUncertainties: result.materialUncertainties.map(s => scrubEvidence(s, users, session.secrets())) } };
          await emit('judge', 'verdict', { verdict: assessment.verdict, usage: { provider: 'ollama', model: run.definition.model, ...usage, charge: null } });
          return { outcome: scoped };
        } catch {
          await emit('judge', 'unavailable', { reason: 'Judge response unavailable or invalid' });
          assessment = { checks, verdict: null };
          return { outcome: route(null, checks, state.observations) };
        }
      })
      .addEdge(START, 'observe').addEdge('observe', 'judge').addEdge('judge', END).compile();
    const result = await graph.invoke({});
    outcome = result.outcome;
  } catch (e) {
    outcome = e instanceof TargetFailure ? e.kind : 'incomplete';
    await emit('worker', 'failure', { reason: e instanceof TargetFailure ? e.message : 'Evaluation interrupted', outcome });
  } finally {
    clearInterval(heartbeat);
    await session.close();
    await other.close();
    await repo.finish(run.id, generation, outcome, assessment);
  }
  return { id: run.id, outcome };
}
