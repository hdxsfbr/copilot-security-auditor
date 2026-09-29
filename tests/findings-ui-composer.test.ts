import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import type { AddressInfo } from 'node:net';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { createServer as createViteServer } from 'vite';
import { launchFixtureBrowser } from './support.js';

const output = resolve('test-results/HDX-23/after'), capture = process.env.F02_CAPTURE_MEDIA === '1';
const ids = { target: '00000000-0000-4000-8000-000000000001', seed: '00000000-0000-4000-8000-000000000010' };
const now = '2026-09-29T12:00:00.000Z';

test('composer: report drafting is off by default, sends a strict policy, shows the held allowance and blocks an allowance outside the cap', async () => {
  const cacheDir = await mkdtemp(join(tmpdir(), 'vite-f02-')); // private optimizer cache: other dev servers on this host share node_modules/.vite
  const vite = await createViteServer({ configFile: resolve('apps/web/vite.config.ts'), cacheDir, server: { host: '127.0.0.1', port: 0 }, logLevel: 'error' });
  await vite.listen();
  const base = `http://127.0.0.1:${(vite.httpServer!.address() as AddressInfo).port}`;
  const browser = await launchFixtureBrowser();
  if (capture) await mkdir(output, { recursive: true });
  const posts: { path: string; body: any }[] = [];
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();
  await page.route('https://fonts.googleapis.com/**', route => route.fulfill({ status: 200, contentType: 'text/css', body: '' }));
  await page.route('**/api/**', route => {
    const request = route.request(), pathname = new URL(request.url()).pathname;
    if (!pathname.startsWith('/api/')) return route.continue();
    const path = pathname.slice('/api'.length), body = request.postData() ? JSON.parse(request.postData()!) : undefined;
    const reply = (payload: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(payload) });
    if (request.method() === 'POST') posts.push({ path, body });
    if (path === '/targets') return reply([{ id: ids.target, name: 'Synthetic chart target', baseUrl: 'http://fixture.invalid/', activeRunId: null }]);
    if (path === '/cases') return reply([{ id: ids.seed, title: 'Prompt override case', category: 'prompt_injection', user: 'A', expectedSafeBehavior: 'Refuse the override', actions: [{ kind: 'chat_turn', message: 'Synthetic step' }] }]);
    if (path === '/config') return reply({ ollamaUrl: 'http://127.0.0.1:11434', model: 'stub' });
    if (path === '/models') return reply({ openrouter: ['fixture/paid'], ollama: ['stub'], configured: true, inferenceHealth: 'unverified', availability: { openrouter: 'available', ollama: 'available' } });
    if (['/findings', '/regressions', '/coverage', '/schedules', '/run-definitions'].includes(path)) return reply([]);
    if (path === '/model-preflight') {
      const policy = body.input.reportPolicy, paid = policy?.model.provider === 'openrouter';
      return reply({ status: 'available', inferenceHealth: 'unverified', issues: [], local: { status: 'available', installed: ['stub'] }, paid: { status: paid ? 'available' : 'not_required', configured: true },
        preview: { reservationNanos: '0', capNanos: body.input.openRouterCapUsd === undefined ? null : String(Math.round(body.input.openRouterCapUsd * 1e9)), attempts: 1, basis: 'one_call_per_active_role_per_attempt',
          ...(policy ? { reportAllowanceNanos: paid ? String(Math.round(policy.allowanceUsd * 1e9)) : '0', reportJobReservationNanos: paid ? '12000000' : '0' } : {}) } });
    }
    return reply({ message: `Unexpected synthetic request ${path}` }, 404);
  });
  await page.route('**/api/run-definitions', route => {
    if (route.request().method() === 'GET') return route.fulfill({ status: 200, contentType: 'application/json', body: '[]' });
    const body = JSON.parse(route.request().postData()!); posts.push({ path: '/run-definitions', body });
    return route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify({ id: '00000000-0000-4000-8000-000000000100', name: body.name, run: body.run, revision: 1, archived: false, createdAt: now, updatedAt: now }) });
  });
  await page.route('**/api/run-definitions/*/launch', route => route.fulfill({ status: 202, contentType: 'application/json', body: JSON.stringify({ id: 'run-launched', status: 'queued' }) }));
  try {
    await page.goto(`${base}/runs/new`, { waitUntil: 'networkidle' });
    const composer = page.locator('.run-composer');
    await composer.getByRole('heading', { name: '4. Report drafting (optional)' }).waitFor();
    const toggle = composer.getByLabel('Draft reports automatically for findings this run confirms');
    assert.equal(await toggle.isChecked(), false, 'off by default');
    assert.equal(await composer.getByLabel('Documentation model').count(), 0);
    await composer.getByLabel('Saved authorized target').selectOption(ids.target);
    await composer.getByRole('button', { name: 'Check availability' }).click();
    await composer.getByText(/Conservative reservation|\$0 paid reservation/).waitFor();
    assert.equal(posts.at(-1)!.body.input.reportPolicy, undefined, 'no policy is sent unless opted in');
    assert.equal(await composer.getByText(/Report drafting:/).count(), 0);

    await toggle.check();
    assert.equal(await composer.getByLabel('Documentation model').inputValue(), 'stub', 'local default from server config');
    assert.equal(await composer.getByLabel('Documentation maximum output tokens').inputValue(), '2048');
    await composer.getByRole('button', { name: 'Check availability' }).click();
    await composer.getByText(/local Documentation model, no paid allowance/).waitFor();
    assert.deepEqual(posts.at(-1)!.body.input.reportPolicy, { model: { provider: 'ollama', model: 'stub', maxOutputTokens: 2048 }, reviewWindowMinutes: 60 });

    await composer.getByLabel('Documentation provider').selectOption('openrouter');
    assert.equal(await composer.getByLabel('Documentation model').inputValue(), 'fixture/paid');
    await composer.getByLabel('Report allowance (USD, inside the run cap)').fill('0.3');
    await composer.getByRole('button', { name: 'Check availability' }).click();
    await composer.getByRole('alert').filter({ hasText: /report allowance must fit inside the run paid-call cap/ }).waitFor();
    await composer.getByLabel('Report allowance (USD, inside the run cap)').fill('0.05');
    await composer.getByLabel('Review window (minutes after the run finishes)').fill('30');
    await composer.getByRole('button', { name: 'Check availability' }).click();
    await composer.getByText(/allowance \$0\.05 held inside the cap; one bounded Documentation call reserves \$0\.012/).waitFor();
    await composer.getByText(/Remaining allowance \$0\.20/).waitFor();
    assert.deepEqual(posts.at(-1)!.body.input.reportPolicy, { model: { provider: 'openrouter', model: 'fixture/paid', maxOutputTokens: 2048 }, allowanceUsd: 0.05, reviewWindowMinutes: 30 });
    assert.equal(posts.at(-1)!.body.input.openRouterCapUsd, 0.25);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
    if (capture) { await composer.getByRole('heading', { name: '4. Report drafting (optional)' }).scrollIntoViewIfNeeded(); await page.screenshot({ path: join(output, 'composer-report-policy-1440.png'), fullPage: true }); }

    await composer.getByRole('button', { name: 'Start run' }).click();
    await page.waitForURL(/\/runs\/run-launched$/);
    assert.deepEqual(posts.find(post => post.path === '/run-definitions')!.body.run.input.reportPolicy, { model: { provider: 'openrouter', model: 'fixture/paid', maxOutputTokens: 2048 }, allowanceUsd: 0.05, reviewWindowMinutes: 30 });

    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`${base}/runs/new`, { waitUntil: 'networkidle' });
    await page.locator('.run-composer').getByLabel('Draft reports automatically for findings this run confirms').check();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, 'no horizontal overflow at 390px');
    if (capture) await page.screenshot({ path: join(output, 'composer-report-policy-390.png'), fullPage: true });
  } finally { await browser.close(); await vite.close(); await rm(cacheDir, { recursive: true, force: true }); }
});
