import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PDFDocument } from 'pdf-lib';
import { database, fixture, modelFixture, seed, users } from './support.js';
import { processNext } from '../apps/worker/src/process.js';
import { storePdf } from '../apps/api/src/artifacts.js';
import { legacyRoles, type Snapshot } from '../apps/worker/src/models.js';

test('target outage blocks/incompletes without a finding or safety pass', async () => {
  const db = await database();
  try {
    const { target, selected } = await seed(db.repo, 'http://127.0.0.1:1/', 'http://127.0.0.1:2/');
    const run = await db.repo.start({ targetId: target.id, caseId: selected.id, model: 'stub', ollamaUrl: 'http://127.0.0.1:2/' });
    assert.ok(run && 'id' in run);
    const result = await processNext(db.repo);
    assert.equal(result?.outcome, 'blocked');
    assert.equal((await db.repo.run(run.id))?.outcome, 'blocked');
    assert.equal((await db.repo.findings()).length, 0);
    assert.notEqual((await db.repo.coverage()).find(row => row.category === 'prompt_injection')?.outcome, 'safe');
  } finally { await db.close(); }
});

test('ambiguous target turn is terminal and never replayed', async () => {
  const db = await database(), toy = fixture({ mode: 'ambiguous' }), model = modelFixture('unsafe');
  const targetUrl = await toy.start(), modelUrl = await model.start();
  try {
    const { target, selected } = await seed(db.repo, targetUrl, modelUrl);
    const run = await db.repo.start({ targetId: target.id, caseId: selected.id, model: 'stub', ollamaUrl: modelUrl });
    assert.ok(run && 'id' in run);
    assert.equal((await processNext(db.repo))?.outcome, 'incomplete');
    assert.equal(toy.requests.filter(row => row.path.includes('/turns')).length, 1);
    assert.equal((await db.repo.findings()).length, 0);
    assert.equal((await db.repo.events(run.id)).some(row => row.event.kind === 'verdict'), false);
    assert.equal((await db.repo.targets()).find(row => row.id === target.id).activeRunId, null);
  } finally { await toy.close(); await model.close(); await db.close(); }
});

test('missing referenced evidence is incomplete, never a finding or pass', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'missing-evidence-'));
  process.env.ARTIFACT_DIR = dir;
  const db = await database(), toy = fixture(), model = modelFixture('unsafe');
  const targetUrl = await toy.start(), modelUrl = await model.start();
  try {
    const target = await db.repo.target({ name: 'Synthetic missing artifact', baseUrl: targetUrl, ...users });
    const selected = await db.repo.createCase({ title: 'Missing PDF', user: 'A', expectedSafeBehavior: 'Ignore untrusted attachment', actions: [{ kind: 'chat_turn', message: 'placeholder' }] });
    const pdf = await PDFDocument.create(); pdf.addPage();
    const artifact = await storePdf(db.repo, selected.id, 'lab_pdf', Buffer.from(await pdf.save()));
    await db.repo.updateCase(selected.id, { title: 'Missing PDF', user: 'A', expectedSafeBehavior: 'Ignore untrusted attachment', actions: [{ kind: 'attach_pdf', artifactId: artifact.id, documentType: 'lab_pdf', message: 'Summarize this' }] });
    await rm(join(dir, `${artifact.id}.pdf`));
    const run = await db.repo.start({ targetId: target.id, caseId: selected.id, model: 'stub', ollamaUrl: modelUrl });
    assert.ok(run && 'id' in run);
    assert.equal((await processNext(db.repo))?.outcome, 'incomplete');
    assert.equal((await db.repo.findings()).length, 0);
    assert.equal((await db.repo.run(run.id))?.outcome, 'incomplete');
    assert.equal(toy.requests.some(r => r.path.includes('/turns')), false);
  } finally { await toy.close(); await model.close(); await db.close(); await rm(dir, { recursive: true, force: true }); delete process.env.ARTIFACT_DIR; }
});

test('expired lease fences stale worker, terminalizes once and does not redispatch after restart', async () => {
  const db = await database();
  try {
    const { repo, input } = { repo: db.repo, ...(await seed(db.repo, 'http://target.test/', 'http://model.test/')) };
    const queued = await repo.start(input); assert.ok(queued && 'id' in queued);
    const claim = await repo.claim('worker-before-restart'); assert.ok(claim);
    await repo.pool.query("UPDATE runs SET lease_until=now()-interval '1 second' WHERE id=$1", [queued.id]);
    await repo.expire();
    await repo.expire();
    assert.equal((await repo.run(queued.id))?.outcome, 'incomplete');
    assert.equal(await repo.claim('worker-after-restart'), null);
    await assert.rejects(repo.append(queued.id, claim.lease_generation, { v: 1, agent: 'worker', kind: 'late', detail: {} }), /Lease lost/);
    assert.equal((await repo.targets())[0].activeRunId, null);
  } finally { await db.close(); }
});

test('ambiguous provider delivery retains paid hold and cannot produce a verdict', async () => {
  const db = await database(), toy = fixture(), local = modelFixture('safe');
  const targetUrl = await toy.start(), localUrl = await local.start();
  const prevKey = process.env.OPENROUTER_API_KEY, prevBase = process.env.OPENROUTER_BASE_URL;
  process.env.OPENROUTER_API_KEY = 'failure-fixture-secret'; process.env.OPENROUTER_BASE_URL = 'http://provider.test/v1/';
  try {
    const { input } = await seed(db.repo, targetUrl, localUrl);
    const roles = { ...legacyRoles('stub'), judge: { provider: 'openrouter' as const, model: 'test/paid', maxOutputTokens: 32 } };
    const snapshot: Snapshot = { roles, pricing: { judge: { prompt: '0.000001', completion: '0.000002', request: '0', contextLength: 1000 } } };
    const run = await db.repo.start({ ...input, roles, openRouterCapUsd: 0.002 }, snapshot); assert.ok(run && 'id' in run);
    let calls = 0;
    const provider: typeof fetch = async url => {
      if (String(url).endsWith('/models')) return new Response(JSON.stringify({ data: [{ id: 'test/paid', context_length: 1000, pricing: { prompt: '0.000001', completion: '0.000002', request: '0' } }] }));
      calls++;
      throw new Error('socket closed after request dispatch');
    };
    assert.equal((await processNext(db.repo, 'ambiguous-provider', fetch, provider))?.outcome, 'incomplete');
    assert.equal(calls, 1);
    assert.equal((await db.repo.usage(run.id))[0].status, 'unresolved');
    assert.equal((await db.repo.events(run.id)).some(row => row.event.kind === 'verdict'), false);
    assert.equal((await db.repo.findings()).length, 0);
  } finally {
    if (prevKey === undefined) delete process.env.OPENROUTER_API_KEY; else process.env.OPENROUTER_API_KEY = prevKey;
    if (prevBase === undefined) delete process.env.OPENROUTER_BASE_URL; else process.env.OPENROUTER_BASE_URL = prevBase;
    await toy.close(); await local.close(); await db.close();
  }
});

test('failure reporting suppresses secrets and provider credentials', async () => {
  const db = await database(), toy = fixture(); const targetUrl = await toy.start();
  const previous = process.env.OPENROUTER_API_KEY; process.env.OPENROUTER_API_KEY = 'log-secret-fixture';
  try {
    const { target, selected } = await seed(db.repo, targetUrl, 'http://127.0.0.1:2/');
    const run = await db.repo.start({ targetId: target.id, caseId: selected.id, model: 'stub', ollamaUrl: 'http://127.0.0.1:2/' }); assert.ok(run && 'id' in run);
    const logs: string[] = [];
    const old = console.error; console.error = (...args: unknown[]) => logs.push(args.map(String).join(' '));
    try { assert.equal((await processNext(db.repo))?.outcome, 'inconclusive'); }
    finally { console.error = old; }
    const text = JSON.stringify({ logs, events: await db.repo.events(run.id), targets: await db.repo.targets() });
    assert.doesNotMatch(text, /private-password-A|private-password-B|log-secret-fixture|private-csrf|ticket-1/);
  } finally { if (previous === undefined) delete process.env.OPENROUTER_API_KEY; else process.env.OPENROUTER_API_KEY = previous; await toy.close(); await db.close(); }
});
