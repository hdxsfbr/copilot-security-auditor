import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deriveTargetStates, type StateObservation } from '../apps/api/src/regression-states.js';

const T = '00000000-0000-4000-8000-000000000001', U = '00000000-0000-4000-8000-000000000002';
let clock = 0;
const at = () => new Date(Date.UTC(2026, 8, 1, 0, 0, ++clock)).toISOString();
const seen = (kind: StateObservation['kind'], version: string | null, basis: StateObservation['basis'] = 'replay', targetId = T): StateObservation => ({ targetId, targetName: 'T', version, kind, basis, runId: `run-${clock}`, at: at() });
const chain = (...steps: [StateObservation['kind'], string | null, StateObservation['basis']?][]) => deriveTargetStates(steps.map(step => seen(...step)));
const states = (found: ReturnType<typeof deriveTargetStates>) => found[0]?.scopes.map(scope => `${scope.targetVersion}:${scope.state}:${scope.reason}`);

test('a finding that has not been replayed is unknown, never fixed', () => {
  assert.deepEqual(states(chain(['violation', 'v1', 'source_finding'])), ['v1:unknown:not_replayed_since_finding']);
});
test('violation again is recurring on the same or a new version', () => {
  assert.deepEqual(states(chain(['violation', 'v1', 'source_finding'], ['violation', 'v1'])), ['v1:recurring:violation_observed_again']);
  assert.deepEqual(states(chain(['violation', 'v1', 'source_finding'], ['violation', 'v2'])), ['v2:recurring:violation_observed_again', 'v1:unknown:not_replayed_since_finding']);
});
test('fail, fix, resurface is derived per version; later inconclusive results never read as fixed', () => {
  const found = chain(['violation', 'v1', 'source_finding'], ['safe', 'v2'], ['violation', 'v3'], ['inconclusive', 'v4'], ['safe', 'v5']);
  assert.deepEqual(states(found), ['v5:fixed:safe_on_later_version', 'v4:unknown:result_not_conclusive', 'v3:resurfaced:violation_after_fix', 'v2:fixed:safe_on_later_version', 'v1:unknown:not_replayed_since_finding']);
  assert.equal(found[0].current.state, 'fixed');
  assert.equal(chain(['violation', 'v1', 'source_finding'], ['safe', 'v2'], ['inconclusive', 'v3'])[0].current.state, 'unknown');
});
test('only a finished safe replay on a different verified version can be fixed', () => {
  const base: [StateObservation['kind'], string | null, StateObservation['basis']?] = ['violation', 'v1', 'source_finding'];
  for (const [step, reason] of [[['safe', null], 'version_not_verified'], [['safe', 'v1'], 'violation_seen_on_this_version'], [['inconclusive', 'v2'], 'result_not_conclusive'], [['inconclusive', null], 'result_not_conclusive']] as const) {
    const found = chain(base, [...step]);
    assert.equal(found[0].current.state, 'unknown', reason);
    assert.equal(found[0].current.reason, reason);
  }
  assert.equal(chain(['violation', null, 'source_finding'], ['safe', 'v2'])[0].current.reason, 'violation_version_unverified');
  assert.equal(chain(['safe', 'v2'])[0].current.reason, 'no_prior_violation');
  assert.equal(deriveTargetStates([seen('pending', 'v2')]).length, 0, 'an unfinished replay is counted, not interpreted');
});
test('a safe replay on a version that also violated is a conflict, even when the violation came later', () => {
  const found = chain(['violation', 'v1', 'source_finding'], ['safe', 'v2'], ['violation', 'v2']);
  assert.deepEqual(states(found), ['v2:recurring:violation_observed_again', 'v1:unknown:not_replayed_since_finding']);
});
test('a further finding after a fix resurfaces it; a violation with no version after a fix resurfaces too', () => {
  assert.equal(chain(['violation', 'v1', 'source_finding'], ['safe', 'v2'], ['violation', 'v3', 'source_finding'])[0].current.state, 'resurfaced');
  assert.equal(chain(['violation', 'v1', 'source_finding'], ['safe', 'v2'], ['violation', null])[0].current.state, 'resurfaced');
});
test('targets are never pooled: a fix on one target says nothing about another', () => {
  const found = deriveTargetStates([seen('violation', 'v1', 'source_finding', T), seen('violation', 'v1', 'source_finding', U), seen('safe', 'v2', 'replay', T), seen('pending', 'v2', 'replay', U)]);
  assert.deepEqual(found.map(state => [state.targetId, state.current.state, state.pendingReplays]), [[T, 'fixed', 0], [U, 'unknown', 1]]);
});
