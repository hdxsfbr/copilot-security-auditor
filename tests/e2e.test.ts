import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import { createApp } from '../apps/api/src/app.js';
import { processNext } from '../apps/worker/src/process.js';
import { database, fixture, modelFixture, users, testCase } from './support.js';
import { chromium } from 'playwright-core';
import { PDFDocument } from 'pdf-lib';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('served UI and API start, poll and inspect safe, incomplete and reviewable fixture runs', async () => {
  const db = await database(), toy = fixture(), model = modelFixture('safe');
  const targetUrl = await toy.start(), ollamaUrl = await model.start();
  const server = createApp(db.repo).listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  try {
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    assert.match(await (await fetch(url)).text(), /Clinical Auditor/);
    assert.deepEqual(await (await fetch(`${url}/api/config`)).json(), { ollamaUrl: process.env.OLLAMA_URL ?? '', model: process.env.OLLAMA_MODEL ?? '' });
    const post = async (path: string, body: unknown) => {
      const response = await fetch(url + '/api' + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      return { status: response.status, data: await response.json() };
    };
    const target = (await post('/targets', { name: 'Fixture', baseUrl: targetUrl, ...users })).data;
    assert.equal(JSON.stringify(target).includes(users.userA.password), false);
    const editResponse = await fetch(`${url}/api/targets/${target.id}/edit`);
    assert.equal(editResponse.status, 200);
    assert.deepEqual(await editResponse.json(), { id: target.id, name: 'Fixture', baseUrl: targetUrl, userA: { username: users.userA.username, pubpid: users.userA.pubpid }, userB: { username: users.userB.username, pubpid: users.userB.pubpid } });
    const updated = await fetch(`${url}/api/targets/${target.id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Renamed fixture', baseUrl: targetUrl, ...users }) });
    assert.equal(updated.status, 200);
    assert.equal((await updated.json()).id, target.id);
    assert.equal((await (await fetch(`${url}/api/targets`)).json()).length, 1);
    const retained = await fetch(`${url}/api/targets/${target.id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Retained fixture', baseUrl: targetUrl, userA: { username: users.userA.username, pubpid: users.userA.pubpid }, userB: { username: users.userB.username, pubpid: users.userB.pubpid } }) });
    assert.equal(retained.status, 200);
    assert.equal(JSON.stringify(await retained.json()).includes(users.userA.password), false);
    const invalid = await fetch(`${url}/api/targets/${target.id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Invalid', baseUrl: targetUrl, userA: { ...users.userA, password: '' }, userB: users.userB }) });
    assert.equal(invalid.status, 400);
    const selected = (await post('/cases', testCase)).data;
    const input = { targetId: target.id, caseId: selected.id, model: 'fixture', ollamaUrl };
    const first = await post('/runs', input); assert.equal(first.status, 202);
    const conflict = await post('/runs', input); assert.equal(conflict.status, 409); assert.equal(conflict.data.active_run_id, first.data.id);
    assert.deepEqual(await processNext(db.repo), { id: first.data.id, outcome: 'safe' });
    const run = await (await fetch(`${url}/api/runs/${first.data.id}`)).json(); assert.equal(run.outcome, 'safe'); assert.equal(run.version, 'toy-v1');
    const events = await (await fetch(`${url}/api/runs/${first.data.id}/events`)).json();
    assert.deepEqual(events.map((e: { event: { agent: string } }) => e.event.agent), ['worker', 'target', 'check', 'judge']);
    assert.equal(JSON.stringify(events).includes(users.userA.password), false);
    assert.equal(JSON.stringify(events).includes('Cookie: leaked'), false);
    assert.equal(JSON.stringify(events).includes('ticket-1'), false);
    assert.equal(JSON.stringify(events).includes('private-csrf'), false);
    assert.ok(toy.requests.some(r => r.path.includes('dynamic_finder_ajax.php') && r.path.includes('sSearch=SYN-900001')));
    assert.ok(toy.requests.some(r => r.path.includes('set_pid=42')));
    assert.ok(JSON.stringify(model.packet).includes('PATIENT_A'));
    const ambiguous = fixture({ mode: 'ambiguous' }); const ambiguousUrl = await ambiguous.start();
    try {
      const other = (await post('/targets', { name: 'Ambiguous', baseUrl: ambiguousUrl, ...users })).data;
      const queued = await post('/runs', { ...input, targetId: other.id });
      assert.deepEqual(await processNext(db.repo), { id: queued.data.id, outcome: 'incomplete' });
      const result = await (await fetch(`${url}/api/runs/${queued.data.id}`)).json(); assert.equal(result.outcome, 'incomplete');
      assert.equal((await (await fetch(`${url}/api/candidates`)).json()).length, 0);
    } finally { await ambiguous.close(); }
    const missing = fixture({ lookup: 'missing' }); const missingUrl = await missing.start();
    try {
      const other = (await post('/targets', { name: 'Unresolved', baseUrl: missingUrl, ...users })).data;
      const queued = await post('/runs', { ...input, targetId: other.id });
      assert.deepEqual(await processNext(db.repo), { id: queued.data.id, outcome: 'blocked' });
      assert.equal((await (await fetch(`${url}/api/runs/${queued.data.id}`)).json()).outcome, 'blocked');
      assert.equal(missing.requests.some(r => r.path.includes('set_pid=') || r.path.includes('/turns')), false);
      assert.equal((await (await fetch(`${url}/api/candidates`)).json()).length, 0);
      assert.equal((await db.repo.targets()).find(t => t.id === other.id).activeRunId, null);
    } finally { await missing.close(); }
    const unsafe = modelFixture('unsafe'); const unsafeUrl = await unsafe.start();
    try {
      const queued = await post('/runs', { ...input, ollamaUrl: unsafeUrl });
      assert.equal((await processNext(db.repo))?.outcome, 'auto_confirm');
      const findings = await (await fetch(`${url}/api/findings`)).json(); assert.equal(findings.length, 1);
      assert.equal(findings[0].state, 'confirmed');
      assert.equal((await (await fetch(`${url}/api/regressions`)).json()).length, 1);
      const deniedExport = await fetch(`${url}/api/findings/${findings[0].id}/export`); assert.equal(deniedExport.status, 403);
      const approved = await post(`/findings/${findings[0].id}/approve-export`, {}); assert.equal(approved.status, 200);
      const again = await post(`/findings/${findings[0].id}/approve-export`, {}); assert.equal(again.data.approvedAt, approved.data.approvedAt);
      const shared = await (await fetch(`${url}/api/findings/${findings[0].id}/export`)).json();
      assert.equal(shared.category, 'prompt_injection');
      assert.equal(shared.reproduction.length, 1);
      assert.doesNotMatch(JSON.stringify(shared), /SYN-90000|private-password|Cookie|Ignore prior/);
      const replay = await post('/runs', input); assert.equal(replay.status, 202);
      assert.equal((await processNext(db.repo))?.outcome, 'safe');
      assert.equal((await (await fetch(`${url}/api/regressions`)).json()).length, 1);
      const coverage = await (await fetch(`${url}/api/coverage`)).json();
      assert.ok(coverage.some((c: { category: string; outcome: string }) => c.category === 'prompt_injection' && c.outcome === 'auto_confirm'));
    } finally { await unsafe.close(); }
    const uncertain = modelFixture('unsafe', { reproductionComplete: false }); const uncertainUrl = await uncertain.start();
    try {
      const queued = await post('/runs', { ...input, ollamaUrl: uncertainUrl });
      assert.equal((await processNext(db.repo))?.outcome, 'pending_review');
      const candidates = await (await fetch(`${url}/api/candidates`)).json(); assert.equal(candidates.length, 1);
      assert.equal((await post(`/findings/${candidates[0].id}/approve-export`, {})).status, 409);
      const confirmed = await post(`/findings/${candidates[0].id}/review`, { decision: 'confirm' }); assert.equal(confirmed.status, 200);
      assert.equal((await post(`/findings/${candidates[0].id}/review`, { decision: 'confirm' })).status, 200);
      assert.equal((await post(`/findings/${candidates[0].id}/review`, { decision: 'reject' })).status, 409);
      assert.equal((await (await fetch(`${url}/api/regressions`)).json()).length, 2);
    } finally { await uncertain.close(); }
  } finally {
    await new Promise<void>((resolve, reject) => (server as Server).close(err => err ? reject(err) : resolve()));
    await toy.close(); await model.close(); await db.close();
  }
});

test('operator UI authors a case, replays it, reviews a finding and approves redacted export', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'auditor-browser-'));
  process.env.ARTIFACT_DIR = dir;
  const db = await database(), toy = fixture(), safe = modelFixture('safe'), uncertain = modelFixture('unsafe', { reproductionComplete: false });
  const targetUrl = await toy.start(), safeUrl = await safe.start(), uncertainUrl = await uncertain.start();
  const server = createApp(db.repo).listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox'] });
  try {
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const target = await db.repo.target({ name: 'Browser fixture', baseUrl: targetUrl, ...users });
    const page = await browser.newPage();
    await page.goto(url);
    await page.getByLabel('Target to configure').selectOption(target.id);
    await page.getByText('Saved passwords are stored securely and will be reused.').waitFor();
    assert.equal(await page.getByLabel('Username').first().inputValue(), users.userA.username);
    assert.equal(await page.getByLabel('External patient ID (pubpid)').last().inputValue(), users.userB.pubpid);
    assert.equal(await page.getByLabel('New password (optional)').nth(0).inputValue(), '');
    assert.equal(await page.getByLabel('New password (optional)').nth(1).inputValue(), '');
    await page.getByRole('button', { name: 'Update target' }).click();
    await page.getByText(/Target updated and selected/).waitFor();
    const refs = (await db.repo.pool.query('SELECT user_a_credential,user_b_credential FROM targets WHERE id=$1', [target.id])).rows[0];
    assert.deepEqual(await db.repo.credential(refs.user_a_credential), users.userA);
    assert.deepEqual(await db.repo.credential(refs.user_b_credential), users.userB);
    assert.equal(await page.getByLabel('Selected case').locator('option').count() >= 3, true);
    await page.getByLabel('Selected case').selectOption('c0000000-0000-4000-8000-000000000004');
    await page.getByText('cross patient / user A').waitFor();
    await page.getByText(/Step 1 \(chat_turn\): Keep the current chart open/).waitFor();
    await page.getByLabel('Case title').fill('UI trust-boundary case');
    await page.getByLabel('Category').selectOption('unintended_tool_action');
    await page.getByLabel('Test message').fill('Do not call unexpected tools');
    await page.getByRole('button', { name: 'Save case' }).click();
    await page.getByText(/Saved unintended_tool_action case/).waitFor();
    const authored = (await db.repo.cases()).find(c => c.title === 'UI trust-boundary case');
    assert.ok(authored);
    await page.getByLabel('Saved authorized target').selectOption(target.id);
    await page.getByLabel('Selected case').selectOption(authored.id);
    await page.getByLabel('Ollama endpoint').fill(safeUrl);
    await page.getByLabel('Installed model').fill('stub');
    await page.getByRole('button', { name: /Start selected run/ }).click();
    await page.getByText(/running|queued|awaiting result/).first().waitFor();
    assert.equal((await processNext(db.repo))?.outcome, 'inconclusive');
    await page.getByText('finished / inconclusive').waitFor();
    await page.getByText('Untested / coverage gap').first().waitFor();
    const pending = await db.repo.start({ targetId: target.id, caseId: authored.id, model: 'stub', ollamaUrl: uncertainUrl });
    assert.ok(pending && 'id' in pending);
    assert.equal((await processNext(db.repo))?.outcome, 'pending_review');
    await page.getByRole('button', { name: 'Refresh decisions' }).click();
    await page.getByRole('button', { name: 'Confirm' }).click();
    await page.getByText('confirmed / operator').waitFor();
    await page.getByRole('button', { name: 'Approve redacted export' }).click();
    await page.getByText(/patient-specific response omitted/i).waitFor();
    await page.getByRole('button', { name: 'Select for replay' }).click();
    await page.getByText(/Original case selected for a new replay/).waitFor();
    assert.equal(await page.getByLabel('Selected case').inputValue(), authored.id);
    await page.getByRole('button', { name: /Start selected run/ }).click();
    await page.getByText('queued / awaiting result').waitFor();
    assert.equal((await processNext(db.repo))?.outcome, 'inconclusive');
    await page.getByText('finished / inconclusive').waitFor();
    await page.getByRole('button', { name: 'Refresh decisions' }).click();
    await page.getByText(/toy-v1: inconclusive/).waitFor();
    const document = await PDFDocument.create(); document.addPage();
    await page.getByLabel('Case title').fill('Indirect PDF boundary');
    await page.getByLabel('Category').selectOption('prompt_injection');
    await page.getByLabel('Synthetic PDF (optional)').setInputFiles({ name: 'synthetic.pdf', mimeType: 'application/pdf', buffer: Buffer.from(await document.save()) });
    await page.getByRole('button', { name: 'Save case' }).click();
    await page.getByText(/Saved prompt_injection case/).waitFor();
    const withDocument = (await db.repo.cases()).find(c => c.title === 'Indirect PDF boundary');
    assert.equal(withDocument?.actions[0].kind, 'attach_pdf');
    if (withDocument?.actions[0].kind === 'attach_pdf') {
      const response = await fetch(`${url}/api/cases/${withDocument.id}/artifacts/${withDocument.actions[0].artifactId}?documentType=lab_pdf`);
      assert.equal(response.status, 200);
      assert.equal(response.headers.get('content-type'), 'application/pdf');
    }
  } finally { await browser.close(); await new Promise<void>(resolve => server.close(() => resolve())); await toy.close(); await safe.close(); await uncertain.close(); await db.close(); await rm(dir, { recursive: true, force: true }); delete process.env.ARTIFACT_DIR; }
});
