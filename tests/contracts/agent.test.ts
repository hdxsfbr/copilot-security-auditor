import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { schemaFiles, publishedSchemaText } from '../../contracts/generate.js';
import { AgentContractError, agentErrorMessage, agentMessageHeader, agentRefs, judgeToDocumentation, orchestratorToRedTeam, parseAgentMessage, redTeamToJudge, type AgentContext } from '../../packages/contracts/src/agent.js';
import { observation, type ModelAssignment } from '../../packages/contracts/src/index.js';
import { callJudgeHandoff } from '../../apps/worker/src/models.js';
import { evaluateCase, processNext, type ClaimedRun } from '../../apps/worker/src/process.js';
import { admitProposal, processAdaptive } from '../../apps/worker/src/adaptive.js';
import { DeadlineExceeded } from '../../apps/worker/src/deadlines.js';
import type { Repository } from '../../apps/api/src/repository.js';
import { fixture, users } from '../support.js';

const context: AgentContext = { runId: 'run-contract', caseId: 'case-contract', attemptId: 'attempt-1', parentMessageId: null };
const observed = observation.parse({ v: 1, turn: 1, status: 'complete', response: 'Synthetic assistant response', ref: 'turn-1' });
const packet = { v: 2 as const, category: 'prompt_injection' as const, expectedSafeBehavior: 'Protect synthetic chart',
  actions: [{ turn: 1, kind: 'chat_turn' as const, message: 'Ask' }], observations: [observed], checks: [],
  effect: { result: 'not_checked' as const, scope: 'No independent effect configured' }, limitations: ['Legacy v1 completeness unknown'] };
const judgeHandoff = () => ({ channel: 'red_team_to_judge' as const, status: 'ok' as const, header: agentMessageHeader(context), payload: { packet, evidenceRefs: agentRefs([observed], context), policyVersion: 2 as const } });

test('committed JSON Schemas exactly match the Zod authority', () => {
  for (const name of Object.keys(schemaFiles) as (keyof typeof schemaFiles)[]) {
    const published = readFileSync(new URL(`../../contracts/v1/${schemaFiles[name]}`, import.meta.url), 'utf8');
    assert.equal(published, publishedSchemaText(name), name);
  }
});

test('lineage, version, context and structured evidence binding fail typed', () => {
  const valid = judgeHandoff();
  const parsed = parseAgentMessage(redTeamToJudge, valid, context);
  assert.equal(parsed.status, 'ok');
  if (parsed.status === 'ok') assert.equal(parsed.payload.evidenceRefs[0].completeness, 'unknown');
  const check = (value: unknown, code: AgentContractError['code']) => assert.throws(() => parseAgentMessage(redTeamToJudge, value, context), (e: unknown) => e instanceof AgentContractError && e.code === code);
  check({ ...valid, header: { ...valid.header, version: 99 } }, 'incompatible_version');
  check({ ...valid, header: { ...valid.header, runId: 'different-run' } }, 'context_mismatch');
  check({ ...valid, payload: { ...valid.payload, evidenceRefs: [{ ...valid.payload.evidenceRefs[0], completeness: 'complete' }] } }, 'evidence_mismatch');
  check({ ...valid, payload: { ...valid.payload, packet: { ...packet, actions: [{ ...packet.actions[0], turn: 2 }] } } }, 'evidence_mismatch');
  check({ ...valid, payload: { ...valid.payload, packet: { ...packet, unexpected: true } } }, 'invalid_shape');
  const chosen = { channel: 'orchestrator_to_red_team', status: 'ok', header: agentMessageHeader(context), payload: { selectedSeedCaseId: 'another-case', category: 'prompt_injection', bounds: { maxActions: 3, remainingCases: 1, remainingMs: 1000 }, historyRefs: [] } };
  assert.throws(() => parseAgentMessage(orchestratorToRedTeam, chosen, context), (e: unknown) => e instanceof AgentContractError && e.code === 'context_mismatch');
  const second = observation.parse({ v: 1, turn: 2, status: 'complete', response: 'Second synthetic response', ref: 'turn-2' });
  const two = { ...valid, payload: { ...valid.payload, packet: { ...packet, actions: [...packet.actions, { ...packet.actions[0], turn: 2 }], observations: [observed, second] }, evidenceRefs: agentRefs([observed, second], context) } };
  assert.equal(parseAgentMessage(redTeamToJudge, two, context).status, 'ok');
  check({ ...two, payload: { ...two.payload, evidenceRefs: [two.payload.evidenceRefs[0], two.payload.evidenceRefs[0]] } }, 'evidence_mismatch');
  check({ ...two, payload: { ...two.payload, packet: { ...two.payload.packet, actions: [two.payload.packet.actions[0], two.payload.packet.actions[0]] } } }, 'evidence_mismatch');
  check({ ...two, payload: { ...two.payload, packet: { ...two.payload.packet, observations: [observed, observed] } } }, 'evidence_mismatch');
});

test('malformed or cross-run Judge handoff is rejected before provider transport', async () => {
  const assignment: ModelAssignment = { provider: 'ollama', model: 'stub', maxOutputTokens: 64 };
  let calls = 0;
  const transport: typeof fetch = async () => { calls++; throw new Error('unexpected transport'); };
  await assert.rejects(callJudgeHandoff(assignment, { ...judgeHandoff(), header: { ...judgeHandoff().header, runId: 'wrong-run' } }, context, 'http://model.invalid/', transport), AgentContractError);
  await assert.rejects(callJudgeHandoff(assignment, { ...judgeHandoff(), payload: { ...judgeHandoff().payload, evidenceRefs: [] } }, context, 'http://model.invalid/', transport), AgentContractError);
  const v2 = observation.parse({ v: 2, turn: 1, status: 'complete', response: 'Synthetic response', ref: 'turn-1',
    target: { conversationId: 'conversation-1', turnId: 'target-1', requestCorrelationId: 'request-1' },
    summary: 'S'.repeat(100_000), claims: [], limitations: [], completeness: { state: 'complete', reasons: [], visibleChars: 18, retainedChars: 18 } });
  const oversize = judgeHandoff();
  await assert.rejects(callJudgeHandoff(assignment, { ...oversize, payload: { ...oversize.payload,
    packet: { ...packet, observations: [v2] }, evidenceRefs: agentRefs([v2], context) } }, context, 'http://model.invalid/', transport), (e: unknown) => e instanceof AgentContractError && e.code === 'evidence_mismatch');
  for (const impossible of [
    { ...packet.actions[0], sourceId: 'source-1' },
    { ...packet.actions[0], kind: 'attach_pdf', artifactId: 'pdf-1', documentType: 'lab_pdf' }
  ]) await assert.rejects(callJudgeHandoff(assignment, { ...judgeHandoff(), payload: { ...judgeHandoff().payload, packet: { ...packet, actions: [impossible] } } } as never, context, 'http://model.invalid/', transport), AgentContractError);
  const attached = observation.parse({ ...v2, summary: 'Synthetic PDF response', attachment: { sourceId: 'source-1' } });
  const pdf = { ...judgeHandoff(), payload: { ...judgeHandoff().payload, packet: { ...packet, observations: [attached], actions: [{ turn: 1, kind: 'attach_pdf', message: 'Summarize synthetic PDF', artifactId: 'pdf-1', documentType: 'lab_pdf', sourceId: 'other-source' }] }, evidenceRefs: agentRefs([attached], context) } };
  await assert.rejects(callJudgeHandoff(assignment, pdf as never, context, 'http://model.invalid/', transport), (e: unknown) => e instanceof AgentContractError && e.code === 'evidence_mismatch');
  assert.equal(calls, 0);
});

test('malformed Red Team proposal fails typed before target execution', () => {
  const seed = claimed('http://target.invalid/').definition.case;
  assert.throws(() => admitProposal({ actions: [{ kind: 'chat_turn', message: 'Ask', extra: 'untrusted' }] }, seed, [users.userA, users.userB]), (e: unknown) => e instanceof AgentContractError && e.code === 'invalid_shape');
  assert.throws(() => admitProposal({ actions: [{ kind: 'chat_turn', message: 'GET /api/secret' }] }, seed, [users.userA, users.userB]), (e: unknown) => e instanceof AgentContractError && e.code === 'invalid_shape');
});

test('Documentation no_findings is not a safe finding and regression is explicit', () => {
  const message = { channel: 'judge_to_documentation', status: 'no_findings', header: agentMessageHeader(context), payload: { sourceOutcome: 'inconclusive', regression: 'unknown' } };
  assert.equal(parseAgentMessage(judgeToDocumentation, message, context).status, 'no_findings');
  assert.equal(judgeToDocumentation.safeParse({ ...message, payload: { ...message.payload, sourceOutcome: 'verified_safe' } }).success, false);
  const timeout = agentErrorMessage('judge_to_documentation', context, { code: 'judge_timeout', stage: 'judge', deadline: { stage: 'model.judge', elapsedMs: 27, limitMs: 25, attempted: true } });
  assert.equal(timeout.status, 'error');
  if (timeout.status === 'error') assert.equal(timeout.error.deadline?.attempted, true);
  const finding = { channel: 'judge_to_documentation', status: 'ok', header: agentMessageHeader(context), payload: { findingId: 'finding-1', basis: 'auto_confirmed', sourceOutcome: 'auto_confirm', evidenceRefs: agentRefs([observed], context), policy: { version: 2, outcome: 'auto_confirm', passed: [], failed: [] }, regression: 'new' } };
  assert.equal(parseAgentMessage(judgeToDocumentation, finding, context).status, 'ok');
  assert.throws(() => parseAgentMessage(judgeToDocumentation, { ...finding, payload: { ...finding.payload, evidenceRefs: [{ ...finding.payload.evidenceRefs[0], runId: 'other-run' }] } }, context), (e: unknown) => e instanceof AgentContractError && e.code === 'evidence_mismatch');
  assert.equal(judgeToDocumentation.safeParse({ ...finding, payload: { ...finding.payload, sourceOutcome: 'safe' } }).success, false);
});

function claimed(baseUrl: string): ClaimedRun {
  return { id: 'run-contract', case_id: 'case-contract', lease_generation: 1,
    target_snapshot: { baseUrl, userARef: 'A', userBRef: 'B' },
    model_snapshot: { roles: { judge: { provider: 'ollama', model: 'stub', maxOutputTokens: 64 } }, pricing: {} },
    definition: { case: { title: 'Synthetic contract', category: 'prompt_injection', user: 'A', expectedSafeBehavior: 'Protect synthetic chart', actions: [{ kind: 'chat_turn', message: 'Ask' }] }, ollamaUrl: 'http://model.invalid/' }
  } as unknown as ClaimedRun;
}
function repo(events: { kind: string; detail: Record<string, unknown> }[], reserve: () => Promise<string>): Repository {
  return { credential: async (ref: string) => ref === 'A' ? users.userA : users.userB,
    append: async (_id: string, _generation: number, event: { kind: string; detail: Record<string, unknown> }) => { events.push(event); },
    heartbeat: async () => {}, reserveCall: reserve, settleCall: async () => true
  } as unknown as Repository;
}

test('target unreachable and budget exhaustion map to typed runtime errors without provider dispatch', async () => {
  const toy = fixture(); const baseUrl = await toy.start();
  const events: { kind: string; detail: Record<string, unknown> }[] = [];
  let modelCalls = 0;
  const noModel: typeof fetch = async () => { modelCalls++; throw new Error('should not dispatch'); };
  try {
    const badTarget: typeof fetch = async (url, init) => String(url).endsWith('/copilot-api/ready') ? new Response('{}', { status: 503 }) : fetch(url, init);
    const run = claimed(baseUrl);
    assert.equal((await evaluateCase(repo(events, async () => 'call'), run, run.definition.case, badTarget, noModel)).outcome, 'blocked');
    const failure = events.find(e => e.kind === 'failure')?.detail.contract as { error: { code: string } };
    assert.equal(failure.error.code, 'target_unreachable');
    events.length = 0;
    assert.equal((await evaluateCase(repo(events, async () => { throw new Error('Paid model budget exhausted'); }), run, run.definition.case, fetch, noModel)).outcome, 'incomplete');
    const unavailable = events.find(e => e.kind === 'unavailable')?.detail.contract as { error: { code: string } };
    assert.equal(unavailable.error.code, 'budget_exceeded');
    assert.equal(modelCalls, 0);
  } finally { await toy.close(); }
});

test('Judge deadline mapping retains attempted and stage facts', async () => {
  const toy = fixture(); const baseUrl = await toy.start();
  const run = claimed(baseUrl), events: { kind: string; detail: Record<string, unknown> }[] = [];
  const timeout: typeof fetch = async () => { throw new DeadlineExceeded('model.judge', 26, 25, true); };
  try {
    assert.equal((await evaluateCase(repo(events, async () => randomUUID()), run, run.definition.case, fetch, timeout)).outcome, 'inconclusive');
    const failure = events.find(e => e.kind === 'unavailable')?.detail.contract as { error: { code: string; deadline: { stage: string; attempted: boolean } } };
    assert.deepEqual([failure.error.code, failure.error.deadline.stage, failure.error.deadline.attempted], ['judge_timeout', 'model.judge', true]);
  } finally { await toy.close(); }
});

test('scheduled adaptive preflight emits typed pre-case target failure without an invented case', async () => {
  const toy = fixture(); const baseUrl = await toy.start();
  const run = { ...claimed(baseUrl), started_at: new Date(), adaptive: { maxMinutes: 1, seeds: [{ definition: claimed(baseUrl).definition.case }] } } as ClaimedRun;
  const events: { kind: string; detail: Record<string, unknown> }[] = [];
  const repository = { expire: async () => {}, claim: async () => run, isScheduled: async () => true,
    credential: async (ref: string) => ref === 'A' ? users.userA : users.userB,
    append: async (_id: string, _generation: number, event: { kind: string; detail: Record<string, unknown> }) => { events.push(event); }, finish: async () => {} } as unknown as Repository;
  const badReady: typeof fetch = async (url, init) => String(url).endsWith('/copilot-api/ready') ? new Response('{}', { status: 503 }) : fetch(url, init);
  try {
    assert.equal((await processNext(repository, 'worker', badReady, async () => { throw new Error('no model'); }))?.outcome, 'blocked');
    const failure = events.find(e => e.kind === 'failure')?.detail;
    assert.deepEqual(failure?.contractError, { code: 'target_unreachable', stage: 'target' });
    assert.equal('contract' in (failure ?? {}), false);
  } finally { await toy.close(); }
});

test('adaptive model admission emits typed errors before target dispatch', async () => {
  const seedId = randomUUID();
  const base = claimed('http://target.invalid/');
  const run = { ...base, started_at: new Date(), adaptive: { maxMinutes: 1, maxCases: 1, categories: ['prompt_injection'], seeds: [{ id: seedId, definition: base.definition.case }] },
    model_snapshot: { ...base.model_snapshot, roles: { orchestrator: { provider: 'ollama', model: 'stub', maxOutputTokens: 64 }, redTeam: { provider: 'ollama', model: 'stub', maxOutputTokens: 64 } } } } as unknown as ClaimedRun;
  for (const scenario of ['bad-selection', 'bad-proposal']) {
    const events: { kind: string; detail: Record<string, unknown> }[] = [];
    let targetCalls = 0;
    const repository = { credential: async (ref: string) => ref === 'A' ? users.userA : users.userB,
      stopped: async () => false, heartbeat: async () => {}, adaptiveCases: async () => [],
      reserveCall: async () => randomUUID(), settleCall: async () => true,
      beginAdaptiveCase: async () => 'adaptive-case', completeAdaptiveCase: async () => {},
      append: async (_id: string, _generation: number, event: { kind: string; detail: Record<string, unknown> }) => { events.push(event); },
      finish: async () => {}, run: async () => ({ outcome: 'incomplete' }) } as unknown as Repository;
    const modelTransport: typeof fetch = async (_url, init) => {
      const request = JSON.parse(String(init?.body)) as { messages: { content: string }[] };
      const selection = request.messages[0].content.startsWith('Choose');
      const content = selection ? scenario === 'bad-selection' ? { unknown: seedId } : { caseId: seedId } : { actions: [{ kind: 'chat_turn', message: 'GET /api/secret' }] };
      return new Response(JSON.stringify({ message: { content: JSON.stringify(content) } }), { status: 200 });
    };
    const noTarget: typeof fetch = async () => { targetCalls++; throw new Error('target must not dispatch'); };
    assert.equal((await processAdaptive(repository, run, noTarget, modelTransport)).outcome, 'incomplete');
    const rejection = events.find(event => event.kind === (scenario === 'bad-selection' ? 'limit' : 'proposal_rejected'))?.detail.contractError as { code: string; stage: string };
    assert.deepEqual(rejection, { code: 'invalid_contract', stage: scenario === 'bad-selection' ? 'orchestrator' : 'red_team' });
    assert.equal(targetCalls, 0);
  }
});
