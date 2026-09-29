import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { createServer as createViteServer } from 'vite';
import { launchFixtureBrowser } from './support.js';

const runA = '11111111-1111-4111-8111-111111111111';
const runB = '22222222-2222-4222-8222-222222222222';
const at = '2026-09-29T12:00:00.000Z';
// IDs start above Number.MAX_SAFE_INTEGER: any Number coercion would merge neighbours.
const id = (n: number) => String(9007199254740992n + BigInt(n));
const event = (n: number, label = 'Synthetic event') => ({ id: id(n), createdAt: at, event: { agent: 'worker', kind: 'synthetic_note', detail: { reason: `${label} ${n}` } } });

test('run evidence reads pages incrementally, resumes after failures, ignores stale pages and stops polling when finished', async () => {
  const server = await createViteServer({ configFile: resolve('apps/web/vite.config.ts'), server: { host: '127.0.0.1', port: 0 }, logLevel: 'error' });
  await server.listen();
  const address = server.httpServer?.address(); assert.ok(address && typeof address !== 'string');
  const origin = `http://127.0.0.1:${address.port}`;
  const browser = await launchFixtureBrowser();
  const page = await (await browser.newContext({ viewport: { width: 1440, height: 1000 } })).newPage();
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  const store: Record<string, ReturnType<typeof event>[]> = { [runA]: [1, 2, 3, 4, 5].map(n => event(n)), [runB]: [1].map(n => event(n, 'Second run event')) };
  const status: Record<string, string> = { [runA]: 'running', [runB]: 'running' };
  const log: string[] = [];
  let pageSize = 2, failAfter: string | null = null, replay: unknown = null, gate: Promise<void> | null = null;
  const requestedAfter = () => log.filter(entry => entry.startsWith('events ')).map(entry => entry.split(' ')[2]);
  const requestedAfterFor = (run: string) => log.filter(entry => entry.startsWith(`events ${run} `)).map(entry => entry.split(' ')[2]);
  await page.route('**/api/**', async route => {
    const url = new URL(route.request().url());
    if (!url.pathname.startsWith('/api/')) return route.continue();
    const api = url.pathname.slice(4);
    const respond = (body: unknown, code = 200) => route.fulfill({ status: code, contentType: 'application/json', body: JSON.stringify(body) });
    const runMatch = /^\/runs\/([^/]+)$/.exec(api), pageMatch = /^\/runs\/([^/]+)\/events\/page$/.exec(api);
    if (runMatch) { log.push(`run ${runMatch[1] === runA ? 'A' : 'B'}`); return respond({ id: runMatch[1], status: status[runMatch[1]], outcome: status[runMatch[1]] === 'finished' ? 'safe' : null, version: null, model: 'local-stub', mode: 'selected', stopRequested: false }); }
    if (pageMatch) {
      const run = pageMatch[1], after = url.searchParams.get('after');
      log.push(`events ${run === runA ? 'A' : 'B'} ${after ?? 'none'}`);
      if (gate && run === runA) await gate;
      if (failAfter !== null && after === failAfter) return respond({ v: 1, code: 'unavailable', message: 'Synthetic page offline' }, 503);
      if (replay) { const body = replay; replay = null; return respond(body); }
      const remaining = store[run].filter(item => after === null || BigInt(item.id) > BigInt(after));
      const items = remaining.slice(0, pageSize);
      return respond({ items, hasMore: remaining.length > items.length, nextCursor: items.at(-1)?.id ?? after });
    }
    if (api.endsWith('/usage') || api.endsWith('/cases')) return respond([]);
    if (['/targets', '/cases', '/findings', '/regressions', '/coverage', '/schedules'].includes(api)) return respond([]);
    if (api === '/config') return respond({ ollamaUrl: '', model: '' });
    if (api === '/models') return respond({ openrouter: [], ollama: [], configured: false });
    return respond({ message: `Unexpected synthetic request ${api}` }, 404);
  });
  const shown = (label: string, n: number) => page.getByText(`${label} ${n}`, { exact: true });
  const navigateClient = (path: string) => page.evaluate(`window.history.pushState(null, '', '${path}'); window.dispatchEvent(new PopStateEvent('popstate'));`);
  try {
    // Direct URL: status is read before evidence, then three sequential bounded pages drain from the start.
    await page.goto(`${origin}/runs/${runA}`);
    await shown('Synthetic event', 5).waitFor();
    assert.deepEqual(log.slice(0, 4), ['run A', 'events A none', `events A ${id(2)}`, `events A ${id(4)}`]);
    assert.equal(await page.getByText(`Raw event JSON · ID ${id(3)}`).count(), 1, 'exact bigint id is displayed, not a rounded Number');
    assert.equal(await page.getByText(`Raw event JSON · ID ${id(4)}`).count(), 1);
    for (let n = 1; n <= 5; n++) assert.equal(await shown('Synthetic event', n).count(), 1);

    // Later polls request only events after the last accepted id.
    const initial = requestedAfter().length;
    store[runA].push(event(6));
    await shown('Synthetic event', 6).waitFor();
    assert.ok(requestedAfter().length > initial);
    assert.equal(requestedAfter().slice(3).every(after => after !== 'none' && BigInt(after) >= BigInt(id(5))), true, `no refetch from the start: ${requestedAfter()}`);
    assert.equal(await shown('Synthetic event', 1).count(), 1, 'earlier evidence is retained, not duplicated');

    // A failure between pages keeps accepted evidence and the cursor; Retry resumes after the last accepted event.
    failAfter = id(8);
    store[runA].push(event(7), event(8), event(9));
    await shown('Synthetic event', 8).waitFor();
    const failure = page.getByRole('alert').filter({ hasText: 'Run evidence could not refresh; the last saved evidence is retained.' });
    await failure.waitFor();
    assert.equal(await shown('Synthetic event', 9).count(), 0);
    assert.equal(await shown('Synthetic event', 7).count(), 1);
    const failedAt = log.length;
    failAfter = null;
    await failure.getByRole('button', { name: 'Retry' }).click();
    await shown('Synthetic event', 9).waitFor();
    await failure.waitFor({ state: 'detached' });
    const resumedAfter = log.slice(failedAt).filter(entry => entry.startsWith('events ')).map(entry => entry.split(' ')[2]);
    assert.ok(resumedAfter.length > 0 && resumedAfter.every(after => after !== 'none' && BigInt(after) >= BigInt(id(8))), `resumed after the last accepted event: ${resumedAfter}`);
    for (let n = 1; n <= 9; n++) assert.equal(await shown('Synthetic event', n).count(), 1, `event ${n} appears exactly once`);

    // Duplicate and out-of-order rows are dropped; the newest accepted id only moves forward.
    store[runA].push(event(11));
    replay = { items: [event(7), event(11), event(10)], hasMore: false, nextCursor: id(11) };
    await shown('Synthetic event', 11).waitFor();
    await page.waitForTimeout(200);
    assert.equal(await shown('Synthetic event', 11).count(), 1);
    assert.equal(await shown('Synthetic event', 7).count(), 1, 'duplicate id is not shown twice');
    assert.equal(await shown('Synthetic event', 10).count(), 0, 'out-of-order id behind the cursor is not accepted');
    assert.deepEqual(await page.locator('.run-evidence-list > li').evaluateAll(items => items.map(item => item.querySelector('summary')?.textContent?.replace(/^.*ID /, ''))), [1, 2, 3, 4, 5, 6, 7, 8, 9, 11].map(id));

    // Terminal: after the final events are drained polling stops; manual refresh still resumes after the cursor.
    status[runA] = 'finished';
    store[runA].push(event(12));
    await shown('Synthetic event', 12).waitFor();
    await page.locator('.run-detail .status').filter({ hasText: 'finished / safe' }).waitFor();
    const terminalRuns = log.filter(entry => entry === 'run A').length, terminalPages = log.length;
    await page.waitForTimeout(1800);
    assert.equal(log.filter(entry => entry === 'run A').length, terminalRuns, 'terminal run is not polled');
    assert.equal(log.slice(terminalPages).filter(entry => entry.startsWith('events ')).length, 0, 'terminal run does not poll events');
    store[runA].push(event(13));
    await page.getByRole('button', { name: 'Refresh saved evidence' }).click();
    await shown('Synthetic event', 13).waitFor();
    assert.equal(log.slice(terminalPages).filter(entry => entry.startsWith('events A ')).every(entry => entry !== 'events A none'), true, 'manual refresh resumes after the cursor');

    // A delayed page for run A must not render in run B, and each run keeps its own cursor.
    let release = () => {};
    gate = new Promise<void>(resolve => { release = resolve; });
    store[runA].push(event(14));
    await page.getByRole('button', { name: 'Refresh saved evidence' }).click();
    await navigateClient(`/runs/${runB}`);
    await shown('Second run event', 1).waitFor();
    const gated = gate; gate = null;
    release(); await gated;
    await page.waitForTimeout(300);
    assert.equal(await shown('Synthetic event', 14).count(), 0, 'stale page for the previous run is ignored');
    assert.equal(await shown('Synthetic event', 1).count(), 0);
    assert.equal(log.filter(entry => entry === 'events B none').length, 1, 'new run starts from its own beginning');
    store[runB].push(event(2, 'Second run event'));
    await shown('Second run event', 2).waitFor();
    assert.equal(requestedAfterFor('B').slice(1).every(after => after === id(1) || after === id(2)), true);

    // Returning to run A does not reuse run B's cursor.
    await navigateClient(`/runs/${runA}`);
    await shown('Synthetic event', 14).waitFor();
    assert.equal(log.lastIndexOf('events A none') > log.lastIndexOf('events B none'), true, 'run A reloads from its own start');
    assert.equal(await shown('Second run event', 1).count(), 0);
    assert.deepEqual(errors, []);
  } finally { await browser.close(); await server.close(); }
});
