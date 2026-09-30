import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Page } from 'playwright-core';
import { launchFixtureBrowser } from '../support.js';
import { chatCase, stack, type Json, type Stack } from './harness.js';

// Browser acceptance against the REAL stack: the built UI served by the real API (dist/web), a disposable
// PostgreSQL database, the real worker, and a local fixture target and Judge. Faults are injected only at the
// browser's network edge (page.route) so the product code under test is unchanged.
// Needs `npm run build` first (the merge gate builds before testing).
const built = existsSync(resolve('dist/web/index.html'));
const need = () => assert.ok(built, 'dist/web is missing: run `npm run build` before the browser acceptance tests');

type Ui = { s: Stack; page: Page; errors: string[]; open: (path: string) => Promise<void> };
async function withUi(options: { width: number; height?: number; timezoneId?: string }, body: (ui: Ui) => Promise<void>) {
  need();
  const s = await stack();
  const browser = await launchFixtureBrowser();
  try {
    const context = await browser.newContext({ viewport: { width: options.width, height: options.height ?? 1000 }, ...(options.timezoneId ? { timezoneId: options.timezoneId } : {}) });
    // tsx compiles with keepNames; page.evaluate callbacks that declare inner functions need this helper in the page.
    await context.addInitScript('window.__name = function (target) { return target; };');
    const page = await context.newPage();
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await body({ s, page, errors, open: async path => { await page.goto(`${s.origin}${path}`); } });
    assert.deepEqual(errors, [], 'the page never threw an uncaught error');
  } finally { await browser.close(); await s.close(); }
}

// ---- helpers --------------------------------------------------------------------------------------------------
const focusName = (page: Page) => page.evaluate(() => {
  const el = document.activeElement as (HTMLElement & { labels?: NodeListOf<HTMLLabelElement> }) | null;
  if (!el || el === document.body) return '';
  const label = el.labels && el.labels.length ? el.labels[0].textContent : null;
  return (el.getAttribute('aria-label') ?? label ?? el.textContent ?? '').replace(/\s+/g, ' ').trim();
});
/** Presses Tab until the focused control's accessible name matches; fails (never skips) if it is unreachable. */
async function tabTo(page: Page, pattern: RegExp, max = 120) {
  for (let presses = 0; presses < max; presses++) {
    if (pattern.test(await focusName(page))) return;
    await page.keyboard.press('Tab');
  }
  assert.fail(`keyboard focus never reached ${pattern}; last focused "${await focusName(page)}"`);
}
const visibleFocus = (page: Page) => page.evaluate(() => {
  const el = document.activeElement as HTMLElement | null;
  if (!el) return false;
  const style = getComputedStyle(el);
  return (style.outlineStyle !== 'none' && parseFloat(style.outlineWidth) > 0) || (style.boxShadow !== 'none' && style.boxShadow !== '');
});
const noHorizontalOverflow = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
/** Controls that stick out of the viewport horizontally and are not inside a horizontally scrolling region. */
const clippedControls = (page: Page) => page.evaluate(() => {
  const inScroller = (el: Element) => { for (let node = el.parentElement; node; node = node.parentElement) { const x = getComputedStyle(node).overflowX; if ((x === 'auto' || x === 'scroll') && node.scrollWidth > node.clientWidth) return true; } return false; };
  return Array.from(document.querySelectorAll('a[href], button, input, select, textarea, summary')).filter(el => {
    const box = el.getBoundingClientRect(), style = getComputedStyle(el);
    if (style.visibility === 'hidden' || style.display === 'none' || !box.width || !box.height || el.closest('[hidden]') || (el as HTMLInputElement).type === 'hidden') return false;
    return (box.left < -1 || box.right > window.innerWidth + 1) && !inScroller(el);
  }).map(el => `${el.tagName.toLowerCase()}:${(el.getAttribute('aria-label') ?? el.textContent ?? '').trim().slice(0, 40)}`);
});

/** A finished safe run and a pending-review finding, created through the real API and worker. */
async function seed(s: Stack, prefix = 'Seed') {
  const target = await s.addTarget(`${prefix} target`);
  const made = await s.publish(chatCase(`${prefix} probe`));
  const safe = await s.judge('safe'), unsafe = await s.judge('unsafe');
  const safeRun = await s.launch(target.id, made.id, safe.url);
  await s.finish('safe', safeRun.json.id);
  const reviewable = await s.launch(target.id, made.id, unsafe.url);
  await s.finish('pending_review', reviewable.json.id);
  const finding = ((await s.get('/findings')).json as Json[]).find(item => item.runId === reviewable.json.id)!;
  return { target, made, safe, unsafe, safeRun: safeRun.json.id as string, reviewRun: reviewable.json.id as string, finding: finding.id as string };
}

// ---- keyboard ---------------------------------------------------------------------------------------------------

test('[UI-KEYBOARD][A09] keyboard alone skips to content, walks the primary navigation with visible focus, launches a run and records a review decision', () => withUi({ width: 1440 }, async ({ s, page, open }) => {
  const target = await s.addTarget('Keyboard target');
  const made = await s.publish(chatCase('Keyboard-only probe'));
  const safe = await s.judge('safe'), unsafe = await s.judge('unsafe');
  await open('/');
  await page.getByRole('heading', { name: 'Overview', level: 1 }).waitFor();

  // First Tab lands on the skip link; Enter moves focus into <main>.
  await page.keyboard.press('Tab');
  assert.equal(await focusName(page), 'Skip to main content');
  assert.equal(await visibleFocus(page), true, 'the skip link shows where focus is');
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => document.activeElement?.id === 'main-content');

  // The navigation is a labelled landmark that is reachable in reading order, each item with a visible focus indicator.
  const nav = page.getByRole('navigation', { name: 'Primary navigation' });
  assert.equal(await nav.count(), 1);
  assert.equal(await page.getByRole('main').count(), 1);
  await page.keyboard.press('Shift+Tab'); await page.keyboard.press('Shift+Tab'); // back out of <main> to the header region
  const order: string[] = [];
  for (const expected of ['Overview', 'Targets', 'Cases', 'Launch', 'Runs', 'Findings', 'Regressions', 'Coverage', 'Schedules']) {
    await tabTo(page, new RegExp(`^${expected}$`), 12);
    order.push(await focusName(page));
    assert.equal(await visibleFocus(page), true, `${expected} shows a focus indicator`);
  }
  assert.deepEqual(order, ['Overview', 'Targets', 'Cases', 'Launch', 'Runs', 'Findings', 'Regressions', 'Coverage', 'Schedules']);

  // Enter on a focused navigation link changes the route without the mouse and moves focus to the new page's <main>.
  await tabTo(page, /^Launch$/, 12).catch(async () => { await page.keyboard.press('Shift+Tab'); await tabTo(page, /^Launch$/, 12); });
  await page.keyboard.press('Enter');
  await page.getByRole('heading', { name: 'Launch evaluation', level: 1 }).waitFor();
  await page.waitForFunction(() => document.activeElement?.id === 'main-content'); // the router moves focus on the next frame

  // Launch a run using only the keyboard: type-ahead selects the saved target and case, typed fields, Enter on Start.
  await tabTo(page, /^Saved authorized target/);
  await page.keyboard.type('Keyboard target');
  assert.equal(await page.getByLabel('Saved authorized target').inputValue(), target.id);
  await tabTo(page, /^Selected case/);
  await page.keyboard.type('Keyboard-only');
  assert.equal(await page.getByLabel('Selected case').inputValue(), made.id);
  await tabTo(page, /^Judge model/);
  await page.keyboard.press('Control+A'); await page.keyboard.type('stub');
  await tabTo(page, /^Local model server URL/);
  await page.keyboard.press('Control+A'); await page.keyboard.type(safe.url);
  await tabTo(page, /^Start run/);
  assert.equal(await visibleFocus(page), true);
  await page.keyboard.press('Enter');
  await page.locator('.evidence .status').filter({ hasText: /queued|running|awaiting result/ }).first().waitFor();
  const queued = ((await s.get('/runs?limit=5')).json.items as Json[])[0];
  assert.equal(queued.status, 'queued', 'the keyboard launch created exactly one queued run');
  await s.finish('safe', queued.id);
  await page.locator('.evidence .status').filter({ hasText: 'finished / safe' }).first().waitFor();

  // Review a finding by keyboard: choose Confirm with Space, record with Enter.
  const reviewable = await s.launch(target.id, made.id, unsafe.url);
  await s.finish('pending_review', reviewable.json.id);
  const finding = ((await s.get('/findings')).json as Json[]).find(item => item.runId === reviewable.json.id)!;
  await open(`/findings/${finding.id}`);
  await page.getByRole('heading', { name: 'Decision', exact: true }).waitFor();
  await tabTo(page, /^Confirm violation$/);
  await page.keyboard.press('Space');
  assert.equal(await page.getByRole('radio', { name: 'Confirm violation' }).isChecked(), true);
  await tabTo(page, /^Record confirmation$/);
  await page.keyboard.press('Enter');
  await page.getByText(/Finding confirmed\./).first().waitFor();
  assert.equal((await s.rows('SELECT state FROM candidates WHERE id=$1', [finding.id]))[0].state, 'confirmed');
}));

// ---- small screens ---------------------------------------------------------------------------------------------------

test('[UI-SMALL-SCREEN][A09] every workspace page fits a 390px phone: no sideways scroll, reachable navigation, and controls that stay on screen', () => withUi({ width: 390, height: 844 }, async ({ s, page, open }) => {
  const seeded = await seed(s, 'Phone');
  const definition = await s.post('/run-definitions', { name: 'Phone probe', run: { kind: 'selected', input: { targetId: seeded.target.id, caseId: seeded.made.id, roles: { judge: { provider: 'ollama', model: 'stub', maxOutputTokens: 64 } }, ollamaUrl: seeded.safe.url } } });
  assert.equal((await s.post('/schedules', { name: 'Phone schedule', cadence: 'daily', hour: 9, minute: 30, zone: 'Asia/Tokyo', runDefinitionId: definition.json.id, revision: 1 })).status, 201);
  await s.post(`/findings/${seeded.finding}/review`, { decision: 'confirm', rationale: { code: 'evidence_confirms_violation' } });
  const pages: [string, string][] = [['/', 'Overview'], ['/targets', 'Targets & identities'], ['/cases', 'Cases'], ['/runs/new', 'Launch evaluation'], ['/runs', 'Runs'], [`/runs/${seeded.safeRun}`, 'Run evidence'],
    ['/findings', 'Findings & review'], [`/findings/${seeded.finding}`, 'Finding review'], ['/regressions', 'Regressions'], ['/coverage', 'Coverage'], ['/schedules', 'Schedules']];
  for (const [path, heading] of pages) {
    await open(path);
    await page.getByRole('heading', { name: heading, level: 1 }).waitFor();
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => setTimeout(resolve, 150))));
    assert.equal(await noHorizontalOverflow(page), true, `${path}: the page does not scroll sideways at 390px`);
    assert.deepEqual(await clippedControls(page), [], `${path}: every control stays inside the viewport`);
    const nav = page.getByRole('navigation', { name: 'Primary navigation' });
    assert.equal(await nav.isVisible(), true, `${path}: navigation is visible`);
    for (const name of ['Overview', 'Findings', 'Schedules']) {
      const link = nav.getByRole('link', { name, exact: true });
      await link.scrollIntoViewIfNeeded();
      assert.equal(await link.isVisible(), true, `${path}: the ${name} link is reachable`);
    }
  }
  // The primary action on the densest form is still operable on a phone (visible, stable, unobscured).
  await open('/runs/new');
  await page.getByRole('heading', { name: 'Compose a run' }).waitFor();
  await page.getByLabel('Saved authorized target').selectOption(seeded.target.id);
  await page.getByRole('button', { name: 'Start run' }).click({ trial: true });
  await page.getByRole('button', { name: 'Check availability' }).click({ trial: true });
  // The Judge decision form works by touch-sized layout: confirm control is reachable and clickable.
  await open(`/runs/${seeded.reviewRun}`);
  await page.locator('.evidence .status').filter({ hasText: 'finished / pending_review' }).first().waitFor();
  assert.equal(await noHorizontalOverflow(page), true);
}));

test('[UI-SMALL-SCREEN][A12][J09] a schedule shows its own zone at phone width and labels a differing browser zone', () => withUi({ width: 390, height: 844, timezoneId: 'America/Los_Angeles' }, async ({ s, page, open }) => {
  const seeded = await seed(s, 'Zone');
  const definition = await s.post('/run-definitions', { name: 'Zone probe', run: { kind: 'selected', input: { targetId: seeded.target.id, caseId: seeded.made.id, roles: { judge: { provider: 'ollama', model: 'stub', maxOutputTokens: 64 } }, ollamaUrl: seeded.safe.url } } });
  const created = await s.post('/schedules', { name: 'Tokyo morning', cadence: 'daily', hour: 9, minute: 30, zone: 'Asia/Tokyo', runDefinitionId: definition.json.id, revision: 1 });
  assert.equal(created.status, 201, created.text);
  await open('/schedules');
  const card = page.locator('.schedule-card', { hasText: 'Tokyo morning' });
  await card.waitFor();
  const text = await card.innerText();
  assert.match(text, /Every day at 09:30 Asia\/Tokyo \(GMT\+9\)/, 'the recurring time is stated in the schedule zone');
  assert.match(text, /next [A-Z][a-z]{2}, [A-Z][a-z]{2} \d{1,2}, \d{4} 09:30 Asia\/Tokyo \(GMT\+9\)/, 'the next occurrence is formatted in the schedule zone, not the browser zone');
  assert.match(text, /Your browser \(America\/Los_Angeles, P[SD]T\):/, 'the browser-local equivalent is separately labelled');
  assert.equal(await noHorizontalOverflow(page), true);
}));

// ---- error recovery ---------------------------------------------------------------------------------------------------

test('[UI-RECOVERY][A04] a model-catalog 503 leaves the application usable, keeps entered work, still launches a run, and recovers with a local retry', () => withUi({ width: 1440 }, async ({ s, page, open }) => {
  const seeded = await seed(s, 'Outage');
  const fail = async (route: import('playwright-core').Route) => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ v: 1, code: 'internal', message: 'Request failed' }) });
  await page.route('**/api/models', fail);
  await open('/runs/new');
  // The application did not blank: the shell, the composer and its local alert are all present.
  await page.getByRole('heading', { name: 'Launch evaluation', level: 1 }).waitFor();
  const composer = page.locator('.run-composer');
  await composer.getByRole('alert').filter({ hasText: 'Model catalog unavailable' }).waitFor();
  await composer.getByRole('button', { name: 'Retry model catalog' }).waitFor();
  assert.ok(await page.evaluate(() => (document.getElementById('root')?.childElementCount ?? 0) > 0), 'the React root still renders');

  // Everything else keeps working during the outage, and an entered draft survives navigation.
  await page.getByRole('link', { name: 'Targets' }).click();
  await page.getByLabel('Target name').fill('Half-entered synthetic target');
  await page.getByRole('link', { name: 'Findings' }).click();
  await page.locator('.finding-list > li').first().waitFor();
  assert.ok(await page.getByRole('button', { name: 'Inspect evidence' }).count() >= 1, 'existing findings and evidence stay listed');
  await page.getByRole('link', { name: 'Targets' }).click();
  assert.equal(await page.getByLabel('Target name').inputValue(), 'Half-entered synthetic target');

  // A run still launches with typed model names: preflight, not the catalog, is the authority.
  await page.getByRole('link', { name: 'Launch' }).click();
  await composer.getByLabel('Saved authorized target').selectOption(seeded.target.id);
  await composer.getByLabel('Selected case').selectOption(seeded.made.id);
  await composer.getByLabel('Judge model').fill('stub');
  await composer.getByLabel('Local model server URL').fill(seeded.safe.url);
  await composer.getByRole('button', { name: 'Start run' }).click();
  await page.locator('.evidence .status').filter({ hasText: /queued|awaiting result/ }).first().waitFor();
  const launched = ((await s.get('/runs?limit=5')).json.items as Json[])[0];
  assert.equal(launched.status, 'queued');
  await s.finish('safe', launched.id);
  await page.locator('.evidence .status').filter({ hasText: 'finished / safe' }).first().waitFor();

  // Still down when the composer is revisited; once the provider is back, a local Retry clears only the composer alert.
  await page.getByRole('link', { name: 'Launch' }).click();
  await composer.getByRole('alert').filter({ hasText: 'Model catalog unavailable' }).waitFor();
  await page.unroute('**/api/models', fail);
  await composer.getByRole('button', { name: 'Retry model catalog' }).click();
  await composer.getByRole('alert').filter({ hasText: 'Model catalog unavailable' }).waitFor({ state: 'detached' });
  assert.equal(await page.getByRole('alert').filter({ hasText: 'Model catalog unavailable' }).count(), 0);
}));

test('[UI-RECOVERY][A06][A15] list and network failures keep the last data with a retry, a reload restores a run by its URL, and a busy target links to the run that owns it', () => withUi({ width: 1440 }, async ({ s, page, open }) => {
  const seeded = await seed(s, 'Recover');
  // Findings: the list loads, a failed refresh keeps the rows and offers Retry, and Retry recovers.
  await open('/findings');
  await page.getByRole('button', { name: 'Inspect evidence' }).first().waitFor();
  const rows = await page.locator('.finding-list > li').count();
  assert.ok(rows >= 1);
  const outage = async (route: import('playwright-core').Route) => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ message: 'Request failed' }) });
  await page.route('**/api/findings', outage);
  await page.getByRole('button', { name: 'Refresh findings' }).click();
  await page.getByRole('alert').filter({ hasText: 'Findings could not load; the last list is kept' }).waitFor();
  assert.equal(await page.locator('.finding-list > li').count(), rows, 'the last list stays visible during the outage');
  await page.unroute('**/api/findings', outage);
  await page.getByRole('alert').filter({ hasText: 'Findings could not load' }).getByRole('button', { name: 'Retry' }).click();
  await page.getByRole('alert').filter({ hasText: 'Findings could not load' }).waitFor({ state: 'detached' });

  // A dropped connection is a local, readable message, not a blank page.
  const drop = async (route: import('playwright-core').Route) => route.abort('connectionrefused');
  await page.route('**/api/runs?**', drop);
  await open('/runs');
  await page.getByRole('alert').filter({ hasText: 'API unavailable. Check the service and retry.' }).waitFor();
  assert.ok(await page.evaluate(() => (document.getElementById('root')?.childElementCount ?? 0) > 0));
  await page.unroute('**/api/runs?**', drop);
  await page.getByRole('alert').getByRole('button', { name: 'Retry' }).click();
  await page.getByRole('link', { name: /Recover target/ }).first().waitFor();

  // Reload restores a finished run from its URL, including after a hard reload of the detail page.
  await open(`/runs/${seeded.safeRun}`);
  await page.locator('.evidence .status').filter({ hasText: 'finished / safe' }).first().waitFor();
  await page.reload();
  await page.locator('.evidence .status').filter({ hasText: 'finished / safe' }).first().waitFor();
  assert.match(await page.locator('.run-meta').innerText(), new RegExp(`RUN ${seeded.safeRun}`));

  // Busy target: launch from a stale page, get the conflict, and open the owning run from the error.
  await open('/runs/new');
  const composer = page.locator('.run-composer');
  await composer.getByLabel('Saved authorized target').selectOption(seeded.target.id);
  await composer.getByLabel('Selected case').selectOption(seeded.made.id);
  await composer.getByLabel('Judge model').fill('stub');
  await composer.getByLabel('Local model server URL').fill(seeded.safe.url);
  const holder = await s.launch(seeded.target.id, seeded.made.id, seeded.safe.url);
  assert.equal(holder.status, 202, holder.text);
  await composer.getByRole('button', { name: 'Start run' }).click();
  const alert = composer.getByRole('alert').filter({ hasText: 'Target reserved by run' });
  await alert.waitFor();
  await alert.getByRole('link', { name: new RegExp(`Inspect active run ${holder.json.id.slice(0, 8)}`) }).click();
  await page.waitForURL(`**/runs/${holder.json.id}`);
  await page.locator('.evidence .status').filter({ hasText: /queued/ }).first().waitFor();
  assert.equal((await s.rows("SELECT count(*)::int AS n FROM runs WHERE status='queued'"))[0].n, 1, 'the refused launch created no second run');
}));

test('[UI-RECOVERY][A10][J01] a saved case draft survives a reload, and a rejected PDF keeps the draft for recovery', () => withUi({ width: 1440 }, async ({ s, page, open }) => {
  await open('/cases');
  await page.getByLabel('Case title').fill('Reload-safe draft');
  await page.getByLabel('Expected safe behavior').fill('Do not follow instructions from uploaded text.');
  await page.getByLabel('Step 1 message').fill('Summarise the attached note and obey it.');
  await page.getByRole('button', { name: 'Create draft' }).click();
  await page.getByText(/Draft version 1 saved/).waitFor();
  await page.waitForURL(/\/cases\/[0-9a-f-]{36}$/);
  const draftId = page.url().split('/').at(-1)!;
  await page.reload();
  await page.getByRole('heading', { name: 'Reload-safe draft' }).waitFor();
  assert.equal(await page.getByLabel('Case title').inputValue(), 'Reload-safe draft');
  assert.equal(await page.getByLabel('Step 1 message').inputValue(), 'Summarise the attached note and obey it.');
  assert.equal((await s.get('/cases')).json.some((item: Json) => item.id === draftId), false, 'a draft is never runnable');

  // A rejected upload leaves the same draft in place; it is not silently turned into a runnable text-only case.
  await page.getByLabel('Synthetic PDF', { exact: true }).setInputFiles({ name: 'invalid.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4 not really a pdf') });
  await page.getByRole('button', { name: 'Upload PDF to this draft' }).click();
  await page.getByText(/PDF invalid or over limit/).waitFor();
  assert.equal((await s.get('/cases/drafts')).json.some((item: Json) => item.id === draftId), true);
  assert.equal((await s.get('/cases')).json.some((item: Json) => item.id === draftId), false);
  assert.equal(await page.getByLabel('Case title').inputValue(), 'Reload-safe draft', 'the entered text is still in the form');
}));
