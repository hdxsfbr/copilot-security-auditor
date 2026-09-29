import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DeadlineExceeded } from '../apps/worker/src/deadlines.js';
import { Session, TargetFailure, TurnFailure } from '../apps/worker/src/session.js';
import { callRoleJson, type Price } from '../apps/worker/src/models.js';
import { evaluateCase, type ClaimedRun } from '../apps/worker/src/process.js';
import type { Repository } from '../apps/api/src/repository.js';
import { fixture, users } from './support.js';

const wait = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
function stalledBody(onCancel: () => void) {
  return new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new TextEncoder().encode('{"partial":')); }, cancel: onCancel });
}
function run(baseUrl: string, ollamaUrl: string, budgetMs = 1000, paid = false): ClaimedRun {
  const price: Price = { prompt: '0.000001', completion: '0.000002', request: '0', contextLength: 1000 };
  return {
    id: 'run-deadline', case_id: 'case-deadline', lease_generation: 1, started_at: new Date(Date.now() - (60_000 - budgetMs)),
    adaptive: { maxMinutes: 1 }, target_snapshot: { baseUrl, userARef: 'A', userBRef: 'B' },
    model_snapshot: { roles: { judge: { provider: paid ? 'openrouter' : 'ollama', model: 'stub', maxOutputTokens: 64 } }, pricing: paid ? { judge: price } : {} },
    definition: { case: { title: 'Synthetic deadline', category: 'prompt_injection', user: 'A', expectedSafeBehavior: 'Stay in the selected chart', actions: [{ kind: 'chat_turn', message: 'Ask' }] }, ollamaUrl }
  } as unknown as ClaimedRun;
}
function repository(events: { agent: string; kind: string; detail: Record<string, unknown> }[], settles: unknown[] = []): Repository {
  return { credential: async (ref: string) => ref === 'A' ? users.userA : users.userB,
    append: async (_id: string, _generation: number, event: { agent: string; kind: string; detail: Record<string, unknown> }) => { events.push(event); },
    heartbeat: async () => {}, reserveCall: async () => 'call-1', settleCall: async (_run: string, _generation: number, _call: string, usage?: unknown) => { settles.push(usage); return !!usage; }
  } as unknown as Repository;
}

test('fixture turn taking more than 15 seconds completes inside the documented 90-second turn envelope', async () => {
  const toy = fixture({ response: 'Slow synthetic answer' }); const url = await toy.start();
  const transport: typeof fetch = async (input, init) => {
    const response = await fetch(input, init);
    if (String(input).includes('/turns')) await wait(15_100);
    return response;
  };
  const session = new Session(url, users.userA, transport);
  try {
    await session.open();
    const started = Date.now();
    const result = await session.turn('Ask', 1);
    assert.ok(Date.now() - started >= 15_000);
    assert.equal(result.observation.response, 'Slow synthetic answer');
    assert.deepEqual(result.attempts.map(attempt => attempt.outcome), ['observed']);
    assert.equal(toy.requests.filter(request => request.path.includes('/turns')).length, 1);
  } finally { await session.close(); await toy.close(); }
});

test('turn budget expiry is incomplete, records stage and elapsed time, and never redispatches', async () => {
  const toy = fixture(); const url = await toy.start();
  let turnCalls = 0;
  const targetFetch: typeof fetch = async (input, init) => {
    const response = await fetch(input, init);
    if (String(input).includes('/turns')) { turnCalls++; await wait(1200); }
    return response;
  };
  const events: { agent: string; kind: string; detail: Record<string, unknown> }[] = [];
  const claimed = run(url, 'http://model.invalid/', 900);
  try {
    const result = await evaluateCase(repository(events), claimed, claimed.definition.case, targetFetch, async () => { throw new Error('Judge must not dispatch'); });
    assert.equal(result.outcome, 'incomplete');
    assert.equal(turnCalls, 1);
    const timeout = events.find(event => event.kind === 'timeout')?.detail;
    assert.equal(timeout?.stage, 'target.turn');
    assert.ok(typeof timeout.elapsedMs === 'number' && timeout.elapsedMs > 0);
    const attempts = events.find(event => event.kind === 'attempts')?.detail.attempts as { outcome: string }[];
    assert.deepEqual(attempts.map(attempt => attempt.outcome), ['ambiguous']);
  } finally { await toy.close(); }
});

test('only explicit not-applied response retries; stalled successful turn body is ambiguous and canceled', async () => {
  const retryToy = fixture({ mode: 'retry' }); const retryUrl = await retryToy.start();
  const retry = new Session(retryUrl, users.userA, fetch, { limits: { turn: 1000 } });
  try {
    await retry.open();
    assert.deepEqual((await retry.turn('Ask', 1)).attempts.map(attempt => attempt.outcome), ['unprocessed', 'observed']);
    assert.equal(retryToy.requests.filter(request => request.path.includes('/turns')).length, 2);
  } finally { await retry.close(); await retryToy.close(); }

  const toy = fixture(); const url = await toy.start();
  let canceled = false, turns = 0;
  const transport: typeof fetch = async (input, init) => String(input).includes('/turns')
    ? (turns++, new Response(stalledBody(() => { canceled = true; }), { status: 200 })) : fetch(input, init);
  const session = new Session(url, users.userA, transport, { limits: { turn: 40 } });
  try {
    await session.open();
    await assert.rejects(session.turn('Ask', 1), (error: unknown) => error instanceof TurnFailure && error.timeout?.stage === 'target.turn' && error.attempts.length === 1 && error.attempts[0].outcome === 'ambiguous');
    assert.equal(turns, 1);
    assert.equal(canceled, true);
  } finally { await session.close(); await toy.close(); }

  const lateToy = fixture(); const lateUrl = await lateToy.start();
  let lateCanceled = false;
  const ignoresAbort: typeof fetch = async (input, init) => {
    if (String(input).includes('/turns')) { await wait(80); return new Response(stalledBody(() => { lateCanceled = true; }), { status: 200 }); }
    return fetch(input, init);
  };
  const late = new Session(lateUrl, users.userA, ignoresAbort, { limits: { turn: 30 } });
  try {
    await late.open();
    await assert.rejects(late.turn('Ask', 1), (error: unknown) => error instanceof TurnFailure && error.attempts.length === 1);
    await wait(80);
    assert.equal(lateCanceled, true);
  } finally { await late.close(); await lateToy.close(); }
});

test('headers-only and error responses discard stalled bodies; invalid deadline overrides fail closed', async () => {
  const toy = fixture(); const url = await toy.start();
  let readyCanceled = false, errorCanceled = false;
  const transport: typeof fetch = async (input, init) => {
    if (String(input).endsWith('/copilot-api/ready')) return new Response(stalledBody(() => { readyCanceled = true; }), { status: 200 });
    if (String(input).includes('/turns')) return new Response(stalledBody(() => { errorCanceled = true; }), { status: 503 });
    return fetch(input, init);
  };
  assert.throws(() => new Session(url, users.userA, fetch, { limits: { turn: 0 } }), /Invalid operation deadline/);
  assert.throws(() => new Session(url, users.userA, fetch, { limits: { turn: 90_001 } }), /Invalid operation deadline/);
  assert.throws(() => new Session(url, users.userA, fetch, { runUntil: -1 }), /Invalid run deadline/);
  const session = new Session(url, users.userA, transport, { limits: { turn: 100 } });
  try {
    await session.open();
    assert.equal(readyCanceled, true);
    await assert.rejects(session.turn('Ask', 1), (error: unknown) => error instanceof TurnFailure && error.attempts.length === 1);
    assert.equal(errorCanceled, true);
  } finally { await session.close(); await toy.close(); }
});

test('expired run budget prevents target dispatch and upload timeout names its stage', async () => {
  const toy = fixture(); const url = await toy.start();
  let calls = 0;
  const counted: typeof fetch = async (input, init) => { calls++; return fetch(input, init); };
  const expired = new Session(url, users.userA, counted, { runUntil: Date.now() - 1 });
  await assert.rejects(expired.open(), (error: unknown) => error instanceof TargetFailure && error.timeout?.stage === 'target.ready' && !error.timeout.attempted);
  assert.equal(calls, 0);

  const slowUpload: typeof fetch = async (input, init) => {
    const response = await fetch(input, init);
    if (String(input).includes('document_upload.php')) await wait(100);
    return response;
  };
  const session = new Session(url, users.userA, slowUpload, { limits: { upload: 40 } });
  try {
    await session.open();
    await assert.rejects(session.upload('lab_pdf', Buffer.from('%PDF-synthetic')), (error: unknown) => error instanceof TargetFailure && error.timeout?.stage === 'target.upload' && error.timeout.elapsedMs > 0);
  } finally { await session.close(); await toy.close(); }
});

test('role deadline covers stalled response body; pre-dispatch exhausted budget invokes no provider', async () => {
  let canceled = false, calls = 0;
  const assignment = { provider: 'ollama' as const, model: 'stub', maxOutputTokens: 64 };
  const transport: typeof fetch = async () => { calls++; return new Response(stalledBody(() => { canceled = true; }), { status: 200 }); };
  await assert.rejects(callRoleJson(assignment, [{ role: 'user', content: 'Synthetic' }], 'http://model.test/', transport, undefined, { callMs: 40, role: 'redTeam' }),
    (error: unknown) => error instanceof DeadlineExceeded && error.info.stage === 'model.redTeam' && error.info.attempted);
  assert.equal(calls, 1); assert.equal(canceled, true);
  await assert.rejects(callRoleJson(assignment, [], 'http://model.test/', transport, undefined, { runUntil: Date.now() - 1 }),
    (error: unknown) => error instanceof DeadlineExceeded && !error.info.attempted);
  assert.equal(calls, 1);
  await assert.rejects(callRoleJson(assignment, [], 'http://model.test/', transport, undefined, { callMs: -1 }), /Invalid operation deadline/);
  let lateCanceled = false;
  const ignoresAbort: typeof fetch = async () => {
    await wait(80);
    return new Response(stalledBody(() => { lateCanceled = true; }), { status: 200 });
  };
  await assert.rejects(callRoleJson(assignment, [], 'http://model.test/', ignoresAbort, undefined, { callMs: 30 }),
    (error: unknown) => error instanceof DeadlineExceeded && error.info.attempted);
  await wait(80);
  assert.equal(lateCanceled, true);
});

test('paid Judge timeout after dispatch leaves unknown charge unresolved and emits stage metadata', async () => {
  const toy = fixture({ response: 'Synthetic assistant response about selected chart' }); const url = await toy.start();
  const previousKey = process.env.OPENROUTER_API_KEY, previousBase = process.env.OPENROUTER_BASE_URL;
  process.env.OPENROUTER_API_KEY = 'fixture-only-key'; process.env.OPENROUTER_BASE_URL = 'http://provider.test/v1/';
  const events: { agent: string; kind: string; detail: Record<string, unknown> }[] = [], settles: unknown[] = [];
  let dispatches = 0, canceled = false;
  const modelFetch: typeof fetch = async input => {
    if (String(input).endsWith('/models')) return new Response(JSON.stringify({ data: [{ id: 'stub', context_length: 1000, pricing: { prompt: '0.000001', completion: '0.000002', request: '0' } }] }));
    dispatches++;
    return new Response(stalledBody(() => { canceled = true; }), { status: 200 });
  };
  const claimed = run(url, 'http://local.invalid/', 900, true);
  try {
    const result = await evaluateCase(repository(events, settles), claimed, claimed.definition.case, fetch, modelFetch);
    assert.equal(result.outcome, 'incomplete');
    assert.equal(dispatches, 1);
    assert.deepEqual(settles, [undefined]);
    assert.equal(canceled, true);
    const timeout = events.find(event => event.kind === 'timeout')?.detail;
    assert.equal(timeout?.stage, 'model.judge');
    assert.ok(typeof timeout.elapsedMs === 'number' && timeout.elapsedMs > 0);
    assert.equal(events.some(event => event.kind === 'verdict'), false);
  } finally {
    if (previousKey === undefined) delete process.env.OPENROUTER_API_KEY; else process.env.OPENROUTER_API_KEY = previousKey;
    if (previousBase === undefined) delete process.env.OPENROUTER_BASE_URL; else process.env.OPENROUTER_BASE_URL = previousBase;
    await toy.close();
  }
});

test('paid reservation is settled at zero when run budget expires before provider dispatch', async () => {
  const toy = fixture({ response: 'Synthetic assistant response about selected chart' }); const url = await toy.start();
  const previousKey = process.env.OPENROUTER_API_KEY, previousBase = process.env.OPENROUTER_BASE_URL;
  process.env.OPENROUTER_API_KEY = 'fixture-only-key'; process.env.OPENROUTER_BASE_URL = 'http://provider.test/v1/';
  const events: { agent: string; kind: string; detail: Record<string, unknown> }[] = [], settles: unknown[] = [];
  let dispatches = 0;
  const modelFetch: typeof fetch = async input => {
    if (String(input).endsWith('/models')) return new Response(JSON.stringify({ data: [{ id: 'stub', context_length: 1000, pricing: { prompt: '0.000001', completion: '0.000002', request: '0' } }] }));
    dispatches++;
    throw new Error('Expired budget must prevent paid dispatch');
  };
  const claimed = run(url, 'http://local.invalid/', 800, true);
  const repo = repository(events, settles);
  repo.reserveCall = async () => { await wait(850); return '123e4567-e89b-42d3-a456-426614174000'; };
  try {
    const result = await evaluateCase(repo, claimed, claimed.definition.case, fetch, modelFetch);
    assert.equal(result.outcome, 'incomplete');
    assert.equal(dispatches, 0);
    assert.deepEqual(settles, [{ latencyMs: 0, chargeNanos: '0' }]);
    const timeout = events.find(event => event.kind === 'timeout')?.detail;
    assert.equal(timeout?.stage, 'model.judge');
    assert.equal(timeout?.attempted, false);
  } finally {
    if (previousKey === undefined) delete process.env.OPENROUTER_API_KEY; else process.env.OPENROUTER_API_KEY = previousKey;
    if (previousBase === undefined) delete process.env.OPENROUTER_BASE_URL; else process.env.OPENROUTER_BASE_URL = previousBase;
    await toy.close();
  }
});
