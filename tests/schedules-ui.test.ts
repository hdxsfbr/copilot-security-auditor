import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import type { Browser } from 'playwright-core';
import { createServer as createViteServer, type ViteDevServer } from 'vite';
import { browserEquivalent, inZone, validZone, wallTime } from '../apps/web/src/components/schedules/zone.js';
import { launchFixtureBrowser } from './support.js';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const targetId = id(1), caseA = id(10), caseB = id(11), blockingRun = id(90), dispatchedRun = id(91), finishedRun = id(92), definitionA = id(100), definitionB = id(101);
const seed = (caseId: string, title: string, category: string) => ({ id: caseId, title, category, user: 'A', expectedSafeBehavior: `Expected safe behavior for ${title}`, actions: [{ kind: 'chat_turn', message: `Synthetic step for ${title}` }] });
const local = { provider: 'ollama', model: 'stub', maxOutputTokens: 256 };
const stamp = { archived: false, createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z' };
const definitions = [
  { id: definitionA, name: 'Nightly chart probe', revision: 3, ...stamp, run: { kind: 'selected', input: { targetId, caseId: caseA, roles: { judge: { provider: 'openrouter', model: 'fixture/paid', maxOutputTokens: 512 } }, openRouterCapUsd: 0.25,
    reportPolicy: { model: { provider: 'openrouter', model: 'fixture/report', maxOutputTokens: 256 }, allowanceUsd: 0.05, reviewWindowMinutes: 60 } } } },
  { id: definitionB, name: 'Weekly adaptive sweep', revision: 1, ...stamp, run: { kind: 'adaptive', input: { targetId, caseIds: [caseA, caseB], categories: ['prompt_injection', 'cross_patient'], maxCases: 3, maxMinutes: 5, ollamaUrl: 'http://127.0.0.1:11434', roles: { orchestrator: local, redTeam: local, judge: local } } } },
];
const schedule = (n: number, name: string, over: Record<string, unknown>) => ({ id: id(200 + n), paused: false, archived: false, archivedAt: null, createdAt: '2026-09-01T00:00:00.000Z',
  definition: { name, cadence: 'daily', hour: 9, minute: 0, zone: 'America/Chicago', run: definitions[0].run }, nextFireAt: '2026-09-30T14:00:00.000Z',
  source: { runDefinitionId: definitionA, revision: 3, name: 'Nightly chart probe' }, target: { id: targetId, name: 'Synthetic chart target' }, cases: [{ id: caseA, title: 'Prompt override case', category: 'prompt_injection' }], ...over });
const occurrence = (n: number, over: Record<string, unknown>) => ({ id: id(300 + n), scheduledFor: '2026-09-29T14:00:00.000Z', state: 'finished', reason: null, runId: null, runStatus: null, runOutcome: null, ...over });
const output = resolve('test-results/HDX-20/after');

type State = { active: any[]; archived: any[]; pages: Record<string, any>; calls: { method: string; path: string; body: any }[]; stale: boolean; failPage: string | null };
async function harness(browser: Browser, vite: ViteDevServer, options: { timezoneId: string; viewport?: { width: number; height: number }; active?: any[]; archived?: any[] }) {
  const address = vite.httpServer?.address(); assert.ok(address && typeof address !== 'string');
  const context = await browser.newContext({ viewport: options.viewport ?? { width: 1440, height: 1000 }, timezoneId: options.timezoneId });
  const page = await context.newPage(), errors: string[] = [];
  const state: State = { active: options.active ?? [], archived: options.archived ?? [], pages: {}, calls: [], stale: false, failPage: null };
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/api/**', async route => {
    const request = route.request(), url = new URL(request.url()), method = request.method();
    if (!url.pathname.startsWith('/api/')) return route.continue();
    const path = url.pathname.slice('/api'.length), body = request.postData() ? JSON.parse(request.postData()!) : undefined;
    if (method !== 'GET') state.calls.push({ method, path, body });
    else if (path.endsWith('/occurrences/page')) state.calls.push({ method, path: path + url.search, body });
    const reply = (payload: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(payload) });
    if (path === '/targets') return reply([{ id: targetId, name: 'Synthetic chart target', baseUrl: 'http://fixture.invalid/', activeRunId: null }]);
    if (path === '/cases') return reply([seed(caseA, 'Prompt override case', 'prompt_injection'), seed(caseB, 'Cross chart case', 'cross_patient')]);
    if (path === '/config') return reply({ ollamaUrl: 'http://127.0.0.1:11434', model: 'stub' });
    if (path === '/models') return reply({ openrouter: [], ollama: ['stub'], configured: false, availability: { openrouter: 'not_configured', ollama: 'available' } });
    if (path === '/findings' || path === '/regressions' || path === '/coverage') return reply([]);
    if (path === '/run-definitions') return reply(definitions);
    if (path === '/schedules' && method === 'GET') return reply(state.active);
    if (path === '/schedules/archived') return reply(state.archived);
    if (path === '/schedules' && method === 'POST') return state.stale ? reply({ v: 1, code: 'conflict', message: 'Run definition changed or archived; reload before continuing' }, 409) : reply({ id: id(250), nextFireAt: '2026-10-02T22:30:00.000Z' }, 201);
    const scheduleId = /^\/schedules\/([^/]+)/.exec(path)?.[1];
    if (scheduleId && method === 'DELETE') {
      const found = state.active.find(item => item.id === scheduleId);
      state.active = state.active.filter(item => item !== found); state.archived = [{ ...found, archived: true, archivedAt: '2026-10-01T03:30:00.000Z' }, ...state.archived];
      return route.fulfill({ status: 204 });
    }
    if (scheduleId && path.endsWith('/occurrences/page')) {
      const cursor = url.searchParams.get('cursor') ?? '';
      if (state.failPage === cursor) { state.failPage = null; return reply({ v: 1, code: 'internal', message: 'Request failed' }, 500); }
      return reply(state.pages[`${scheduleId}:${cursor}`] ?? { items: [], nextCursor: null });
    }
    if (path.startsWith('/runs/')) return reply({ id: path.split('/')[2], status: 'finished', outcome: 'safe', version: null, model: 'assigned per role' });
    return reply({ message: `Unexpected synthetic request ${path}` }, 404);
  });
  await page.goto(`http://127.0.0.1:${address.port}/schedules`);
  return { page, state, errors, desk: page.locator('.schedule-desk'), close: () => context.close() };
}
async function withHarness(run: (browser: Browser, vite: ViteDevServer) => Promise<void>) {
  const vite = await createViteServer({ configFile: resolve('apps/web/vite.config.ts'), server: { host: '127.0.0.1', port: 0 }, logLevel: 'error' });
  await vite.listen();
  const browser = await launchFixtureBrowser();
  try { await run(browser, vite); } finally { await browser.close(); await vite.close(); }
}

test('zone formatter labels the schedule zone, follows daylight saving and only adds a browser line for a different zone', () => {
  assert.equal(inZone('2026-09-30T14:00:00.000Z', 'America/Chicago'), 'Wed, Sep 30, 2026 09:00 America/Chicago (CDT)');
  assert.equal(inZone('2026-11-02T15:00:00.000Z', 'America/Chicago'), 'Mon, Nov 2, 2026 09:00 America/Chicago (CST)', 'the same wall time after the fall-back change is CST');
  assert.equal(wallTime(9, 0, 'America/Chicago', '2026-11-02T15:00:00.000Z'), '09:00 America/Chicago (CST)');
  assert.equal(inZone('2026-10-05T08:00:00.000Z', 'Europe/London'), 'Mon, Oct 5, 2026 09:00 Europe/London (GMT+1)');
  assert.equal(inZone('2026-01-05T09:00:00.000Z', 'Europe/London'), 'Mon, Jan 5, 2026 09:00 Europe/London (GMT)');
  assert.equal(inZone('2026-03-08T08:00:00.000Z', 'America/Chicago'), 'Sun, Mar 8, 2026 03:00 America/Chicago (CDT)', 'the skipped spring-forward hour is never shown as 02:xx');
  assert.equal(browserEquivalent('2026-09-30T14:00:00.000Z', 'America/Chicago', 'Asia/Tokyo'), 'Your browser (Asia/Tokyo, GMT+9): Wed, Sep 30, 2026 23:00');
  assert.equal(browserEquivalent('2026-09-30T14:00:00.000Z', 'America/Chicago', 'America/Chicago'), null);
  assert.match(inZone('2026-09-30T14:00:00.000Z', 'Not/Zone'), /not formattable/);
  assert.equal(validZone('Not/Zone'), false); assert.equal(validZone(''), false); assert.equal(validZone('Asia/Tokyo'), true);
});

test('schedule and occurrence times use the schedule zone and label whatever the browser zone is', async () => {
  const active = [
    schedule(1, 'Chicago nightly', {}),
    schedule(2, 'London weekly', { definition: { name: 'London weekly', cadence: 'weekly', weekday: 1, hour: 9, minute: 0, zone: 'Europe/London', run: definitions[0].run }, nextFireAt: '2026-10-05T08:00:00.000Z' }),
    schedule(3, 'Chicago after DST', { nextFireAt: '2026-11-02T15:00:00.000Z' }),
  ];
  await withHarness(async (browser, vite) => {
    const tokyo = await harness(browser, vite, { timezoneId: 'Asia/Tokyo', active });
    try {
      assert.equal(await tokyo.desk.getByLabel('IANA time zone').inputValue(), 'Asia/Tokyo', 'the form defaults to the browser zone, visibly');
      const chicago = tokyo.desk.locator('.schedule-card', { hasText: 'Chicago nightly' });
      await chicago.waitFor();
      const body = await chicago.innerText();
      assert.match(body, /Every day at 09:00 America\/Chicago \(CDT\)/);
      assert.match(body, /Active · next Wed, Sep 30, 2026 09:00 America\/Chicago \(CDT\)/);
      assert.match(body, /Your browser \(Asia\/Tokyo, [^)]+\): Wed, Sep 30, 2026 23:00/);
      assert.match(await tokyo.desk.locator('.schedule-card', { hasText: 'London weekly' }).innerText(), /Every Monday at 09:00 Europe\/London \(GMT\+1\)[\s\S]*Your browser \(Asia\/Tokyo, [^)]+\): Mon, Oct 5, 2026 17:00/);
      assert.match(await tokyo.desk.locator('.schedule-card', { hasText: 'Chicago after DST' }).innerText(), /Every day at 09:00 America\/Chicago \(CST\)[\s\S]*Mon, Nov 2, 2026 09:00 America\/Chicago \(CST\)/);
      assert.deepEqual(tokyo.errors, []);
    } finally { await tokyo.close(); }
    const sameZone = await harness(browser, vite, { timezoneId: 'America/Chicago', active });
    try {
      const chicago = sameZone.desk.locator('.schedule-card', { hasText: 'Chicago nightly' });
      await chicago.waitFor();
      assert.match(await chicago.innerText(), /Wed, Sep 30, 2026 09:00 America\/Chicago \(CDT\)/);
      assert.doesNotMatch(await chicago.innerText(), /Your browser/, 'no duplicate line when the browser is already in the schedule zone');
      assert.match(await sameZone.desk.locator('.schedule-card', { hasText: 'London weekly' }).innerText(), /Your browser \(America\/Chicago, CDT\): Mon, Oct 5, 2026 03:00/);
    } finally { await sameZone.close(); }
  });
});

test('creating from a saved definition shows its target, mode, cases, models, cap and report policy and posts the exact revision and zone', async () => {
  await withHarness(async (browser, vite) => {
    const { page, state, desk, errors, close } = await harness(browser, vite, { timezoneId: 'Asia/Tokyo' });
    try {
      await desk.getByLabel('Saved run definition').selectOption(definitionA);
      const chosen = desk.locator('.schedule-chosen');
      const single = (await chosen.textContent()) ?? '';
      for (const expected of ['Synthetic chart target', 'Single case', 'Prompt override case (prompt injection)', 'Judge: OpenRouter fixture/paid (max 512 output tokens)', '$0.25 per occurrence', 'Report policy', 'OpenRouter fixture/report', 'review window 60 min', 'allowance $0.05', 'revision 3']) assert.ok(single.includes(expected), `${expected} in ${single}`);
      assert.doesNotMatch(single, /Orchestrator|Red Team/, 'a single case shows only the invoked role');
      await desk.getByLabel('Saved run definition').selectOption(definitionB);
      const adaptive = (await chosen.textContent()) ?? '';
      for (const expected of ['Adaptive exploration (up to 3 cases, 5 min)', 'Prompt override case (prompt injection), Cross chart case (cross patient)', 'Orchestrator: Ollama stub', 'Red Team: Ollama stub', 'Judge: Ollama stub', 'No paid calls']) assert.ok(adaptive.includes(expected), `${expected} in ${adaptive}`);

      await desk.getByLabel('Schedule name').fill('Friday sweep');
      await desk.getByLabel('Cadence').selectOption('weekly');
      await desk.getByLabel('Weekday').selectOption('5');
      await desk.getByLabel('Time of day (in the schedule zone)').fill('17:30');
      await desk.getByLabel('IANA time zone').fill('Mars/Base');
      assert.equal(await desk.getByRole('button', { name: 'Create schedule' }).isDisabled(), true, 'an invalid zone cannot be submitted');
      await desk.getByText('Enter a valid IANA time zone').waitFor();
      await desk.getByLabel('IANA time zone').fill('America/Chicago');
      await desk.getByText(/Runs every Friday at 17:30 America\/Chicago \((CDT|CST)\)/).waitFor();
      await desk.getByRole('button', { name: 'Create schedule' }).click();
      await desk.getByRole('status').filter({ hasText: 'Created schedule "Friday sweep"' }).waitFor();
      assert.match(await desk.getByRole('status').filter({ hasText: 'Created schedule' }).innerText(), /Next run: Fri, Oct 2, 2026 17:30 America\/Chicago \(CDT\)\. Your browser \(Asia\/Tokyo, [^)]+\): Sat, Oct 3, 2026 07:30/);
      assert.deepEqual(state.calls.filter(call => call.method === 'POST').map(call => call.body), [{ name: 'Friday sweep', cadence: 'weekly', weekday: 5, hour: 17, minute: 30, zone: 'America/Chicago', runDefinitionId: definitionB, revision: 1 }]);

      state.stale = true;
      await desk.getByLabel('Saved run definition').selectOption(definitionA);
      await desk.getByRole('button', { name: 'Create schedule' }).click();
      await desk.getByRole('alert').getByText('Run definition changed or archived; reload before continuing').waitFor();
      state.stale = false;
      await desk.getByRole('button', { name: 'Reload saved definitions' }).click();
      assert.equal(await desk.getByLabel('Saved run definition').inputValue(), definitionA, 'the draft survives a definition reload');
      assert.deepEqual(errors, []);
    } finally { await close(); }
  });
});

test('removed schedules move to the archive and stay inspectable with paged occurrences, reasons and run links', async () => {
  const first = schedule(1, 'Chicago nightly', {});
  await withHarness(async (browser, vite) => {
    const { page, state, desk, errors, close } = await harness(browser, vite, { timezoneId: 'Asia/Tokyo', active: [first] });
    try {
      const key = (cursor: string) => `${first.id}:${cursor}`;
      state.pages[key('')] = { items: [
        occurrence(1, { scheduledFor: '2026-09-30T14:00:00.000Z', state: 'skipped', reason: `Target reserved by run ${blockingRun}` }),
        occurrence(2, { scheduledFor: '2026-09-29T14:00:00.000Z', state: 'finished', runId: finishedRun, runStatus: 'finished', runOutcome: 'safe' })], nextCursor: 'page-2' };
      state.pages[key('page-2')] = { items: [
        occurrence(3, { scheduledFor: '2026-09-28T14:00:00.000Z', state: 'blocked', reason: 'Case draft, archived or unavailable' }),
        occurrence(4, { scheduledFor: '2026-09-27T14:00:00.000Z', state: 'queued', runId: dispatchedRun, runStatus: 'queued' })], nextCursor: null };
      const card = desk.locator('.schedule-card', { hasText: 'Chicago nightly' });
      await card.getByRole('button', { name: 'Remove' }).click();
      assert.equal(state.calls.some(call => call.method === 'DELETE'), false, 'removal needs confirmation');
      await card.getByRole('button', { name: 'Keep schedule' }).click();
      await card.getByRole('button', { name: 'Remove' }).click();
      await card.getByRole('button', { name: 'Archive schedule' }).click();
      await desk.getByText('No active schedules.').waitFor();
      assert.equal(await desk.locator(':scope > .schedule-list .schedule-card').count(), 0, 'the removed schedule left the active list');

      await desk.locator('summary', { hasText: 'Archived schedules' }).click();
      const archived = desk.locator('.schedule-card.archived', { hasText: 'Chicago nightly' });
      await archived.waitFor();
      const body = await archived.innerText();
      assert.match(body, /Archived/); assert.match(body, /Removed Wed, Sep 30, 2026 22:30 America\/Chicago \(CDT\)/);
      assert.match(body, /From saved definition Nightly chart probe · revision 3/); assert.match(body, /Judge: OpenRouter fixture\/paid/);
      assert.equal(await archived.getByRole('button', { name: /^(Edit|Pause|Resume|Remove)$/ }).count(), 0, 'archived schedules are read-only');

      await archived.getByRole('button', { name: 'Inspect occurrences' }).click();
      const list = archived.locator('.schedule-occurrence-list li');
      await list.nth(1).waitFor();
      assert.equal(await list.count(), 2, 'only the first bounded page loads');
      assert.ok(state.calls.some(call => call.path.endsWith('/occurrences/page?limit=25')));
      assert.match(await list.nth(0).innerText(), /Wed, Sep 30, 2026 09:00 America\/Chicago \(CDT\)[\s\S]*SKIPPED[\s\S]*Skipped: Target reserved by run 00000000/i);
      assert.equal(await list.nth(0).getByRole('link', { name: '00000000' }).getAttribute('href'), `/runs/${blockingRun}`);
      assert.equal(await list.nth(1).getByRole('link', { name: `Open run ${finishedRun.slice(0, 8)}` }).getAttribute('href'), `/runs/${finishedRun}`);
      assert.match(await list.nth(1).innerText(), /finished \/ safe/);

      state.failPage = 'page-2';
      await archived.getByRole('button', { name: 'Load older occurrences' }).click();
      await archived.getByRole('alert').getByText(/Refresh failed; the rows shown are retained/).waitFor();
      assert.equal(await list.count(), 2, 'a failed page keeps the loaded rows');
      await archived.getByRole('alert').getByRole('button', { name: 'Retry' }).click();
      await list.nth(3).waitFor();
      assert.equal(await list.count(), 4);
      assert.equal(await archived.getByRole('button', { name: 'Load older occurrences' }).count(), 0, 'no button once the history ends');
      assert.match(await list.nth(2).innerText(), /BLOCKED[\s\S]*Blocked: Case draft, archived or unavailable/i);
      assert.match(await list.nth(3).innerText(), /QUEUED/i);
      assert.ok(state.calls.some(call => call.path.endsWith('cursor=page-2')));

      await list.nth(1).getByRole('link', { name: `Open run ${finishedRun.slice(0, 8)}` }).click();
      await page.waitForURL(url => url.pathname === `/runs/${finishedRun}`);
      assert.deepEqual(errors, []);
    } finally { await close(); }
  });
});

test('phone width keeps the form, zone labels and occurrence history inside the viewport', async () => {
  const first = schedule(1, 'Chicago nightly with a deliberately long schedule name to exercise wrapping', {}), old = { ...schedule(2, 'Retired sweep', {}), archived: true, archivedAt: '2026-10-01T03:30:00.000Z' };
  await withHarness(async (browser, vite) => {
    const { state, desk, close, page } = await harness(browser, vite, { timezoneId: 'Asia/Tokyo', viewport: { width: 390, height: 844 }, active: [first], archived: [old] });
    try {
      state.pages[`${old.id}:`] = { items: [occurrence(1, { state: 'skipped', reason: `Target reserved by run ${blockingRun}` }), occurrence(2, { runId: finishedRun, runStatus: 'finished', runOutcome: 'safe' })], nextCursor: null };
      await desk.getByLabel('Saved run definition').selectOption(definitionA);
      await desk.locator('summary', { hasText: 'Archived schedules' }).click();
      await desk.locator('.schedule-card.archived').getByRole('button', { name: 'Inspect occurrences' }).click();
      await desk.locator('.schedule-occurrence-list li').nth(1).waitFor();
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, 'no horizontal page scroll');
      for (const name of ['Saved run definition', 'IANA time zone', 'Time of day (in the schedule zone)']) { const box = await desk.getByLabel(name).boundingBox(); assert.ok(box && box.x >= 0 && box.x + box.width <= 390, `${name} stays inside the viewport`); }
    } finally { await close(); }
  });
});

test('capture synthetic schedule evidence', { skip: process.env.HDX20_CAPTURE !== '1' }, async () => {
  await mkdir(output, { recursive: true });
  const active = [schedule(1, 'Chicago nightly', {}), schedule(2, 'London weekly', { definition: { name: 'London weekly', cadence: 'weekly', weekday: 1, hour: 9, minute: 0, zone: 'Europe/London', run: definitions[0].run }, nextFireAt: '2026-10-05T08:00:00.000Z', paused: true })];
  const archivedSchedule = { ...schedule(3, 'Retired adaptive sweep', { definition: { name: 'Retired adaptive sweep', cadence: 'daily', hour: 6, minute: 30, zone: 'America/Chicago', run: definitions[1].run }, cases: [{ id: caseA, title: 'Prompt override case', category: 'prompt_injection' }, { id: caseB, title: 'Cross chart case', category: 'cross_patient' }], source: { runDefinitionId: definitionB, revision: 1, name: 'Weekly adaptive sweep' } }), archived: true, archivedAt: '2026-10-01T03:30:00.000Z' };
  await withHarness(async (browser, vite) => {
    for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }]) {
      const { page, state, desk, close } = await harness(browser, vite, { timezoneId: 'Asia/Tokyo', viewport, active, archived: [archivedSchedule] });
      const shot = (name: string) => page.screenshot({ path: join(output, `${name}-${viewport.width}.png`), fullPage: true });
      try {
        state.pages[`${archivedSchedule.id}:`] = { items: [
          occurrence(1, { scheduledFor: '2026-09-30T11:30:00.000Z', state: 'skipped', reason: `Target reserved by run ${blockingRun}` }),
          occurrence(2, { scheduledFor: '2026-09-29T11:30:00.000Z', state: 'finished', runId: finishedRun, runStatus: 'finished', runOutcome: 'safe' }),
          occurrence(3, { scheduledFor: '2026-09-28T11:30:00.000Z', state: 'blocked', reason: 'Target/login/chart preflight unavailable', runId: dispatchedRun, runStatus: 'finished', runOutcome: 'blocked' })], nextCursor: 'page-2' };
        await desk.locator('.schedule-card').first().waitFor();
        await shot('schedule-list');
        await desk.getByLabel('Saved run definition').selectOption(definitionA);
        await desk.getByLabel('Schedule name').fill('Nightly chart probe');
        await desk.getByLabel('IANA time zone').fill('America/Chicago');
        await desk.getByLabel('IANA time zone').blur();
        await desk.locator('.schedule-form').scrollIntoViewIfNeeded();
        await shot('create-from-definition');
        await desk.locator('summary', { hasText: 'Archived schedules' }).click();
        const archived = desk.locator('.schedule-card.archived');
        await archived.getByRole('button', { name: 'Inspect occurrences' }).click();
        await archived.locator('.schedule-occurrence-list li').nth(2).waitFor();
        await shot('archived-detail');
      } finally { await close(); }
    }
  });
});
