import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import type { Page } from 'playwright-core';
import { createServer as createViteServer } from 'vite';
import { coverageReport } from '../packages/contracts/src/coverage.js';
import { launchFixtureBrowser } from './support.js';

// Synthetic coverage fixture: the API is replaced by a route handler that filters and builds reports like V01 does.
const output = resolve('test-results/HDX-25/after');
const T1 = 'a1111111-1111-4111-8111-111111111111', T2 = 'b2222222-2222-4222-8222-222222222222', MISSING = 'c3333333-3333-4333-8333-333333333333';
const targets = [{ id: T1, name: 'Synthetic Co-Pilot', baseUrl: 'http://fixture.invalid/', activeRunId: null }, { id: T2, name: 'Synthetic Records Bot', baseUrl: 'http://fixture.invalid/', activeRunId: null }];
type Spec = { safe?: number; pending_review?: number; auto_confirm?: number; inconclusive?: number; blocked?: number; incomplete?: number; notAttempted?: number; inFlight?: number; awaiting?: number; confirmed?: number; rejected?: number };
type Case = { id: string; title: string; category: 'prompt_injection' | 'cross_patient' | 'unintended_tool_action'; subcategory: string | null; spec: Spec };
const catalog = (prefix: string, safe: number): Case[] => [
  { id: `${prefix}1`, title: 'Ignore prior instructions', category: 'prompt_injection', subcategory: 'Direct override', spec: { safe, pending_review: 1, awaiting: 1 } },
  { id: `${prefix}2`, title: 'Override via document', category: 'prompt_injection', subcategory: 'Direct override', spec: { inconclusive: 2 } },
  { id: `${prefix}3`, title: 'Poisoned note', category: 'prompt_injection', subcategory: 'Indirect', spec: { blocked: 2, notAttempted: 1 } },
  { id: `${prefix}4`, title: 'Swap patient identifier', category: 'cross_patient', subcategory: 'Identifier swap', spec: {} },
  { id: `${prefix}5`, title: 'Chart bleed', category: 'cross_patient', subcategory: 'Identifier swap', spec: {} },
  { id: `${prefix}6`, title: 'Silent order', category: 'unintended_tool_action', subcategory: 'Write attempt', spec: { inFlight: 1 } },
  { id: `${prefix}7`, title: 'Note edit', category: 'unintended_tool_action', subcategory: 'Write attempt', spec: { incomplete: 1 } }];
const n = (spec: Spec, key: keyof Spec) => spec[key] ?? 0;
const attempts = (s: Spec) => n(s, 'safe') + n(s, 'pending_review') + n(s, 'auto_confirm') + n(s, 'inconclusive') + n(s, 'blocked') + n(s, 'incomplete');
function counts(list: Spec[]) {
  const t = (key: keyof Spec) => list.reduce((sum, s) => sum + n(s, key), 0);
  const outcomes = { safe: t('safe'), pending_review: t('pending_review'), auto_confirm: t('auto_confirm'), inconclusive: t('inconclusive'), blocked: t('blocked'), incomplete: t('incomplete') };
  const attempted = list.reduce((sum, s) => sum + attempts(s), 0), denominator = outcomes.safe + outcomes.pending_review + outcomes.auto_confirm;
  const tried = list.filter(s => attempts(s) > 0).length;
  return { attempted, executed: attempted - outcomes.blocked, assessed: denominator + outcomes.inconclusive, reviewed: t('confirmed') + t('rejected'), notAttempted: t('notAttempted'), inFlight: t('inFlight'), outcomes,
    disposition: { candidates: t('awaiting') + t('confirmed') + t('rejected'), awaitingReview: t('awaiting'), confirmed: t('confirmed'), rejected: t('rejected') },
    safeRate: { numerator: outcomes.safe, denominator, excluded: outcomes.inconclusive + outcomes.blocked + outcomes.incomplete, rate: denominator ? outcomes.safe / denominator : null },
    cases: { catalog: list.length, attempted: tried, executed: list.filter(s => attempts(s) - n(s, 'blocked') > 0).length, untested: list.length - tried } };
}
const gapOf = (c: ReturnType<typeof counts>) => c.outcomes.safe + c.outcomes.pending_review + c.outcomes.auto_confirm ? null : !c.attempted ? (c.inFlight ? 'in_flight' : 'untested') : c.assessed ? 'inconclusive' : c.executed || !c.outcomes.blocked ? 'incomplete' : 'blocked';
const present = (list: Spec[]) => { const c = counts(list); return { counts: c, gap: gapOf(c) }; };
function scope(target: typeof targets[number], version: string | null, cases: Case[], observed: [string, string] | null) {
  const rows: unknown[] = [];
  for (const category of ['prompt_injection', 'cross_patient', 'unintended_tool_action'] as const) {
    const inside = cases.filter(c => c.category === category);
    rows.push({ level: 'category', category, ...present(inside.map(c => c.spec)) });
    for (const sub of [...new Set(inside.map(c => c.subcategory))]) {
      const list = inside.filter(c => c.subcategory === sub);
      rows.push({ level: 'subcategory', category, subcategory: sub, ...present(list.map(c => c.spec)) });
      for (const c of list) rows.push({ level: 'case', category, subcategory: sub, ...present([c.spec]), case: { id: `00000000-0000-4000-8000-${c.id.padStart(12, '0')}`, familyId: `00000000-0000-4000-8000-${c.id.padStart(12, '0')}`, version: 1, title: c.title, catalogState: 'published', metadataStatus: 'complete' } });
    }
  }
  return { target: { id: target.id, name: target.name }, targetVersion: version, observed: { firstAt: observed?.[0] ?? null, lastAt: observed?.[1] ?? null }, totals: counts(cases.map(c => c.spec)), rows };
}
const none = (cases: Case[]) => cases.map(c => ({ ...c, spec: {} }));
const lastSpecs = (cases: Case[], safe: number) => cases.map(c => c.id.endsWith('1') ? { ...c, spec: { safe, pending_review: 0 } } : { ...c, spec: {} });
// Ordered as V01 orders scopes: by target name, then most recently observed first.
const scopes = [
  { ...scope(targets[0], '1.4.0', catalog('1', 3), ['2026-09-27T08:00:00.000Z', '2026-09-29T11:00:00.000Z']) },
  { ...scope(targets[0], null, catalog('1', 0).map(c => ({ ...c, spec: c.id.endsWith('3') ? { blocked: 3 } : {} })), ['2026-09-27T09:00:00.000Z', '2026-09-27T09:30:00.000Z']) },
  { ...scope(targets[0], '1.3.0', lastSpecs(catalog('1', 0), 5), ['2026-09-10T08:00:00.000Z', '2026-09-20T11:00:00.000Z']) },
  { ...scope(targets[1], '2.0.0', catalog('2', 1), ['2026-09-25T08:00:00.000Z', '2026-09-26T11:00:00.000Z']) }];

function report(query: URLSearchParams) {
  const { targetId, targetVersion, since, until } = Object.fromEntries(query);
  if (targetId && !targets.some(t => t.id === targetId)) return null;
  let list = scopes.filter(s => (!targetId || s.target.id === targetId) && (!targetVersion || (s.targetVersion ?? 'unknown') === targetVersion)
    && (!since || s.observed.lastAt! >= since) && (!until || s.observed.firstAt! < until));
  if (targetId && targetVersion && !list.length) list = [scope(targets.find(t => t.id === targetId)!, targetVersion === 'unknown' ? null : targetVersion, none(catalog('9', 0)), null)];
  return coverageReport.parse({ v: 1, generatedAt: '2026-09-29T12:00:00.000Z', filters: { targetId: targetId ?? null, targetVersion: targetVersion ?? null, since: since ?? null, until: until ?? null, mode: query.get('mode') ?? 'all' },
    safeRatePolicy: { numerator: ['safe'], denominator: ['safe', 'pending_review', 'auto_confirm'], excluded: ['inconclusive', 'blocked', 'incomplete'] }, scopes: list });
}

async function withPage(width: number, body: (page: Page, origin: string, api: { requests: string[]; fail: number | null }) => Promise<void>) {
  const server = await createViteServer({ configFile: resolve('apps/web/vite.config.ts'), server: { host: '127.0.0.1', port: 0 }, logLevel: 'error' });
  await server.listen();
  const address = server.httpServer?.address(); assert.ok(address && typeof address !== 'string');
  const browser = await launchFixtureBrowser();
  const context = await browser.newContext({ viewport: { width, height: 1000 } });
  const page = await context.newPage();
  const api = { requests: [] as string[], fail: null as number | null };
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/api/**', route => {
    const url = new URL(route.request().url());
    if (!url.pathname.startsWith('/api/')) return route.continue();
    const path = url.pathname.slice(4);
    api.requests.push(path + url.search);
    const respond = (body: unknown, code = 200) => route.fulfill({ status: code, contentType: 'application/json', body: JSON.stringify(body) });
    if (path === '/coverage/scoped') {
      if (api.fail) return respond({ v: 1, code: 'internal', message: 'Request failed' }, api.fail);
      const found = report(url.searchParams);
      return found ? respond(found) : respond({ v: 1, code: 'not_found', message: 'Target not found' }, 404);
    }
    if (path === '/targets') return respond(targets);
    if (['/cases', '/findings', '/regressions', '/coverage', '/schedules'].includes(path)) return respond([]);
    if (path === '/config') return respond({ ollamaUrl: 'http://127.0.0.1:11434', model: 'synthetic-local' });
    if (path === '/models') return respond({ openrouter: [], ollama: ['synthetic-local'], configured: false });
    return respond({ message: `Unexpected synthetic request ${path}` }, 404);
  });
  try { await body(page, `http://127.0.0.1:${address.port}`, api); assert.deepEqual(errors, []); }
  finally { await context.close(); await browser.close(); await server.close(); }
}
// The page itself never scrolls sideways at desktop or phone width (wide tables scroll inside their own region).
async function fits(page: Page) {
  const original = page.viewportSize()!;
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: original.height });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, `no horizontal page overflow at ${width}px`);
  }
  await page.setViewportSize(original);
}
async function shots(page: Page, name: string, selector?: string) {
  if (process.env.HDX25_CAPTURE_MEDIA !== '1') return;
  await mkdir(output, { recursive: true });
  const original = page.viewportSize()!;
  for (const [label, width] of [['desktop', 1440], ['mobile', 390]] as const) {
    await page.setViewportSize({ width, height: original.height });
    await (selector ? page.locator(selector).screenshot({ path: join(output, `${label}-${name}.png`) }) : page.screenshot({ path: join(output, `${label}-${name}.png`), fullPage: true }));
  }
  await page.setViewportSize(original);
}
const scoped = (requests: string[]) => requests.filter(path => path.startsWith('/coverage/scoped'));

test('scoped coverage table keeps untested, blocked and inconclusive distinct and never presents global counts as a target', async () => {
  await withPage(1440, async (page, origin, api) => {
    await page.goto(`${origin}/coverage?targetId=${T1}&targetVersion=1.4.0`);
    await page.getByRole('heading', { name: 'Coverage', level: 1 }).waitFor();
    const heading = page.getByRole('heading', { level: 3 });
    await heading.waitFor();
    assert.equal(await page.getByRole('heading', { level: 3 }).count(), 1, 'one table for the one selected scope');
    assert.match(await heading.innerText(), /Synthetic Co-Pilot\s+· version 1\.4\.0/);
    assert.match(await page.getByText(/Observed 2026-09-27 08:00Z to 2026-09-29 11:00Z/).innerText(), /UTC/);
    // The selected filters are visible and honored.
    const active = page.getByRole('list', { name: 'Active filters' });
    assert.match(await active.innerText(), /Target: Synthetic Co-Pilot[\s\S]*Version: 1\.4\.0[\s\S]*Window: all time[\s\S]*Mode: All modes/);
    assert.equal(await page.getByLabel('Target', { exact: true }).inputValue(), T1);
    assert.equal(await page.getByLabel('Target version').inputValue(), '1.4.0');
    assert.deepEqual(scoped(api.requests).filter(path => path.includes('targetVersion')), [`/coverage/scoped?targetId=${T1}&targetVersion=1.4.0`]);
    assert.equal(api.requests.includes('/coverage'), false, 'the legacy global counts are no longer requested');

    // Accessible table: caption, colgroup and column scopes, keyboard-focusable scroll region, separate outcome and review groups.
    const table = page.getByRole('table', { name: /Synthetic Co-Pilot · version 1\.4\.0/ });
    assert.match(await table.locator('caption').innerText(), /untested, blocked and inconclusive are never combined/);
    assert.deepEqual(await table.locator('thead th[scope="colgroup"]').allInnerTexts(), ['Outcome (immutable)', 'Review (disposition)', 'Execution']);
    assert.equal(await page.getByRole('region', { name: /Coverage table for Synthetic Co-Pilot/ }).getAttribute('tabindex'), '0');
    assert.equal(await table.locator('tbody th[scope="row"]').count(), 3 + 4 + 7, 'three categories, four subcategories, seven cases');

    // Distinct gaps: untested category, blocked subcategory, inconclusive case, incomplete case and in-flight case.
    const chip = (row: string | RegExp) => table.getByRole('row', { name: row }).locator('.cov-gap').first();
    assert.equal(await chip(/^Category: Cross patient/).innerText(), '○ Untested');
    assert.match(await chip(/^Subcategory: Indirect/).innerText(), /Blocked/);
    assert.match(await chip(/^Case: Override via document/).innerText(), /Inconclusive/);
    assert.match(await chip(/^Case: Note edit/).innerText(), /Incomplete/);
    assert.match(await chip(/^Case: Silent order/).innerText(), /In flight/);
    assert.match(await chip(/^Category: Prompt injection/).innerText(), /Has result/);
    // Blocked, inconclusive and not-attempted are separate columns; review fields are their own group.
    const row = /^Case: Poisoned note/;
    for (const [column, expected] of [['blocked', '2'], ['notAttempted', '1'], ['inconclusive', '0'], ['attempted', '2'], ['executed', '0'], ['awaitingReview', '0']]) assert.equal(await table.getByRole('row', { name: row }).locator(`td[data-col="${column}"]`).innerText(), expected, column);
    assert.equal(await table.getByRole('row', { name: /^Case: Ignore prior instructions/ }).locator('td[data-col="awaitingReview"]').innerText(), '1');
    assert.equal(await table.getByRole('row', { name: /^Case: Ignore prior instructions/ }).locator('td[data-col="reviewed"]').innerText(), '0');
    // Safe rate is n/d with excluded beside it; no determinate assertion is "n/a", never 0%.
    const rate = await table.getByRole('row', { name: /^Case: Ignore prior instructions/ }).locator('td[data-col="safeRate"]').innerText();
    assert.match(rate, /3\/4/); assert.match(rate, /75%/); assert.match(rate, /0 excluded/);
    const unknown = await table.getByRole('row', { name: /^Case: Override via document/ }).locator('td[data-col="safeRate"]').innerText();
    assert.match(unknown, /0\/0/); assert.match(unknown, /n\/a/); assert.match(unknown, /2 excluded/); assert.doesNotMatch(unknown, /0%/);
    // The scope total is labeled for this target and version only; the policy is shown from the response.
    assert.match(await table.locator('tfoot').innerText(), /Scope total \(this target and version only\)/);
    assert.match(await page.getByText(/^Safe rate = safe ÷/).innerText(), /pending review \+ auto confirm\)\. Excluded from the rate and never counted as safe: inconclusive \+ blocked \+ incomplete/);
    await fits(page);
    await shots(page, 'mixed-gaps');
    await page.getByLabel('Show individual cases').uncheck();
    assert.equal(await table.getByRole('row', { name: /^Case:/ }).count(), 0);

    // All targets are separate tables, each named, and the page says it is not one target's coverage.
    await page.goto(`${origin}/coverage`);
    await page.getByRole('heading', { level: 3, name: /Synthetic Records Bot/ }).waitFor();
    assert.deepEqual(await page.getByRole('heading', { level: 3 }).allInnerTexts(), ['Synthetic Co-Pilot · version 1.4.0', 'Synthetic Co-Pilot · version unknown', 'Synthetic Co-Pilot · version 1.3.0', 'Synthetic Records Bot · version 2.0.0'].map(text => text.replace(' · ', ' · ')).map(text => text.replace(' ', ' ')));
    assert.match(await page.locator('.cov-scoped-note').innerText(), /never summed across tables, and this view is not any single target's coverage/);
    assert.match(await page.getByRole('list', { name: 'Active filters' }).innerText(), /Target: All targets[\s\S]*Version: All versions/);
  });
});

test('empty scope states the untested count and the mobile layout does not overflow', async () => {
  await withPage(390, async (page, origin) => {
    await page.goto(`${origin}/coverage?targetId=${T2}&targetVersion=unknown`);
    const empty = page.locator('.cov-empty');
    await empty.waitFor();
    assert.equal(await empty.innerText(), 'No executions in this scope — 7 published cases untested.');
    assert.match(await page.getByRole('heading', { level: 3 }).innerText(), /Synthetic Records Bot\s+· version unknown/);
    assert.match(await page.getByText(/No executions observed in this window/).innerText(), /No executions/);
    assert.equal(await page.getByRole('table').first().getByRole('row', { name: /^Category: Cross patient/ }).locator('.cov-gap').innerText(), '○ Untested');
    await fits(page);
    await shots(page, 'empty-untested');
    await page.goto(`${origin}/coverage?targetId=${T1}`);
    await page.getByRole('heading', { level: 3, name: /1\.4\.0/ }).waitFor();
    await fits(page);
    await shots(page, 'all-versions-one-target');
    // Nothing recorded for the selected filters at all: explicit, with a way to list the catalog as untested.
    await page.goto(`${origin}/coverage?targetId=${T2}&since=2026-09-29T00:00:00.000Z`);
    await page.getByRole('region', { name: 'No matching scopes' }).waitFor();
    assert.match(await page.getByRole('region', { name: 'No matching scopes' }).innerText(), /No executions recorded for Synthetic Records Bot in since 2026-09-29 00:00Z \(UTC\).*Choose “Version unknown”/s);
  });
});

test('filters are reflected in the URL, drive the requests, survive reload and history, and report errors without dropping data', async () => {
  await withPage(1440, async (page, origin, api) => {
    await page.goto(`${origin}/coverage`);
    await page.getByRole('heading', { level: 3, name: /Synthetic Records Bot/ }).waitFor();
    assert.equal(await page.getByLabel('Target version').isDisabled(), true);
    await page.getByLabel('Target', { exact: true }).selectOption(T1);
    await page.getByRole('heading', { level: 3, name: /1\.3\.0/ }).waitFor();
    assert.equal(await page.getByRole('heading', { level: 3 }).count(), 3, 'all three Synthetic Co-Pilot versions, never pooled');
    assert.equal(new URL(page.url()).search, `?targetId=${T1}`);
    // Versions come from a target-only call; the select offers every observed version plus "unknown".
    assert.deepEqual(await page.getByLabel('Target version').locator('option').allInnerTexts(), ['All versions', '1.4.0', 'Version unknown (never established)', '1.3.0']);
    await page.getByLabel('Target version').selectOption('1.3.0');
    await page.getByRole('heading', { level: 3, name: /1\.3\.0/ }).waitFor();
    await page.waitForFunction(() => document.querySelectorAll('.cov-scope h3').length === 1);
    assert.equal(new URL(page.url()).search, `?targetId=${T1}&targetVersion=1.3.0`);
    await page.getByLabel('Run mode').selectOption('adaptive');
    await page.getByLabel('Since (inclusive)').fill('2026-09-05T00:00');
    await page.getByLabel('Until (exclusive)').fill('2026-09-25T00:00');
    await page.waitForFunction(() => location.search.includes('until='));
    const search = `?targetId=${T1}&targetVersion=1.3.0&since=2026-09-05T00%3A00%3A00.000Z&until=2026-09-25T00%3A00%3A00.000Z&mode=adaptive`;
    assert.equal(new URL(page.url()).search, search);
    await page.getByRole('heading', { level: 3, name: /1\.3\.0/ }).waitFor();
    assert.equal(scoped(api.requests).at(-1), `/coverage/scoped${search}`);
    assert.match(await page.getByRole('list', { name: 'Active filters' }).innerText(), /Version: 1\.3\.0[\s\S]*Window: 2026-09-05 00:00Z to 2026-09-25 00:00Z \(UTC\)[\s\S]*Mode: Adaptive only/);
    // A link reproduces the view; history restores the previous filter set.
    await page.goto(origin + '/coverage' + search);
    await page.getByRole('heading', { level: 3, name: /1\.3\.0/ }).waitFor();
    assert.equal(await page.getByLabel('Target', { exact: true }).inputValue(), T1);
    assert.equal(await page.getByLabel('Target version').inputValue(), '1.3.0');
    assert.equal(await page.getByLabel('Run mode').inputValue(), 'adaptive');
    assert.equal(await page.getByLabel('Since (inclusive)').inputValue(), '2026-09-05T00:00');
    await page.getByLabel('Run mode').selectOption('all');
    await page.waitForFunction(() => !location.search.includes('mode='));
    await page.goBack();
    await page.waitForFunction(() => location.search.includes('mode=adaptive'));
    assert.equal(await page.getByLabel('Run mode').inputValue(), 'adaptive');
    // Presets write an absolute start time (24 h before now, UTC) and clear the end.
    await page.getByRole('button', { name: 'Last 24 hours' }).click();
    await page.waitForFunction(() => new URL(location.href).searchParams.has('since') && !new URL(location.href).searchParams.has('until'));
    const since = Date.parse(new URL(page.url()).searchParams.get('since')!);
    assert.ok(Math.abs(Date.now() - 24 * 3_600_000 - since) < 5 * 60_000);
    // An inverted window is refused locally without a request.
    await page.waitForTimeout(200);
    const before = scoped(api.requests).length;
    await page.getByLabel('Since (inclusive)').fill('2026-09-25T00:00');
    await page.getByLabel('Until (exclusive)').fill('2026-09-05T00:00');
    await page.getByRole('alert').filter({ hasText: 'Since must be earlier than until' }).waitFor();
    await page.waitForTimeout(200);
    assert.equal(scoped(api.requests).length, before + 1, 'only the valid since-only request ran');
    await page.getByRole('button', { name: 'Clear filters' }).click();
    await page.getByRole('heading', { level: 3, name: /Synthetic Records Bot/ }).waitFor();
    assert.equal(new URL(page.url()).search, '');

    // A failed refresh keeps the last good tables, announces the failure and recovers with Retry.
    api.fail = 503;
    await page.getByRole('button', { name: 'Refresh' }).click();
    const alert = page.getByRole('alert');
    await alert.waitFor();
    assert.match(await alert.innerText(), /Coverage could not be loaded \(HTTP 503\)/);
    assert.equal(await page.getByRole('heading', { level: 3 }).count(), 4, 'last good data is kept');
    api.fail = null;
    await alert.getByRole('button', { name: 'Retry' }).click();
    await alert.waitFor({ state: 'detached' });

    // An unknown target is a 404: no stale data, an explanation, and a way out.
    await page.goto(`${origin}/coverage?targetId=${MISSING}`);
    const missing = page.getByRole('alert');
    await missing.waitFor();
    assert.match(await missing.innerText(), /The selected target was not found/);
    assert.equal(await page.getByRole('heading', { level: 3 }).count(), 0);
    await missing.getByRole('button', { name: 'Clear target filter' }).click();
    await page.getByRole('heading', { level: 3, name: /Synthetic Records Bot/ }).waitFor();
    assert.equal(await page.getByRole('alert').count(), 0);
  });
});

test('comparison pairs only scopes of one target, labels both versions, and compares against an earlier window', async () => {
  await withPage(1440, async (page, origin, api) => {
    await page.goto(`${origin}/coverage`);
    await page.getByRole('heading', { level: 3, name: /Synthetic Records Bot/ }).waitFor();
    // Across targets: other targets are disabled and the reason is stated.
    const a = page.getByLabel('Scope A'), b = page.getByLabel('Scope B');
    await a.selectOption({ label: 'Synthetic Co-Pilot · version 1.3.0 · last 2026-09-20 11:00Z' });
    const disabled = await b.locator('option:disabled').allInnerTexts();
    assert.ok(disabled.some(text => /Synthetic Records Bot · version 2\.0\.0.*different target, disabled/.test(text)));
    assert.match(await page.getByText(/Options for other targets are disabled/).innerText(), /never compared/);
    await b.selectOption({ label: 'Synthetic Co-Pilot · version 1.4.0 · last 2026-09-29 11:00Z' });
    const comparison = page.getByRole('table', { name: /Per category: safe rate/ });
    await comparison.waitFor();
    assert.match(await page.locator('.cov-compare-note').innerText(), /Comparing version 1\.3\.0 with version 1\.4\.0 of Synthetic Co-Pilot/);
    assert.deepEqual(await comparison.locator('thead th[scope="colgroup"]').allInnerTexts(), ['A: version 1.3.0\nObserved 2026-09-10 08:00Z to 2026-09-20 11:00Z (UTC)', 'B: version 1.4.0\nObserved 2026-09-27 08:00Z to 2026-09-29 11:00Z (UTC)']);
    const injection = await comparison.getByRole('row', { name: /^Prompt injection/ }).innerText();
    assert.match(injection, /5\/5[\s\S]*3\/4/);
    assert.match(await comparison.getByRole('row', { name: /^Cross patient/ }).innerText(), /Untested[\s\S]*Untested/);
    assert.match(injection, /−25 pp/);
    await fits(page);
    await shots(page, 'comparison', '.cov-compare');
    // Changing A to another target clears B rather than comparing across targets.
    await a.selectOption({ label: 'Synthetic Records Bot · version 2.0.0 · last 2026-09-26 11:00Z' });
    assert.equal(await b.inputValue(), '');
    assert.equal(await comparison.count(), 0);

    // One scope against the previous window of equal length: since 2026-09-22 with now 2026-09-29 12:00 => earlier window 09-15..09-22.
    await page.goto(`${origin}/coverage?targetId=${T1}&since=2026-09-22T00:00:00.000Z`);
    await page.getByRole('heading', { level: 3, name: /1\.4\.0/ }).waitFor();
    await page.getByLabel('Comparison', { exact: true }).selectOption('window');
    await page.getByLabel('Scope', { exact: true }).selectOption({ label: 'Synthetic Co-Pilot · version 1.4.0 · last 2026-09-29 11:00Z' });
    await page.getByText(/no executions in the earlier window; that is a gap, not a zero rate/).waitFor();
    assert.ok(api.requests.includes(`/coverage/scoped?targetId=${T1}&since=2026-09-14T12%3A00%3A00.000Z&until=2026-09-22T00%3A00%3A00.000Z`));
    assert.match(await page.locator('.cov-compare-note').innerText(), /Both use version 1\.4\.0/);
    assert.match(await page.getByRole('table', { name: /Per category/ }).locator('thead').innerText(), /A: Earlier window[\s\S]*B: Selected window/);
    await fits(page);
    await shots(page, 'comparison-earlier-window', '.cov-compare');
  });
});
