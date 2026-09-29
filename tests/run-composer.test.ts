import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import type { Page } from 'playwright-core';
import { createServer as createViteServer, type ViteDevServer } from 'vite';
import { launchFixtureBrowser } from './support.js';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const targetId = id(1), busyTargetId = id(2), caseA = id(10), caseB = id(11), caseC = id(12), activeRun = id(90);
const target = { id: targetId, name: 'Synthetic chart target', baseUrl: 'http://fixture.invalid/', activeRunId: null };
const busyTarget = { id: busyTargetId, name: 'Busy synthetic target', baseUrl: 'http://busy.invalid/', activeRunId: activeRun };
const seed = (caseId: string, title: string, category: string) => ({ id: caseId, title, category, user: 'A', expectedSafeBehavior: `Expected safe behavior for ${title}`, actions: [{ kind: 'chat_turn', message: `Synthetic step for ${title}` }] });
const cases = [seed(caseA, 'Prompt override case', 'prompt_injection'), seed(caseB, 'Cross chart case', 'cross_patient'), seed(caseC, 'Unexpected tool case', 'unintended_tool_action')];
const output = resolve('test-results/HDX-19/after');
const gate = () => { let open!: () => void; const promise = new Promise<void>(resolve => { open = resolve; }); return { promise, open }; };

type Call = { method: string; path: string; body: any };
type Knobs = { preflight?: (run: any) => any; catalog: 'ok' | 'empty' | 'down'; launch: 'ok' | 'busy' | 'fail'; stalePut: boolean; delay: { preflight: number; launch: number }; definitionGate?: Promise<void> };
const okPreflight = (run: any) => {
  const roles = Object.values(run.input.roles) as { provider: string }[];
  const local = roles.some(role => role.provider === 'ollama'), paid = roles.some(role => role.provider === 'openrouter');
  return { status: 'available', inferenceHealth: 'unverified', issues: [], local: { status: local ? 'available' : 'not_required', installed: ['stub'] }, paid: { status: paid ? 'available' : 'not_required', configured: paid },
    preview: { reservationNanos: paid ? '120000000' : '0', capNanos: run.input.openRouterCapUsd === undefined ? null : String(Math.round(run.input.openRouterCapUsd * 1e9)), attempts: run.kind === 'adaptive' ? run.input.maxCases : 1, basis: 'one_call_per_active_role_per_attempt' } };
};

async function harness(viewport = { width: 1440, height: 1000 }) {
  const server: ViteDevServer = await createViteServer({ configFile: resolve('apps/web/vite.config.ts'), server: { host: '127.0.0.1', port: 0 }, logLevel: 'error' });
  await server.listen();
  const address = server.httpServer?.address();
  assert.ok(address && typeof address !== 'string');
  const browser = await launchFixtureBrowser();
  const page = await browser.newPage({ viewport });
  const calls: Call[] = [], definitions: any[] = [], errors: string[] = [];
  const knobs: Knobs = { catalog: 'ok', launch: 'ok', stalePut: false, delay: { preflight: 0, launch: 0 } };
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/api/**', async route => {
    const request = route.request(), pathname = new URL(request.url()).pathname, method = request.method();
    if (!pathname.startsWith('/api/')) return route.continue();
    const path = pathname.slice('/api'.length);
    const body = request.postData() ? JSON.parse(request.postData()!) : undefined;
    if (method !== 'GET') calls.push({ method, path, body });
    const reply = (payload: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(payload) });
    const wait = (ms: number) => ms ? new Promise(resolve => setTimeout(resolve, ms)) : undefined;
    if (path === '/targets') return reply([target, busyTarget]);
    if (path === '/cases') return reply(cases);
    if (path === '/config') return reply({ ollamaUrl: 'http://127.0.0.1:11434', model: 'stub' });
    if (path === '/models') return knobs.catalog === 'down' ? reply({ message: 'synthetic catalog offline' }, 503) : reply({ openrouter: knobs.catalog === 'empty' ? [] : ['fixture/paid'], ollama: knobs.catalog === 'empty' ? [] : ['stub'], configured: true, inferenceHealth: 'unverified', availability: { openrouter: 'available', ollama: 'available' } });
    if (path === '/findings') return reply([{ id: 'finding-source', runId: 'run-source', state: 'confirmed', title: 'Synthetic finding', version: null, decisionRoute: null, exportApprovedAt: null }]);
    if (path === '/regressions') return reply([{ id: 'regression-source', sourceRunId: 'run-source', version: null, definition: { title: 'Cross chart case' }, replays: [] }]);
    if (path === '/runs/run-source') return reply({ caseId: caseB });
    if (path === '/coverage' || path === '/schedules' || path.endsWith('/usage') || path.endsWith('/events') || path.endsWith('/cases') && path.startsWith('/runs/')) return reply([]);
    if (path === '/model-preflight') { await wait(knobs.delay.preflight); return reply((knobs.preflight ?? okPreflight)(body)); }
    if (path === '/run-definitions' && method === 'GET') return reply(definitions);
    if (path === '/run-definitions') { const value = { id: id(100 + definitions.length), name: body.name, run: body.run, revision: 1, archived: false, createdAt: '2026-09-29T12:00:00.000Z', updatedAt: '2026-09-29T12:00:00.000Z' }; definitions.unshift(value); return reply(value, 201); }
    const found = /^\/run-definitions\/([^/]+)(\/launch)?$/.exec(path);
    if (found && !found[2] && method === 'GET') { await knobs.definitionGate; return reply(definitions.find(item => item.id === found[1])); }
    if (found && !found[2] && method === 'PUT') {
      const value = definitions.find(item => item.id === found[1]);
      if (knobs.stalePut || value.revision !== body.revision) return reply({ v: 1, code: 'conflict', message: 'Run definition changed or archived; reload before continuing' }, 409);
      Object.assign(value, { name: body.name, run: body.run, revision: value.revision + 1 }); return reply(value);
    }
    if (found && found[2]) {
      await wait(knobs.delay.launch);
      if (knobs.launch === 'busy') return reply({ v: 1, code: 'conflict', message: 'Target already reserved', active_run_id: activeRun }, 409);
      if (knobs.launch === 'fail') return reply({ v: 1, code: 'unavailable', message: 'Ollama model catalog unavailable' }, 503);
      return reply({ id: 'run-launched', status: 'queued' }, 202);
    }
    if (path === '/runs/run-launched' || path === `/runs/${activeRun}`) return reply({ id: path.slice('/runs/'.length), status: 'queued', outcome: null, version: null, model: 'assigned per role' });
    return reply({ message: `Unexpected synthetic request ${path}` }, 404);
  });
  const base = `http://127.0.0.1:${address.port}`;
  await page.goto(`${base}/runs/new`, { waitUntil: 'networkidle' });
  return { page, calls, knobs, definitions, errors, base, composer: page.locator('.run-composer'), close: async () => { await browser.close(); await server.close(); } };
}
const writes = (calls: Call[]) => calls.map(call => `${call.method} ${call.path.replace(/[0-9a-f-]{36}/, ':id')}`);
const focusedRole = (page: Page) => page.evaluate(() => document.activeElement?.getAttribute('role'));

test('selected Judge-local run: check, save once, launch the exact revision and route to the run', async () => {
  const { page, calls, composer, errors, close } = await harness();
  try {
    assert.equal(await page.getByRole('heading', { name: 'Launch evaluation', level: 1 }).count(), 1);
    assert.equal(await composer.getByRole('button', { name: /Start/ }).count(), 1, 'one launch path');
    assert.equal(await composer.getByLabel(/Documentation/i).count(), 0);
    assert.equal(await composer.getByLabel('Orchestrator provider').count(), 0, 'selected runs show only the Judge');
    await composer.getByLabel('Saved authorized target').selectOption(targetId);
    await composer.getByLabel('Selected case').selectOption(caseB);
    await composer.getByText('cross patient / user A').waitFor();
    await composer.getByLabel('Judge model').fill('stub');
    await composer.getByRole('button', { name: 'Check availability' }).click();
    await composer.getByText('$0 paid reservation; local inference unverified.').waitFor();
    await composer.getByText(/Discovery does not prove inference health/).waitFor();
    await composer.getByRole('button', { name: 'Start run' }).click();
    await page.waitForURL('**/runs/run-launched');
    const run = { kind: 'selected', input: { targetId, caseId: caseB, roles: { judge: { provider: 'ollama', model: 'stub', maxOutputTokens: 1024 } }, ollamaUrl: 'http://127.0.0.1:11434' } };
    assert.deepEqual(writes(calls), ['POST /model-preflight', 'POST /model-preflight', 'POST /run-definitions', 'POST /run-definitions/:id/launch']);
    assert.deepEqual(calls[0].body, run);
    assert.deepEqual(calls[2].body, { name: 'Synthetic chart target · Cross chart case', run });
    assert.deepEqual(calls[3].body, { revision: 1 });
    assert.deepEqual(errors, []);
  } finally { await close(); }
});

test('adaptive mixed-provider run shows the conservative reservation and remaining cap; all-paid needs no Ollama URL', async () => {
  const { page, calls, composer, close } = await harness();
  try {
    await composer.getByLabel('Saved authorized target').selectOption(targetId);
    await composer.getByLabel('Adaptive exploration').check();
    await composer.getByLabel(/Prompt override case/).check();
    await composer.getByLabel(/Cross chart case/).check();
    await composer.getByText(/2 seeds selected; categories covered: prompt injection, cross patient/).waitFor();
    await composer.getByLabel('Maximum cases').fill('2');
    await composer.getByLabel('Maximum elapsed minutes').fill('5');
    await composer.getByLabel('Red Team provider').selectOption('openrouter');
    assert.equal(await composer.getByLabel('Red Team model').inputValue(), 'fixture/paid');
    await composer.getByLabel('Judge provider').selectOption('openrouter');
    await composer.getByLabel('Judge model').fill('fixture/paid');
    await composer.getByLabel('Maximum OpenRouter spend (USD, this run)').fill('0.25');
    await composer.getByRole('button', { name: 'Check availability' }).click();
    await composer.getByText(/Conservative reservation \$0\.12 for up to 2 attempts, against a cap of \$0\.25/).waitFor();
    await composer.getByText(/Remaining allowance \$0\.13/).waitFor();
    const mixed = calls.at(-1)!.body;
    assert.equal(mixed.kind, 'adaptive');
    assert.deepEqual(mixed.input.caseIds, [caseA, caseB]);
    assert.deepEqual(mixed.input.categories, ['prompt_injection', 'cross_patient']);
    assert.deepEqual([mixed.input.maxCases, mixed.input.maxMinutes, mixed.input.openRouterCapUsd, mixed.input.ollamaUrl], [2, 5, 0.25, 'http://127.0.0.1:11434']);
    assert.deepEqual(Object.keys(mixed.input.roles), ['orchestrator', 'redTeam', 'judge']);
    assert.deepEqual(Object.values(mixed.input.roles).map((role: any) => role.provider), ['ollama', 'openrouter', 'openrouter']);
    await composer.getByLabel('Orchestrator provider').selectOption('openrouter');
    await composer.getByLabel('Orchestrator model').fill('fixture/paid');
    assert.equal(await composer.getByLabel('Local model server URL').count(), 0);
    await composer.getByLabel('Definition name').fill('All paid adaptive');
    await composer.getByRole('button', { name: 'Start run' }).click();
    await page.waitForURL('**/runs/run-launched');
    assert.equal('ollamaUrl' in calls.find(call => call.path === '/run-definitions')!.body.run.input, false);
    assert.deepEqual(calls.at(-1)!.body, { revision: 1 });
  } finally { await close(); }
});

test('unavailable, unknown or over-cap preflight blocks launch, keeps the form and is distinct from an empty catalog', async () => {
  const { page, calls, knobs, composer, close } = await harness();
  try {
    await composer.getByLabel('Saved authorized target').selectOption(targetId);
    await composer.getByLabel('Judge model').fill('missing-model');
    knobs.preflight = run => ({ ...okPreflight(run), status: 'unavailable', issues: [{ code: 'local_model_missing', role: 'judge' }], local: { status: 'available', installed: [] } });
    await composer.getByRole('button', { name: 'Start run' }).click();
    await composer.getByRole('alert').getByText('Launch blocked: Judge: model not installed locally').waitFor();
    assert.equal(await focusedRole(page), 'alert');
    assert.equal(await composer.getByRole('button', { name: 'Start run' }).isDisabled(), true);
    assert.equal(await composer.getByLabel('Judge model').inputValue(), 'missing-model');
    assert.deepEqual(writes(calls), ['POST /model-preflight'], 'nothing is saved or launched');
    await composer.getByLabel('Judge model').fill('stub');
    assert.equal(await composer.getByRole('button', { name: 'Start run' }).isDisabled(), false, 'editing invalidates the stale result');
    await composer.getByLabel('Judge provider').selectOption('openrouter');
    await composer.getByLabel('Maximum OpenRouter spend (USD, this run)').fill('0.05');
    knobs.preflight = run => ({ ...okPreflight(run), status: 'unavailable', issues: [{ code: 'paid_catalog_or_pricing_unavailable' }], paid: { status: 'unavailable', configured: true }, preview: null });
    await composer.getByRole('button', { name: 'Check availability' }).click();
    await composer.getByText('Paid reservation unknown, so launch is blocked. It is never treated as $0.').waitFor();
    knobs.preflight = okPreflight; // reserves $0.12 against the $0.05 cap
    await composer.getByRole('button', { name: 'Check availability' }).click();
    await composer.getByText(/Remaining allowance -\$0\.07 \(over cap\)/).waitFor();
    assert.equal(await composer.getByRole('button', { name: 'Start run' }).isDisabled(), true);
    assert.deepEqual(writes(calls).filter(call => call.includes('run-definitions')), []);
    knobs.catalog = 'empty';
    await composer.getByLabel('Judge provider').selectOption('ollama');
    await page.reload({ waitUntil: 'networkidle' });
    await composer.getByText(/local available \(0 listed\), OpenRouter available \(0 listed\)/).waitFor();
    assert.equal(await composer.getByRole('alert').count(), 0, 'reachable but empty is not a failure');
    knobs.catalog = 'down';
    await page.reload({ waitUntil: 'networkidle' });
    await composer.getByRole('alert').getByText(/Model catalog unavailable: synthetic catalog offline/).waitFor();
    await composer.getByLabel('Judge model').fill('typed-model');
    knobs.catalog = 'ok';
    await composer.getByRole('button', { name: 'Retry model catalog' }).click();
    await composer.getByRole('alert').waitFor({ state: 'detached' });
    assert.equal(await composer.getByLabel('Judge model').inputValue(), 'typed-model');
  } finally { await close(); }
});

test('reserved target and launch races link to the active run; failures and stale revisions keep the draft', async () => {
  const { page, calls, knobs, definitions, composer, close } = await harness();
  try {
    await composer.getByLabel('Saved authorized target').selectOption(busyTargetId);
    const link = composer.getByRole('link', { name: /Inspect active run/ });
    assert.equal(await link.first().getAttribute('href'), `/runs/${activeRun}`);
    await composer.getByLabel('Saved authorized target').selectOption(targetId);
    assert.equal(await composer.getByRole('status').filter({ hasText: 'reserved by an active run' }).count(), 0);
    knobs.launch = 'busy';
    await composer.getByRole('button', { name: 'Start run' }).click();
    const alert = composer.getByRole('alert');
    await alert.getByText(/Target reserved by run/).waitFor();
    assert.equal(await alert.getByRole('link', { name: /Inspect active run/ }).getAttribute('href'), `/runs/${activeRun}`);
    assert.equal(await focusedRole(page), 'alert');
    assert.equal(await composer.getByLabel('Judge model').inputValue(), 'stub');
    knobs.launch = 'fail';
    await composer.getByRole('button', { name: 'Start run' }).click();
    await alert.getByText('Ollama model catalog unavailable').waitFor();
    assert.equal(await page.getByRole('link', { name: 'Runs', exact: true }).count(), 1, 'the shell remains usable');
    knobs.launch = 'ok';
    await alert.getByRole('button', { name: 'Retry' }).click();
    await page.waitForURL('**/runs/run-launched');
    const saves = calls.filter(call => call.path === '/run-definitions'), launches = calls.filter(call => call.path.endsWith('/launch'));
    assert.equal(saves.length, 1, 'save-success then launch failure retries the saved revision');
    assert.deepEqual(launches.map(call => call.body), [{ revision: 1 }, { revision: 1 }, { revision: 1 }]);
    assert.equal(definitions.length, 1);
    await page.getByRole('link', { name: 'Launch' }).click();
    assert.equal(await composer.getByLabel('Saved definition').inputValue(), definitions[0].id);
    await composer.getByLabel('Judge maximum output tokens').fill('512');
    knobs.stalePut = true;
    await composer.getByRole('button', { name: 'Start run' }).click();
    await alert.getByText(/reload before continuing/).waitFor();
    assert.equal(await composer.getByLabel('Judge maximum output tokens').inputValue(), '512', 'draft is kept');
    await alert.getByRole('button', { name: 'Reload saved definition' }).click();
    await page.waitForFunction(() => (document.querySelector('.run-composer input[type="number"]') as HTMLInputElement | null)?.value === '1024');
    assert.equal(await alert.count(), 0);
  } finally { await close(); }
});

test('rapid double submit sends one save and one launch, and inputs are locked while in flight', async () => {
  const { page, calls, knobs, composer, close } = await harness();
  try {
    await composer.getByLabel('Saved authorized target').selectOption(targetId);
    knobs.delay = { preflight: 300, launch: 500 };
    await page.evaluate(() => { const form = document.querySelector<HTMLFormElement>('.run-composer form')!; form.requestSubmit(); form.requestSubmit(); form.requestSubmit(); });
    await page.locator('.composer-actions .primary').dblclick({ force: true, timeout: 1000 }).catch(() => undefined);
    await composer.getByRole('status').getByText(/Checking model catalogs/).waitFor();
    assert.equal(await composer.getByLabel('Judge model').isDisabled(), true, 'edits are locked during the check');
    await page.waitForURL('**/runs/run-launched');
    assert.deepEqual(writes(calls), ['POST /model-preflight', 'POST /run-definitions', 'POST /run-definitions/:id/launch']);
  } finally { await close(); }
});

test('regression selection survives navigation and a delayed definition load cannot overwrite it', async () => {
  const { page, knobs, definitions, composer, close } = await harness();
  try {
    await composer.getByLabel('Saved authorized target').selectOption(targetId);
    await composer.getByLabel('Selected case').selectOption(caseA);
    await composer.getByRole('button', { name: 'Save definition' }).click();
    await composer.getByText('Saved definition revision 1.').waitFor();
    const held = gate();
    knobs.definitionGate = held.promise;
    await page.reload({ waitUntil: 'networkidle' });
    await composer.getByLabel('Saved definition').selectOption(definitions[0].id);
    await page.getByRole('link', { name: 'Regressions' }).click();
    await page.getByRole('button', { name: 'Select for replay' }).click();
    await page.getByRole('heading', { name: 'Launch evaluation', level: 1 }).waitFor();
    held.open();
    await composer.getByText(/draft changed while the definition loaded/).waitFor();
    assert.equal(await composer.getByLabel('Selected case').inputValue(), caseB);
    await composer.getByLabel('Selected case').selectOption(caseA);
    await page.getByRole('link', { name: 'Regressions' }).click();
    await page.getByRole('button', { name: 'Select for replay' }).click();
    await page.getByRole('heading', { name: 'Launch evaluation', level: 1 }).waitFor();
    assert.equal(await composer.getByLabel('Selected case').inputValue(), caseB);
  } finally { await close(); }
});

test('keyboard-only mode, seed and role flow works at 390px without overflow or hidden controls', async () => {
  const { page, composer, close } = await harness({ width: 390, height: 844 });
  try {
    await composer.getByLabel('Adaptive exploration').focus();
    await page.keyboard.press('Space');
    await composer.getByLabel(/Unexpected tool case/).focus();
    await page.keyboard.press('Space');
    assert.equal(await composer.getByLabel(/Unexpected tool case/).isChecked(), true);
    await composer.getByLabel('Judge provider').focus();
    await page.keyboard.press('ArrowDown');
    assert.equal(await composer.getByLabel('Judge provider').inputValue(), 'openrouter');
    for (const name of ['Orchestrator provider', 'Red Team provider', 'Judge provider', 'Judge model', 'Judge maximum output tokens', 'Maximum OpenRouter spend (USD, this run)', 'Local model server URL', 'Maximum cases']) {
      await composer.getByLabel(name).scrollIntoViewIfNeeded();
      const box = await composer.getByLabel(name).boundingBox();
      assert.ok(box && box.x >= 0 && box.x + box.width <= 390, `${name} stays inside the viewport`);
    }
    for (const name of ['Check availability', 'Save definition', 'Start run']) assert.equal(await composer.getByRole('button', { name }).isVisible(), true);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
  } finally { await close(); }
});

test('capture synthetic composer evidence', { skip: process.env.HDX19_CAPTURE !== '1' }, async () => {
  await mkdir(output, { recursive: true });
  for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }]) {
    const { page, knobs, composer, close } = await harness(viewport);
    const shot = (name: string) => page.screenshot({ path: join(output, `${name}-${viewport.width}.png`), fullPage: true });
    try {
      await composer.getByLabel('Saved authorized target').selectOption(targetId);
      await composer.getByLabel('Selected case').selectOption(caseB);
      await composer.getByRole('button', { name: 'Check availability' }).click();
      await composer.getByText('$0 paid reservation; local inference unverified.').waitFor();
      await shot('selected-preflight');
      await composer.getByLabel('Adaptive exploration').check();
      await composer.getByLabel(/Prompt override case/).check();
      await composer.getByLabel(/Cross chart case/).check();
      await composer.getByLabel('Red Team provider').selectOption('openrouter');
      await composer.getByLabel('Judge provider').selectOption('openrouter');
      await composer.getByLabel('Judge model').fill('fixture/paid');
      await composer.getByRole('button', { name: 'Check availability' }).click();
      await composer.getByText(/Remaining allowance/).waitFor();
      await shot('adaptive-mixed-provider');
      knobs.launch = 'busy';
      await composer.getByRole('button', { name: 'Start run' }).click();
      await composer.getByRole('alert').getByText(/Target reserved by run/).waitFor();
      await shot('conflict-error');
    } finally { await close(); }
  }
  await writeFile(join(output, 'metadata.json'), JSON.stringify({ sourceHead: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), syntheticOnly: true, credentials: false, scenario: 'Synthetic API fixture routed in the browser; selected preflight, adaptive mixed-provider preflight, and target-conflict error', viewports: [1440, 390] }, null, 2));
});
