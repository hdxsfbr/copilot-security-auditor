import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { createServer as createViteServer } from 'vite';
import { launchFixtureBrowser } from './support.js';

const output = resolve('test-results/u02/after-capture');
const target = { id: 'synthetic-target', name: 'Synthetic chart target', baseUrl: 'http://fixture.invalid/', activeRunId: null };
const testCase = { id: 'synthetic-case', title: 'Synthetic chart-context case', category: 'prompt_injection', user: 'A', expectedSafeBehavior: 'Keep the current chart boundary', actions: [{ kind: 'chat_turn', message: 'Synthetic test turn' }] };
const run = (id: string) => ({ id, caseId: testCase.id, status: 'running', outcome: null, version: 'synthetic-v1', model: 'synthetic-local', categories: ['prompt_injection'] });
const event = (id: string) => ({ id: '1', event: { agent: 'target', kind: 'synthetic_observation', detail: { note: `Evidence for ${id}` } }, createdAt: '2026-09-29T12:00:00.000Z' });

async function revealRecordedEvidence(page: import('playwright-core').Page) {
  const history = page.locator('.run-detail > details').filter({ has: page.locator('summary').filter({ hasText: /^Uncorrelated historical/ }) });
  await history.waitFor();
  if (!await history.evaluate(element => (element as HTMLDetailsElement).open)) await history.locator(':scope > summary').click();
  const raw = page.locator('.run-evidence-list details').first();
  await raw.waitFor();
  if (!await raw.evaluate(element => (element as HTMLDetailsElement).open)) await raw.locator('summary').click();
}

async function fixture(page: import('playwright-core').Page) {
  const requests: string[] = [];
  await page.route('**/api/**', async route => {
    const pathname = new URL(route.request().url()).pathname;
    if (!pathname.startsWith('/api/')) return route.continue();
    const path = pathname.slice('/api'.length);
    requests.push(path);
    const respond = (body: unknown) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
    if (path === '/targets') return respond([target]);
    if (path === '/cases') return respond([testCase]);
    if (path === '/findings' || path === '/regressions' || path === '/coverage' || path === '/schedules') return respond([]);
    if (path === '/config') return respond({ ollamaUrl: 'http://127.0.0.1:11434', model: 'synthetic-local' });
    if (path === '/models') return respond({ openrouter: [], ollama: ['synthetic-local'], configured: false });
    if (path === '/runs/synthetic-run' || path === '/runs/second-run') return respond(run(path.split('/').at(-1)!));
    if (path === '/runs/synthetic-run/events' || path === '/runs/second-run/events') return respond([event(path.split('/')[2])]);
    if (path.endsWith('/usage')) return respond([]);
    if (path.endsWith('/cases')) return respond([{ id: 'synthetic-progress', ordinal: 1, category: 'prompt_injection', state: 'running', executed: true, reason: null }]);
    if (path.endsWith('/stop')) return respond({ stopRequested: true });
    return route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ message: `Unexpected synthetic request ${path}` }) });
  });
  return requests;
}

test('task routes preserve drafts, support history and hard reload, and isolate run evidence', async () => {
  const server = await createViteServer({ configFile: resolve('apps/web/vite.config.ts'), server: { host: '127.0.0.1', port: 0 }, logLevel: 'error' });
  await server.listen();
  const address = server.httpServer?.address();
  assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  const browser = await launchFixtureBrowser();
  const capture = process.env.U02_CAPTURE_MEDIA === '1';
  if (capture) await mkdir(output, { recursive: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, ...(capture ? { recordVideo: { dir: output, size: { width: 1440, height: 1000 } } } : {}) });
  const page = await context.newPage();
  const requests = await fixture(page);
  const pageErrors: string[] = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  try {
    await page.goto(base + '/', { waitUntil: 'networkidle' });
    await page.getByRole('heading', { name: 'Overview', level: 1 }).waitFor();
    assert.equal(await page.getByRole('navigation', { name: 'Primary navigation' }).count(), 1);
    assert.equal(await page.getByRole('main').count(), 1);
    if (capture) await page.screenshot({ path: join(output, 'desktop-overview.png'), fullPage: true });

    await page.getByRole('link', { name: 'Targets' }).click();
    await page.getByLabel('Target name').fill('Draft synthetic target');
    await page.getByRole('link', { name: 'Launch' }).click();
    await page.getByLabel('Saved authorized target').selectOption(target.id);
    await page.waitForFunction(() => (document.querySelector('.model-desk input[type="url"]') as HTMLInputElement | null)?.value === 'http://127.0.0.1:11434');
    await page.locator('.model-desk').getByLabel('Local model server URL').fill('');
    assert.equal(await page.locator('.model-desk').getByLabel('Local model server URL').inputValue(), '');
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => resolve())));
    if (capture) await page.screenshot({ path: join(output, 'desktop-launch.png'), fullPage: true });
    await page.getByRole('link', { name: 'Schedules' }).click();
    await page.getByLabel('Schedule name').fill('Draft synthetic schedule');
    await page.waitForFunction(() => (document.querySelector('.schedule-desk input[type="url"]') as HTMLInputElement | null)?.value === 'http://127.0.0.1:11434');
    await page.locator('.schedule-desk').getByLabel('Local model server URL').fill('');
    assert.equal(await page.locator('.schedule-desk').getByLabel('Local model server URL').inputValue(), '');
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => resolve())));
    await page.getByRole('link', { name: 'Targets' }).click();
    assert.equal(await page.getByLabel('Target name').inputValue(), 'Draft synthetic target');
    await page.goBack();
    await page.getByRole('heading', { name: 'Schedules', level: 1 }).waitFor();
    assert.equal(await page.getByLabel('Schedule name').inputValue(), 'Draft synthetic schedule');
    assert.equal(await page.locator('.schedule-desk').getByLabel('Local model server URL').inputValue(), '');
    await page.goBack();
    await page.getByRole('heading', { name: 'Launch evaluation', level: 1 }).waitFor();
    assert.equal(await page.locator('.model-desk').getByLabel('Local model server URL').inputValue(), '');
    assert.equal(await page.getByLabel('Saved authorized target').inputValue(), target.id);
    assert.equal(await page.locator('main').evaluate(element => document.activeElement === element), true);
    await page.goForward();
    await page.getByRole('heading', { name: 'Schedules', level: 1 }).waitFor();
    assert.equal(await page.getByLabel('Schedule name').inputValue(), 'Draft synthetic schedule');
    await page.goBack();
    await page.getByRole('heading', { name: 'Launch evaluation', level: 1 }).waitFor();

    await page.goto(base + '/runs/synthetic-run', { waitUntil: 'networkidle' });
    await revealRecordedEvidence(page);
    await page.getByText('Evidence for synthetic-run').waitFor();
    await page.locator('.run-activity').getByText(/prompt injection: case 1 running/).waitFor();
    await page.locator('.run-activity').getByRole('button', { name: 'Stop after in-flight work' }).click();
    await page.locator('.run-activity').getByRole('button', { name: 'Stop requested' }).waitFor();
    if (capture) await page.screenshot({ path: join(output, 'desktop-run-detail.png'), fullPage: true });
    await page.getByRole('link', { name: 'Launch' }).click();
    await page.locator('.run-activity').getByText(/prompt injection: case 1 running/).waitFor();
    await page.getByRole('link', { name: 'Current run' }).click();
    await revealRecordedEvidence(page);
    await page.getByText('Evidence for synthetic-run').waitFor();
    await page.goto(base + '/runs/second-run', { waitUntil: 'networkidle' });
    await revealRecordedEvidence(page);
    await page.getByText('Evidence for second-run').waitFor();
    assert.equal(await page.getByText('Evidence for synthetic-run').count(), 0);
    assert.ok(requests.includes('/runs/second-run'));
    assert.deepEqual(pageErrors, []);

    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole('link', { name: 'Launch' }).click();
    await page.getByRole('heading', { name: 'Launch evaluation', level: 1 }).waitFor();
    assert.equal(await page.getByRole('navigation', { name: 'Primary navigation' }).isVisible(), true);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
    if (capture) await page.screenshot({ path: join(output, 'mobile-launch.png'), fullPage: true });
    await page.getByRole('link', { name: 'Current run' }).click();
    await revealRecordedEvidence(page);
    await page.getByText('Evidence for second-run').waitFor();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
    if (capture) await page.screenshot({ path: join(output, 'mobile-run-detail.png'), fullPage: true });
  } finally {
    await context.close();
    const video = capture ? page.video() : undefined;
    await browser.close();
    if (video) await rename(await video.path(), join(output, 'navigation-and-run-reload.webm'));
    await server.close();
  }
  if (capture) {
    const sourceHead = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    const workingTreeStatus = execFileSync('git', ['status', '--porcelain', '--untracked-files=all'], { encoding: 'utf8' }).trim();
    await writeFile(join(output, 'metadata.json'), JSON.stringify({ sourceHead, workingTreeStatus, cleanSource: workingTreeStatus === '', scenario: 'Real browser navigation, in-memory draft preservation, hard reload of two synthetic run URLs, current-run progress and stop control', viewports: [{ width: 1440, height: 1000 }, { width: 390, height: 844 }], syntheticOnly: true }, null, 2));
  }
});
