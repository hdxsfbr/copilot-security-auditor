import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { createServer as createViteServer, type ViteDevServer } from 'vite';
import { launchFixtureBrowser } from './support.js';
import { regressionIdentityDetail, regressionIdentityList } from '../packages/contracts/src/regressions.js';
import { suiteDetail, suiteList, versionTrigger } from '../packages/contracts/src/regression-suites.js';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const t1 = id(1), t2 = id(2), busyRun = id(90), [idA, idB, idC] = [id(20), id(21), id(22)], run = (n: number) => id(100 + n), at = (minute: number) => new Date(Date.UTC(2026, 8, 20, 12, minute)).toISOString();
const flat = async (locator: { allTextContents(): Promise<string[]> }) => (await locator.allTextContents()).map(value => value.replace(/\s+/g, ' ').trim());
const output = resolve('test-results/HDX-27/after');
const judge = { provider: 'ollama', model: 'stub', maxOutputTokens: 1024 };
const targets = [{ id: t1, name: 'Synthetic chart target', baseUrl: 'http://fixture.invalid/', activeRunId: null }, { id: t2, name: 'Second synthetic target', baseUrl: 'http://second.invalid/', activeRunId: null }];
const entry = (state: string, reason: string, targetVersion: string | null, n: number, basis = 'replay') => ({ state, reason, targetVersion, basis, runId: run(n), observedAt: at(n) });
const summary = (identity: string, title: string, category: string, scopes: ReturnType<typeof entry>[], replayCount: number) => ({
  id: identity, normalizationVersion: 1, fingerprint: 'a'.repeat(64), category, user: 'A', title, createdAt: at(0), firstSeenFindingId: id(60), sourceFindingCount: 1, replayCount, latestReplays: [],
  targetStates: [{ targetId: t1, targetName: targets[0].name, current: scopes[0], scopes, pendingReplays: 0 }], actionCount: 1, attachmentCount: 0, firstMessage: title, sourceFindings: [] });
// Synthetic fail -> fix -> resurface on version labels toy-v1..v3, a blocked replay that is only Unknown, and a cross-category identity that keeps recurring.
const identities = [
  summary(idA, 'Cross chart override', 'cross_patient', [entry('resurfaced', 'violation_after_fix', 'toy-v3', 13), entry('fixed', 'safe_on_later_version', 'toy-v2', 12), entry('unknown', 'not_replayed_since_finding', 'toy-v1', 11, 'source_finding')], 2),
  summary(idB, 'Blocked probe', 'cross_patient', [entry('unknown', 'result_not_conclusive', null, 15), entry('unknown', 'not_replayed_since_finding', 'toy-v1', 11, 'source_finding')], 1),
  summary(idC, 'Tool action nudge', 'unintended_tool_action', [entry('recurring', 'violation_observed_again', 'toy-v2', 14), entry('unknown', 'not_replayed_since_finding', 'toy-v1', 11, 'source_finding')], 1)
];
const replay = (n: number, trigger: string, outcome: string, signal: string, version: string) => ({ id: id(200 + n), runId: run(n), regressionId: id(70), findingId: id(60), replayCaseId: id(80), targetId: t1, targetName: targets[0].name, targetVersion: version, status: 'finished', outcome, signal, trigger, createdAt: at(n), finishedAt: at(n) });
const detailA = { ...identities[0], v: 1, canonical: { v: 1, category: 'cross_patient', user: 'A', actions: [{ kind: 'chat_turn', message: 'Cross chart override' }] }, sourceFindings: [], replaysTruncated: false,
  replays: [replay(13, 'version_change', 'pending_review', 'violation_observed', 'toy-v3'), replay(12, 'suite', 'safe', 'no_violation_observed', 'toy-v2')] };
delete (detailA as { actionCount?: number }).actionCount; delete (detailA as { attachmentCount?: number }).attachmentCount; delete (detailA as { firstMessage?: string }).firstMessage;
const item = (ordinal: number, identity: string, title: string, state: string, extra: object = {}) => ({ ordinal, identityId: identity, title, category: 'cross_patient', regressionId: id(70 + ordinal), replayCaseId: id(80 + ordinal), state, runId: null, outcome: null, targetVersion: null, signal: null, versionCheck: null, reason: null, startedAt: null, finishedAt: null, ...extra });
const settings = { roles: { judge }, ollamaUrl: 'http://127.0.0.1:11434', maxItems: 25, maxMinutes: 60 };
const suiteBase = (suite: string, state: string, trigger: string, counts: object, outcomes: object) => ({ id: suite, targetId: t1, targetName: targets[0].name, trigger, expectedVersion: 'toy-v3', state, createdAt: at(20), finishedAt: state === 'active' ? null : at(30), maxMinutes: 60, omittedCount: 0, counts, outcomes });
const suites = [
  suiteBase(id(40), 'active', 'manual', { pending: 1, running: 1, finished: 1, skipped: 0 }, { safe: 1 }),
  suiteBase(id(41), 'completed', 'version_change', { pending: 0, running: 0, finished: 2, skipped: 1 }, { safe: 1, blocked: 1 })
];
const suiteItems: Record<string, ReturnType<typeof item>[]> = {
  [id(40)]: [item(1, idA, 'Cross chart override', 'finished', { runId: run(31), outcome: 'safe', signal: 'no_violation_observed', targetVersion: 'toy-v4', versionCheck: 'differs' }), item(2, idB, 'Blocked probe', 'running', { runId: run(32), signal: 'in_progress' }), item(3, idC, 'Tool action nudge', 'pending')],
  [id(41)]: [item(1, idA, 'Cross chart override', 'finished', { runId: run(33), outcome: 'safe', signal: 'no_violation_observed', targetVersion: 'toy-v3', versionCheck: 'matches' }), item(2, idB, 'Blocked probe', 'finished', { runId: run(34), outcome: 'blocked', signal: 'unknown', versionCheck: 'unverified' }), item(3, idC, 'Tool action nudge', 'skipped', { reason: 'suite_time_budget_exhausted' })]
};
const preflightOk = { status: 'available', inferenceHealth: 'unverified', issues: [], local: { status: 'available', installed: ['stub'] }, paid: { status: 'not_required', configured: false }, preview: { reservationNanos: '0', capNanos: null, attempts: 1, basis: 'one_call_per_active_role_per_attempt' } };
const seed = (caseId: string, title: string) => ({ id: caseId, title, category: 'cross_patient', user: 'A', expectedSafeBehavior: 'Stay in chart', actions: [{ kind: 'chat_turn', message: title }] });

async function harness(viewport = { width: 1440, height: 1200 }, start = '/regressions') {
  const server: ViteDevServer = await createViteServer({ configFile: resolve('apps/web/vite.config.ts'), server: { host: '127.0.0.1', port: 0 }, logLevel: 'error' });
  await server.listen();
  const address = server.httpServer?.address();
  assert.ok(address && typeof address !== 'string');
  const browser = await launchFixtureBrowser();
  const page = await browser.newPage({ viewport });
  const calls: { method: string; path: string; body: any }[] = [], gets: string[] = [], errors: string[] = [];
  page.on('requestfailed', request => { if (process.env.UI_DEBUG) console.error('requestfailed', request.url(), request.failure()?.errorText); });
  const triggers = targets.map(target => ({ targetId: target.id, targetName: target.name, enabled: false, settings: null, lastSeenVersion: 'toy-v3', lastTriggeredVersion: null, updatedAt: null }));
  const board = { suites: [...suites] as any[], launch: 'ok' as 'ok' | 'busy', preflight: preflightOk as any };
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/api/**', async route => {
    const request = route.request(), url = new URL(request.url()), path = url.pathname.slice('/api'.length), method = request.method();
    if (!url.pathname.startsWith('/api/')) return route.continue(); // the glob also matches source files under /src/api/
    const body = request.postData() ? JSON.parse(request.postData()!) : undefined;
    const reply = (payload: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(payload) });
    if (method === 'GET') gets.push(path + url.search); else calls.push({ method, path, body });
    if (path === '/targets') return reply(targets);
    if (path === '/cases') return reply([seed(id(50), 'Override case')]);
    if (path === '/config') return reply({ ollamaUrl: 'http://127.0.0.1:11434', model: 'stub' });
    if (path === '/models') return reply({ openrouter: ['fixture/paid'], ollama: ['stub'], configured: true, inferenceHealth: 'unverified', availability: { openrouter: 'available', ollama: 'available' } });
    if (path === '/findings') return reply([{ id: 'finding-source', runId: 'run-source', state: 'confirmed', title: 'Synthetic finding', version: null, decisionRoute: null, exportApprovedAt: null }]);
    if (path === '/regressions') return reply([{ id: 'regression-source', sourceRunId: 'run-source', version: null, definition: { title: 'Cross chart override' }, replays: [] }]);
    if (['/coverage', '/schedules', '/run-definitions'].includes(path)) return reply([]);
    if (path === '/regression-identities') return reply(regressionIdentityList.parse({ v: 1, items: url.searchParams.get('targetId') === t2 ? [] : identities, nextCursor: null, unlinked: { count: 0, items: [] } }));
    if (path === `/regression-identities/${idA}`) return reply(regressionIdentityDetail.parse(detailA));
    if (path === '/regression-suites/preflight') return reply(board.preflight);
    if (path === '/regression-suites' && method === 'GET') return reply(suiteList.parse({ v: 1, items: board.suites, nextCursor: null }));
    if (path === '/regression-suites') {
      if (board.launch === 'busy') return reply({ v: 1, code: 'conflict', message: 'Target already reserved', active_run_id: busyRun }, 409);
      const created = suiteBase(id(42), 'active', 'manual', { pending: 2, running: 1, finished: 0, skipped: 0 }, {});
      board.suites.unshift({ ...created, expectedVersion: body.expectedVersion ?? null });
      suiteItems[id(42)] = [item(1, idA, 'Cross chart override', 'running', { runId: run(35), signal: 'in_progress' })];
      return reply(suiteDetail.parse({ ...created, v: 1, settings, items: suiteItems[id(42)] }), 202);
    }
    const found = /^\/regression-suites\/([^/]+)(\/stop)?$/.exec(path);
    if (found && found[2]) { board.suites = board.suites.map(suite => suite.id === found[1] ? { ...suite, state: 'stopped' } : suite); return reply({ ok: true }, 202); }
    if (found) return reply(suiteDetail.parse({ ...board.suites.find(suite => suite.id === found[1]), v: 1, settings, items: suiteItems[found[1]] }));
    if (path === '/regression-triggers') return reply(triggers.map(row => versionTrigger.parse(row)));
    const trigger = /^\/regression-triggers\/([^/]+)$/.exec(path);
    if (trigger && method === 'PUT') {
      const row = triggers.find(value => value.targetId === trigger[1])!;
      Object.assign(row, body.enabled ? { enabled: true, settings: body.settings, updatedAt: at(40) } : { enabled: false, updatedAt: at(41) });
      return reply(row);
    }
    return reply({ message: `Unexpected synthetic request ${path}` }, 404);
  });
  const base = `http://127.0.0.1:${address.port}`;
  await page.goto(`${base}${start}`, { waitUntil: 'networkidle' });
  return { page, calls, gets, board, errors, base, close: async () => { await browser.close(); await server.close(); } };
}

test('regression page shows per-version state chips, lineage and suites; unknown is never worded as fixed', async () => {
  const { page, calls, gets, errors, close } = await harness();
  try {
    await page.getByRole('heading', { name: 'Regression state' }).waitFor();
    const [a, b, c] = ['Cross chart override', 'Blocked probe', 'Tool action nudge'].map(title => page.locator('.identity-card', { hasText: title }));
    await a.getByText('Resurfaced').first().waitFor();
    assert.deepEqual(await flat(a.locator('.state-scopes .state-chip')), ['↺ Resurfaced · toy-v3', '✓ Fixed · toy-v2', '? Unknown · toy-v1']);
    await a.getByText('Safe replay on a later verified version').waitFor();
    await a.getByText('Violation observed after an earlier fix').waitFor();
    assert.equal(await b.getByText('Fixed').count(), 0, 'a blocked replay is Unknown, never Fixed');
    assert.deepEqual(await flat(b.locator('.state-scopes .state-chip')), ['? Unknown · version not verified', '? Unknown · toy-v1']);
    await b.getByText('Latest replay was inconclusive, blocked or incomplete').waitFor();
    assert.deepEqual((await flat(c.locator('.state-scopes .state-chip')))[0], '▲ Recurring · toy-v2');
    assert.equal(await page.getByRole('button', { name: 'Select for replay' }).count(), 1, 'the per-definition replay selection is kept');
    await a.getByText('Replay lineage (2)').click();
    await a.getByText(/version change · Synthetic chart target · toy-v3 · pending_review \(violation observed\)/).waitFor();
    await a.getByText(/suite · Synthetic chart target · toy-v2 · safe \(no violation observed\)/).waitFor();
    await page.locator('.regression-filter select').selectOption(t1);
    await page.getByLabel('Version (exact, optional)').fill('toy-v2');
    await page.waitForFunction(() => document.querySelector<HTMLInputElement>('input[maxlength="200"]')?.value === 'toy-v2');
    assert.ok(gets.some(path => path === `/regression-identities?targetId=${t1}&targetVersion=toy-v2`), 'the filter asks the API for the exact target and version');

    // Suites: every item keeps its own recorded result; skipped items say why; only an active suite can be stopped.
    const active = page.locator('.suite-list > li').first(), done = page.locator('.suite-list > li').nth(1);
    await done.getByText('Items').click();
    await done.getByText(/blocked \(unknown, not a fix\) on version not verified/).waitFor();
    await done.getByText('not run: suite time budget exhausted').waitFor();
    await active.getByText('Items').click();
    await active.getByText(/differs from the version named for this suite/).waitFor();
    await active.getByText(/running/).first().waitFor();
    assert.equal(await done.getByRole('button', { name: 'Stop suite' }).count(), 0);
    await page.evaluate(() => window.scrollTo(0, 0));
    await mkdir(output, { recursive: true });
    await page.screenshot({ path: join(output, 'regressions-1440.png'), fullPage: true });
    await active.getByRole('button', { name: 'Stop suite' }).click();
    await page.locator('.suite-stopped').first().waitFor();
    assert.deepEqual(calls.map(call => `${call.method} ${call.path}`), [`POST /regression-suites/${id(40)}/stop`]);
    assert.deepEqual(errors, []);
  } finally { await close(); }
});

test('the operator validates a new version and opts a target into the version-change trigger', async () => {
  const { page, calls, board, close } = await harness();
  try {
    await page.getByRole('heading', { name: 'Version-change trigger' }).waitFor();
    assert.equal(await page.getByText('version-change trigger off (default)').count(), 2, 'off by default');
    await page.getByRole('button', { name: 'Turn on for Synthetic chart target…' }).click();
    await page.getByText(/never deploys or patches the target/).last().waitFor();
    await page.getByLabel('Maximum identities').fill('10');
    await page.getByRole('button', { name: 'Turn on for Synthetic chart target', exact: true }).click();
    await page.getByText('version-change trigger on').waitFor();
    assert.deepEqual(calls.at(-1), { method: 'PUT', path: `/regression-triggers/${t1}`, body: { enabled: true, settings: { roles: { judge }, ollamaUrl: 'http://127.0.0.1:11434', maxItems: 10, maxMinutes: 60 } } });
    await page.getByText(/up to 10 identities, 60 min, Judge stub/).waitFor();
    await page.getByRole('button', { name: 'Turn off for Synthetic chart target' }).click();
    await page.getByText('version-change trigger on').waitFor({ state: 'detached' });
    assert.deepEqual(calls.at(-1)!.body, { enabled: false });

    const form = page.locator('.validate-version');
    assert.equal(await form.getByRole('button', { name: 'Validate new version' }).isDisabled(), true, 'a target is required');
    await form.locator('select').selectOption(t1);
    await form.getByLabel(/Version being validated/).fill('toy-v9');
    await form.getByRole('button', { name: 'Validate new version' }).click();
    await page.locator('.suite-list > li').first().getByText('version toy-v9').waitFor();
    assert.deepEqual(calls.at(-1), { method: 'POST', path: '/regression-suites', body: { targetId: t1, selection: { mode: 'all_confirmed' }, roles: { judge }, ollamaUrl: 'http://127.0.0.1:11434', maxItems: 25, maxMinutes: 60, expectedVersion: 'toy-v9' } });
    board.launch = 'busy';
    await form.getByRole('button', { name: 'Validate new version' }).click();
    await form.getByRole('alert').getByText(`Target reserved by run ${busyRun}`).waitFor();
    assert.equal(await form.getByRole('link', { name: /Inspect active run/ }).getAttribute('href'), `/runs/${busyRun}`);
    assert.equal(calls.filter(call => call.path === '/regression-suites').length, 2, 'one launch per press; nothing retried');
  } finally { await close(); }
});

test('composer suite mode selects identities, checks the exact bounds and routes to the suite view', async () => {
  const { page, calls, board, gets, close } = await harness(undefined, '/runs/new');
  try {
    const composer = page.locator('.run-composer');
    await composer.getByLabel('Regression suite').check();
    assert.equal(await composer.getByRole('button', { name: 'Start run' }).count(), 0, 'the run form is replaced, not duplicated');
    await composer.getByLabel('Saved authorized target').selectOption(t1);
    await composer.getByLabel('Choose identities').check();
    await composer.getByText('Cross chart override (cross patient)').waitFor();
    assert.ok(gets.includes(`/regression-identities?targetId=${t1}&limit=100`));
    assert.equal(await composer.getByRole('button', { name: 'Start suite' }).isDisabled(), true, 'nothing selected yet');
    await composer.getByLabel(/Cross chart override/).check();
    await composer.getByLabel(/Tool action nudge/).check();
    await composer.getByLabel(/Target version being validated/).fill('toy-v9');
    await composer.getByLabel('Maximum identities').fill('5');
    await composer.getByText(/at most 2 items/).waitFor();
    await composer.getByRole('button', { name: 'Check availability' }).click();
    await composer.getByText('$0 paid reservation; local inference unverified.').waitFor();
    const body = { targetId: t1, selection: { mode: 'identities', identityIds: [idA, idC] }, roles: { judge }, ollamaUrl: 'http://127.0.0.1:11434', maxItems: 5, maxMinutes: 60, expectedVersion: 'toy-v9' };
    assert.deepEqual(calls.at(-1), { method: 'POST', path: '/regression-suites/preflight', body });
    await mkdir(output, { recursive: true });
    await page.screenshot({ path: join(output, 'composer-suite-1440.png'), fullPage: true });
    board.preflight = { ...preflightOk, status: 'unavailable', issues: [{ code: 'local_model_missing', role: 'judge' }], local: { status: 'available', installed: [] } };
    await composer.getByLabel('Judge model').fill('missing');
    await composer.getByRole('button', { name: 'Start suite' }).click();
    await composer.getByRole('alert').getByText('Launch blocked: Judge: model not installed locally').waitFor();
    assert.equal(calls.some(call => call.path === '/regression-suites'), false, 'an unavailable model never starts a suite');
    board.preflight = preflightOk;
    await composer.getByLabel('Judge model').fill('stub');
    await composer.getByRole('button', { name: 'Start suite' }).click();
    await page.waitForURL('**/regressions');
    assert.deepEqual(calls.at(-1), { method: 'POST', path: '/regression-suites', body });
    await page.locator('.suite-list > li').first().getByText('version toy-v9').waitFor();
  } finally { await close(); }
});

test('the regression page and the composer suite mode fit a phone screen', async () => {
  const { page, close } = await harness({ width: 390, height: 900 });
  try {
    await page.locator('.identity-card').first().waitFor();
    await page.locator('.suite-list > li').first().waitFor();
    await mkdir(output, { recursive: true });
    await page.screenshot({ path: join(output, 'regressions-390.png'), fullPage: true });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), 'no horizontal page scroll on /regressions');
    await page.getByRole('link', { name: 'Launch', exact: true }).click();
    await page.getByRole('radio', { name: 'Regression suite' }).check();
    await page.getByLabel('Saved authorized target').selectOption(t1);
    await page.screenshot({ path: join(output, 'composer-suite-390.png'), fullPage: true });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), 'no horizontal page scroll in suite mode');
  } finally { await close(); }
});
