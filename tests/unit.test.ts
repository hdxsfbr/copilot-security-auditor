import { test } from 'node:test';
import assert from 'node:assert/strict';
import { caseInput, targetInput, verdict } from '../packages/contracts/src/index.js';
import { classify, packet, scrub, scrubEvidence } from '../apps/worker/src/judge.js';
import { users } from './support.js';

test('v1 contracts reject unsafe target inputs and unbounded turns', () => {
  assert.equal(targetInput.safeParse({ name: 'test', baseUrl: 'file:///tmp/foo', ...users }).success, false);
  assert.equal(caseInput.safeParse({ title: 'x', user: 'A', expectedSafeBehavior: 'no', actions: [{ kind: 'chat_turn', message: 'a'.repeat(1001) }] }).success, false);
  assert.equal(caseInput.safeParse({ title: 'x', user: 'A', expectedSafeBehavior: 'no', actions: [{ kind: 'chat_turn', message: 'hi', url: 'https://bad' }] }).success, false);
  assert.equal(targetInput.safeParse({ name: 'test', baseUrl: 'http://toy/', userA: { ...users.userA, pubpid: 'SYN%' }, userB: users.userB }).success, false);
  assert.equal(targetInput.safeParse({ name: 'test', baseUrl: 'http://toy/', userA: users.userA, userB: { ...users.userB, pubpid: users.userA.pubpid } }).success, false);
});
test('judge packet pseudonymizes identifiers and scrubs credentials without losing evidence refs', () => {
  const input = packet('Protect patient SYN-900002', [{ v: 1, turn: 1, ref: 'turn-1', status: 'fallback', response: 'alice saw SYN-900002 Cookie: abc clearPass=xyz private-password-A' }], [users.userA, users.userB]);
  assert.match(JSON.stringify(input), /PATIENT_B/);
  assert.doesNotMatch(JSON.stringify(input), /SYN-900002|private-password-A|Cookie: abc|clearPass=xyz/);
  assert.equal(input.observations[0].ref, 'turn-1');
  assert.match(scrubEvidence('patient SYN-900001 Cookie: secret', [users.userA]), /SYN-900001/);
  assert.doesNotMatch(scrub('csrf_token=xyz', [users.userA]), /xyz/);
});
test('safe, uncertain, and unsafe verdicts remain separate', () => {
  const base = { v: 1 as const, claim: '', evidenceRefs: ['turn-1'], reproductionComplete: true, materialUncertainties: [] as string[] };
  assert.equal(classify(verdict.parse({ ...base, outcome: 'safe' })), 'safe');
  assert.equal(classify(verdict.parse({ ...base, outcome: 'safe', evidenceRefs: [] })), 'inconclusive');
  assert.equal(classify(verdict.parse({ ...base, outcome: 'unsafe' })), 'pending_review');
  assert.equal(classify(verdict.parse({ ...base, outcome: 'inconclusive' })), 'inconclusive');
  assert.equal(verdict.safeParse({ ...base, outcome: 'certainly safe' }).success, false);
});
