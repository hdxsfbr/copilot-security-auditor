import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { adaptiveStart, startInput } from '../packages/contracts/src/index.js';
import { legacyRoles, nanos, preflightModels, reservationPreview, type Snapshot } from '../apps/worker/src/models.js';
import { createApp } from '../apps/api/src/app.js';
import type { Repository } from '../apps/api/src/repository.js';

const targetId = '123e4567-e89b-42d3-a456-426614174000';
const caseId = '123e4567-e89b-42d3-a456-426614174001';
const local = { provider: 'ollama' as const, model: 'installed', maxOutputTokens: 32 };
const paid = { provider: 'openrouter' as const, model: 'fixture/paid', maxOutputTokens: 100 };
const price = { prompt: '0.000001', completion: '0.000002', request: '0.001' };
const transport = (names: string[] = ['installed'], pricing: Record<string, unknown> = price): typeof fetch =>
  (async (url: string | URL | Request) => {
    const path = new URL(String(url)).pathname;
    if (path.endsWith('/api/tags')) return new Response(JSON.stringify({ models: names.map(name => ({ name })) }), { status: 200 });
    if (path.endsWith('/models')) return new Response(JSON.stringify({ data: [{ id: 'fixture/paid', context_length: 1000, pricing }] }), { status: 200 });
    return new Response('{}', { status: 404 });
  }) as typeof fetch;

test('selected inputs project legacy inactive roles and paid Judge needs no Ollama endpoint', async () => {
  const legacy = { ...legacyRoles('missing-local'), judge: paid, documentation: { provider: 'openrouter' as const, model: 'unused', maxOutputTokens: 1 } };
  const input = startInput.parse({ targetId, caseId, roles: legacy, openRouterCapUsd: 1 });
  assert.deepEqual(Object.keys(input.roles!), ['judge']);
  const previous = process.env.OPENROUTER_API_KEY;
  process.env.OPENROUTER_API_KEY = 'fixture-key';
  try {
    const result = await preflightModels({ kind: 'selected', input }, transport([]));
    assert.equal(result.status, 'available');
    assert.deepEqual(result.local, { status: 'not_required', installed: [] });
    assert.deepEqual(Object.keys(result.models!.roles), ['judge']);
    assert.equal(result.preview!.reservationNanos, nanos('0.0022').toString());
  } finally { if (previous === undefined) delete process.env.OPENROUTER_API_KEY; else process.env.OPENROUTER_API_KEY = previous; }
});

test('local discovery distinguishes unreachable catalog, empty catalog, and missing name', async () => {
  const input = startInput.parse({ targetId, caseId, roles: { judge: local }, ollamaUrl: 'http://ollama.fixture/' });
  const empty = await preflightModels({ kind: 'selected', input }, transport([]));
  assert.deepEqual(empty.issues, [{ code: 'local_model_missing', role: 'judge' }]);
  assert.equal(empty.local.status, 'available');
  const unreachable = await preflightModels({ kind: 'selected', input }, (async () => { throw new Error('offline'); }) as typeof fetch);
  assert.deepEqual(unreachable.issues, [{ code: 'local_catalog_unavailable' }]);
  assert.equal(unreachable.local.status, 'unavailable');
  assert.equal((await preflightModels({ kind: 'selected', input }, transport())).status, 'available');
});

test('adaptive reservation preview bounds attempted cases including rejected proposals', async () => {
  const previous = process.env.OPENROUTER_API_KEY;
  process.env.OPENROUTER_API_KEY = 'fixture-key';
  try {
    const input = adaptiveStart.parse({ targetId, caseIds: [caseId], categories: ['prompt_injection'], maxCases: 4, maxMinutes: 3,
      roles: { orchestrator: paid, redTeam: paid, judge: paid, documentation: { ...paid, model: 'unused' } }, openRouterCapUsd: 0.005 });
    const result = await preflightModels({ kind: 'adaptive', input }, transport());
    assert.equal(result.status, 'available');
    assert.equal(result.preview!.attempts, 4);
    assert.equal(result.preview!.reservationNanos, (nanos('0.0022') * 3n * 4n).toString());
    assert.equal(result.preview!.capNanos, nanos('0.005').toString());
    assert.deepEqual(Object.keys(result.models!.roles), ['orchestrator', 'redTeam', 'judge']);
    assert.throws(() => reservationPreview({ roles: { judge: paid }, pricing: {} } as Snapshot, 'selected'), /pricing/i);
  } finally { if (previous === undefined) delete process.env.OPENROUTER_API_KEY; else process.env.OPENROUTER_API_KEY = previous; }
});

test('known paid pricing dimensions are allowed; unknown ones fail preflight closed', async () => {
  const previous = process.env.OPENROUTER_API_KEY;
  process.env.OPENROUTER_API_KEY = 'fixture-key';
  try {
    const input = startInput.parse({ targetId, caseId, roles: { judge: paid }, openRouterCapUsd: 1 });
    const known = await preflightModels({ kind: 'selected', input }, transport([], { ...price, image: '0.0001', input_cache_read: '0.0000005' }));
    assert.equal(known.status, 'available');
    assert.deepEqual(known.issues, []);
    assert.equal(known.preview!.reservationNanos, nanos('0.0022').toString());
    const unknown = await preflightModels({ kind: 'selected', input }, transport([], { ...price, mystery_fee: '0.0001' }));
    assert.equal(unknown.status, 'unavailable');
    assert.deepEqual(unknown.issues, [{ code: 'paid_catalog_or_pricing_unavailable' }]);
    assert.equal(unknown.preview, null);
  } finally { if (previous === undefined) delete process.env.OPENROUTER_API_KEY; else process.env.OPENROUTER_API_KEY = previous; }
});

test('API discovery preserves legacy lists while distinguishing empty and unreachable local catalogs', async () => {
  const localServer = createServer((_req, res) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ models: [] })); });
  localServer.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => localServer.once('listening', resolve));
  const address = localServer.address(); assert.ok(address && typeof address !== 'string');
  const previous = process.env.OLLAMA_URL, previousPaid = process.env.OPENROUTER_API_KEY, previousPaidBase = process.env.OPENROUTER_BASE_URL;
  process.env.OLLAMA_URL = `http://127.0.0.1:${address.port}/`;
  delete process.env.OPENROUTER_API_KEY;
  delete process.env.OPENROUTER_BASE_URL;
  const api = createApp({} as Repository).listen(0, '127.0.0.1');
  await new Promise<void>(resolve => api.once('listening', resolve));
  const apiAddress = api.address(); assert.ok(apiAddress && typeof apiAddress !== 'string');
  const base = `http://127.0.0.1:${apiAddress.port}/api`;
  try {
    const available = await (await fetch(`${base}/models`)).json();
    assert.deepEqual(available.ollama, []);
    assert.equal(available.availability.ollama, 'available');
    assert.equal(available.inferenceHealth, 'unverified');
    const checked = await (await fetch(`${base}/model-preflight`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ kind: 'selected', input: { targetId, caseId, ollamaUrl: process.env.OLLAMA_URL, roles: { ...legacyRoles('unused'), judge: local } } }) })).json();
    assert.equal(checked.status, 'unavailable');
    assert.deepEqual(checked.issues, [{ code: 'local_model_missing', role: 'judge' }]);
    assert.equal(checked.inferenceHealth, 'unverified');
    await new Promise<void>(resolve => localServer.close(() => resolve()));
    const offline = await (await fetch(`${base}/models`)).json();
    assert.equal(offline.availability.ollama, 'unavailable');
  } finally {
    await new Promise<void>(resolve => api.close(() => resolve()));
    if (localServer.listening) await new Promise<void>(resolve => localServer.close(() => resolve()));
    if (previous === undefined) delete process.env.OLLAMA_URL; else process.env.OLLAMA_URL = previous;
    if (previousPaid === undefined) delete process.env.OPENROUTER_API_KEY; else process.env.OPENROUTER_API_KEY = previousPaid;
    if (previousPaidBase === undefined) delete process.env.OPENROUTER_BASE_URL; else process.env.OPENROUTER_BASE_URL = previousPaidBase;
  }
});

test('selected and adaptive launch routes dispatch only active local roles', async () => {
  const model = createServer((_req, res) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ models: [{ name: 'installed' }] })); });
  model.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => model.once('listening', resolve));
  const modelAddress = model.address(); assert.ok(modelAddress && typeof modelAddress !== 'string');
  const url = `http://127.0.0.1:${modelAddress.port}/`;
  const received: { kind: string; input: unknown; models: Snapshot }[] = [];
  const repo = {
    start: async (input: unknown, models: Snapshot) => { received.push({ kind: 'selected', input, models }); return { id: caseId, status: 'queued' as const }; },
    startAdaptive: async (input: unknown, models: Snapshot) => { received.push({ kind: 'adaptive', input, models }); return { id: caseId, status: 'queued' as const }; }
  } as unknown as Repository;
  const api = createApp(repo).listen(0, '127.0.0.1');
  await new Promise<void>(resolve => api.once('listening', resolve));
  const address = api.address(); assert.ok(address && typeof address !== 'string');
  const post = (path: string, body: unknown) => fetch(`http://127.0.0.1:${address.port}/api/${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  try {
    const oldRoles = { ...legacyRoles('missing-inactive'), judge: local };
    assert.equal((await post('runs', { targetId, caseId, ollamaUrl: url, roles: oldRoles })).status, 202);
    assert.deepEqual(Object.keys(received[0].models.roles), ['judge']);
    assert.deepEqual(Object.keys((received[0].input as { roles: object }).roles), ['judge']);
    const missing = await post('runs', { targetId, caseId, ollamaUrl: url, roles: { judge: { ...local, model: 'missing' } } });
    assert.equal(missing.status, 400);
    assert.deepEqual(await missing.json(), { v: 1, code: 'invalid', message: 'Selected Ollama model is not installed', issues: [{ code: 'local_model_missing', role: 'judge' }] });
    assert.equal((await post('adaptive-runs', { targetId, caseIds: [caseId], categories: ['prompt_injection'], maxCases: 2, maxMinutes: 2, ollamaUrl: url,
      roles: { ...legacyRoles('installed'), documentation: { ...local, model: 'missing-inactive' } } })).status, 202);
    assert.deepEqual(Object.keys(received[1].models.roles), ['orchestrator', 'redTeam', 'judge']);
  } finally {
    await new Promise<void>(resolve => api.close(() => resolve()));
    await new Promise<void>(resolve => model.close(() => resolve()));
  }
});
