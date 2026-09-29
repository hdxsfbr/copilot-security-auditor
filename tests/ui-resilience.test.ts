import assert from 'node:assert/strict';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { createServer as createViteServer, type ViteDevServer } from 'vite';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { launchFixtureBrowser } from './support.js';

const artifacts = resolve('test-results/HDX-9');
const fixtureTarget = { id: 'target-fixture', name: 'Synthetic chart target', baseUrl: 'http://fixture.invalid/', activeRunId: null };
const fixtureCase = { id: 'case-fixture', title: 'Synthetic instruction-boundary case', category: 'prompt_injection', user: 'A', expectedSafeBehavior: 'Keep the synthetic evidence visible', actions: [{ kind: 'chat_turn', message: 'Synthetic request' }] };
const fixtureRun = { id: 'run-fixture', caseId: fixtureCase.id, status: 'finished', outcome: 'pending_review', version: 'fixture-v1', model: 'fixture-model', categories: ['prompt_injection'] };
const fixtureEvent = { id: 1, event: { agent: 'synthetic', kind: 'fixture_evidence', detail: { note: 'Synthetic evidence remains visible during catalog outage' } }, createdAt: '2026-09-29T12:00:00.000Z' };
const fixtureAdaptiveCase = { id: 'adaptive-case-fixture', ordinal: 1, category: 'prompt_injection', state: 'completed', executed: true, reason: null };
const fixtureFinding = { id: 'finding-fixture', runId: fixtureRun.id, state: 'pending_review', title: 'Synthetic review finding', version: 'fixture-v1', decisionRoute: null, exportApprovedAt: null };
const fixtureConfig = { ollamaUrl: 'http://127.0.0.1:11434', model: 'synthetic-local-model' };
const fixtureCatalog = { openrouter: ['fixture/paid'], ollama: ['fixture-model'], configured: true, inferenceHealth: 'unverified', availability: { openrouter: 'available', ollama: 'available' } };

async function revealRecordedEvidence(page: import('playwright-core').Page) {
  const history = page.locator('.run-detail > details').filter({ has: page.locator('summary').filter({ hasText: /^Uncorrelated historical/ }) });
  await history.waitFor();
  if (!await history.evaluate(element => (element as HTMLDetailsElement).open)) await history.locator(':scope > summary').click();
  const raw = page.locator('.run-evidence-list details').first();
  await raw.waitFor();
  if (!await raw.evaluate(element => (element as HTMLDetailsElement).open)) await raw.locator('summary').click();
}

async function startWeb(): Promise<ViteDevServer> {
  const server = await createViteServer({
    configFile: resolve('apps/web/vite.config.ts'),
    server: { host: '127.0.0.1', port: 0, strictPort: false },
    logLevel: 'error',
  });
  await server.listen();
  return server;
}

async function fixtureRoute(page: import('playwright-core').Page, mode: { catalogOffline: boolean; configOffline: boolean; runMalformed: boolean; localErrors: Set<string> }) {
  await page.route('**/api/**', async route => {
    const url = new URL(route.request().url());
    if (!url.pathname.startsWith('/api/')) return route.continue();
    const path = url.pathname.slice('/api'.length);
    const reply = (body: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    if (path === '/models') return mode.catalogOffline ? reply({ message: 'synthetic catalog offline' }, 503) : reply(fixtureCatalog);
    if (path === '/config') return mode.configOffline ? reply({ message: 'synthetic config offline' }, 503) : reply(fixtureConfig);
    if (path === '/targets') return reply([fixtureTarget]);
    if (path === '/cases') return reply([fixtureCase]);
    if (path === '/findings') return reply([fixtureFinding]);
    if (path === '/regressions') return reply([]);
    if (path === '/coverage') return reply([]);
    if (path === '/schedules' || path === '/run-definitions') return reply([]);
    if (path === `/runs/${fixtureRun.id}`) return reply(mode.runMalformed ? { ...fixtureRun, modelSnapshot: { roles: {} } } : fixtureRun);
    if (path === `/runs/${fixtureRun.id}/events/page`) return reply({ items: [{ ...fixtureEvent, id: String(fixtureEvent.id) }], hasMore: false, nextCursor: String(fixtureEvent.id) });
    if (path === `/runs/${fixtureRun.id}/usage` && mode.localErrors.has('usage')) return reply({ message: 'synthetic usage offline' }, 503);
    if (path === `/runs/${fixtureRun.id}/cases` && mode.localErrors.has('progress')) return reply({ message: 'synthetic progress offline' }, 503);
    if (path === `/runs/${fixtureRun.id}/usage`) return reply([]);
    if (path === `/runs/${fixtureRun.id}/cases`) return reply([fixtureAdaptiveCase]);
    return reply({ message: `unexpected synthetic request ${path}` }, 404);
  });
}

test('catalog 503 is local, recoverable, and preserves entered forms and evidence', async () => {
  await mkdir(artifacts, { recursive: true });
  const server = await startWeb();
  const address = server.httpServer?.address();
  assert.ok(address && typeof address !== 'string');
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const browser = await launchFixtureBrowser();
  const captureMedia = process.env.HDX9_CAPTURE_MEDIA === '1';
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, ...(captureMedia ? { recordVideo: { dir: artifacts, size: { width: 1440, height: 1000 } } } : {}) });
  const page = await context.newPage();
  const mode = { catalogOffline: true, configOffline: false, runMalformed: false, localErrors: new Set<string>() };
  await fixtureRoute(page, mode);
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  try {
    await page.goto(`${baseUrl}/runs/new`, { waitUntil: 'networkidle' });
    await page.getByRole('heading', { name: 'Compose a run' }).waitFor();
    await page.getByRole('button', { name: 'Retry model catalog' }).first().waitFor();
    await page.getByRole('link', { name: 'Findings' }).click();
    await page.getByRole('button', { name: 'Inspect evidence' }).click();
    await revealRecordedEvidence(page);
    await page.getByText('Synthetic evidence remains visible during catalog outage').waitFor();
    await page.getByRole('link', { name: 'Targets' }).click();
    const targetName = page.getByLabel('Target name');
    await targetName.fill('User-entered synthetic target');
    await page.getByRole('link', { name: 'Launch' }).click();
    const modelPanel = page.locator('.run-composer');
    await modelPanel.scrollIntoViewIfNeeded();
    if (captureMedia) {
      await page.waitForTimeout(600);
      await page.screenshot({ path: join(artifacts, 'after-catalog-503-before-retry.png'), fullPage: true });
      await modelPanel.screenshot({ path: join(artifacts, 'catalog-503-model-panel.png') });
    }

    mode.catalogOffline = false;
    await modelPanel.getByRole('button', { name: 'Retry model catalog' }).click();
    await modelPanel.locator('[role="alert"]').waitFor({ state: 'detached' });
    const schedulePanel = page.locator('.schedule-desk');
    await page.getByRole('link', { name: 'Schedules' }).click();
    await schedulePanel.getByRole('button', { name: 'Retry model catalog' }).click();
    await schedulePanel.locator('[role="alert"]').waitFor({ state: 'detached' });
    await page.getByRole('link', { name: 'Current run' }).click();
    await revealRecordedEvidence(page);
    await page.getByText('Synthetic evidence remains visible during catalog outage').waitFor();
    await page.getByRole('link', { name: 'Targets' }).click();
    assert.equal(await targetName.inputValue(), 'User-entered synthetic target');
    await page.getByRole('link', { name: 'Launch' }).click();
    await modelPanel.getByLabel('Judge provider').selectOption('openrouter');
    assert.equal(await modelPanel.getByLabel('Judge model').inputValue(), 'fixture/paid');
    assert.deepEqual(errors, []);
    if (captureMedia) {
      await page.waitForTimeout(600);
      await page.screenshot({ path: join(artifacts, 'after-catalog-retry.png'), fullPage: true });
      await modelPanel.screenshot({ path: join(artifacts, 'catalog-recovered-model-panel.png') });
      await page.getByRole('link', { name: 'Current run' }).click();
      await page.locator('.evidence').scrollIntoViewIfNeeded();
      await page.waitForTimeout(700);
    }
  } finally {
    await context.close();
    const video = captureMedia ? page.video() : undefined;
    await browser.close();
    if (video) await rename(await video.path(), join(artifacts, 'catalog-503-recovery.webm'));
    await server.close();
  }
  if (captureMedia) {
    const head = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    const diff = execFileSync('git', ['diff', '--binary'], { encoding: 'buffer' });
    await writeFile(join(artifacts, 'metadata.json'), JSON.stringify({
    capturedHead: head,
    workingTreeDiffSha256: createHash('sha256').update(diff).digest('hex'),
    scenario: 'Synthetic GET /api/models returns HTTP 503 JSON {message:"synthetic catalog offline"}; the visible alert is captured before local Retry model catalog returns the synthetic catalog. Target form text and run event evidence remain visible through recovery.',
    viewport: { width: 1440, height: 1000 },
    evidence: ['after-catalog-503-before-retry.png', 'after-catalog-retry.png', 'catalog-503-model-panel.png', 'catalog-recovered-model-panel.png', 'catalog-503-recovery.webm'],
    syntheticOnly: true,
    }, null, 2));
  }
});

test('usage and adaptive progress 503 errors stay local and support retry', async () => {
  const server = await startWeb();
  const address = server.httpServer?.address();
  assert.ok(address && typeof address !== 'string');
  const browser = await launchFixtureBrowser();
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const mode = { catalogOffline: false, configOffline: true, runMalformed: false, localErrors: new Set(['usage', 'progress']) };
  await fixtureRoute(page, mode);
  try {
    await page.goto(`http://127.0.0.1:${address.port}/runs/new`, { waitUntil: 'networkidle' });
    await page.getByRole('button', { name: 'Retry model defaults' }).first().waitFor();
    const composer = page.locator('.run-composer');
    const composerUrl = composer.getByLabel('Local model server URL');
    const judgeModel = composer.getByLabel('Judge model');
    await composerUrl.fill('http://localhost:11435');
    await composerUrl.fill('');
    await judgeModel.fill('manually-entered-model');
    mode.configOffline = false;
    await page.getByRole('button', { name: 'Retry model defaults' }).first().click();
    await page.getByRole('button', { name: 'Retry model defaults' }).waitFor({ state: 'detached' });
    assert.equal(await composerUrl.inputValue(), '', 'retrying defaults keeps the operator-cleared endpoint');
    assert.equal(await judgeModel.inputValue(), 'manually-entered-model');
    const scheduleDesk = page.locator('.schedule-desk');
    await page.getByRole('link', { name: 'Schedules' }).click();
    const scheduleUrl = scheduleDesk.getByLabel('Local model server URL');
    await scheduleUrl.fill('http://localhost:11437');
    await scheduleUrl.fill('');
    await scheduleDesk.getByRole('button', { name: 'Retry defaults' }).click();
    assert.equal(await scheduleUrl.inputValue(), '');
    await page.getByRole('link', { name: 'Findings' }).click();
    await page.getByRole('button', { name: 'Inspect evidence' }).click();
    await revealRecordedEvidence(page);
    await page.getByText('Synthetic evidence remains visible during catalog outage').waitFor();
    mode.runMalformed = true;
    await page.getByRole('button', { name: 'Refresh saved evidence' }).click();
    await page.locator('.evidence').getByText('Run evidence could not refresh; the last saved evidence is retained.', { exact: false }).waitFor();
    await revealRecordedEvidence(page);
    await page.getByText('Synthetic evidence remains visible during catalog outage').waitFor();
    mode.runMalformed = false;
    await page.locator('.evidence').getByRole('button', { name: 'Retry', exact: true }).click();
    await page.getByRole('link', { name: 'Launch' }).click();
    const activity = page.locator('.run-activity');
    await activity.getByRole('button', { name: 'Retry usage' }).waitFor();
    await activity.getByRole('button', { name: 'Retry progress' }).waitFor();
    mode.localErrors.clear();
    await activity.getByRole('button', { name: 'Retry usage' }).click();
    await activity.getByRole('button', { name: 'Retry progress' }).click();
    await activity.getByRole('button', { name: 'Retry usage' }).waitFor({ state: 'detached' });
    await activity.getByRole('button', { name: 'Retry progress' }).waitFor({ state: 'detached' });
    await page.getByRole('link', { name: 'Current run' }).click();
    assert.equal(await page.getByText('Synthetic evidence remains visible during catalog outage').count(), 1);
  } finally {
    await browser.close();
    await server.close();
  }
});
