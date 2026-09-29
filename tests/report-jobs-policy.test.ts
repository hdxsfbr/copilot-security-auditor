import { test } from 'node:test';
import assert from 'node:assert/strict';
import { adaptiveStart, startInput } from '../packages/contracts/src/index.js';
import { legacyRoles, nanos, preflightModels, reserveAmount } from '../apps/worker/src/models.js';

const targetId = '123e4567-e89b-42d3-a456-426614174000';
const caseId = '123e4567-e89b-42d3-a456-426614174001';
const local = { provider: 'ollama' as const, model: 'installed', maxOutputTokens: 32 };
const paid = { provider: 'openrouter' as const, model: 'fixture/paid', maxOutputTokens: 100 };
const price = { prompt: '0.000001', completion: '0.000002', request: '0.001' };
const transport = (names: string[] = ['installed']): typeof fetch => (async (url: string | URL | Request) => {
  const path = new URL(String(url)).pathname;
  if (path.endsWith('/api/tags')) return new Response(JSON.stringify({ models: names.map(name => ({ name })) }), { status: 200 });
  if (path.endsWith('/models')) return new Response(JSON.stringify({ data: [{ id: 'fixture/paid', context_length: 1000, pricing: price }] }), { status: 200 });
  return new Response('{}', { status: 404 });
}) as typeof fetch;
const withKey = async (work: () => Promise<void>) => {
  const previous = process.env.OPENROUTER_API_KEY;
  process.env.OPENROUTER_API_KEY = 'fixture-key';
  try { await work(); } finally { if (previous === undefined) delete process.env.OPENROUTER_API_KEY; else process.env.OPENROUTER_API_KEY = previous; }
};

test('report policy is optional, strict, and never enabled by a stored Documentation role', () => {
  const base = { targetId, caseId, roles: { judge: local }, ollamaUrl: 'http://ollama.fixture/' };
  assert.equal(startInput.parse(base).reportPolicy, undefined);
  const legacy = startInput.parse({ targetId, caseId, roles: legacyRoles('installed'), ollamaUrl: 'http://ollama.fixture/' });
  assert.equal(legacy.reportPolicy, undefined);
  assert.equal(adaptiveStart.parse({ targetId, caseIds: [caseId], categories: ['prompt_injection'], maxCases: 1, maxMinutes: 1, ollamaUrl: 'http://ollama.fixture/', roles: legacyRoles('installed') }).reportPolicy, undefined);
  const ok = { model: paid, allowanceUsd: 0.01, reviewWindowMinutes: 30 };
  assert.deepEqual(startInput.parse({ ...base, openRouterCapUsd: 0.01, reportPolicy: ok }).reportPolicy, ok);
  for (const [name, input] of Object.entries({
    'paid model needs an allowance': { ...base, openRouterCapUsd: 1, reportPolicy: { model: paid, reviewWindowMinutes: 30 } },
    'allowance must fit the cap': { ...base, openRouterCapUsd: 0.005, reportPolicy: ok },
    'allowance needs a cap': { ...base, reportPolicy: ok },
    'local model has no allowance': { ...base, reportPolicy: { model: local, allowanceUsd: 0.01, reviewWindowMinutes: 30 } },
    'local model needs an endpoint': { targetId, caseId, roles: { judge: paid }, openRouterCapUsd: 1, reportPolicy: { model: local, reviewWindowMinutes: 30 } },
    'window is bounded': { ...base, openRouterCapUsd: 1, reportPolicy: { ...ok, reviewWindowMinutes: 10081 } },
    'unknown field': { ...base, openRouterCapUsd: 1, reportPolicy: { ...ok, extra: true } }
  })) assert.equal(startInput.safeParse(input).success, false, name);
});

test('preflight prices and checks the opted-in Documentation model and previews the allowance inside the cap', async () => {
  await withKey(async () => {
    const input = startInput.parse({ targetId, caseId, roles: { judge: local }, ollamaUrl: 'http://ollama.fixture/', openRouterCapUsd: 0.01, reportPolicy: { model: paid, allowanceUsd: 0.0066, reviewWindowMinutes: 30 } });
    const result = await preflightModels({ kind: 'selected', input }, transport());
    assert.equal(result.status, 'available');
    assert.equal(result.preview!.reservationNanos, '0', 'execution reservation excludes report spend');
    assert.equal(result.preview!.reportAllowanceNanos, nanos('0.0066').toString());
    assert.equal(result.preview!.reportJobReservationNanos, reserveAmount({ ...price, contextLength: 1000 }, 100).toString());
    assert.equal(result.models!.roles.documentation?.model, 'fixture/paid');
    assert.ok(result.models!.pricing.documentation);
    const missing = startInput.parse({ targetId, caseId, roles: { judge: local }, ollamaUrl: 'http://ollama.fixture/', reportPolicy: { model: { ...local, model: 'absent' }, reviewWindowMinutes: 30 } });
    assert.deepEqual((await preflightModels({ kind: 'selected', input: missing }, transport())).issues, [{ code: 'local_model_missing', role: 'documentation' }]);
    const plain = await preflightModels({ kind: 'selected', input: startInput.parse({ targetId, caseId, roles: { judge: local }, ollamaUrl: 'http://ollama.fixture/' }) }, transport());
    assert.equal('reportAllowanceNanos' in plain.preview!, false, 'no policy: preview shape unchanged');
    assert.equal(plain.models!.roles.documentation, undefined);
  });
});
