import { test } from 'node:test';
import assert from 'node:assert/strict';
import { database, fixture, seed } from './support.js';
import { legacyRoles, nanos, type Snapshot } from '../apps/worker/src/models.js';
import { migrate } from '../db/migrate.js';
import { processNext } from '../apps/worker/src/process.js';
import { storePdf } from '../apps/api/src/artifacts.js';
import { PDFDocument } from 'pdf-lib';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('queued selected stop terminalizes without claim and releases only its target reservation', async () => {
  const db = await database();
  try {
    const { input, target } = await seed(db.repo, 'http://target.fixture/', 'http://ollama.fixture/');
    const queued = await db.repo.start(input); assert.ok(queued && 'id' in queued);
    assert.deepEqual(await db.repo.stop(queued.id), { stopRequested: true, status: 'finished', outcome: 'incomplete' });
    assert.equal((await db.repo.run(queued.id)).outcome, 'incomplete');
    assert.equal((await db.repo.run(queued.id)).stopRequested, true);
    assert.equal((await db.repo.targets()).find(row => row.id === target.id).activeRunId, null);
    assert.equal(await db.repo.claim('must-not-claim'), null);
    assert.equal(await db.repo.stop(queued.id), null);
    assert.equal((await db.repo.events(queued.id)).length, 0);
    const next = await db.repo.start(input); assert.ok(next && 'id' in next);
  } finally { await db.close(); }
});

test('running selected stop keeps lease/reservation until finish and cannot insert review candidate', async () => {
  const db = await database();
  try {
    const { input, target } = await seed(db.repo, 'http://target.fixture/', 'http://ollama.fixture/');
    const queued = await db.repo.start(input); assert.ok(queued && 'id' in queued);
    const lease = await db.repo.claim('selected-stop'); assert.ok(lease);
    assert.deepEqual(await db.repo.stop(queued.id), { stopRequested: true, status: 'running' });
    assert.equal(await db.repo.stopped(queued.id, lease.lease_generation), true);
    assert.equal((await db.repo.targets()).find(row => row.id === target.id).activeRunId, queued.id);
    await assert.rejects(db.repo.reserveCall(queued.id, lease.lease_generation, 'judge', 'ollama', 'stub', 0n), /Lease lost/);
    await db.repo.finish(queued.id, lease.lease_generation, 'pending_review', { checks: [], verdict: null });
    assert.equal((await db.repo.run(queued.id)).outcome, 'incomplete');
    assert.equal((await db.repo.candidates()).length, 0);
    assert.equal((await db.repo.pool.query('SELECT count(*)::int AS count FROM assessments WHERE run_id=$1', [queued.id])).rows[0].count, 0);
    assert.equal((await db.repo.targets()).find(row => row.id === target.id).activeRunId, null);
  } finally { await db.close(); }
});

test('ordinary incomplete finish retains its assessment when no stop or timeout won', async () => {
  const db = await database();
  try {
    const { input } = await seed(db.repo, 'http://target.fixture/', 'http://ollama.fixture/');
    const queued = await db.repo.start(input); assert.ok(queued && 'id' in queued);
    const claimed = await db.repo.claim('ordinary-incomplete'); assert.ok(claimed);
    await db.repo.finish(queued.id, claimed.lease_generation, 'incomplete', { checks: [], verdict: null });
    const assessment = (await db.repo.pool.query('SELECT route,checks,verdict FROM assessments WHERE run_id=$1', [queued.id])).rows[0];
    assert.deepEqual(assessment, { route: 'incomplete', checks: [], verdict: null });
    assert.equal((await db.repo.run(queued.id)).outcome, 'incomplete');
  } finally { await db.close(); }
});

test('stop and claim serialize on the run row; a stop that wins prevents any work', async () => {
  const db = await database();
  try {
    const { input } = await seed(db.repo, 'http://target.fixture/', 'http://ollama.fixture/');
    const queued = await db.repo.start(input); assert.ok(queued && 'id' in queued);
    const [stopped, claimed] = await Promise.all([db.repo.stop(queued.id), db.repo.claim('claim-race')]);
    assert.ok(stopped);
    if (claimed) {
      assert.equal(claimed.id, queued.id);
      assert.equal(stopped.status, 'running');
      assert.equal(await db.repo.stopped(queued.id, claimed.lease_generation), true);
      await db.repo.finish(queued.id, claimed.lease_generation, 'safe');
    } else assert.equal(stopped.status, 'finished');
    assert.equal((await db.repo.run(queued.id)).outcome, 'incomplete');
    assert.equal((await db.repo.events(queued.id)).length, 0);
  } finally { await db.close(); }
});

test('stop and finish serialize; only a finish that wins may create a candidate', async () => {
  const db = await database();
  try {
    const { input } = await seed(db.repo, 'http://target.fixture/', 'http://ollama.fixture/');
    const queued = await db.repo.start(input); assert.ok(queued && 'id' in queued);
    const claimed = await db.repo.claim('finish-race'); assert.ok(claimed);
    const [stopped] = await Promise.all([db.repo.stop(queued.id), db.repo.finish(queued.id, claimed.lease_generation, 'pending_review', { checks: [], verdict: null })]);
    const run = await db.repo.run(queued.id);
    if (stopped) {
      assert.equal(stopped.status, 'running');
      assert.equal(run.outcome, 'incomplete');
      assert.equal((await db.repo.candidates()).length, 0);
    } else {
      assert.equal(run.outcome, 'pending_review');
      assert.equal((await db.repo.candidates()).length, 1);
    }
  } finally { await db.close(); }
});

test('stop permits settlement of already reserved paid work, retaining an unknown charge hold', async () => {
  const db = await database();
  try {
    const { input } = await seed(db.repo, 'http://target.fixture/', 'http://ollama.fixture/');
    const judge = { provider: 'openrouter' as const, model: 'fixture/paid', maxOutputTokens: 64 };
    const models: Snapshot = { roles: { judge }, pricing: { judge: { prompt: '0.000001', completion: '0.000002', request: '0', contextLength: 1000 } } };
    const queued = await db.repo.start({ targetId: input.targetId, caseId: input.caseId, roles: { judge }, openRouterCapUsd: 0.01 }, models);
    assert.ok(queued && 'id' in queued);
    const lease = await db.repo.claim('paid-stop'); assert.ok(lease);
    const callId = await db.repo.reserveCall(queued.id, lease.lease_generation, 'judge', 'openrouter', judge.model, nanos('0.0012'));
    await db.repo.stop(queued.id);
    await assert.rejects(db.repo.reserveCall(queued.id, lease.lease_generation, 'judge', 'openrouter', judge.model, 1n), /Lease lost/);
    assert.equal(await db.repo.settleCall(queued.id, lease.lease_generation, callId), false);
    await db.repo.finish(queued.id, lease.lease_generation, 'safe');
    assert.equal((await db.repo.run(queued.id)).outcome, 'incomplete');
    const usage = await db.repo.usage(queued.id);
    assert.deepEqual(usage.map(row => row.status), ['unresolved']);
    assert.equal(usage[0].reservedNanos, nanos('0.0012').toString());
  } finally { await db.close(); }
});

test('queued scheduled adaptive stop records reason without dispatch and leaves later schedules runnable', async () => {
  const db = await database();
  try {
    const { input } = await seed(db.repo, 'http://target.fixture/', 'http://ollama.fixture/');
    const roles = legacyRoles('stub');
    const schedule = await db.repo.saveSchedule({ name: 'Synthetic daily', cadence: 'daily', hour: 9, minute: 0, zone: 'UTC',
      run: { kind: 'adaptive', input: { targetId: input.targetId, caseIds: [input.caseId], categories: ['prompt_injection'], maxCases: 2, maxMinutes: 3,
        ollamaUrl: input.ollamaUrl, roles } } }, { roles, pricing: {} }, new Date('2026-09-29T00:00:00Z'));
    assert.ok(schedule);
    const fired = await db.repo.tick(new Date('2026-09-29T09:00:01Z'));
    assert.equal(fired.length, 1); assert.equal(fired[0].state, 'queued');
    const occurrence = (await db.repo.occurrences(schedule.id))[0];
    assert.deepEqual(await db.repo.stop(occurrence.runId), { stopRequested: true, status: 'finished', outcome: 'incomplete' });
    assert.equal(await db.repo.claim('scheduled-stop'), null);
    const stopped = (await db.repo.occurrences(schedule.id))[0];
    assert.deepEqual([stopped.state, stopped.reason], ['finished', 'Stopped before dispatch']);
    const next = await db.repo.start(input); assert.ok(next && 'id' in next);
  } finally { await db.close(); }
});

test('migration terminalizes pre-upgrade queued adaptive stop requests and releases their target', async () => {
  const db = await database();
  try {
    const { input, target } = await seed(db.repo, 'http://target.fixture/', 'http://ollama.fixture/');
    const roles = legacyRoles('stub');
    const schedule = await db.repo.saveSchedule({ name: 'Legacy stopped daily', cadence: 'daily', hour: 9, minute: 0, zone: 'UTC',
      run: { kind: 'adaptive', input: { targetId: input.targetId, caseIds: [input.caseId], categories: ['prompt_injection'], maxCases: 2, maxMinutes: 3,
        ollamaUrl: input.ollamaUrl, roles } } }, { roles, pricing: {} }, new Date('2026-09-29T00:00:00Z'));
    assert.ok(schedule);
    await db.repo.tick(new Date('2026-09-29T09:00:01Z'));
    const occurrence = (await db.repo.occurrences(schedule.id))[0]; assert.ok(occurrence.runId);
    await db.repo.pool.query('UPDATE runs SET stop_requested=true WHERE id=$1', [occurrence.runId]);
    await db.repo.pool.query("DELETE FROM schema_migrations WHERE name='013_run_history_index.sql'");
    await migrate(db.repo.pool);
    assert.deepEqual([(await db.repo.run(occurrence.runId)).status, (await db.repo.run(occurrence.runId)).outcome], ['finished', 'incomplete']);
    assert.deepEqual([(await db.repo.occurrences(schedule.id))[0].state, (await db.repo.occurrences(schedule.id))[0].reason], ['finished', 'Stopped before dispatch']);
    assert.equal((await db.repo.targets()).find(row => row.id === target.id).activeRunId, null);
    assert.equal(await db.repo.claim('legacy-stopped'), null);
  } finally { await db.close(); }
});

test('selected stop after first turn prevents later turn and Judge dispatch', async () => {
  const db = await database(), toy = fixture(); const baseUrl = await toy.start();
  try {
    const { input, selected } = await seed(db.repo, baseUrl, 'http://ollama.fixture/');
    const updated = await db.repo.updateCase(selected.id, { title: 'Two actions', user: 'A', expectedSafeBehavior: 'Stay in chart', actions: [
      { kind: 'chat_turn', message: 'First synthetic request' }, { kind: 'chat_turn', message: 'Second synthetic request' }
    ] }); assert.ok(updated);
    const run = await db.repo.start(input); assert.ok(run && 'id' in run);
    let modelCalls = 0;
    const targetFetch: typeof fetch = async (url, init) => {
      const response = await fetch(url, init);
      if (String(url).includes('/turns')) await db.repo.stop(run.id);
      return response;
    };
    const modelFetch: typeof fetch = async () => { modelCalls++; throw new Error('Judge must not dispatch'); };
    assert.equal((await processNext(db.repo, 'selected-turn-stop', targetFetch, modelFetch))?.outcome, 'incomplete');
    assert.equal(toy.requests.filter(request => request.path.includes('/turns')).length, 1);
    assert.equal(modelCalls, 0);
    assert.equal((await db.repo.usage(run.id)).length, 0);
    assert.equal((await db.repo.candidates()).length, 0);
  } finally { await toy.close(); await db.close(); }
});

test('selected stop after PDF upload prevents target turn and Judge dispatch', async () => {
  const oldArtifactDir = process.env.ARTIFACT_DIR;
  const artifactDir = await mkdtemp(join(tmpdir(), 'r01-stop-pdf-'));
  process.env.ARTIFACT_DIR = artifactDir;
  const db = await database(), toy = fixture(); const baseUrl = await toy.start();
  try {
    const { input, selected } = await seed(db.repo, baseUrl, 'http://ollama.fixture/');
    const pdf = await PDFDocument.create(); pdf.addPage();
    const artifact = await storePdf(db.repo, selected.id, 'lab_pdf', Buffer.from(await pdf.save()));
    await db.repo.updateCase(selected.id, { title: 'PDF stop', user: 'A', expectedSafeBehavior: 'Ignore document instructions', actions: [
      { kind: 'attach_pdf', artifactId: artifact.id, documentType: 'lab_pdf', message: 'Summarize this synthetic PDF' }
    ] });
    const run = await db.repo.start(input); assert.ok(run && 'id' in run);
    let modelCalls = 0;
    const targetFetch: typeof fetch = async (url, init) => {
      const response = await fetch(url, init);
      if (String(url).includes('document_upload.php')) await db.repo.stop(run.id);
      return response;
    };
    assert.equal((await processNext(db.repo, 'selected-upload-stop', targetFetch, async () => { modelCalls++; throw new Error('Judge must not dispatch'); }))?.outcome, 'incomplete');
    assert.equal(toy.requests.filter(request => request.path.includes('document_upload.php')).length, 1);
    assert.equal(toy.requests.filter(request => request.path.includes('/turns')).length, 0);
    assert.equal(modelCalls, 0);
  } finally {
    await toy.close(); await db.close();
    if (oldArtifactDir === undefined) delete process.env.ARTIFACT_DIR; else process.env.ARTIFACT_DIR = oldArtifactDir;
    await rm(artifactDir, { recursive: true, force: true });
  }
});

test('stop in the reservation-to-Judge-dispatch gap settles zero and sends no model request', async () => {
  const db = await database(), toy = fixture(); const baseUrl = await toy.start();
  try {
    const { input } = await seed(db.repo, baseUrl, 'http://ollama.fixture/');
    const run = await db.repo.start(input); assert.ok(run && 'id' in run);
    const originalReserve = db.repo.reserveCall.bind(db.repo);
    db.repo.reserveCall = (async (...args: Parameters<typeof db.repo.reserveCall>) => {
      const callId = await originalReserve(...args);
      await db.repo.stop(run.id);
      return callId;
    }) as typeof db.repo.reserveCall;
    let modelCalls = 0;
    assert.equal((await processNext(db.repo, 'judge-gap-stop', fetch, async () => { modelCalls++; throw new Error('Judge must not dispatch'); }))?.outcome, 'incomplete');
    assert.equal(modelCalls, 0);
    assert.equal(toy.requests.filter(request => request.path.includes('/turns')).length, 1);
    assert.deepEqual((await db.repo.usage(run.id)).map(call => [call.status, call.reservedNanos, call.chargeNanos, call.latencyMs]), [['settled', '0', null, 0]]);
    assert.equal((await db.repo.candidates()).length, 0);
  } finally { await toy.close(); await db.close(); }
});

test('paid Judge reservation stopped before dispatch releases its hold with a proven zero charge', async () => {
  const db = await database(), toy = fixture(); const baseUrl = await toy.start();
  const oldKey = process.env.OPENROUTER_API_KEY;
  process.env.OPENROUTER_API_KEY = 'synthetic-fixture-key';
  try {
    const { input } = await seed(db.repo, baseUrl, 'http://ollama.fixture/');
    const judge = { provider: 'openrouter' as const, model: 'fixture/paid', maxOutputTokens: 32 };
    const price = { prompt: '0.000001', completion: '0.000002', request: '0', contextLength: 1000 };
    const run = await db.repo.start({ targetId: input.targetId, caseId: input.caseId, roles: { judge }, openRouterCapUsd: 0.01 }, { roles: { judge }, pricing: { judge: price } });
    assert.ok(run && 'id' in run);
    const originalReserve = db.repo.reserveCall.bind(db.repo);
    db.repo.reserveCall = (async (...args: Parameters<typeof db.repo.reserveCall>) => {
      const callId = await originalReserve(...args);
      await db.repo.stop(run.id);
      return callId;
    }) as typeof db.repo.reserveCall;
    let paidDispatches = 0;
    const transport: typeof fetch = async url => {
      if (String(url).endsWith('/models')) return new Response(JSON.stringify({ data: [{ id: judge.model, context_length: price.contextLength, pricing: { prompt: price.prompt, completion: price.completion, request: price.request } }] }));
      paidDispatches++; throw new Error('Paid model must not dispatch');
    };
    assert.equal((await processNext(db.repo, 'paid-judge-gap', fetch, transport))?.outcome, 'incomplete');
    assert.equal(paidDispatches, 0);
    const usage = await db.repo.usage(run.id);
    assert.equal(usage.length, 1);
    assert.equal(usage[0].status, 'settled');
    assert.equal(usage[0].chargeNanos, '0');
    assert.ok(BigInt(usage[0].reservedNanos) > 0n);
  } finally {
    if (oldKey === undefined) delete process.env.OPENROUTER_API_KEY; else process.env.OPENROUTER_API_KEY = oldKey;
    await toy.close(); await db.close();
  }
});

test('adaptive paid Orchestrator and Red Team reservation gaps settle zero without paid dispatch', async () => {
  const oldKey = process.env.OPENROUTER_API_KEY;
  process.env.OPENROUTER_API_KEY = 'synthetic-fixture-key';
  try {
    for (const paidRole of ['orchestrator', 'redTeam'] as const) {
      const db = await database();
      try {
        const { input } = await seed(db.repo, 'http://target.fixture/', 'http://ollama.fixture/');
        const roles = legacyRoles('stub');
        roles[paidRole] = { provider: 'openrouter', model: 'fixture/paid', maxOutputTokens: 32 };
        const price = { prompt: '0.000001', completion: '0.000002', request: '0', contextLength: 1000 };
        const run = await db.repo.startAdaptive({ targetId: input.targetId, caseIds: [input.caseId], categories: ['prompt_injection'], maxCases: 1,
          maxMinutes: 2, ollamaUrl: input.ollamaUrl, roles, openRouterCapUsd: 0.01 }, { roles, pricing: { [paidRole]: price } });
        assert.ok(run && 'id' in run);
        const originalReserve = db.repo.reserveCall.bind(db.repo);
        db.repo.reserveCall = (async (...args: Parameters<typeof db.repo.reserveCall>) => {
          const callId = await originalReserve(...args);
          if (args[2] === paidRole) await db.repo.stop(run.id);
          return callId;
        }) as typeof db.repo.reserveCall;
        let paidDispatches = 0;
        const transport: typeof fetch = async (url, init) => {
          if (String(url).endsWith('/models')) return new Response(JSON.stringify({ data: [{ id: 'fixture/paid', context_length: price.contextLength, pricing: { prompt: price.prompt, completion: price.completion, request: price.request } }] }));
          if (String(url).includes('chat/completions')) { paidDispatches++; throw new Error('Paid model must not dispatch'); }
          const system = JSON.parse(init!.body as string).messages[0].content as string;
          const answer = system.startsWith('Choose') ? { caseId: input.caseId } : { actions: [{ kind: 'chat_turn', message: 'Synthetic bounded probe' }] };
          return new Response(JSON.stringify({ message: { content: JSON.stringify(answer) } }));
        };
        assert.equal((await processNext(db.repo, `adaptive-${paidRole}-gap`, fetch, transport))?.outcome, 'incomplete');
        assert.equal(paidDispatches, 0);
        const paidCalls = (await db.repo.usage(run.id)).filter(call => call.provider === 'openrouter');
        assert.equal(paidCalls.length, 1);
        assert.deepEqual([paidCalls[0].role, paidCalls[0].status, paidCalls[0].chargeNanos], [paidRole, 'settled', '0']);
        assert.ok(BigInt(paidCalls[0].reservedNanos) > 0n);
      } finally { await db.close(); }
    }
  } finally { if (oldKey === undefined) delete process.env.OPENROUTER_API_KEY; else process.env.OPENROUTER_API_KEY = oldKey; }
});
