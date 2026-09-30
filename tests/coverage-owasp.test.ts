import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../apps/api/src/app.js';
import type { Repository } from '../apps/api/src/repository.js';
import { coverageOwaspRow, coverageQuery, coverageReport, evidenceEvent, type CoverageOwaspRow, type CoverageReport, type CoverageScope, type Outcome } from '../packages/contracts/src/index.js';
import { database, users } from './support.js';
import { legacyRoles } from '../apps/worker/src/models.js';

// OWASP dimension of scoped coverage (HDX-45). Every test uses synthetic identifiers (XT..:2099) so the seeded
// starter matrix, which is OWASP-mapped with real tags, never shares a row with the cases under test.
type Db = Awaited<ReturnType<typeof database>>;
const rubric = (owaspMappings: string[]) => ({ v: 1 as const, subcategory: 'owasp probe', owaspMappings, severity: 'high' as const, severityRationale: 'r', exploitabilityRationale: 'r', boundary: 'b', invariant: 'i', regressionRisk: 'r' });
const base = { user: 'A' as const, expectedSafeBehavior: 'Stay within the synthetic task.', actions: [{ kind: 'chat_turn' as const, message: 'probe' }] };
const mapped = (repo: Repository, title: string, owaspMappings: string[]) => repo.createCase({ ...base, title, category: 'prompt_injection', rubric: rubric(owaspMappings) });
const legacy = (repo: Repository, title: string) => repo.createCase({ ...base, title }); // no category and no rubric, like the pre-matrix starters
const newTarget = (repo: Repository, name: string) => repo.target({ name, baseUrl: 'http://synthetic.invalid/', ...users });
const coverage = (repo: Repository, query: Record<string, string> = {}) => repo.scopedCoverage(coverageQuery.parse(query)).then(report => { assert.ok(report); return report; });
const scopeOf = (report: CoverageReport, targetId: string, version: string | null) => {
  const scope = report.scopes.find(item => item.target.id === targetId && item.targetVersion === version);
  assert.ok(scope, `scope ${targetId}@${version}`);
  return scope;
};
const tagRow = (scope: CoverageScope, tag: string) => {
  const row = scope.owasp.find(item => item.kind === 'tag' && item.tag === tag);
  assert.ok(row && row.kind === 'tag', `OWASP row ${tag}`);
  return row;
};
const hasTag = (scope: CoverageScope, tag: string) => scope.owasp.some(row => row.kind === 'tag' && row.tag === tag);
const unmappedRow = (scope: CoverageScope) => scope.owasp.find(item => item.kind === 'unmapped');
const titles = (row: { cases: { title: string }[] }) => row.cases.map(item => item.title);
// Independent cross-check: an OWASP row is exactly the sum of the case rows it lists, so it can never invent a safe result.
function assertDerivedFromCaseRows(scope: CoverageScope) {
  const caseRows = new Map(scope.rows.flatMap(row => row.level === 'case' ? [[row.case.id, row] as const] : []));
  for (const row of scope.owasp) {
    const list = row.cases.map(ref => { const found = caseRows.get(ref.id); assert.ok(found, `${ref.title} has a case row`); return found; });
    for (const key of ['safe', 'pending_review', 'auto_confirm', 'inconclusive', 'blocked', 'incomplete'] as const)
      assert.equal(row.counts.outcomes[key], list.reduce((total, item) => total + item.counts.outcomes[key], 0), `${row.kind === 'tag' ? row.tag : 'unmapped'} ${key}`);
    const { numerator, denominator, excluded, rate } = row.counts.safeRate;
    assert.equal(numerator, row.counts.outcomes.safe);
    assert.equal(denominator, row.counts.outcomes.safe + row.counts.outcomes.pending_review + row.counts.outcomes.auto_confirm);
    assert.equal(excluded, row.counts.outcomes.inconclusive + row.counts.outcomes.blocked + row.counts.outcomes.incomplete);
    assert.equal(rate, denominator ? numerator / denominator : null);
    assert.equal(row.counts.cases.catalog, list.filter(item => item.case.catalogState === 'published').length);
  }
}
// Drives the same repository calls the worker makes, without a target (see tests/coverage-scoped.test.ts).
async function execute(repo: Repository, targetId: string, caseId: string, options: { outcome: Outcome; version?: string; acted?: boolean; leaveRunning?: boolean }) {
  const started = await repo.start({ targetId, caseId, model: 'stub', ollamaUrl: 'http://ollama.invalid/' });
  assert.ok(started && 'id' in started);
  const run = await repo.claim('owasp-coverage-test');
  assert.equal(run?.id, started.id);
  const emit = (agent: 'worker' | 'target', kind: string, version?: string) => repo.append(run.id, run.lease_generation, evidenceEvent.parse({ v: 1, agent, kind, detail: {} }), version);
  if (options.version) await emit('worker', 'session_open', options.version);
  if (options.acted) await emit('target', 'turn');
  if (!options.leaveRunning) await repo.finish(run.id, run.lease_generation, options.outcome);
  return started.id;
}
async function withDb(work: (db: Db) => Promise<void>) { const db = await database(); try { await work(db); } finally { await db.close(); } }

test('the OWASP row contract is strict and discriminated', () => {
  const counts = { attempted: 0, executed: 0, assessed: 0, reviewed: 0, notAttempted: 0, inFlight: 0, outcomes: { safe: 0, pending_review: 0, auto_confirm: 0, inconclusive: 0, blocked: 0, incomplete: 0 },
    disposition: { candidates: 0, awaitingReview: 0, confirmed: 0, rejected: 0 }, safeRate: { numerator: 0, denominator: 0, excluded: 0, rate: null }, cases: { catalog: 0, attempted: 0, executed: 0, untested: 0 } };
  const row = { counts, gap: 'untested', cases: [] };
  assert.equal(coverageOwaspRow.safeParse({ kind: 'tag', tag: 'LLM01:2025', ...row }).success, true);
  assert.equal(coverageOwaspRow.safeParse({ kind: 'unmapped', ...row }).success, true);
  assert.equal(coverageOwaspRow.safeParse({ kind: 'tag', ...row }).success, false, 'a tag row needs its tag');
  assert.equal(coverageOwaspRow.safeParse({ kind: 'tag', tag: '', ...row }).success, false);
  assert.equal(coverageOwaspRow.safeParse({ kind: 'unmapped', tag: 'LLM01:2025', ...row }).success, false, 'the unmapped bucket carries no tag');
  assert.equal(coverageOwaspRow.safeParse({ kind: 'other', ...row }).success, false);
});

test('a case with several OWASP tags contributes to each tag; rows overlap while the scope total counts it once', () => withDb(async ({ repo }) => {
  const target = await newTarget(repo, 'OWASP overlap');
  const both = await mapped(repo, 'Both tags', ['XT01:2099', 'XT02:2099']);
  const first = await mapped(repo, 'First tag only', [' xt01:2099 ', 'XT01:2099']); // spelling and duplicates collapse to one tag
  await execute(repo, target.id, both.id, { outcome: 'safe', version: '1.0', acted: true });
  await execute(repo, target.id, first.id, { outcome: 'inconclusive', version: '1.0', acted: true });
  await execute(repo, target.id, both.id, { outcome: 'pending_review', version: '2.0', acted: true });

  const report = await coverage(repo, { targetId: target.id });
  const v1 = scopeOf(report, target.id, '1.0'), v2 = scopeOf(report, target.id, '2.0');
  const one = tagRow(v1, 'XT01:2099'), two = tagRow(v1, 'XT02:2099');
  assert.deepEqual(titles(one), ['Both tags', 'First tag only']);
  assert.deepEqual(titles(two), ['Both tags']);
  assert.deepEqual(one.counts.outcomes, { safe: 1, pending_review: 0, auto_confirm: 0, inconclusive: 1, blocked: 0, incomplete: 0 });
  assert.deepEqual(one.counts.safeRate, { numerator: 1, denominator: 1, excluded: 1, rate: 1 });
  assert.deepEqual(two.counts.safeRate, { numerator: 1, denominator: 1, excluded: 0, rate: 1 });
  assert.equal(one.counts.outcomes.safe + two.counts.outcomes.safe, 2, 'the shared case is counted under each of its tags');
  assert.equal(v1.totals.outcomes.safe, 1, 'but once in the scope total');
  assert.equal(hasTag(v1, 'xt01:2099'), false, 'only the normalized spelling exists');
  // Tags ascend; nothing is pooled across target versions.
  const tags = v1.owasp.flatMap(row => row.kind === 'tag' ? [row.tag] : []);
  assert.deepEqual(tags, [...tags].sort());
  assert.deepEqual(tagRow(v2, 'XT01:2099').counts.safeRate, { numerator: 0, denominator: 1, excluded: 0, rate: 0 }, 'a suspected violation is in the denominator, never safe');
  assert.deepEqual(tagRow(v2, 'XT02:2099').counts.outcomes.pending_review, 1);
  assertDerivedFromCaseRows(v1); assertDerivedFromCaseRows(v2);
}));

test('a non-safe outcome is never counted as safe under an OWASP tag', () => withDb(async ({ repo }) => {
  const target = await newTarget(repo, 'OWASP denominators');
  type Kind = Outcome | 'never_run' | 'queued_stop' | 'running';
  // [numerator, denominator, excluded, rate] for a tag whose only case ended this way, the gap it reports and whether the case counts as untested.
  const table: { tag: string; kind: Kind; acted: boolean; rate: [number, number, number, number | null]; gap: string | null; untested: number }[] = [
    { tag: 'XT10:2099', kind: 'safe', acted: true, rate: [1, 1, 0, 1], gap: null, untested: 0 }, // positive control: the only kind that may be safe
    { tag: 'XT11:2099', kind: 'pending_review', acted: true, rate: [0, 1, 0, 0], gap: null, untested: 0 },
    { tag: 'XT12:2099', kind: 'auto_confirm', acted: true, rate: [0, 1, 0, 0], gap: null, untested: 0 },
    { tag: 'XT13:2099', kind: 'inconclusive', acted: true, rate: [0, 0, 1, null], gap: 'inconclusive', untested: 0 },
    { tag: 'XT14:2099', kind: 'blocked', acted: false, rate: [0, 0, 1, null], gap: 'blocked', untested: 0 },
    { tag: 'XT15:2099', kind: 'incomplete', acted: true, rate: [0, 0, 1, null], gap: 'incomplete', untested: 0 },
    { tag: 'XT16:2099', kind: 'never_run', acted: false, rate: [0, 0, 0, null], gap: 'untested', untested: 1 },
    { tag: 'XT17:2099', kind: 'queued_stop', acted: false, rate: [0, 0, 0, null], gap: 'untested', untested: 1 },
    { tag: 'XT18:2099', kind: 'running', acted: true, rate: [0, 0, 0, null], gap: 'in_flight', untested: 1 }];
  for (const item of table) {
    const probe = await mapped(repo, `Probe ${item.kind}`, [item.tag]);
    if (item.kind === 'never_run') continue;
    if (item.kind === 'queued_stop') { const queued = await repo.start({ targetId: target.id, caseId: probe.id, model: 'stub', ollamaUrl: 'http://ollama.invalid/' }); assert.ok(queued && 'id' in queued); await repo.stop(queued.id); continue; }
    if (item.kind === 'running') continue; // started last: a running run blocks the target's next start
    await execute(repo, target.id, probe.id, { outcome: item.kind, version: '1.0', acted: item.acted });
  }
  // One tag that mixes every kind, and one that mixes everything except a safe result.
  const mixed: [string, Outcome | 'never_run'][] = [['XT98:2099', 'inconclusive'], ['XT98:2099', 'blocked'], ['XT98:2099', 'incomplete'], ['XT98:2099', 'never_run'],
    ['XT99:2099', 'safe'], ['XT99:2099', 'pending_review'], ['XT99:2099', 'inconclusive'], ['XT99:2099', 'blocked'], ['XT99:2099', 'incomplete'], ['XT99:2099', 'never_run']];
  for (const [tag, kind] of mixed) {
    const item = await mapped(repo, `${tag} ${kind}`, [tag]);
    if (kind !== 'never_run') await execute(repo, target.id, item.id, { outcome: kind, version: '1.0', acted: kind !== 'blocked' });
  }
  const running = await repo.pool.query("SELECT id FROM cases WHERE definition->>'title'='Probe running'");
  await execute(repo, target.id, running.rows[0].id, { outcome: 'safe', version: '1.0', acted: true, leaveRunning: true });
  const scope = scopeOf(await coverage(repo, { targetId: target.id }), target.id, '1.0');
  for (const item of table) {
    const row = tagRow(scope, item.tag), { numerator, denominator, excluded, rate } = row.counts.safeRate;
    assert.deepEqual([numerator, denominator, excluded, rate], item.rate, `${item.kind} safe rate`);
    assert.equal(row.counts.outcomes.safe, item.kind === 'safe' ? 1 : 0, `${item.kind} is safe only when it is safe`);
    assert.equal(row.gap, item.gap, `${item.kind} gap`);
    assert.deepEqual([row.counts.cases.catalog, row.counts.cases.untested], [1, item.untested], `${item.kind} cases`);
  }
  const unsafe = tagRow(scope, 'XT98:2099');
  assert.deepEqual(unsafe.counts.safeRate, { numerator: 0, denominator: 0, excluded: 3, rate: null }, 'inconclusive, blocked and incomplete are excluded, never safe');
  assert.deepEqual([unsafe.counts.outcomes.safe, unsafe.gap, unsafe.counts.cases.untested], [0, 'inconclusive', 1]);
  const all = tagRow(scope, 'XT99:2099');
  assert.deepEqual(all.counts.safeRate, { numerator: 1, denominator: 2, excluded: 3, rate: 0.5 }, 'a suspected violation counts against the rate; excluded kinds stay out of it');
  assert.equal(all.counts.cases.untested, 1);
  assertDerivedFromCaseRows(scope);
}));

test('cases without an OWASP mapping are an explicit unmapped bucket, never dropped and never safe by default', () => withDb(async ({ repo }) => {
  const target = await newTarget(repo, 'OWASP unmapped');
  const old = await legacy(repo, 'Legacy no rubric'), empty = await mapped(repo, 'Empty mapping', []), tagged = await mapped(repo, 'Tagged case', ['XT20:2099']);
  await mapped(repo, 'Blank tags', ['  ', '']); // whitespace-only tags are no mapping
  await execute(repo, target.id, old.id, { outcome: 'inconclusive', version: '1.0', acted: true });
  await execute(repo, target.id, tagged.id, { outcome: 'safe', version: '1.0', acted: true });

  const scope = scopeOf(await coverage(repo, { targetId: target.id }), target.id, '1.0');
  const unmapped = unmappedRow(scope);
  assert.ok(unmapped, 'an unmapped row exists');
  assert.equal(scope.owasp.at(-1), unmapped, 'unmapped is last');
  for (const title of ['Legacy no rubric', 'Empty mapping', 'Blank tags']) assert.ok(titles(unmapped).includes(title), `${title} is unmapped`);
  assert.equal(titles(unmapped).includes('Tagged case'), false);
  assert.equal(scope.owasp.filter(row => row.kind === 'unmapped').length, 1);
  // The three pre-matrix starters carry no rubric, so they are here too, as legacy, untested and never safe.
  const starters = ['Starter: direct instruction override', 'Starter: Co-Pilot chart-context isolation', 'Starter: unintended chart action'];
  for (const title of starters) {
    const ref: CoverageOwaspRow['cases'][number] | undefined = unmapped.cases.find(item => item.title === title);
    assert.ok(ref, `${title} is listed under unmapped`);
    assert.deepEqual([ref.catalogState, ref.metadataStatus], ['published', 'unknown_legacy']);
  }
  // Only the executed legacy case has an outcome; everything else is untested, not safe.
  assert.deepEqual(unmapped.counts.outcomes, { safe: 0, pending_review: 0, auto_confirm: 0, inconclusive: 1, blocked: 0, incomplete: 0 });
  assert.deepEqual(unmapped.counts.safeRate, { numerator: 0, denominator: 0, excluded: 1, rate: null });
  assert.equal(unmapped.gap, 'inconclusive');
  assert.equal(unmapped.counts.cases.untested, unmapped.counts.cases.catalog - 1, 'every unmapped case but the executed one is untested');
  assert.equal(unmapped.counts.cases.attempted, 1);
  // An unmapped result never leaks into a tag, and a tagged result never leaks into the bucket.
  const tag = tagRow(scope, 'XT20:2099');
  assert.deepEqual([tag.counts.outcomes.safe, tag.counts.outcomes.inconclusive, tag.counts.safeRate.rate], [1, 0, 1]);
  assertDerivedFromCaseRows(scope);

  // An unmapped case that genuinely passed is reported as safe inside the unmapped bucket only.
  await execute(repo, target.id, empty.id, { outcome: 'safe', version: '1.0', acted: true });
  const after = scopeOf(await coverage(repo, { targetId: target.id }), target.id, '1.0');
  assert.deepEqual(unmappedRow(after)!.counts.safeRate, { numerator: 1, denominator: 1, excluded: 1, rate: 1 });
  assert.equal(tagRow(after, 'XT20:2099').counts.safeRate.numerator, 1);
  assertDerivedFromCaseRows(after);
}));

test('there is no unmapped row once every case is mapped, and an executed unmapped version stays as history after it is archived', () => withDb(async ({ repo }) => {
  const target = await newTarget(repo, 'OWASP archive');
  const starterIds = (await repo.pool.query("SELECT id FROM cases WHERE state='published' AND NOT (definition ? 'rubric')")).rows.map(row => row.id as string);
  assert.equal(starterIds.length, 3, 'the three pre-matrix starters');
  for (const id of starterIds) assert.ok(await repo.archiveCase(id));
  const tagged = await mapped(repo, 'Tagged then archived', ['XT30:2099']);
  await execute(repo, target.id, tagged.id, { outcome: 'safe', version: '1.0', acted: true });
  let scope = scopeOf(await coverage(repo, { targetId: target.id }), target.id, '1.0');
  assert.equal(unmappedRow(scope), undefined, 'nothing is unmapped, so no empty bucket is invented');
  assert.equal(scope.owasp.every(row => row.kind === 'tag'), true);

  const old = await legacy(repo, 'Legacy run then archived');
  await execute(repo, target.id, old.id, { outcome: 'blocked', version: '1.0' });
  await repo.archiveCase(old.id); await repo.archiveCase(tagged.id);
  scope = scopeOf(await coverage(repo, { targetId: target.id }), target.id, '1.0');
  const unmapped = unmappedRow(scope);
  assert.ok(unmapped, 'an executed archived version without a mapping is still reported');
  assert.deepEqual([unmapped.cases[0].catalogState, unmapped.counts.outcomes.blocked, unmapped.counts.cases.catalog, unmapped.gap], ['archived', 1, 0, 'blocked']);
  const row = tagRow(scope, 'XT30:2099');
  assert.deepEqual([row.cases[0].catalogState, row.counts.executed, row.counts.outcomes.safe, row.counts.cases.catalog], ['archived', 1, 1, 0], 'archived history is kept and does not inflate the catalog');
  assertDerivedFromCaseRows(scope);
}));

test('adaptive executions count under the tags of their source seed case', () => withDb(async ({ repo }) => {
  const target = await newTarget(repo, 'OWASP adaptive'), seed = await mapped(repo, 'Adaptive seed', ['XT40:2099', 'XT41:2099']);
  const roles = legacyRoles('stub');
  const started = await repo.startAdaptive({ targetId: target.id, caseIds: [seed.id], categories: ['prompt_injection'], maxCases: 3, maxMinutes: 5, roles, ollamaUrl: 'http://ollama.invalid/' }, { roles, pricing: {} });
  assert.ok(started && 'id' in started);
  const run = await repo.claim('adaptive-owasp'); assert.ok(run);
  const generation = run.lease_generation, { id: _seedId, ...seedDefinition } = seed, definition = { ...seedDefinition, actions: [{ kind: 'chat_turn' as const, message: 'mutated probe' }] };
  await repo.append(run.id, generation, evidenceEvent.parse({ v: 1, agent: 'worker', kind: 'session_open', detail: {} }), '1.0');
  const admitted = async (ordinal: number) => { const id = await repo.beginAdaptiveCase(run.id, generation, ordinal, 'prompt_injection', seed.id); await repo.executeAdaptiveCase(run.id, generation, id, definition); return id; };
  await repo.completeAdaptiveCase(run.id, generation, await admitted(1), 'safe', true);
  await repo.completeAdaptiveCase(run.id, generation, await admitted(2), 'blocked', false, 'Preflight blocked');
  await repo.completeAdaptiveCase(run.id, generation, await repo.beginAdaptiveCase(run.id, generation, 3, 'prompt_injection', seed.id), 'rejected', false, 'Proposal rejected by action boundary');
  await repo.finish(run.id, generation, 'incomplete');

  const scope = scopeOf(await coverage(repo, { targetId: target.id, mode: 'adaptive' }), target.id, '1.0');
  for (const tag of ['XT40:2099', 'XT41:2099']) {
    const row = tagRow(scope, tag);
    assert.deepEqual(titles(row), ['Adaptive seed']);
    assert.deepEqual([row.counts.attempted, row.counts.executed, row.counts.notAttempted, row.counts.outcomes.safe, row.counts.outcomes.blocked], [2, 1, 1, 1, 1], tag);
    assert.deepEqual(row.counts.safeRate, { numerator: 1, denominator: 1, excluded: 1, rate: 1 });
  }
  assert.deepEqual((await coverage(repo, { targetId: target.id, mode: 'selected' })).scopes, [], 'mode filtering applies to the OWASP view as it does to the rest');
  assertDerivedFromCaseRows(scope);
}));

test('the scoped coverage endpoint adds the OWASP view without changing rows or totals', () => withDb(async ({ repo }) => {
  const server = createApp(repo).listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  try {
    const target = await newTarget(repo, 'OWASP endpoint'), item = await mapped(repo, 'Endpoint mapped', ['XT50:2099']);
    await execute(repo, target.id, item.id, { outcome: 'safe', version: '1.0', acted: true });
    const response = await fetch(`http://127.0.0.1:${address.port}/api/coverage/scoped?targetId=${target.id}&targetVersion=1.0`);
    assert.equal(response.status, 200);
    const data = await response.json() as any;
    const parsed = coverageReport.parse(data); // strict: any unknown or missing field fails
    const scope = parsed.scopes[0];
    assert.deepEqual(Object.keys(data.scopes[0]).sort(), ['observed', 'owasp', 'rows', 'target', 'targetVersion', 'totals']);
    assert.deepEqual(tagRow(scope, 'XT50:2099').counts.safeRate, { numerator: 1, denominator: 1, excluded: 0, rate: 1 });
    assert.ok(scope.owasp.some(row => row.kind === 'unmapped'), 'the legacy starters are reported as unmapped');
    assert.deepEqual(scope.rows.filter(row => row.level === 'category').map(row => row.category), ['prompt_injection', 'cross_patient', 'unintended_tool_action']);
    assert.equal(scope.totals.outcomes.safe, 1);
  } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
}));
