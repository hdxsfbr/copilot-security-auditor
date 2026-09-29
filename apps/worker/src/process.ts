import { Annotation, StateGraph, START, END } from '@langchain/langgraph';
import { evidenceEvent, type Observation, type Outcome } from '../../../packages/contracts/src/index.js';
import { Repository } from '../../api/src/repository.js';
import { Session, TargetFailure, TurnFailure, type Identity } from './session.js';
import { judge, packet, classify, scrubEvidence } from './judge.js';

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
  let outcome: Outcome = 'incomplete';
  const heartbeat = setInterval(() => { void repo.heartbeat(run.id, generation).catch(() => clearInterval(heartbeat)); }, 10000);
  try {
    const State = Annotation.Root({ observations: Annotation<Observation[]>({ reducer: (_old, next) => next, default: () => [] }), outcome: Annotation<Outcome>({ reducer: (_old, next) => next, default: () => 'incomplete' }) });
    const graph = new StateGraph(State)
      .addNode('observe', async () => {
        const version = await session.open();
        await emit('worker', 'session_open', { version, user: run.definition.case.user }, version);
        const observations: Observation[] = [];
        for (const [index, action] of run.definition.case.actions.entries()) {
          let turn: Awaited<ReturnType<Session['turn']>>;
          try { turn = await session.turn(action.message, index + 1); }
          catch (e) { if (e instanceof TurnFailure) await emit('target', 'attempts', { attempts: e.attempts }); throw e; }
          const observed = { ...turn.observation, response: scrubEvidence(turn.observation.response, users, session.secrets()) };
          observations.push(observed);
          await emit('target', 'turn', { message: scrubEvidence(action.message, users, session.secrets()), observation: observed, attempts: turn.attempts });
        }
        return { observations };
      })
      .addNode('judge', async (state) => {
        await emit('check', 'deterministic', { result: 'undecidable', scope: 'selected direct-injection observation' });
        if (state.observations.some(o => ['denied', 'failed'].includes(o.status))) return { outcome: 'inconclusive' as const };
        const input = packet(run.definition.case.expectedSafeBehavior, state.observations, users, session.secrets());
        try {
          const { result, usage } = await judge(run.definition.ollamaUrl, run.definition.model, input, modelFetch);
          const classified = classify(result);
          await emit('judge', 'verdict', { verdict: { ...result, claim: scrubEvidence(result.claim, users, session.secrets()), materialUncertainties: result.materialUncertainties.map(s => scrubEvidence(s, users, session.secrets())) }, usage: { provider: 'ollama', model: run.definition.model, ...usage, charge: null } });
          return { outcome: classified };
        } catch {
          await emit('judge', 'unavailable', { reason: 'Judge response unavailable or invalid' });
          return { outcome: 'inconclusive' as const };
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
    await repo.finish(run.id, generation, outcome);
  }
  return { id: run.id, outcome };
}
