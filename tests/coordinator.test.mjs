import test from 'node:test';
import assert from 'node:assert/strict';
import { computeSnapshot, hydrateLinkedMrs, parsePaginatedJson, validateInputs } from '../scripts/audit-coordinator.mjs';

const A = 'a'.repeat(40), B = 'b'.repeat(40), C = 'c'.repeat(40);
const task = (key, deps = [], locks = [], gate) => ({
  key, wave: 'W1', title: `Implement ${key}`, model: 'gpt-6-sol', audit: [key],
  deps, locks, files: [], scope: 'synthetic', accept: ['verified'],
  linear: { id: `AUD-${key}`, uuid: key, url: `https://linear.example/${key}` },
  ...(gate ? { gate } : {})
});
const manifest = tasks => ({ schemaVersion: 1,
  project: { gitlabProjectId: 2059, gitlabHost: 'labs.gauntletai.com', defaultBranch: 'main' },
  limits: { maxSubagents: 3, maxWorkInProgress: 3, maxRepairRounds: 2 }, tasks });
const journal = tasks => ({ schemaVersion: 1, mode: 'active-session', tasks, updatedAt: new Date().toISOString() });
const mr = (iid, key, state = 'opened', changes = {}) => ({ iid, project_id: 2059,
  state, title: `Implement ${key}`, source_branch: `codex/${key}`, target_branch: 'main',
  sha: A, merged_at: state === 'merged' ? '2026-09-29T00:00:00Z' : null,
  merge_commit_sha: state === 'merged' ? B : null, head_pipeline: null, ...changes });
const checked = (mrIid, headSha = A, phase = 'in_review') => ({ phase, mrIid, headSha, validation: { passed: true, headSha } });
const snapshot = (tasks, state = {}, mrs = [], ancestor = () => true) =>
  computeSnapshot(manifest(tasks), journal(state), mrs, ancestor);

test('unknown and cyclic dependencies fail closed', () => {
  assert.throws(() => validateInputs(manifest([task('A', ['missing'])]), journal({})), /Unknown/);
  assert.throws(() => validateInputs(manifest([task('A', ['B']), task('B', ['A'])]), journal({})), /Cyclic/);
  assert.throws(() => validateInputs(manifest([task('A')]), journal({ other: { phase: 'merged' } })), /Malformed journal/);
});

test('only GitLab merged plus main ancestry and exact-head validation unlocks a dependency', () => {
  const tasks = [task('A'), task('B', ['A'])];
  const state = { A: checked(1) };
  assert.deepEqual(snapshot(tasks, state, [mr(1, 'A', 'merged')]).ready, ['B']);
  assert.deepEqual(snapshot(tasks, state, [mr(1, 'A', 'merged')], () => false).waiting, ['B']);
  assert.deepEqual(snapshot(tasks, state, [mr(1, 'A', 'merged', { target_branch: 'dev' })]).waiting, ['B']);
  assert.deepEqual(snapshot(tasks, state, [mr(1, 'A', 'merged', { merged_at: null })]).waiting, ['B']);
});

test('journal Done is forged until a verified MR exists', () => {
  const result = snapshot([task('A'), task('B', ['A'])], { A: { phase: 'merged' } });
  assert.deepEqual(result.blocked, ['A']);
  assert.deepEqual(result.waiting, ['B']);
  assert.match(result.warnings.join(' '), /journal merged without verified/);
});

test('closed unmerged MR blocks the issue and dependent work', () => {
  const result = snapshot([task('A'), task('B', ['A'])], { A: checked(1) }, [mr(1, 'A', 'closed')]);
  assert.deepEqual(result.blocked, ['A']);
  assert.deepEqual(result.waiting, ['B']);
  assert.deepEqual(result.active, []);
});

test('unlinked historical MR blocks redispatch after journal loss', () => {
  const tasks = [task('A', [], ['contracts']), task('B', [], ['contracts/src'])];
  for (const state of ['merged', 'closed']) {
    const result = snapshot(tasks, {}, [mr(1, 'A', state)]);
    assert.deepEqual(result.ready, []);
    assert.deepEqual(result.blocked, ['A']);
    assert.deepEqual(result.waiting, ['B']);
    assert.match(result.warnings.join(' '), /historical MR requires reconciliation/);
  }
});

test('closed MR retains WIP and locks until explicit journal closure', () => {
  const tasks = [task('A', [], ['contracts']), task('B', [], ['contracts/src'])];
  const review = snapshot(tasks, { A: checked(1) }, [mr(1, 'A', 'closed')]);
  assert.deepEqual(review.blocked, ['A']);
  assert.deepEqual(review.waiting, ['B']);
  const closed = snapshot(tasks, { A: { phase: 'closed', mrIid: 1 } }, [mr(1, 'A', 'closed')]);
  assert.deepEqual(closed.ready, ['B']);
  const occupied = snapshot([task('A'), task('B'), task('C'), task('D')],
    { A: checked(1), B: checked(2), C: checked(3) },
    [mr(1, 'A', 'closed'), mr(2, 'B', 'closed'), mr(3, 'C', 'closed')]);
  assert.deepEqual(occupied.ready, []);
  assert.deepEqual(occupied.waiting, ['D']);
});

test('closed history permits only an explicit reconciled retry', () => {
  const tasks = [task('A')];
  const old = mr(1, 'A', 'closed');
  assert.deepEqual(snapshot(tasks, { A: { phase: 'ready', attempt: 2 } }, [old]).blocked, ['A']);
  assert.deepEqual(snapshot(tasks, { A: { phase: 'ready', attempt: 2, reconciledMrIids: [1] } }, [old]).ready, ['A']);
  assert.deepEqual(snapshot(tasks, { A: { phase: 'ready', attempt: 2, reconciledMrIids: [1] } }, [old, mr(2, 'A', 'closed')]).blocked, ['A']);
  assert.deepEqual(snapshot(tasks, { A: { phase: 'ready', attempt: 2, reconciledMrIids: [1] } }, [mr(1, 'A', 'merged')]).blocked, ['A']);
});

test('duplicate or orphan open MR blocks dispatch and holds its lock', () => {
  const tasks = [task('A', [], ['apps/api']), task('B', [], ['apps/api/src'])];
  const duplicate = snapshot(tasks, { A: checked(1) }, [mr(1, 'A'), mr(2, 'A')]);
  assert.deepEqual(duplicate.blocked, ['A']);
  assert.deepEqual(duplicate.waiting, ['B']);
  assert.match(duplicate.warnings.join(' '), /duplicate open MR/);
  const orphan = snapshot(tasks, {}, [mr(1, 'A')]);
  assert.deepEqual(orphan.blocked, ['A']);
  assert.deepEqual(orphan.waiting, ['B']);
  assert.match(orphan.warnings.join(' '), /orphan open MR/);
});

test('active and review work consume slots; locks prevent concurrent conflicting tasks', () => {
  const tasks = [task('A', [], ['contracts']), task('B', [], ['api']), task('C', [], ['worker']),
    task('D', [], ['contracts/src']), task('E', [], ['reports'])];
  const result = snapshot(tasks, { A: { phase: 'in_progress' }, B: checked(2) }, [mr(2, 'B')]);
  assert.deepEqual(result.active, ['A', 'B']);
  assert.deepEqual(result.ready, ['C']);
  assert.deepEqual(result.waiting, ['D', 'E']);
});

test('external gate never becomes ready', () => {
  const result = snapshot([task('A', [], [], { kind: 'external' }), task('B')]);
  assert.deepEqual(result.blocked, ['A']);
  assert.deepEqual(result.ready, ['B']);
});

test('validation must match the exact GitLab head, including metadata-only work', () => {
  const tasks = [{ ...task('D00'), wave: 'W0', model: 'coordinator' }, task('A01', ['D00'])];
  const state = { D00: checked(1, C, 'merged') };
  const result = snapshot(tasks, state, [mr(1, 'D00', 'merged')]);
  assert.deepEqual(result.blocked, ['D00']);
  assert.deepEqual(result.waiting, ['A01']);
  assert.match(result.warnings.join(' '), /exact-head validation/);
});

test('coordinator owned D00 never dispatches before its verified merge', () => {
  const result = snapshot([{ ...task('D00'), wave: 'W0', model: 'coordinator' }]);
  assert.deepEqual(result.ready, []);
  assert.deepEqual(result.blocked, ['D00']);
});

test('missing linked MR retains active work in progress and file locks', () => {
  const tasks = [task('A', [], ['contracts']), task('B', [], ['contracts/src'])];
  const result = snapshot(tasks, { A: checked(99) });
  assert.deepEqual(result.blocked, ['A']);
  assert.deepEqual(result.waiting, ['B']);
  const full = snapshot([task('A'), task('B'), task('C'), task('D')],
    { A: checked(97), B: checked(98), C: checked(99) });
  assert.deepEqual(full.ready, []);
  assert.deepEqual(full.waiting, ['D']);
});

test('pending or failed head pipeline cannot certify a merge', () => {
  const tasks = [task('A'), task('B', ['A'])];
  const state = { A: checked(1) };
  for (const status of ['pending', 'running', 'failed']) {
    const result = snapshot(tasks, state, [mr(1, 'A', 'merged', { head_pipeline: { status, sha: A } })]);
    assert.deepEqual(result.blocked, ['A']);
    assert.deepEqual(result.waiting, ['B']);
  }
  assert.deepEqual(snapshot(tasks, state, [mr(1, 'A', 'merged', { head_pipeline: { status: 'success', sha: A } })]).ready, ['B']);
  assert.deepEqual(snapshot(tasks, state, [mr(1, 'A', 'merged', { head_pipeline: { status: 'success', sha: B } })]).ready, ['B']);
  assert.deepEqual(snapshot(tasks, state, [mr(1, 'A', 'merged', { head_pipeline: { status: 'success', sha: C } })]).waiting, ['B']);
  assert.deepEqual(snapshot(tasks, state, [mr(1, 'A', 'merged', { head_pipeline: { status: 'skipped', sha: A } })]).waiting, ['B']);
});

test('linked MR hydration requires authoritative pipeline detail', () => {
  const state = journal({ A: checked(1) });
  const list = [mr(1, 'A', 'merged', { head_pipeline: undefined })];
  const hydrated = hydrateLinkedMrs(state, list, iid => mr(iid, 'A', 'merged', { head_pipeline: { status: 'success', sha: A } }));
  assert.equal(hydrated[0].head_pipeline.status, 'success');
  assert.throws(() => hydrateLinkedMrs(state, list, () => ({ ...mr(1, 'A', 'merged'), head_pipeline: undefined })), /detail unavailable/);
  assert.throws(() => hydrateLinkedMrs(state, list, () => { throw new Error('GitLab unavailable'); }), /GitLab unavailable/);
});

test('runner exception permits only pending CI with authorized current-head local evidence', () => {
  const m = manifest([task('A'), task('B', ['A']), task('Q03', [], [], 'runner')]);
  m.validationPolicy = { runnerUnavailable: { authorized: true, authorizedOn: '2026-09-29', untilTask: 'Q03' } };
  const entry = { ...checked(1), ciException: { kind: 'runner_unavailable', authorizedOn: '2026-09-29', headSha: A, evidence: 'test-results/runner.json' } };
  entry.validation.checks = [{ name: 'fixture pipeline', exitCode: 0, evidence: 'test-results/fixtures.txt' }];
  const run = (candidate = entry, status = 'pending', sha = A, extraState = {}, extraMrs = []) =>
    computeSnapshot(m, journal({ A: candidate, ...extraState }),
      [mr(1, 'A', 'merged', { head_pipeline: { status, sha } }), ...extraMrs], () => true);
  assert.deepEqual(run().ready, ['B']);
  assert.match(run().warnings.join(' '), /remote CI awaits runner/);
  for (const status of ['failed', 'running', 'canceled', 'skipped']) assert.deepEqual(run(entry, status).ready, []);
  assert.deepEqual(run(entry, 'pending', C).ready, []);
  assert.deepEqual(run({ ...entry, ciException: undefined }).ready, []);
  assert.deepEqual(run({ ...entry, ciException: { ...entry.ciException, headSha: C } }).ready, []);
  assert.deepEqual(run({ ...entry, validation: { ...entry.validation, checks: [] } }).ready, []);
  assert.deepEqual(run({ ...entry, validation: { ...entry.validation, passed: false } }).ready, []);
  assert.deepEqual(run({ ...entry, validation: { ...entry.validation, checks: [{ name: 'fixtures', exitCode: 1, evidence: 'test-results/failed.txt' }] } }).ready, []);
  assert.deepEqual(run(entry, 'pending', A, { Q03: checked(3) }, [mr(3, 'Q03', 'merged')]).ready, []);
  delete m.validationPolicy;
  assert.deepEqual(run().ready, []);
});

test('dependency IDs in an MR description do not claim that dependency', () => {
  const tasks = [task('A'), task('B', ['A'])];
  const result = snapshot(tasks, {}, [mr(2, 'B', 'opened', { description: 'Depends on AUD-A' })]);
  assert.deepEqual(result.blocked, ['B']);
  assert.deepEqual(result.ready, ['A']);
});

test('linked MR must identify the task and target main', () => {
  const tasks = [task('A', [], ['contracts']), task('B', [], ['contracts/src'])];
  const wrongIssue = snapshot(tasks, { A: checked(1) }, [mr(1, 'OTHER', 'merged')]);
  assert.deepEqual(wrongIssue.blocked, ['A']);
  assert.deepEqual(wrongIssue.waiting, ['B']);
  assert.match(wrongIssue.warnings.join(' '), /does not identify/);
  const wrongBranch = snapshot(tasks, { A: checked(1) }, [mr(1, 'A', 'opened', { target_branch: 'dev' })]);
  assert.deepEqual(wrongBranch.blocked, ['A']);
  assert.deepEqual(wrongBranch.waiting, ['B']);
});

test('paginated GitLab arrays parse without exposing or dropping pages', () => {
  assert.deepEqual(parsePaginatedJson('[{"title":"a]b","iid":1}]\n[{"iid":2}]'),
    [{ title: 'a]b', iid: 1 }, { iid: 2 }]);
  assert.throws(() => parsePaginatedJson('{"iid":1}'), /Malformed/);
});
