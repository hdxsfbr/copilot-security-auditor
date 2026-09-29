import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { createServer as createViteServer } from 'vite';
import { launchFixtureBrowser } from './support.js';

const output = resolve('test-results/HDX-21/after');
const at = '2026-09-29T12:00:00.000Z';
const workerId = '3f2a9c1e-7b64-4d0e-9a31-5c2d8e4f6a10';
const runId = '11111111-1111-4111-8111-111111111111';
const base = (over: Record<string, unknown> = {}) => ({
  v: 1, status: 'ok', checkedAt: at, policy: { heartbeatIntervalSeconds: 10, freshSeconds: 30, queueWarningSeconds: 30 },
  workerSummary: { state: 'fresh', freshCount: 1, idleCount: 1, busyCount: 0 },
  workers: [{ id: workerId, state: 'idle', startedAt: '2026-09-29T11:00:00.000Z', heartbeatAgeSeconds: 4, activeRunId: null, diagnosticCode: null }],
  queue: { queuedCount: 0, oldestQueuedAgeSeconds: null }, leases: { activeCount: 0, expiredCount: 0 }, diagnostics: [], ...over
});
const healthy = base();
const busy = base({ workerSummary: { state: 'fresh', freshCount: 1, idleCount: 0, busyCount: 1 }, workers: [{ ...healthy.workers[0], state: 'busy', activeRunId: runId }],
  queue: { queuedCount: 2, oldestQueuedAgeSeconds: 95 }, leases: { activeCount: 1, expiredCount: 0 }, diagnostics: [{ code: 'queue_waiting_for_worker_capacity', level: 'info' }] });
const stale = base({ status: 'attention', workerSummary: { state: 'no_recent_heartbeat', freshCount: 0, idleCount: 0, busyCount: 0 }, workers: [{ ...healthy.workers[0], state: 'no_recent_heartbeat', heartbeatAgeSeconds: 245 }],
  queue: { queuedCount: 3, oldestQueuedAgeSeconds: 185 }, diagnostics: [{ code: 'worker_heartbeat_stale', level: 'warning' }, { code: 'queue_aging', level: 'warning' }] });

test('Overview operations panel distinguishes idle, busy, stale worker with aging queue, retains samples and polls only while visible', async () => {
  const server = await createViteServer({ configFile: resolve('apps/web/vite.config.ts'), server: { host: '127.0.0.1', port: 0 }, logLevel: 'error' });
  await server.listen();
  const address = server.httpServer?.address(); assert.ok(address && typeof address !== 'string');
  const origin = `http://127.0.0.1:${address.port}`;
  const browser = await launchFixtureBrowser();
  const capture = process.env.O01_CAPTURE_MEDIA === '1';
  if (capture) await mkdir(output, { recursive: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();
  const errors: string[] = [];
  let current: unknown = healthy, status = 200, polls = 0;
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/api/**', route => {
    const path = new URL(route.request().url()).pathname;
    if (!path.startsWith('/api/')) return route.continue();
    const api = path.slice(4);
    const respond = (body: unknown, code = 200) => route.fulfill({ status: code, contentType: 'application/json', body: JSON.stringify(body) });
    if (api === '/operations/health') { polls++; return status === 200 ? respond(current) : respond({ v: 1, code: 'unavailable', message: 'Operations status unavailable' }, status); }
    if (api === '/targets' || api === '/cases' || api === '/findings' || api === '/regressions' || api === '/coverage' || api === '/schedules') return respond([]);
    if (api === '/config') return respond({ ollamaUrl: 'http://127.0.0.1:11434', model: 'synthetic-local' });
    if (api === '/models') return respond({ openrouter: [], ollama: ['synthetic-local'], configured: false });
    return respond({ message: `Unexpected synthetic request ${api}` }, 404);
  });
  const panel = page.locator('.operations-panel');
  const noOverflow = () => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
  const shot = async (name: string) => { if (capture) await page.screenshot({ path: join(output, name), fullPage: true }); };
  try {
    // Once enabled, later 10 s panel refresh timers run at 150 ms so polling is observable in real time; other timers are untouched.
    await page.addInitScript(`(() => { const original = window.setInterval.bind(window); window.setInterval = function (handler, ms, ...args) { return original(handler, ms === 10000 && window.fastOps ? 150 : ms, ...args); }; })();`);
    await page.goto(origin + '/');
    await panel.getByRole('heading', { name: 'Worker and queue health', level: 2 }).waitFor();

    // (a) Healthy idle worker.
    await panel.getByRole('status').filter({ hasText: 'Normal' }).waitFor();
    assert.match(await panel.innerText(), /1 reporting \(1 idle, 0 busy\)/);
    assert.match(await panel.innerText(), /0 queued/);
    assert.match(await panel.innerText(), /Worker 3f2a9c1e: Idle/);
    assert.equal(await panel.getByRole('list', { name: 'Diagnostics' }).count(), 0);
    assert.match(await panel.innerText(), /Execution capacity is one evaluation per reporting worker process\. Target reservations are separate/);
    assert.equal(await noOverflow(), true);
    await shot('desktop-healthy-idle.png');
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(await noOverflow(), true);
    await shot('mobile-healthy-idle.png');
    await page.setViewportSize({ width: 1440, height: 1000 });

    // A busy fresh worker with a waiting queue is informational capacity, not an outage; it links to the running evaluation.
    current = busy;
    await panel.getByRole('button', { name: 'Refresh now' }).click();
    await panel.getByText('Note: Queued evaluations are waiting for a busy worker.').waitFor();
    assert.match(await panel.innerText(), /1 reporting \(0 idle, 1 busy\)/);
    assert.match(await panel.innerText(), /2 queued, oldest waiting 1 min 35 s/);
    assert.equal(await panel.getByRole('link', { name: 'Inspect its run' }).getAttribute('href'), `/runs/${runId}`);
    assert.equal(await panel.getByRole('status').filter({ hasText: 'Normal' }).count(), 1);

    // (b) Stale worker with an aging queued run is a separate, actionable state.
    current = stale;
    await panel.getByRole('button', { name: 'Refresh now' }).click();
    await panel.getByRole('status').filter({ hasText: 'Needs attention' }).waitFor();
    const staleText = await panel.innerText();
    assert.match(staleText, /Warning: No recent worker heartbeat\./);
    assert.match(staleText, /Warning: A queued evaluation has waited longer than expected\./);
    assert.match(staleText, /3 queued, oldest waiting 3 min 5 s/);
    assert.match(staleText, /Worker 3f2a9c1e: No recent heartbeat · heartbeat 4 min 5 s ago/);
    assert.match(staleText, /this page cannot tell which/);
    assert.equal(await noOverflow(), true);
    await shot('desktop-stale-worker-aging-queue.png');
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(await noOverflow(), true);
    await shot('mobile-stale-worker-aging-queue.png');
    await page.setViewportSize({ width: 1440, height: 1000 });

    // A failed refresh keeps the last valid sample, announces the failure locally and recovers with retry.
    status = 503;
    await panel.getByRole('button', { name: 'Refresh now' }).click();
    const failure = panel.getByRole('alert');
    await failure.waitFor();
    assert.match(await failure.innerText(), /could not refresh; showing the sample checked at/);
    assert.match(await panel.innerText(), /3 queued, oldest waiting 3 min 5 s/);
    assert.equal((await panel.innerText()).includes('Operations status unavailable'), false);
    status = 200; current = healthy;
    await failure.getByRole('button', { name: 'Retry' }).click();
    await failure.waitFor({ state: 'detached' });
    await panel.getByRole('status').filter({ hasText: 'Normal' }).waitFor();

    // Polling runs only while Overview is active and the tab is visible.
    const quiet = async (ms: number) => { const before = polls; await page.waitForTimeout(ms); return polls - before; };
    await page.evaluate('window.fastOps = true');
    const nav = page.getByRole('navigation', { name: 'Primary navigation' });
    await nav.getByRole('link', { name: 'Targets' }).click();
    await page.getByRole('heading', { name: 'Targets & identities', level: 1 }).waitFor();
    await page.waitForTimeout(400);
    assert.equal(await quiet(900), 0, 'no polling while another route is active');
    await nav.getByRole('link', { name: 'Overview' }).click();
    await panel.getByRole('heading', { name: 'Worker and queue health', level: 2 }).waitFor();
    assert.ok(await quiet(1000) >= 3, 'active visible page polls at the refresh interval');
        await page.evaluate("Object.defineProperty(document, 'hidden', { configurable: true, get() { return true; } })");
    await page.waitForTimeout(400);
    assert.equal(await quiet(900), 0, 'hidden tabs do not poll');
    await page.evaluate("Object.defineProperty(document, 'hidden', { configurable: true, get() { return false; } }); document.dispatchEvent(new Event('visibilitychange'));");
    assert.ok(await quiet(600) >= 1, 'becoming visible resumes polling');
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
    await browser.close();
    await server.close();
  }
});

test('Overview operations panel shows an actionable unavailable state when there is no sample yet', async () => {
  const server = await createViteServer({ configFile: resolve('apps/web/vite.config.ts'), server: { host: '127.0.0.1', port: 0 }, logLevel: 'error' });
  await server.listen();
  const address = server.httpServer?.address(); assert.ok(address && typeof address !== 'string');
  const browser = await launchFixtureBrowser();
  const page = await (await browser.newContext({ viewport: { width: 390, height: 844 } })).newPage();
  let online = false;
  await page.route('**/api/**', route => {
    const path = new URL(route.request().url()).pathname;
    if (!path.startsWith('/api/')) return route.continue();
    const api = path.slice(4);
    const respond = (body: unknown, code = 200) => route.fulfill({ status: code, contentType: 'application/json', body: JSON.stringify(body) });
    if (api === '/operations/health') return online ? respond(base({ status: 'attention', workerSummary: { state: 'none_registered', freshCount: 0, idleCount: 0, busyCount: 0 }, workers: [], diagnostics: [{ code: 'no_worker_registered', level: 'warning' }] })) : respond({ message: 'sk-or-v1-leaked-provider-key postgres://user:pass@db/x' }, 503);
    if (api === '/config') return respond({ ollamaUrl: '', model: '' });
    if (api === '/models') return respond({ openrouter: [], ollama: [], configured: false });
    return respond([]);
  });
  try {
    await page.goto(`http://127.0.0.1:${address.port}/`, { waitUntil: 'networkidle' });
    const alert = page.locator('.operations-panel').getByRole('alert');
    await alert.waitFor();
    assert.match(await alert.innerText(), /Worker and queue health is unavailable/);
    assert.equal((await page.locator('.operations-panel').innerText()).includes('sk-or-v1'), false);
    online = true;
    await alert.getByRole('button', { name: 'Retry' }).click();
    await page.locator('.operations-panel').getByText('Warning: No worker has registered.').waitFor();
    assert.match(await page.locator('.operations-panel').innerText(), /workers\s+none registered/i);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
  } finally { await browser.close(); await server.close(); }
});
