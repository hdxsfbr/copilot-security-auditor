import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { createServer as createViteServer } from 'vite';
import { launchFixtureBrowser } from './support.js';
import { turnNumbers } from '../apps/web/src/components/evidence/RunEvidence.js';

const selected = '11111111-1111-4111-8111-111111111111';
const adaptive = '22222222-2222-4222-8222-222222222222';
const caseId = '33333333-3333-4333-8333-333333333333';
const historicalCaseId = '99999999-9999-4999-8999-999999999999';
const seedId = '44444444-4444-4444-8444-444444444444';
const target = { id: '55555555-5555-4555-8555-555555555555', name: 'Synthetic chart target', version: 'toy-v2' };
const at = '2026-09-29T12:00:00.000Z';
const artifactId = '77777777-7777-4777-8777-777777777777';
const caseDefinition = { title: 'Synthetic current-chart isolation', actions: [{ kind: 'attach_pdf', message: 'Synthetic prompt', artifactId, documentType: 'lab_pdf' }] };
const selectedRun = { id: selected, targetId: target.id, target, caseId: seedId, status: 'finished', outcome: 'safe', version: target.version, mode: 'selected', model: 'local-stub', modelSnapshot: { roles: { judge: { provider: 'ollama', model: 'local-stub' } } }, categories: null, stopRequested: false, caseSnapshot: { id: seedId, familyId: seedId, version: 2, definition: caseDefinition }, adaptiveSeeds: null, createdAt: at, startedAt: at, finishedAt: at };
const adaptiveRun = { ...selectedRun, id: adaptive, caseId: null, status: 'running', outcome: null, mode: 'adaptive', categories: ['cross_patient'], stopRequested: false, caseSnapshot: null, adaptiveSeeds: [{ id: seedId, familyId: seedId, version: 2, definition: caseDefinition }], finishedAt: null };
const summary = (run: { id: string; mode: string; status: string; outcome: string | null; stopRequested: boolean; finishedAt: string | null; caseSnapshot: { id: string } | null; categories: string[] | null }) => ({ id: run.id, mode: run.mode, status: run.status, outcome: run.outcome, stopRequested: run.stopRequested, createdAt: at, startedAt: at, finishedAt: run.finishedAt, target, caseSnapshot: run.caseSnapshot ? { id: seedId, familyId: seedId, version: 2, title: caseDefinition.title } : null, adaptiveCategories: run.categories, scheduleOccurrenceId: null });
const turn = (id: string, message: string, executionCaseId?: string, number = 1) => ({ id, createdAt: at, event: { agent: 'target', kind: 'turn', detail: { action: 'attach_pdf', message, observation: { v: 2, turn: number, response: 'Synthetic scoped response', status: 'complete', completeness: { state: 'complete' }, claims: [{ text: 'Visible claim', sources: [{ locator: 'synthetic-source-1', support: 'supported' }] }] }, ...(executionCaseId ? { executionCaseId } : {}) } } });
const output = resolve('test-results/u03/after-capture');
// Event evidence is read through the cursor page contract; rows are ascending by decimal id.
const pageOf = <T extends { id: string }>(items: T[]) => ({ items, hasMore: false, nextCursor: items.at(-1)?.id ?? null });

test('saved history recovers pages and exact selected/adaptive evidence without cross-run leakage', async () => {
  const server = await createViteServer({ configFile: resolve('apps/web/vite.config.ts'), server: { host: '127.0.0.1', port: 0 }, logLevel: 'error' });
  await server.listen();
  const address = server.httpServer?.address(); assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  const browser = await launchFixtureBrowser();
  const capture = process.env.U03_CAPTURE_MEDIA === '1';
  if (capture) await mkdir(output, { recursive: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, ...(capture ? { recordVideo: { dir: output, size: { width: 1440, height: 1000 } } } : {}) });
  const page = await context.newPage();
  const errors: string[] = [], requests: string[] = [];
  let olderFailures = 1, stopCount = 0, caseOffline = false, includeNewTurn = false, deferStop = false, deferSelected = false, selectedRace = false, heldSelected = false;
  let releaseStop = () => {}, releaseSelected = () => {}, releaseRace = () => {};
  const stopGate = new Promise<void>(resolve => { releaseStop = resolve; });
  const selectedGate = new Promise<void>(resolve => { releaseSelected = resolve; });
  const raceGate = new Promise<void>(resolve => { releaseRace = resolve; });
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/api/**', async route => {
    const path = new URL(route.request().url()).pathname;
    if (!path.startsWith('/api/')) return route.continue();
    const api = path.slice(4), query = new URL(route.request().url()).searchParams;
    requests.push(`${route.request().method()} ${api}${query.toString() ? `?${query}` : ''}`);
    const respond = (body: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    if (api === '/targets') return respond([{ id: target.id, name: target.name, baseUrl: 'http://fixture.invalid/', activeRunId: adaptive }]);
    if (api === '/cases' || api === '/findings' || api === '/regressions' || api === '/coverage' || api === '/schedules' || api === '/cases/drafts' || api === '/cases/archived') return respond([]);
    if (api === '/config') return respond({ ollamaUrl: 'http://127.0.0.1:11434', model: 'local-stub' });
    if (api === '/models') return respond({ openrouter: [], ollama: ['local-stub'], configured: false });
    if (api === '/runs') {
      if (query.has('cursor')) {
        if (olderFailures-- > 0) return respond({ message: 'Synthetic page two offline' }, 503);
        return respond({ items: [summary(selectedRun)], nextCursor: null });
      }
      return respond({ items: [summary(adaptiveRun)], nextCursor: 'opaque.synthetic.cursor' });
    }
    if (api === `/runs/${selected}`) {
      if (deferSelected) await selectedGate;
      if (selectedRace && !heldSelected) { heldSelected = true; await raceGate; return respond({ ...selectedRun, status: 'running', outcome: null }); }
      return respond(selectedRun);
    }
    if (api === `/runs/${adaptive}`) return respond({ ...adaptiveRun, stopRequested: stopCount > 0 });
    if (api === `/runs/${selected}/events/page`) return respond(pageOf([turn('9007199254740993', 'Selected synthetic message'), { id: '9007199254740994', createdAt: at, event: { agent: 'check', kind: 'deterministic', detail: { checks: [{ kind: 'required_source_citation', outcome: 'safe', coveredClaim: 'Structured citation present; fact not independently verified', evidenceRefs: ['turn-1'] }] } } }]));
    if (api === `/runs/${adaptive}/events/page`) return respond(pageOf([turn('101', 'Adaptive synthetic message', caseId), turn('102', 'Historical untagged message'), ...(includeNewTurn ? [turn('103', 'New synthetic second turn', caseId, 2)] : [])]));
    if (api === `/runs/${adaptive}/cases`) return respond([{ id: caseId, ordinal: 1, category: 'cross_patient', state: 'running', executed: true, reason: null }, { id: historicalCaseId, ordinal: 2, category: 'cross_patient', state: 'pending_review', executed: true, reason: null }]);
    if (api === `/runs/${selected}/cases`) return respond([]);
    if (api === `/runs/${adaptive}/cases/${caseId}`) return caseOffline ? respond({ message: 'Synthetic exact case offline' }, 503) : respond({ id: caseId, runId: adaptive, ordinal: 1, category: 'cross_patient', state: 'running', executed: true, reason: null, admittedDefinition: caseDefinition, sourceSeed: { id: seedId, familyId: seedId, version: 2, definition: caseDefinition }, eventIds: includeNewTurn ? ['101', '103'] : ['101'], eventLinkage: 'tagged' });
    if (api === `/runs/${adaptive}/cases/${historicalCaseId}`) return respond({ id: historicalCaseId, runId: adaptive, ordinal: 2, category: 'cross_patient', state: 'pending_review', executed: true, reason: null, admittedDefinition: caseDefinition, sourceSeed: { id: seedId, familyId: seedId, version: 2, definition: caseDefinition }, eventIds: [], eventLinkage: 'unknown', assessment: { checks: [{ kind: 'forbidden_patient_disclosure', version: 1, outcome: 'undecidable', coveredClaim: 'Historical scoped check', evidenceRefs: ['turn-2'], signal: 'present' }], verdict: { v: 1, outcome: 'unsafe', claim: 'Saved historical case claim', evidenceRefs: ['turn-2'] }, route: 'pending_review' } });
    if (api.includes('/cases/') && api.startsWith('/runs/')) return respond({ message: 'Unknown synthetic execution case' }, 404);
    if (api.endsWith('/usage')) return respond([]);
    if (api === `/runs/${adaptive}/stop`) { stopCount++; if (deferStop) await stopGate; return respond({ stopRequested: true, status: 'running' }, 202); }
    return respond({ message: `Unexpected fixture route ${api}` }, 404);
  });
  const hold = async () => { if (capture) await page.waitForTimeout(1500); };
  try {
    await page.goto(`${base}/runs`, { waitUntil: 'networkidle' });
    await page.getByRole('heading', { name: 'Run history', level: 2 }).waitFor();
    assert.equal(await page.getByRole('link', { name: /Synthetic chart target adaptive/ }).count(), 1);
    if (capture) { await hold(); await page.screenshot({ path: join(output, 'desktop-history.png'), fullPage: true }); }
    await page.getByRole('button', { name: 'Load older runs' }).click();
    await page.getByRole('alert').getByText(/Synthetic page two offline/).waitFor();
    assert.equal(await page.getByRole('link', { name: /Synthetic chart target adaptive/ }).count(), 1);
    await page.getByRole('alert').getByRole('button', { name: 'Retry' }).click();
    await page.getByRole('link', { name: /Synthetic chart target selected/ }).waitFor();
    assert.ok(requests.filter(request => request.includes('cursor=opaque.synthetic.cursor')).length === 2);
    await page.getByRole('link', { name: /Synthetic chart target selected/ }).click();
    await page.locator('.run-evidence-list p').filter({ hasText: 'Selected synthetic message' }).first().waitFor();
    await page.getByText(/required_source_citation: safe/).waitFor();
    assert.ok((await page.locator('.run-detail').innerText()).includes(caseDefinition.title));
    assert.equal(await page.getByRole('link', { name: 'Download restricted synthetic PDF for step 1' }).getAttribute('href'), `/api/cases/${seedId}/artifacts/${artifactId}?documentType=lab_pdf`);
    await page.getByRole('navigation', { name: 'Recorded turns' }).getByRole('link', { name: 'Turn 1' }).click();
    assert.equal(new URL(page.url()).hash, '#turn-1');
    await page.reload({ waitUntil: 'networkidle' });
    await page.locator('.run-evidence-list p').filter({ hasText: 'Selected synthetic message' }).first().waitFor();
    assert.equal(await page.locator('#turn-1').count(), 1);
    const terminalRequests = requests.filter(request => request === `GET /runs/${selected}`).length;
    await page.waitForTimeout(1700);
    assert.equal(requests.filter(request => request === `GET /runs/${selected}`).length, terminalRequests);
    await page.getByRole('button', { name: 'Refresh saved evidence' }).click();
    assert.equal(requests.filter(request => request === `GET /runs/${selected}`).length, terminalRequests + 1);
    selectedRace = true;
    await page.getByRole('button', { name: 'Refresh saved evidence' }).click();
    await page.getByRole('button', { name: 'Refresh saved evidence' }).click();
    await page.locator('.run-detail .status').filter({ hasText: 'finished / safe' }).waitFor();
    releaseRace();
    await page.waitForTimeout(100);
    assert.match(await page.locator('.run-detail .status').textContent() ?? '', /finished \/ safe/);
    selectedRace = false;
    if (capture) { await hold(); await page.screenshot({ path: join(output, 'desktop-selected.png'), fullPage: true }); }
    await page.goto(`${base}/runs/${adaptive}/cases/${caseId}#turn-1`, { waitUntil: 'networkidle' });
    await page.locator('.run-evidence-list').first().locator('p').filter({ hasText: 'Adaptive synthetic message' }).first().waitFor();
    assert.equal(await page.locator('.run-evidence-list').first().getByText('Historical untagged message').count(), 0);
    assert.equal(await page.locator('#turn-1').count(), 1);
    await page.locator('.run-detail > details > summary').filter({ hasText: 'Uncorrelated historical' }).click();
    await page.locator('.run-evidence-list').last().locator('p').filter({ hasText: 'Historical untagged message' }).first().waitFor();
    caseOffline = true;
    await page.locator('.run-detail').getByRole('button', { name: 'Refresh now' }).click();
    await page.locator('.run-detail').getByRole('alert').filter({ hasText: 'Synthetic exact case offline' }).waitFor();
    assert.equal(await page.locator('.run-evidence-list').first().locator('p').filter({ hasText: 'Adaptive synthetic message' }).count(), 1);
    caseOffline = false;
    await page.locator('.run-detail').getByRole('button', { name: 'Retry cases' }).click();
    await page.locator('.run-detail').getByRole('alert').filter({ hasText: 'Synthetic exact case offline' }).waitFor({ state: 'hidden' });
    includeNewTurn = true;
    await page.locator('.run-detail').getByRole('button', { name: 'Refresh now' }).click();
    await page.locator('.run-turn-nav').getByRole('link', { name: 'Turn 2' }).waitFor();
    await page.locator('.run-detail').getByRole('button', { name: 'Refresh now' }).focus();
    await page.waitForTimeout(1700);
    assert.equal(await page.locator('.run-detail').getByRole('button', { name: 'Refresh now' }).evaluate(element => document.activeElement === element), true);
    deferStop = true;
    await page.locator('.run-activity').getByRole('button', { name: 'Stop after in-flight work' }).click();
    const pending = page.locator('.run-activity').getByRole('button', { name: 'Requesting stop…' });
    await pending.waitFor();
    assert.equal(await pending.isDisabled(), true);
    assert.equal(stopCount, 1);
    releaseStop();
    await page.locator('.run-activity').getByRole('button', { name: 'Stop requested' }).waitFor();
    assert.equal(stopCount, 1);
    if (capture) { await hold(); await page.screenshot({ path: join(output, 'desktop-adaptive-case.png'), fullPage: true }); }
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
    if (capture) { await hold(); await page.screenshot({ path: join(output, 'mobile-adaptive-case.png'), fullPage: true }); }
    await page.getByRole('navigation', { name: 'Primary navigation' }).getByRole('link', { name: 'Runs' }).click();
    await page.getByRole('button', { name: 'Load older runs' }).click();
    await page.getByRole('link', { name: /Synthetic chart target selected/ }).waitFor();
    deferSelected = true;
    const loadingRequest = page.waitForRequest(request => new URL(request.url()).pathname === `/api/runs/${selected}`);
    await page.getByRole('link', { name: /Synthetic chart target selected/ }).click();
    await loadingRequest;
    await page.getByRole('status').filter({ hasText: 'Loading run evidence…' }).waitFor();
    assert.equal(await page.locator('.run-activity').count(), 0);
    assert.equal(await page.locator('.run-evidence-list').count(), 0);
    releaseSelected();
    await page.locator('.run-evidence-list p').filter({ hasText: 'Selected synthetic message' }).first().waitFor();
    await page.goto(`${base}/runs/${adaptive}/cases/66666666-6666-4666-8666-666666666666`, { waitUntil: 'networkidle' });
    await page.getByRole('alert').filter({ hasText: 'Unknown synthetic execution case' }).waitFor();
    assert.equal(await page.locator('.run-evidence-list').first().locator('p').filter({ hasText: 'Adaptive synthetic message' }).count(), 0);
    await page.goto(`${base}/runs/${adaptive}/cases/${historicalCaseId}`, { waitUntil: 'networkidle' });
    const savedAssessment = page.getByRole('region', { name: 'Saved case assessment' });
    await savedAssessment.getByText('Judge claim: Saved historical case claim', { exact: true }).waitFor();
    assert.equal(await savedAssessment.getByText('Judge outcome: unsafe', { exact: true }).count(), 1);
    assert.match(await savedAssessment.textContent() ?? '', /forbidden_patient_disclosure: undecidable/);
    assert.equal(await page.locator('#turn-2').count(), 0);
    await page.goto(`${base}/runs/88888888-8888-4888-8888-888888888888`, { waitUntil: 'networkidle' });
    await page.getByRole('alert').filter({ hasText: 'Run evidence is unavailable' }).waitFor();
    assert.equal(await page.locator('.run-activity').count(), 0);
    assert.deepEqual(errors, []);
  } finally {
    releaseStop(); releaseSelected(); releaseRace();
    await context.close();
    const video = capture ? page.video() : undefined;
    await browser.close();
    if (video) await rename(await video.path(), join(output, 'history-case-stop-recovery.webm'));
    await server.close();
  }
  if (capture) {
    const sourceHead = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    const workingTreeStatus = execFileSync('git', ['status', '--porcelain', '--untracked-files=all'], { encoding: 'utf8' }).trim();
    await writeFile(join(output, 'metadata.json'), JSON.stringify({ sourceHead, workingTreeStatus, cleanSource: workingTreeStatus === '', scenario: 'Synthetic paged history error/retry, selected deep link and terminal refresh, adaptive exact case/turn, Stop and mobile isolation', viewport: ['1440x1000', '390x844'], requests, pageErrors: errors, syntheticOnly: true }, null, 2));
  }
});

test('turn links keep recorded ordinals and omit missing or ambiguous identities', () => {
  assert.deepEqual(turnNumbers([turn('1', 'Second recorded turn', undefined, 2)]), [2]);
  assert.deepEqual(turnNumbers([turn('1', 'First', undefined, 2), turn('2', 'Duplicate', undefined, 2)]), [null, null]);
  const missing = turn('3', 'Legacy');
  delete (missing.event.detail.observation as Partial<typeof missing.event.detail.observation>).turn;
  assert.deepEqual(turnNumbers([missing, turn('4', 'Known', undefined, 3)]), [null, 3]);
});
