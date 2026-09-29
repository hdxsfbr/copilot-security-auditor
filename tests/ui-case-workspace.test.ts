import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { test } from 'node:test';
import { createServer as createViteServer } from 'vite';
import type { Route } from 'playwright-core';
import { launchFixtureBrowser } from './support.js';

const ids = {
  published: 'a0000000-0000-4000-8000-000000000001',
  draftA: 'd0000000-0000-4000-8000-000000000001',
  draftB: 'd0000000-0000-4000-8000-000000000002',
  clone: 'd0000000-0000-4000-8000-000000000003',
  created: 'd0000000-0000-4000-8000-000000000004',
};
const rubric = { v: 1, subcategory: 'synthetic boundary', owaspMappings: ['LLM01:2025'], severity: 'medium', severityRationale: 'Synthetic consequence', exploitabilityRationale: 'Crafted input', boundary: 'Current chart', invariant: 'Stay scoped', regressionRisk: 'Later retrieval change' };
type RecordShape = { id: string; familyId: string; version: number; state: 'draft' | 'published' | 'archived'; title: string; category?: string; user?: string; expectedSafeBehavior?: string; actions?: unknown[]; checks?: unknown[]; rubric?: typeof rubric; metadataStatus?: string };
const record = (id: string, title: string, state: RecordShape['state'], actions: unknown[] = [{ kind: 'chat_turn', message: 'Synthetic request' }], familyId = id, version = 1): RecordShape => ({ id, familyId, version, state, title, category: 'prompt_injection', user: 'A', expectedSafeBehavior: 'Refuse clinical advice', actions, checks: [], rubric, metadataStatus: 'complete' });
const pdfAction = (id: string) => ({ kind: 'attach_pdf', message: 'Read the synthetic PDF', artifactId: id, documentType: 'lab_pdf' });
const fixtureRecords = () => new Map<string, RecordShape>([
  [ids.published, record(ids.published, 'Published synthetic case', 'published')],
  [ids.draftA, record(ids.draftA, 'Draft A', 'draft', [{ kind: 'chat_turn', message: 'First turn' }, pdfAction('f0000000-0000-4000-8000-000000000001')])],
  [ids.draftB, record(ids.draftB, 'Draft B', 'draft', [{ kind: 'chat_turn', message: 'First turn' }, pdfAction('f0000000-0000-4000-8000-000000000002')])],
]);

async function setup(capture = false) {
  const server = await createViteServer({ configFile: resolve('apps/web/vite.config.ts'), server: { host: '127.0.0.1', port: 0 }, logLevel: 'error' });
  await server.listen();
  const address = server.httpServer?.address();
  assert.ok(address && typeof address !== 'string');
  const browser = await launchFixtureBrowser();
  const mediaDir = resolve('test-results/HDX-18/after');
  if (capture) await mkdir(mediaDir, { recursive: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, ...(capture ? { recordVideo: { dir: mediaDir, size: { width: 1440, height: 1000 } } } : {}) });
  const page = await context.newPage();
  const records = fixtureRecords();
  const calls: string[] = [];
  const pageErrors: string[] = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  const control: { holdCreate: boolean; heldCreate?: Route; holdGet?: string; heldGet?: Route; wrongId?: string; cloneFails: boolean; holdUpload: boolean; heldUpload?: Route; holdPut?: string; heldPut?: Route; } = { holdCreate: false, cloneFails: false, holdUpload: false };
  const reply = (route: Route, body: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
  await page.route('**/api/**', async route => {
    const pathname = new URL(route.request().url()).pathname;
    if (!pathname.startsWith('/api/')) return route.continue();
    const path = pathname.slice('/api'.length), method = route.request().method();
    calls.push(`${method} ${path}`);
    if (path === '/targets' || path === '/findings' || path === '/regressions' || path === '/coverage' || path === '/schedules') return reply(route, []);
    if (path === '/config') return reply(route, { ollamaUrl: 'http://127.0.0.1:11434', model: 'synthetic-local' });
    if (path === '/models') return reply(route, { openrouter: [], ollama: ['synthetic-local'], configured: false });
    if (path === '/cases' && method === 'GET') return reply(route, [...records.values()].filter(item => item.state === 'published'));
    if (path === '/cases/drafts' && method === 'GET') return reply(route, [...records.values()].filter(item => item.state === 'draft'));
    if (path === '/cases/archived') return reply(route, [...records.values()].filter(item => item.state === 'archived').map(({ id, familyId, version, state, title, category, metadataStatus }) => ({ id, familyId, version, state, title, category, metadataStatus })));
    if (path === '/cases/drafts' && method === 'POST') {
      const body = route.request().postDataJSON() as Partial<RecordShape>;
      records.set(ids.created, { ...record(ids.created, body.title ?? 'Untitled', 'draft', body.actions ?? []), ...body, id: ids.created, familyId: ids.created, version: 1, state: 'draft', metadataStatus: 'incomplete_draft' });
      if (control.holdCreate) { control.heldCreate = route; return; }
      return reply(route, records.get(ids.created), 201);
    }
    const parts = path.split('/').filter(Boolean);
    if (parts[0] === 'cases' && parts[1] === 'drafts' && parts[2] && method === 'PUT') {
      const current = records.get(parts[2]);
      if (!current) return reply(route, { message: 'Draft unavailable' }, 404);
      records.set(parts[2], { ...current, ...(route.request().postDataJSON() as RecordShape), id: current.id, familyId: current.familyId, version: current.version, state: 'draft' });
      if (control.holdPut === parts[2]) { control.heldPut = route; return; }
      return reply(route, records.get(parts[2]));
    }
    if (parts[0] === 'cases' && parts[1] === 'drafts' && parts[2] && parts[3] === 'publish') {
      const current = records.get(parts[2]); if (!current) return reply(route, { message: 'Draft unavailable' }, 404);
      current.state = 'published'; return reply(route, current);
    }
    if (parts[0] === 'cases' && parts[1] && parts[2] === 'artifacts' && method === 'POST') {
      if (control.holdUpload) { control.heldUpload = route; return; }
      return reply(route, { id: 'f0000000-0000-4000-8000-000000000009' }, 201);
    }
    if (parts[0] === 'cases' && parts[1] && parts[2] === 'clone') {
      const source = records.get(parts[1]); if (!source) return reply(route, { message: 'Missing' }, 404);
      const clone = { ...source, id: ids.clone, familyId: source.familyId, version: 2, state: 'draft' as const, actions: [] };
      records.set(ids.clone, clone);
      return control.cloneFails ? reply(route, { v: 1, code: 'conflict', reason: 'artifact_copy_failed', draftId: ids.clone, message: 'Draft created; copy PDF again' }, 409) : reply(route, clone, 201);
    }
    if (parts[0] === 'cases' && parts[1] && parts[2] === 'archive') {
      const current = records.get(parts[1]); if (!current) return reply(route, { message: 'Missing' }, 404);
      current.state = 'archived'; return reply(route, { id: current.id, familyId: current.familyId, version: current.version, state: 'archived' });
    }
    if (parts[0] === 'cases' && parts[1] && parts[2] === 'versions') {
      const current = records.get(parts[1]); return reply(route, current ? [...records.values()].filter(item => item.familyId === current.familyId) : []);
    }
    if (parts[0] === 'cases' && parts[1] && parts[2] === 'executions') return reply(route, []);
    if (parts[0] === 'cases' && parts[1] && method === 'GET') {
      if (control.holdGet === parts[1]) { control.heldGet = route; return; }
      return reply(route, control.wrongId === parts[1] ? records.get(control.wrongId === ids.draftA ? ids.draftB : ids.draftA) : records.get(parts[1]) ?? { message: 'Missing' }, records.has(parts[1]) ? 200 : 404);
    }
    return reply(route, { message: `Unexpected synthetic request ${path}` }, 404);
  });
  return { page, records, calls, control, reply, mediaDir, pageErrors, base: `http://127.0.0.1:${address.port}`, async close() { await context.close(); const video = capture ? page.video() : undefined; await browser.close(); if (video) await rename(await video.path(), join(mediaDir, 'case-workspace.webm')); await server.close(); } };
}

test('case workspace keeps partial drafts, recovers clone failures and archived history', async () => {
  const capture = process.env.HDX18_CAPTURE_MEDIA === '1';
  const fixture = await setup(capture);
  const { page, records, control, base, mediaDir } = fixture;
  try {
    await page.goto(base + '/cases', { waitUntil: 'networkidle' });
    await page.getByRole('heading', { name: 'Create a draft' }).waitFor();
    if (capture) { await page.screenshot({ path: join(mediaDir, 'desktop-case-library.png'), fullPage: true }); await page.waitForTimeout(1800); }
    await page.getByLabel('Case title').fill('Partially authored synthetic case');
    await page.getByLabel('Step 1 message').fill('');
    await page.getByLabel('Subcategory').fill('partially entered rubric');
    await page.getByRole('link', { name: 'Targets' }).click();
    await page.getByRole('link', { name: 'Cases' }).click();
    assert.equal(await page.getByLabel('Case title').inputValue(), 'Partially authored synthetic case');
    if (capture) { await page.screenshot({ path: join(mediaDir, 'desktop-unsaved-draft.png'), fullPage: true }); await page.waitForTimeout(1800); }
    await page.getByRole('button', { name: 'Create draft' }).click();
    await page.getByText(/Draft version 1 saved/).waitFor();
    assert.equal(records.get(ids.created)?.rubric?.subcategory, 'partially entered rubric');
    assert.equal((records.get(ids.created)?.actions?.[0] as { message: string }).message, '');
    await page.reload({ waitUntil: 'networkidle' });
    assert.equal(await page.getByLabel('Subcategory').inputValue(), 'partially entered rubric');
    await page.getByRole('button', { name: 'Preview case' }).click();
    await page.getByText(/Before publish/).waitFor();
    if (capture) { await page.screenshot({ path: join(mediaDir, 'desktop-draft-preview.png'), fullPage: true }); await page.waitForTimeout(1800); }
    await page.locator('.case-catalog').locator(`a[href="/cases/${ids.published}"]`).click();
    control.cloneFails = true;
    await page.getByRole('button', { name: 'Clone as new draft' }).click();
    await page.getByText(/PDF copy failed/).waitFor();
    assert.equal(new URL(page.url()).pathname, `/cases/${ids.clone}`);
    assert.equal(records.get(ids.published)?.state, 'published');
    if (capture) { await page.screenshot({ path: join(mediaDir, 'desktop-clone-recovery.png'), fullPage: true }); await page.waitForTimeout(1800); }
    await page.locator('.case-catalog').locator(`a[href="/cases/${ids.published}"]`).click();
    await page.getByRole('button', { name: 'Archive version' }).click();
    await page.getByRole('button', { name: 'Confirm archive' }).click();
    await page.getByText(/no longer available for new runs/).waitFor();
    await page.getByRole('link', { name: 'Targets' }).click();
    await page.getByRole('link', { name: 'Cases' }).click();
    await page.getByRole('heading', { name: 'Archived' }).waitFor();
    await page.locator('.case-catalog').locator(`a[href="/cases/${ids.published}"]`).click();
    await page.getByText(/ARCHIVED/).first().waitFor();
    if (capture) { await page.screenshot({ path: join(mediaDir, 'desktop-archived-history.png'), fullPage: true }); await page.setViewportSize({ width: 390, height: 844 }); await page.screenshot({ path: join(mediaDir, 'mobile-archived-history.png'), fullPage: true }); await page.waitForTimeout(1800); }
    assert.deepEqual(fixture.pageErrors, []);
  } finally { await fixture.close(); }
  if (capture) {
    const sourceHead = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    const workingTreeStatus = execFileSync('git', ['status', '--porcelain', '--untracked-files=all'], { encoding: 'utf8' }).trim();
    await writeFile(join(mediaDir, 'metadata.json'), JSON.stringify({ sourceHead, workingTreeStatus, cleanSource: !workingTreeStatus, scenario: 'Synthetic case library, unsaved draft retention, saved partial draft reload, preview, clone-copy recovery, archive and historical deep link.', pageErrors: fixture.pageErrors, viewports: [{ width: 1440, height: 1000 }, { width: 390, height: 844 }] }, null, 2));
  }
});

test('deferred case responses cannot overwrite another route or clear a newer operation', async () => {
  const fixture = await setup();
  const { page, control, reply, base, records } = fixture;
  try {
    await page.goto(base + '/cases', { waitUntil: 'networkidle' });
    await page.getByLabel('Case title').fill('Deferred new draft');
    control.holdCreate = true;
    await page.getByRole('button', { name: 'Create draft' }).click();
    await page.getByRole('link', { name: 'Targets' }).click();
    await page.waitForFunction(() => document.querySelector('main h1')?.textContent?.includes('Targets'));
    assert.ok(control.heldCreate);
    await reply(control.heldCreate!, records.get(ids.created), 201);
    await page.getByRole('link', { name: 'Cases' }).click();
    await page.getByRole('link', { name: 'Deferred new draft' }).waitFor();
    assert.equal(await page.getByRole('heading', { name: 'Create a draft' }).count(), 1);

    control.holdGet = ids.draftA;
    await page.goto(base + `/cases/${ids.draftA}`);
    await page.waitForFunction(() => document.querySelector('main h1')?.textContent?.includes('Case workspace'));
    await page.getByRole('link', { name: 'Create new draft' }).click();
    await page.getByRole('heading', { name: 'Create a draft' }).waitFor();
    assert.ok(control.heldGet);
    await reply(control.heldGet!, records.get(ids.draftA));
    assert.equal(await page.getByRole('heading', { name: 'Create a draft' }).count(), 1);

    control.holdGet = undefined;
    await page.getByRole('link', { name: 'Draft A' }).click();
    await page.getByLabel('Replace PDF for step 2').setInputFiles({ name: 'old.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4 old') });
    control.holdUpload = true;
    await page.getByRole('button', { name: 'Upload replacement for step 2' }).click();
    await page.getByRole('link', { name: 'Draft B' }).click();
    assert.equal(await page.getByRole('button', { name: 'Upload replacement for step 2' }).isDisabled(), true);
    await page.getByRole('link', { name: 'Draft A' }).click();
    control.holdPut = ids.draftA;
    await page.getByLabel('Case title').fill('New operation stays busy');
    await page.getByRole('button', { name: 'Save draft' }).click();
    assert.ok(control.heldUpload);
    await reply(control.heldUpload!, { id: 'f0000000-0000-4000-8000-000000000009' }, 201);
    assert.equal(await page.getByRole('button', { name: 'Save draft' }).isDisabled(), true);
    assert.ok(control.heldPut);
    await reply(control.heldPut!, records.get(ids.draftA));
    await page.getByText(/Draft version 1 saved/).waitFor();
    assert.equal(await page.getByLabel('Case title').inputValue(), 'New operation stays busy');
    assert.deepEqual(fixture.pageErrors, []);
  } finally { await fixture.close(); }
});

test('wrong case identity blocks editing and action-index shifts clear replacement PDF selection', async () => {
  const fixture = await setup();
  const { page, control, base } = fixture;
  try {
    control.wrongId = ids.draftA;
    await page.goto(base + `/cases/${ids.draftA}`, { waitUntil: 'networkidle' });
    await page.getByText(/did not match the selected definition/).waitFor();
    assert.equal(await page.getByRole('button', { name: 'Save draft' }).count(), 0);
    control.wrongId = undefined;
    await page.getByRole('button', { name: 'Retry case' }).click();
    await page.getByLabel('Replace PDF for step 2').waitFor();
    await page.getByLabel('Replace PDF for step 2').setInputFiles({ name: 'shift.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4 shift') });
    assert.equal(await page.getByRole('button', { name: 'Upload replacement for step 2' }).isEnabled(), true);
    await page.getByRole('button', { name: 'Remove step 1' }).click();
    assert.equal(await page.getByRole('button', { name: 'Upload replacement for step 1' }).isDisabled(), true);
    assert.deepEqual(fixture.pageErrors, []);
  } finally { await fixture.close(); }
});
