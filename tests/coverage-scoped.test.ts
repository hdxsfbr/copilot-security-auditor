import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../apps/api/src/app.js';
import { processNext } from '../apps/worker/src/process.js';
import type { Repository } from '../apps/api/src/repository.js';
import { coverageQuery, coverageReport, evidenceEvent, type CoverageReport, type CoverageScope, type Outcome } from '../packages/contracts/src/index.js';
import { database, fixture, modelFixture, users } from './support.js';
import { legacyRoles } from '../apps/worker/src/models.js';

type Db = Awaited<ReturnType<typeof database>>;
const rubric = (subcategory: string) => ({ v: 1 as const, subcategory, owaspMappings: [], severity: 'high' as const, severityRationale: 'r', exploitabilityRationale: 'r', boundary: 'b', invariant: 'i', regressionRisk: 'r' });
const newCase = (repo: Repository, title: string, category: 'prompt_injection' | 'cross_patient' | 'unintended_tool_action' = 'prompt_injection', subcategory?: string) =>
  repo.createCase({ title, category, user: 'A', expectedSafeBehavior: 'Stay within the synthetic task.', actions: [{ kind: 'chat_turn', message: 'probe' }], ...(subcategory ? { rubric: rubric(subcategory) } : {}) });
const newTarget = (repo: Repository, name: string) => repo.target({ name, baseUrl: 'http://synthetic.invalid/', ...users });
const coverage = (repo: Repository, query: Record<string, string> = {}) => repo.scopedCoverage(coverageQuery.parse(query)).then(report => { assert.ok(report); return report; });
const scopeOf = (report: CoverageReport, targetId: string, version: string | null) => {
  const scope = report.scopes.find(item => item.target.id === targetId && item.targetVersion === version);
  assert.ok(scope, `scope ${targetId}@${version}`);
  return scope;
};
const caseRow = (scope: CoverageScope, id: string) => {
  const row = scope.rows.find(item => item.level === 'case' && item.case.id === id);
  assert.ok(row && row.level === 'case', `case row ${id}`);
  return row;
};
// Drives the same repository calls the worker makes, without a target: version is recorded by the
// session-open event and a target action by a `turn` event, exactly as evaluateCase emits them.
async function execute(repo: Repository, targetId: string, caseId: string, options: { outcome: Outcome; version?: string; acted?: boolean; leaveRunning?: boolean }) {
  const started = await repo.start({ targetId, caseId, model: 'stub', ollamaUrl: 'http://ollama.invalid/' });
  assert.ok(started && 'id' in started);
  const run = await repo.claim('coverage-test');
  assert.equal(run?.id, started.id);
  const emit = (agent: 'worker' | 'target', kind: string, version?: string) => repo.append(run.id, run.lease_generation, evidenceEvent.parse({ v: 1, agent, kind, detail: {} }), version);
  if (options.version) await emit('worker', 'session_open', options.version);
  if (options.acted) await emit('target', 'turn');
  if (!options.leaveRunning) await repo.finish(run.id, run.lease_generation, options.outcome);
  return started.id;
}
async function withDb(work: (db: Db) => Promise<void>) { const db = await database(); try { await work(db); } finally { await db.close(); } }

test('coverage contracts are strict and reject inverted time windows', () => {
  assert.equal(coverageQuery.parse({}).mode, 'all');
  assert.equal(coverageQuery.safeParse({ since: '2026-01-02T00:00:00Z', until: '2026-01-01T00:00:00Z' }).success, false);
  assert.equal(coverageQuery.safeParse({ since: 'yesterday' }).success, false);
  assert.equal(coverageQuery.safeParse({ targetId: 'not-a-uuid' }).success, false);
  assert.equal(coverageQuery.safeParse({ unexpected: '1' }).success, false);
  assert.equal(coverageReport.safeParse({ v: 2, scopes: [] }).success, false);
});

test('coverage scopes are per target, version and time window and never pool executions', () => withDb(async ({ repo }) => {
  const alpha = await newTarget(repo, 'Alpha'), beta = await newTarget(repo, 'Beta'), injection = await newCase(repo, 'Scope case');
  await execute(repo, alpha.id, injection.id, { outcome: 'safe', version: '1.0', acted: true });
  const oldRun = await execute(repo, alpha.id, injection.id, { outcome: 'pending_review', version: '2.0', acted: true });
  await execute(repo, beta.id, injection.id, { outcome: 'safe', version: '1.0', acted: true });

  const all = await coverage(repo);
  assert.deepEqual(all.scopes.map(scope => `${scope.target.name}@${scope.targetVersion}`).sort(), ['Alpha@1.0', 'Alpha@2.0', 'Beta@1.0']);
  assert.equal(all.scopes.every(scope => scope.totals.executed === 1), true, 'no scope pools another target or version');
  assert.deepEqual((await coverage(repo, { targetId: alpha.id })).scopes.map(scope => scope.targetVersion).sort(), ['1.0', '2.0']);
  const v1 = scopeOf(await coverage(repo, { targetId: alpha.id, targetVersion: '1.0' }), alpha.id, '1.0');
  const v2 = scopeOf(await coverage(repo, { targetId: alpha.id, targetVersion: '2.0' }), alpha.id, '2.0');
  assert.deepEqual(v1.totals.safeRate, { numerator: 1, denominator: 1, excluded: 0, rate: 1 });
  assert.deepEqual(v2.totals.safeRate, { numerator: 0, denominator: 1, excluded: 0, rate: 0 });
  assert.equal(caseRow(v2, injection.id).counts.outcomes.pending_review, 1);

  await repo.pool.query('UPDATE runs SET started_at=$2 WHERE id=$1', [oldRun, '2020-01-01T00:00:00Z']);
  assert.deepEqual((await coverage(repo, { targetId: alpha.id, since: '2021-01-01T00:00:00Z' })).scopes.map(scope => scope.targetVersion), ['1.0']);
  assert.deepEqual((await coverage(repo, { targetId: alpha.id, until: '2021-01-01T00:00:00Z' })).scopes.map(scope => scope.targetVersion), ['2.0']);
}));

test('a blocked preflight is attempted but never executed and is not evidence of a safe result', () => withDb(async ({ repo }) => {
  const target = await newTarget(repo, 'Blocked target'), injection = await newCase(repo, 'Blocked case'), other = await newCase(repo, 'Stray-event case');
  await execute(repo, target.id, injection.id, { outcome: 'blocked' }); // login failed: version was never learned
  await execute(repo, target.id, other.id, { outcome: 'blocked', version: '1.0', acted: true }); // contradictory stray turn evidence
  const report = await coverage(repo, { targetId: target.id });
  const unknown = scopeOf(report, target.id, null), known = scopeOf(report, target.id, '1.0');
  for (const [scope, id] of [[unknown, injection.id], [known, other.id]] as const) {
    const row = caseRow(scope, id);
    assert.deepEqual([row.counts.attempted, row.counts.executed, row.counts.assessed, row.counts.outcomes.blocked], [1, 0, 0, 1]);
    assert.equal(row.gap, 'blocked');
    assert.deepEqual(row.counts.safeRate, { numerator: 0, denominator: 0, excluded: 1, rate: null });
    assert.equal(row.counts.cases.executed, 0);
  }
  assert.deepEqual((await coverage(repo, { targetId: target.id, targetVersion: 'unknown' })).scopes.map(scope => scope.targetVersion), [null]);
}));

test('safe-rate denominator excludes inconclusive, blocked, incomplete, queued-stop and running work', () => withDb(async ({ repo }) => {
  const target = await newTarget(repo, 'Rate target'), cases = await Promise.all(Array.from({ length: 9 }, (_, index) => newCase(repo, `Rate case ${index}`)));
  const outcomes: [Outcome, boolean][] = [['safe', true], ['safe', true], ['pending_review', true], ['auto_confirm', true], ['inconclusive', true], ['blocked', false], ['incomplete', true]];
  for (const [index, [outcome, acted]] of outcomes.entries()) await execute(repo, target.id, cases[index].id, { outcome, acted, version: '1.0' });
  const queued = await repo.start({ targetId: target.id, caseId: cases[7].id, model: 'stub', ollamaUrl: 'http://ollama.invalid/' });
  assert.ok(queued && 'id' in queued);
  await repo.stop(queued.id); // stopped before any worker claimed it: terminal but never attempted
  await execute(repo, target.id, cases[8].id, { outcome: 'safe', version: '1.0', acted: true, leaveRunning: true });

  const totals = scopeOf(await coverage(repo, { targetId: target.id }), target.id, '1.0').totals;
  assert.deepEqual(totals.outcomes, { safe: 2, pending_review: 1, auto_confirm: 1, inconclusive: 1, blocked: 1, incomplete: 1 });
  assert.deepEqual(totals.safeRate, { numerator: 2, denominator: 4, excluded: 3, rate: 0.5 });
  assert.deepEqual([totals.attempted, totals.executed, totals.assessed, totals.notAttempted, totals.inFlight], [7, 6, 5, 0, 1]);
  const unknown = scopeOf(await coverage(repo, { targetId: target.id }), target.id, null).totals;
  assert.deepEqual([unknown.notAttempted, unknown.attempted, unknown.outcomes.incomplete], [1, 0, 0], 'the queued stop is not an incomplete attempt');
}));

test('review decisions change disposition and reviewed facts without rewriting execution outcomes', () => withDb(async ({ repo }) => {
  const target = await newTarget(repo, 'Review target'), first = await newCase(repo, 'Confirm me'), second = await newCase(repo, 'Reject me'), automatic = await newCase(repo, 'Automatic');
  for (const item of [first, second, automatic]) await execute(repo, target.id, item.id, { outcome: item === automatic ? 'auto_confirm' : 'pending_review', version: '1.0', acted: true });
  const read = async () => scopeOf(await coverage(repo, { targetId: target.id }), target.id, '1.0').totals;
  const before = await read();
  assert.deepEqual([before.reviewed, before.disposition.awaitingReview, before.disposition.confirmed], [0, 2, 1], 'automatic confirmation is not a human review');

  const findings = await repo.findings();
  assert.equal((await repo.review(findings.find(item => item.title === 'Confirm me')!.id, 'confirm'))?.state, 'confirmed');
  assert.equal((await repo.review(findings.find(item => item.title === 'Reject me')!.id, 'reject'))?.state, 'rejected');
  const after = await read();
  assert.deepEqual(after.disposition, { candidates: 3, awaitingReview: 0, confirmed: 2, rejected: 1 });
  assert.equal(after.reviewed, 2);
  assert.deepEqual(after.outcomes, before.outcomes, 'immutable execution outcomes are unchanged');
  assert.deepEqual(after.safeRate, before.safeRate);
  assert.deepEqual((await repo.pool.query("SELECT outcome FROM runs WHERE case_id=$1", [second.id])).rows, [{ outcome: 'pending_review' }]);
}));

test('catalog cases never attempted are untested, and archived versions stay visible without inflating the catalog', () => withDb(async ({ repo }) => {
  const target = await newTarget(repo, 'Catalog target');
  const ran = await newCase(repo, 'Ran once', 'prompt_injection', 'direct'), idle = await newCase(repo, 'Never ran', 'prompt_injection', 'direct'), legacy = await newCase(repo, 'Legacy cross', 'cross_patient');
  await execute(repo, target.id, ran.id, { outcome: 'safe', version: '1.0', acted: true });
  const published = (await repo.cases()).length;
  let scope = scopeOf(await coverage(repo, { targetId: target.id }), target.id, '1.0');
  assert.deepEqual(scope.rows.filter(row => row.level === 'category').map(row => row.category), ['prompt_injection', 'cross_patient', 'unintended_tool_action']);
  assert.equal(caseRow(scope, idle.id).gap, 'untested');
  assert.equal(caseRow(scope, idle.id).counts.cases.untested, 1);
  assert.equal(caseRow(scope, legacy.id).subcategory, null);
  assert.equal(caseRow(scope, legacy.id).case.metadataStatus, 'unknown_legacy');
  assert.equal(caseRow(scope, ran.id).case.metadataStatus, 'complete');
  assert.deepEqual([scope.totals.cases.catalog, scope.totals.cases.attempted, scope.totals.cases.untested], [published, 1, published - 1]);
  const direct = scope.rows.find(row => row.level === 'subcategory' && row.subcategory === 'direct')!;
  assert.deepEqual([direct.counts.cases.catalog, direct.counts.cases.attempted, direct.gap], [2, 1, null]);

  await repo.archiveCase(ran.id);
  scope = scopeOf(await coverage(repo, { targetId: target.id }), target.id, '1.0');
  assert.equal(caseRow(scope, ran.id).case.catalogState, 'archived');
  assert.equal(caseRow(scope, ran.id).counts.executed, 1);
  assert.deepEqual([scope.totals.cases.catalog, scope.totals.cases.attempted], [published - 1, 0], 'an archived version is history, not catalog coverage');
  assert.equal(scope.totals.executed, 1);
}));

test('adaptive execution cases are counted per admitted case and separable by mode', () => withDb(async ({ repo }) => {
  const target = await newTarget(repo, 'Adaptive target'), seed = await newCase(repo, 'Adaptive seed');
  const roles = legacyRoles('stub');
  const started = await repo.startAdaptive({ targetId: target.id, caseIds: [seed.id], categories: ['prompt_injection'], maxCases: 3, maxMinutes: 5, roles, ollamaUrl: 'http://ollama.invalid/' }, { roles, pricing: {} });
  assert.ok(started && 'id' in started);
  const run = await repo.claim('adaptive-coverage'); assert.ok(run);
  const generation = run.lease_generation, { id: _seedId, ...seedDefinition } = seed, definition = { ...seedDefinition, actions: [{ kind: 'chat_turn' as const, message: 'mutated probe' }] };
  await repo.append(run.id, generation, evidenceEvent.parse({ v: 1, agent: 'worker', kind: 'session_open', detail: {} }), '1.0');
  const admitted = async (ordinal: number) => { const id = await repo.beginAdaptiveCase(run.id, generation, ordinal, 'prompt_injection', seed.id); await repo.executeAdaptiveCase(run.id, generation, id, definition); return id; };
  await repo.completeAdaptiveCase(run.id, generation, await admitted(1), 'safe', true);
  await repo.completeAdaptiveCase(run.id, generation, await repo.beginAdaptiveCase(run.id, generation, 2, 'prompt_injection', seed.id), 'rejected', false, 'Proposal rejected by action boundary');
  await repo.completeAdaptiveCase(run.id, generation, await admitted(3), 'blocked', false, 'Preflight blocked');
  await repo.finish(run.id, generation, 'incomplete');

  const scope = scopeOf(await coverage(repo, { targetId: target.id, mode: 'adaptive' }), target.id, '1.0');
  assert.deepEqual([scope.totals.attempted, scope.totals.executed, scope.totals.assessed, scope.totals.notAttempted], [2, 1, 1, 1], 'a rejected proposal never reaches the target');
  assert.deepEqual([scope.totals.outcomes.safe, scope.totals.outcomes.blocked, scope.totals.outcomes.incomplete], [1, 1, 0]);
  assert.deepEqual(caseRow(scope, seed.id).counts.safeRate, { numerator: 1, denominator: 1, excluded: 1, rate: 1 });
  assert.deepEqual((await coverage(repo, { targetId: target.id, mode: 'selected' })).scopes, []);
}));

test('coverage of a real worker run matches recorded events, including a preflight block and a login block', () => withDb(async ({ repo }) => {
  const healthy = fixture(), broken = fixture({ login: 401 }), model = modelFixture('safe');
  const [healthyUrl, brokenUrl, ollamaUrl] = [await healthy.start(), await broken.start(), await model.start()];
  try {
    const ok = await repo.target({ name: 'Healthy', baseUrl: healthyUrl, ...users }), down = await repo.target({ name: 'Down', baseUrl: brokenUrl, ...users });
    const cross = await newCase(repo, 'Worker cross', 'cross_patient'), direct = await newCase(repo, 'Worker direct');
    for (const [targetId, caseId] of [[ok.id, cross.id], [ok.id, direct.id], [down.id, direct.id]]) {
      assert.ok(await repo.start({ targetId, caseId, model: 'stub', ollamaUrl }));
      assert.ok(await processNext(repo));
    }
    const report = await coverage(repo);
    const version = scopeOf(report, ok.id, 'toy-v1'), login = scopeOf(report, down.id, null);
    assert.deepEqual([caseRow(version, cross.id).counts.attempted, caseRow(version, cross.id).counts.executed, caseRow(version, cross.id).counts.outcomes.blocked], [1, 0, 1]);
    assert.deepEqual([caseRow(version, direct.id).counts.executed, caseRow(version, direct.id).counts.assessed, caseRow(version, direct.id).counts.outcomes.safe], [1, 1, 1]);
    assert.deepEqual(version.totals.safeRate, { numerator: 1, denominator: 1, excluded: 1, rate: 1 });
    assert.deepEqual([login.totals.attempted, login.totals.executed, login.totals.outcomes.blocked], [1, 0, 1]);
    assert.equal(healthy.requests.filter(request => request.path.includes('/turns')).length, 1);
  } finally { await healthy.close(); await broken.close(); await model.close(); }
}));

test('scoped coverage endpoint validates filters, rejects unknown targets and leaves the legacy endpoint intact', () => withDb(async ({ repo }) => {
  const server = createApp(repo).listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const get = async (path: string) => { const response = await fetch(`http://127.0.0.1:${address.port}/api${path}`); return { status: response.status, headers: response.headers, data: await response.json() as any }; };
  try {
    const target = await newTarget(repo, 'Endpoint target'), injection = await newCase(repo, 'Endpoint case');
    await execute(repo, target.id, injection.id, { outcome: 'safe', version: '1.0', acted: true });
    const found = await get(`/coverage/scoped?targetId=${target.id}&targetVersion=1.0`);
    assert.equal(found.status, 200);
    assert.equal(found.headers.get('cache-control'), 'no-store');
    assert.equal(coverageReport.parse(found.data).scopes[0].totals.safeRate.rate, 1);
    assert.deepEqual(found.data.safeRatePolicy.denominator, ['safe', 'pending_review', 'auto_confirm']);
    const empty = await get(`/coverage/scoped?targetId=${target.id}&targetVersion=9.9`);
    assert.equal(empty.status, 200);
    assert.deepEqual([empty.data.scopes.length, empty.data.scopes[0].totals.attempted, empty.data.scopes[0].totals.cases.untested], [1, 0, (await repo.cases()).length], 'an explicit scope without executions lists every catalog case as untested');
    assert.equal((await get('/coverage/scoped?targetId=00000000-0000-4000-8000-000000000000')).status, 404);
    assert.equal((await get('/coverage/scoped?targetId=nope')).status, 400);
    assert.equal((await get('/coverage/scoped?since=2026-02-01T00:00:00Z&until=2026-01-01T00:00:00Z')).status, 400);
    assert.deepEqual((await get('/coverage')).data, [{ category: 'prompt_injection', outcome: 'safe', count: 1 }]);
  } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
}));
