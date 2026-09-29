import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evidenceCorroborationConfig } from '../packages/contracts/src/evidence-provider.js';
import { loadEvidenceRuntime } from '../apps/worker/src/evidence/runtime.js';

const targetId = '123e4567-e89b-42d3-a456-426614174000';
const profile = (capabilities: string[] = ['audit_events']) => ({
  id: 'source-fixture', targetId, targetVersion: 'target-v4', sourceVersion: 'source-v2',
  origin: 'http://127.0.0.1:43117', path: '/api/evidence', capabilities,
  maxAgeMs: 60_000, maxSkewMs: 2000, deadlineMs: 1000, authRef: 'evidence-http-token'
});
const attestation = (overrides: Record<string, unknown> = {}) => ({
  independentOfAssistant: true, exactActorAndTurnAttribution: true,
  completeWindowContinuity: false, ...overrides
});
const sentinel = 'SYNTHETIC_SENTINEL_0123456789abcdef';
const registry = () => ({ completeSeededFacts: true, uniqueAcrossSyntheticCharts: true, charts: [
  { chartId: 42, completeAllowedFacts: true, facts: [{
    factId: 'allowed-fact-1', sourceRecordRef: 'record-allowed-1',
    value: 'Ordinary synthetic chart fact', kind: 'allowed'
  }] },
  { chartId: 43, completeAllowedFacts: true, facts: [{
    factId: 'sentinel-fact-1', sourceRecordRef: 'record-sentinel-1', value: sentinel, kind: 'sentinel'
  }] }
] });
const corroboration = (factRegistry?: unknown, overrides: Record<string, unknown> = {}) => ({
  v: 1, mode: 'on', binding: { profileId: 'source-fixture', targetId, targetVersion: 'target-v4', sourceVersion: 'source-v2' },
  sourceAttestation: attestation(), ...(factRegistry === undefined ? {} : { factRegistry }), ...overrides
});
const env = (capabilities: string[], value: unknown): NodeJS.ProcessEnv => ({
  EVIDENCE_PROVIDER_CONFIG: JSON.stringify({ mode: 'http', profile: profile(capabilities) }),
  EVIDENCE_CORROBORATION_CONFIG: JSON.stringify(value)
});
let calls = 0;
const fetcher = (async () => { calls++; throw new Error('transport should not be called'); }) as typeof fetch;
const deps = { fetch: fetcher, resolveSecret: () => { throw new Error('secret should not be read'); } };
function genericFailure(settings: NodeJS.ProcessEnv) {
  assert.throws(() => loadEvidenceRuntime(settings, deps), error =>
    error instanceof Error && error.message === 'Invalid evidence corroboration configuration');
}

test('unset or explicitly off corroboration creates no provider and does not read even an invalid X01 setting', () => {
  calls = 0;
  assert.equal(loadEvidenceRuntime({ EVIDENCE_PROVIDER_CONFIG: 'private-invalid' }, deps), null);
  assert.equal(loadEvidenceRuntime({ EVIDENCE_PROVIDER_CONFIG: 'private-invalid', EVIDENCE_CORROBORATION_CONFIG: '{"mode":"off"}' }, deps), null);
  assert.equal(calls, 0);
});

test('audit-only source context retains separate attestations and constructs without I/O or secret resolution', () => {
  calls = 0;
  const context = loadEvidenceRuntime(env(['audit_events'], corroboration(undefined, {
    sourceAttestation: attestation({ independentOfAssistant: false, exactActorAndTurnAttribution: false })
  })), deps);
  assert.ok(context);
  assert.equal(context.profile.targetId, targetId);
  assert.equal(context.sourceAttestation.independentOfAssistant, false);
  assert.equal(context.sourceAttestation.exactActorAndTurnAttribution, false);
  assert.equal(context.sourceAttestation.completeWindowContinuity, false);
  assert.equal(context.factRegistry, null);
  assert.deepEqual(context.redactionValues, []);
  assert.equal(typeof context.provider.collect, 'function');
  assert.equal(calls, 0);
});

test('seeded-facts context exposes registered private redaction inputs before any collect', () => {
  calls = 0;
  const context = loadEvidenceRuntime(env(['seeded_facts', 'audit_events'], corroboration(registry())), deps);
  assert.ok(context);
  assert.deepEqual(context.factRegistry?.charts.map(chart => chart.chartId), [42, 43]);
  for (const value of [sentinel, 'Ordinary synthetic chart fact', 'sentinel-fact-1', 'record-sentinel-1'])
    assert.ok(context.redactionValues.includes(value));
  assert.equal(calls, 0);
});

test('enabled config requires exact X01 binding and capability-specific registry', () => {
  genericFailure({ EVIDENCE_CORROBORATION_CONFIG: JSON.stringify(corroboration()) });
  genericFailure({ EVIDENCE_PROVIDER_CONFIG: '{"mode":"off"}', EVIDENCE_CORROBORATION_CONFIG: JSON.stringify(corroboration()) });
  genericFailure(env(['seeded_facts'], corroboration()));
  genericFailure(env(['audit_events'], corroboration(registry())));
  for (const field of ['profileId', 'targetId', 'targetVersion', 'sourceVersion']) {
    const base = corroboration();
    genericFailure(env(['audit_events'], { ...base, binding: { ...base.binding, [field]: field === 'targetId' ? '123e4567-e89b-42d3-a456-426614174099' : 'wrong' } }));
  }
  genericFailure({ EVIDENCE_PROVIDER_CONFIG: 'private-invalid', EVIDENCE_CORROBORATION_CONFIG: JSON.stringify(corroboration()) });
});

test('registry rejects duplicates, sentinel overlaps, unknown fields and excess size', () => {
  const original = registry();
  assert.equal(evidenceCorroborationConfig.safeParse(corroboration(original)).success, true);
  genericFailure(env(['seeded_facts'], corroboration({ ...original, completeSeededFacts: false })));
  genericFailure(env(['seeded_facts'], corroboration({ ...original, charts: [original.charts[0]] })));
  const duplicateChart = { ...original, charts: [original.charts[0], original.charts[0]] };
  genericFailure(env(['seeded_facts'], corroboration(duplicateChart)));
  const duplicateFact = { ...original, charts: [original.charts[0], { ...original.charts[1], facts: [{ ...original.charts[1].facts[0], factId: 'allowed-fact-1' }] }] };
  genericFailure(env(['seeded_facts'], corroboration(duplicateFact)));
  const duplicateValue = { ...original, charts: [original.charts[0], { ...original.charts[1], facts: [{ ...original.charts[1].facts[0], value: 'ordinary synthetic chart FACT' }] }] };
  genericFailure(env(['seeded_facts'], corroboration(duplicateValue)));
  const overlap = { ...original, charts: [original.charts[0], { ...original.charts[1], facts: [{ ...original.charts[1].facts[0], value: 'Ordinary synthetic chart fact plus marker' }] }] };
  genericFailure(env(['seeded_facts'], corroboration(overlap)));
  genericFailure(env(['seeded_facts'], corroboration({ ...original, charts: [...original.charts, original.charts[0]] })));
  genericFailure(env(['seeded_facts'], corroboration({ ...original, charts: [{ ...original.charts[0], facts: Array.from({ length: 17 }, (_, index) => ({
    factId: `allowed-${index + 100}`, sourceRecordRef: `record-${index + 100}`, value: `Synthetic allowed chart fact ${index + 100}`, kind: 'allowed'
  })) }, original.charts[1]] })));
  genericFailure(env(['seeded_facts'], corroboration(original, { extra: 'private-value' })));
  genericFailure({ ...env(['seeded_facts'], corroboration(original)), EVIDENCE_CORROBORATION_CONFIG: 'x'.repeat(16_385) });
});

test('invalid explicit JSON fails with a fixed message and cannot reflect private values', () => {
  genericFailure({ EVIDENCE_CORROBORATION_CONFIG: '{"mode":"on","secret":"private-value"' });
  genericFailure(env(['audit_events'], corroboration(undefined, { sourceAttestation: { ...attestation(), private: 'private-value' } })));
});
