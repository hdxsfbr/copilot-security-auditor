import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evidenceCollectRequest, evidenceConfig, evidenceResponse, MAX_EVIDENCE_BYTES } from '../packages/contracts/src/evidence-provider.js';
import { createEvidenceProvider, createFixtureEvidenceProvider } from '../apps/worker/src/evidence/provider.js';
type CollectResult = Awaited<ReturnType<NonNullable<ReturnType<typeof createEvidenceProvider>>['collect']>>;

const targetId = '123e4567-e89b-42d3-a456-426614174000';
const runId = '123e4567-e89b-42d3-a456-426614174001';
const caseId = '123e4567-e89b-42d3-a456-426614174002';
const fixedNow = Date.parse('2026-09-29T12:00:07.000Z');
const profile = (overrides: Record<string, unknown> = {}) => ({
  id: 'ehr-fixture', targetId, targetVersion: 'target-v4', origin: 'http://127.0.0.1:43117', path: '/api/evidence',
  sourceVersion: 'source-v2', capabilities: ['seeded_facts', 'audit_events'], maxAgeMs: 60_000, maxSkewMs: 2_000,
  deadlineMs: 1000, authRef: 'evidence-http-token', ...overrides
});
const config = (overrides: Record<string, unknown> = {}) => evidenceConfig.parse({ mode: 'http', profile: profile(overrides) });
const request = (overrides: Record<string, unknown> = {}) => evidenceCollectRequest.parse({
  v: 1, profileId: 'ehr-fixture', sourceVersion: 'source-v2', targetId, targetVersion: 'target-v4', runId, leaseGeneration: 3,
  attemptId: 'attempt-1', caseId, executionCaseId: '123e4567-e89b-42d3-a456-426614174003', turnOrdinal: 1,
  selectedUser: 'A', selectedChartId: 42, comparisonChartId: 43, conversationId: 'conversation-1', turnId: 'turn-1',
  requestCorrelationId: 'request-1', responseCorrelationId: 'response-1', sentAt: '2026-09-29T12:00:05.000Z',
  receivedAt: '2026-09-29T12:00:06.000Z', window: { start: '2026-09-29T12:00:00.000Z', end: '2026-09-29T12:00:30.000Z' }, ...overrides
});
const response = (req = request(), overrides: Record<string, unknown> = {}) => evidenceResponse.parse({
  v: 1, profileId: 'ehr-fixture', sourceVersion: 'source-v2', collectedAt: '2026-09-29T12:00:07.000Z',
  binding: { targetId, targetVersion: 'target-v4', selectedChartId: 42, comparisonChartId: 43,
    conversationId: 'conversation-1', turnId: 'turn-1', requestCorrelationId: 'request-1', responseCorrelationId: 'response-1' },
  facts: [{ factId: 'fact-1', chartId: 42, sourceRecordRef: 'record-1', value: 'Synthetic fact only' }],
  auditEvents: [{ eventId: 'event-1', actorClass: 'assistant', operationClass: 'read', chartId: 42,
    occurredAt: '2026-09-29T12:00:06.000Z', conversationId: 'conversation-1', turnId: 'turn-1', requestCorrelationId: 'request-1' }],
  coverage: [{ operationClasses: ['read'], state: 'complete', attestedComplete: true,
    window: { start: req.window.start, end: req.window.end }, continuity: 'seq-1' }], ...overrides
});
const collect = (provider: NonNullable<ReturnType<typeof createEvidenceProvider>>, req = request(), options: { signal?: AbortSignal; runUntil?: number } = {}) =>
  provider.collect(req, { signal: options.signal ?? new AbortController().signal, runUntil: options.runUntil });
function expectUnavailable(result: CollectResult, reason: string) {
  assert.equal(result.status, 'unavailable');
  if (result.status === 'unavailable') assert.equal(result.reason, reason);
}

test('strict contract accepts only fixed profiles, bounded requests and unique evidence IDs', () => {
  assert.deepEqual(evidenceConfig.parse({ mode: 'off' }), { mode: 'off' });
  assert.throws(() => evidenceConfig.parse({ mode: 'off', profile: {} }));
  assert.throws(() => evidenceConfig.parse({ mode: 'http', profile: { ...profile(), extra: true } }));
  const badOrigin = { mode: 'http', profile: profile({ origin: 'not-a-url-secret-sentinel' }) };
  let parsedBadOrigin: ReturnType<typeof evidenceConfig.safeParse> | undefined;
  assert.doesNotThrow(() => { parsedBadOrigin = evidenceConfig.safeParse(badOrigin); });
  assert.equal(parsedBadOrigin?.success, false);
  assert.throws(() => evidenceConfig.parse(badOrigin));
  assert.throws(() => evidenceConfig.parse({ mode: 'http', profile: profile({ path: '/api/evidence?url=https://elsewhere.invalid' }) }));
  assert.throws(() => evidenceConfig.parse({ mode: 'http', profile: profile({ origin: 'https://user:pass@example.invalid' }) }));
  assert.throws(() => evidenceConfig.parse({ mode: 'http', profile: profile({ capabilities: ['audit_events', 'audit_events'] }) }));
  assert.throws(() => evidenceCollectRequest.parse({ ...request(), arbitraryUrl: 'https://elsewhere.invalid' }));
  const valid = response();
  assert.equal(valid.facts[0].value, 'Synthetic fact only');
  assert.throws(() => evidenceResponse.parse({ ...valid, extra: true }));
  assert.throws(() => evidenceResponse.parse({ ...valid, facts: [valid.facts[0], valid.facts[0]] }));
  assert.throws(() => evidenceResponse.parse({ ...valid, auditEvents: [valid.auditEvents[0], valid.auditEvents[0]] }));
});

test('off and invalid request/configuration cannot issue HTTP; fixture provider is deterministic', async () => {
  let calls = 0;
  const fetcher = (async () => { calls++; throw new Error('must not fetch'); }) as typeof fetch;
  assert.equal(createEvidenceProvider(undefined, { fetch: fetcher }), null);
  assert.equal(createEvidenceProvider({ mode: 'off' }, { fetch: fetcher }), null);
  assert.throws(() => createEvidenceProvider({ mode: 'http', profile: { ...profile(), unexpected: true } } as any, { fetch: fetcher }));
  let originError: unknown;
  try { createEvidenceProvider({ mode: 'http', profile: profile({ origin: 'not-a-url-secret-sentinel' }) } as any, { fetch: fetcher }); }
  catch (error) { originError = error; }
  assert.ok(originError);
  assert.doesNotMatch(JSON.stringify(originError), /secret-sentinel/);
  const http = createEvidenceProvider(config(), { fetch: fetcher, resolveSecret: () => 'synthetic-secret', now: () => fixedNow });
  assert.ok(http);
  const invalid = await collect(http, { ...request(), targetVersion: 'wrong-version' } as any);
  expectUnavailable(invalid, 'config_mismatch');
  const unknownVersion = await collect(http, { ...request(), targetVersion: 'unknown' } as any);
  expectUnavailable(unknownVersion, 'invalid_request');
  const sameChart = await collect(http, { ...request(), comparisonChartId: 42 } as any);
  expectUnavailable(sameChart, 'invalid_request');
  const throwingResolver = createEvidenceProvider(config(), { fetch: fetcher, resolveSecret: () => { throw new Error('secret-sentinel-do-not-leak'); }, now: () => fixedNow });
  assert.ok(throwingResolver);
  const secretFailure = await collect(throwingResolver);
  expectUnavailable(secretFailure, 'auth_unavailable');
  assert.doesNotMatch(JSON.stringify(secretFailure), /secret-sentinel-do-not-leak/);
  const fixture = createFixtureEvidenceProvider(new Map([['request-1', response()]]));
  assert.deepEqual(await fixture.collect(request(), { signal: new AbortController().signal }), { v: 1, status: 'available', evidence: response() });
  assert.equal(calls, 0);
});

test('HTTP provider sends only the fixed GET and dedicated authorization; missing/reflected secret fails closed', async () => {
  const req = request();
  const token = 'synthetic-evidence-token';
  let captured: { url: string; method?: string; body?: BodyInit | null; redirect?: RequestRedirect; headers: Headers } | undefined;
  let calls = 0;
  const fetcher = (async (url: string | URL | Request, init?: RequestInit) => {
    calls++;
    captured = { url: String(url), method: init?.method, body: init?.body, redirect: init?.redirect, headers: new Headers(init?.headers) };
    return new Response(JSON.stringify(response(req)), { status: 200, headers: { 'Content-Type': 'application/json; charset=utf-8' } });
  }) as typeof fetch;
  const provider = createEvidenceProvider(config(), { fetch: fetcher, resolveSecret: ref => ref === 'evidence-http-token' ? token : undefined, now: () => fixedNow });
  assert.ok(provider);
  const accepted = await collect(provider, req);
  assert.equal(accepted.status, 'available', JSON.stringify(accepted));
  assert.equal(captured?.url, 'http://127.0.0.1:43117/api/evidence');
  assert.equal(captured?.method, 'GET');
  assert.equal(captured?.body, undefined);
  assert.equal(captured?.redirect, 'manual');
  assert.equal(captured?.headers.get('authorization'), `Bearer ${token}`);
  assert.equal(new URL(captured!.url).search, '');
  const wireRequest = captured?.headers.get('x-auditor-evidence-request-v1');
  assert.ok(wireRequest && /^[A-Za-z0-9_-]+$/.test(wireRequest));
  assert.deepEqual(JSON.parse(Buffer.from(wireRequest, 'base64url').toString('utf8')), req);
  const headerNames: string[] = [];
  captured!.headers.forEach((_value, name) => headerNames.push(name));
  assert.deepEqual(headerNames.sort(), ['accept', 'authorization', 'x-auditor-evidence-request-v1']);

  const noSecret = createEvidenceProvider(config(), { fetch: fetcher, resolveSecret: () => undefined, now: () => fixedNow });
  assert.ok(noSecret);
  const denied = await collect(noSecret, req);
  expectUnavailable(denied, 'auth_unavailable');
  assert.equal(calls, 1);

  const reflectionFetch = (async () => new Response(JSON.stringify(response(req, { facts: [{ factId: 'fact-1', chartId: 42, sourceRecordRef: 'rec', value: token }] })),
    { status: 200, headers: { 'Content-Type': 'application/json' } })) as typeof fetch;
  const reflection = createEvidenceProvider(config(), { fetch: reflectionFetch, resolveSecret: () => token, now: () => fixedNow });
  assert.ok(reflection);
  const rejected = await collect(reflection, req);
  expectUnavailable(rejected, 'secret_reflection');
  assert.doesNotMatch(JSON.stringify(rejected), new RegExp(token));
  const eventReflection = createEvidenceProvider(config(), {
    fetch: (async () => new Response(JSON.stringify(response(req, { auditEvents: [{ ...response(req).auditEvents[0], eventId: token }] })),
      { status: 200, headers: { 'Content-Type': 'application/json' } })) as typeof fetch,
    resolveSecret: () => token, now: () => fixedNow
  });
  assert.ok(eventReflection);
  expectUnavailable(await collect(eventReflection, req), 'secret_reflection');
});

test('response binding, version, freshness, media, redirects, malformed and oversized bodies are unavailable', async () => {
  const req = request();
  const run = async (body: unknown, init: ResponseInit = {}, headers: Record<string, string> = { 'Content-Type': 'application/json' }) => {
    const fetcher = (async () => new Response(typeof body === 'string' ? body : JSON.stringify(body), { ...init, headers })) as typeof fetch;
    const provider = createEvidenceProvider(config(), { fetch: fetcher, resolveSecret: () => 'synthetic-evidence-token', now: () => fixedNow });
    assert.ok(provider);
    return collect(provider, req);
  };
  expectUnavailable(await run(response(req, { binding: { ...response().binding, turnId: 'wrong-turn' } })), 'binding_mismatch');
  expectUnavailable(await run(response(req, { sourceVersion: 'old-source' })), 'binding_mismatch');
  expectUnavailable(await run(response(req, { collectedAt: '2026-09-29T11:00:00.000Z' })), 'stale');
  expectUnavailable(await run('{}', { status: 302 }, { Location: 'https://outside.invalid/', 'Content-Type': 'application/json' }), 'redirect');
  expectUnavailable(await run(response(), {}, { 'Content-Type': 'text/html' }), 'bad_media_type');
  expectUnavailable(await run('{not-json'), 'malformed');
  const tooLarge = JSON.stringify({ payload: 'x'.repeat(MAX_EVIDENCE_BYTES + 20) });
  expectUnavailable(await run(tooLarge), 'oversize');
  const undeclared = createEvidenceProvider(config({ capabilities: ['seeded_facts'] }), {
    fetch: (async () => new Response(JSON.stringify(response(req)), { status: 200, headers: { 'Content-Type': 'application/json' } })) as typeof fetch,
    resolveSecret: () => 'synthetic-evidence-token', now: () => fixedNow
  });
  assert.ok(undeclared);
  expectUnavailable(await collect(undeclared, req), 'binding_mismatch');
});

test('pre-abort and deadline abort transport, and bounded body reads cancel excess streams', async () => {
  let calls = 0, sawAbort = false;
  const fetcher = (async (_url: string | URL | Request, init?: RequestInit) => {
    calls++;
    if (!init?.signal) throw new Error('missing composed deadline signal');
    return new Promise<Response>((_resolve, reject) => init.signal!.addEventListener('abort', () => { sawAbort = true; reject(new DOMException('aborted', 'AbortError')); }, { once: true }));
  }) as typeof fetch;
  const slow = createEvidenceProvider(config({ deadlineMs: 30 }), { fetch: fetcher, resolveSecret: () => 'synthetic-evidence-token', now: () => fixedNow });
  assert.ok(slow);
  const alreadyAborted = new AbortController(); alreadyAborted.abort();
  const pre = await collect(slow, request(), { signal: alreadyAborted.signal });
  assert.equal(pre.status, 'unavailable');
  assert.equal(calls, 0);
  const timedOut = await collect(slow, request());
  expectUnavailable(timedOut, 'timeout');
  assert.equal(sawAbort, true);
  assert.equal(calls, 1);

  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(new TextEncoder().encode('x'.repeat(MAX_EVIDENCE_BYTES + 1))); },
    cancel() { cancelled = true; }
  });
  const oversizeFetch = (async () => new Response(stream, { status: 200, headers: { 'Content-Type': 'application/json' } })) as typeof fetch;
  const bounded = createEvidenceProvider(config(), { fetch: oversizeFetch, resolveSecret: () => 'synthetic-evidence-token', now: () => fixedNow });
  assert.ok(bounded);
  expectUnavailable(await collect(bounded), 'oversize');
  assert.equal(cancelled, true);

  let lateCancelled = false;
  const lateBody = new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(new TextEncoder().encode('{}')); },
    cancel() { lateCancelled = true; }
  });
  const lateFetch = (async () => new Promise<Response>(resolve => setTimeout(() => resolve(new Response(lateBody,
    { status: 200, headers: { 'Content-Type': 'application/json' } })), 60))) as typeof fetch;
  const late = createEvidenceProvider(config({ deadlineMs: 30 }), { fetch: lateFetch, resolveSecret: () => 'synthetic-evidence-token', now: () => fixedNow });
  assert.ok(late);
  expectUnavailable(await collect(late), 'timeout');
  await new Promise(resolve => setTimeout(resolve, 70));
  assert.equal(lateCancelled, true);
});
