import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createApp } from '../apps/api/src/app.js';
import { database, modelFixture, seed, testCase } from './support.js';

async function apiFixture(model: Pick<ReturnType<typeof modelFixture>, 'start' | 'close'> = modelFixture('safe')) {
  const db = await database();
  const modelUrl = await model.start();
  const { input } = await seed(db.repo, 'http://target.fixture/', modelUrl);
  const second = await db.repo.createCase({ ...testCase, title: 'Second immutable version' });
  const server = createApp(db.repo).listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}/api`;
  const request = (path: string, method = 'GET', body?: unknown) => fetch(`${base}${path}`, { method,
    ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }) });
  return { db, input, second, request, async close() {
    await new Promise<void>(resolve => server.close(() => resolve()));
    await model.close(); await db.close();
  } };
}

function gatedModel() {
  let announce!: () => void, open!: () => void;
  const arrived = new Promise<void>(resolve => { announce = resolve; });
  const released = new Promise<void>(resolve => { open = resolve; });
  const server = createServer(async (req, res) => {
    if (req.url !== '/api/tags') { res.statusCode = 404; res.end('{}'); return; }
    announce(); await released;
    res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ models: [{ name: 'stub' }] }));
  });
  return { arrived, release: () => open(), async start() {
    server.listen(0, '127.0.0.1'); await new Promise<void>(resolve => server.once('listening', resolve));
    const address = server.address(); assert.ok(address && typeof address !== 'string');
    return `http://127.0.0.1:${address.port}/`;
  }, async close() { open(); await new Promise<void>(resolve => server.close(() => resolve())); } };
}

test('definitions use optimistic revision and launch copies exact selected case/model', async () => {
  const f = await apiFixture();
  try {
    const initial = { name: 'Selected local Judge', run: { kind: 'selected', input: f.input } };
    const createdResponse = await f.request('/run-definitions', 'POST', initial);
    assert.equal(createdResponse.status, 201);
    const created = await createdResponse.json();
    assert.equal(created.revision, 1);
    assert.equal((await (await f.request(`/run-definitions/${created.id}`)).json()).run.input.caseId, f.input.caseId);
    assert.equal((await (await f.request('/run-definitions')).json()).length, 1);

    const first = await f.request(`/run-definitions/${created.id}/launch`, 'POST', { revision: 1 });
    assert.equal(first.status, 202);
    const firstRun = await first.json();
    const firstSnapshot = (await f.db.repo.pool.query('SELECT case_id,definition,model_snapshot FROM runs WHERE id=$1', [firstRun.id])).rows[0];
    assert.equal(firstSnapshot.case_id, f.input.caseId);
    assert.deepEqual(Object.keys(firstSnapshot.model_snapshot.roles), ['judge']);
    assert.deepEqual(firstSnapshot.model_snapshot.roles.judge, { provider: 'ollama', model: 'stub', maxOutputTokens: 1024 });
    assert.equal(firstSnapshot.definition.case.title, testCase.title);

    const revised = { name: 'Second selected case', run: { kind: 'selected', input: { ...f.input, caseId: f.second.id,
      roles: { judge: { provider: 'ollama', model: 'stub', maxOutputTokens: 64 } } } } };
    const updates = await Promise.all([f.request(`/run-definitions/${created.id}`, 'PUT', { ...revised, revision: 1 }), f.request(`/run-definitions/${created.id}`, 'PUT', { ...revised, revision: 1 })]);
    assert.deepEqual(updates.map(response => response.status).sort(), [200, 409]);
    assert.equal((await (await f.request(`/run-definitions/${created.id}/launch`, 'POST', { revision: 1 })).json()).code, 'conflict');
    assert.equal((await f.request(`/run-definitions/${created.id}/launch`, 'POST', { revision: 1 })).status, 409);

    const claimed = await f.db.repo.claim('definition-test'); assert.ok(claimed);
    await f.db.repo.finish(firstRun.id, claimed.lease_generation, 'inconclusive');
    const second = await f.request(`/run-definitions/${created.id}/launch`, 'POST', { revision: 2 });
    assert.equal(second.status, 202);
    const secondRun = await second.json();
    assert.equal((await f.db.repo.run(secondRun.id)).caseId, f.second.id);
    assert.equal((await f.db.repo.run(secondRun.id)).modelSnapshot.roles.judge.maxOutputTokens, 64);
    assert.equal((await f.db.repo.run(firstRun.id)).caseId, f.input.caseId);
    assert.deepEqual((await f.db.repo.run(firstRun.id)).modelSnapshot, firstSnapshot.model_snapshot);
  } finally { await f.close(); }
});

test('schedule resolves a revision once; later edit/archive leaves occurrence snapshot unchanged', async () => {
  const f = await apiFixture();
  try {
    const selected = { kind: 'selected', input: f.input };
    const created = await (await f.request('/run-definitions', 'POST', { name: 'Schedule source', run: selected })).json();
    const scheduleResponse = await f.request('/schedules', 'POST', { name: 'Copied daily', cadence: 'daily', hour: 9, minute: 0, zone: 'UTC', runDefinitionId: created.id, revision: 1 });
    assert.equal(scheduleResponse.status, 201);
    const scheduled = await scheduleResponse.json();
    const stale = await f.request('/schedules', 'POST', { name: 'Stale daily', cadence: 'daily', hour: 9, minute: 0, zone: 'UTC', runDefinitionId: created.id, revision: 2 });
    assert.equal(stale.status, 409);
    assert.equal((await stale.json()).code, 'conflict');
    const changed = await f.request(`/run-definitions/${created.id}`, 'PUT', { revision: 1, name: 'Changed source', run: { kind: 'selected', input: { ...f.input, caseId: f.second.id,
      roles: { judge: { provider: 'ollama', model: 'stub', maxOutputTokens: 64 } } } } });
    assert.equal(changed.status, 200);
    assert.equal((await f.request(`/run-definitions/${created.id}`, 'DELETE', { revision: 2 })).status, 200);
    assert.equal((await f.request(`/run-definitions/${created.id}/launch`, 'POST', { revision: 3 })).status, 409);
    assert.equal((await (await f.request('/run-definitions')).json()).length, 0);

    const row = (await f.db.repo.schedules()).find(schedule => schedule.id === scheduled.id); assert.ok(row);
    assert.equal(row.definition.run.input.caseId, f.input.caseId);
    const stored = (await f.db.repo.pool.query('SELECT run_snapshot,model_snapshot FROM schedules WHERE id=$1', [scheduled.id])).rows[0];
    assert.equal(stored.run_snapshot.case.title, testCase.title);
    assert.deepEqual(Object.keys(stored.model_snapshot.roles), ['judge']);
    assert.equal(stored.model_snapshot.roles.judge.maxOutputTokens, 1024);
    const fired = await f.db.repo.tick(new Date(new Date(row.nextFireAt).getTime() + 1000));
    assert.equal(fired.length, 1);
    assert.equal(fired[0].state, 'queued');
    const occurrence = (await f.db.repo.occurrences(scheduled.id))[0];
    assert.equal((await f.db.repo.run(occurrence.runId)).caseId, f.input.caseId);
    assert.equal((await f.db.repo.run(occurrence.runId)).modelSnapshot.roles.judge.maxOutputTokens, 1024);
  } finally { await f.close(); }
});

test('adaptive definition copies seed, attempt/time bounds and three active roles into launch and schedule', async () => {
  const f = await apiFixture();
  try {
    const local = { provider: 'ollama', model: 'stub', maxOutputTokens: 48 };
    const initial = { kind: 'adaptive', input: { targetId: f.input.targetId, caseIds: [f.input.caseId], categories: ['prompt_injection'],
      maxCases: 2, maxMinutes: 3, ollamaUrl: f.input.ollamaUrl, roles: { orchestrator: local, redTeam: local, judge: local,
        documentation: { ...local, model: 'unused-inactive' } } } };
    const created = await (await f.request('/run-definitions', 'POST', { name: 'Adaptive source', run: initial })).json();
    const scheduleResponse = await f.request('/schedules', 'POST', { name: 'Adaptive daily', cadence: 'daily', hour: 10, minute: 0, zone: 'UTC', runDefinitionId: created.id, revision: 1 });
    assert.equal(scheduleResponse.status, 201);
    const scheduled = await scheduleResponse.json();
    const launched = await f.request(`/run-definitions/${created.id}/launch`, 'POST', { revision: 1 });
    assert.equal(launched.status, 202);
    const runId = (await launched.json()).id;
    const old = (await f.db.repo.pool.query('SELECT adaptive,model_snapshot FROM runs WHERE id=$1', [runId])).rows[0];
    assert.deepEqual([old.adaptive.maxCases, old.adaptive.maxMinutes, old.adaptive.seeds[0].id], [2, 3, f.input.caseId]);
    assert.deepEqual(Object.keys(old.model_snapshot.roles).sort(), ['judge', 'orchestrator', 'redTeam']);

    const changed = await f.request(`/run-definitions/${created.id}`, 'PUT', { revision: 1, name: 'Changed adaptive source', run: { kind: 'adaptive', input: {
      ...initial.input, caseIds: [f.second.id], maxCases: 4, maxMinutes: 5, roles: { ...initial.input.roles, judge: { ...local, maxOutputTokens: 80 } } } } });
    assert.equal(changed.status, 200);
    assert.equal((await f.request(`/run-definitions/${created.id}`, 'DELETE', { revision: 2 })).status, 200);
    const savedSchedule = (await f.db.repo.pool.query('SELECT definition,run_snapshot,model_snapshot FROM schedules WHERE id=$1', [scheduled.id])).rows[0];
    assert.deepEqual([savedSchedule.definition.run.input.maxCases, savedSchedule.run_snapshot.adaptive.maxMinutes, savedSchedule.run_snapshot.adaptive.seeds[0].id], [2, 3, f.input.caseId]);
    assert.equal(savedSchedule.model_snapshot.roles.judge.maxOutputTokens, 48);
    assert.deepEqual((await f.db.repo.pool.query('SELECT adaptive,model_snapshot FROM runs WHERE id=$1', [runId])).rows[0], old);
    const claimed = await f.db.repo.claim('adaptive-definition-test'); assert.ok(claimed);
    await f.db.repo.finish(runId, claimed.lease_generation, 'incomplete');
    const schedule = (await f.db.repo.schedules()).find(row => row.id === scheduled.id); assert.ok(schedule);
    const fired = await f.db.repo.tick(new Date(new Date(schedule.nextFireAt).getTime() + 1000));
    assert.equal(fired[0].state, 'queued');
    const occurrence = (await f.db.repo.occurrences(scheduled.id))[0];
    const occurrenceRun = (await f.db.repo.pool.query('SELECT adaptive,model_snapshot FROM runs WHERE id=$1', [occurrence.runId])).rows[0];
    assert.deepEqual(occurrenceRun, old);
  } finally { await f.close(); }
});

test('edit completing during preflight fences stale launch before target reservation', async () => {
  const model = gatedModel(), f = await apiFixture(model);
  try {
    const created = await (await f.request('/run-definitions', 'POST', { name: 'Racing launch', run: { kind: 'selected', input: f.input } })).json();
    const pending = f.request(`/run-definitions/${created.id}/launch`, 'POST', { revision: 1 });
    await model.arrived;
    const edit = await f.request(`/run-definitions/${created.id}`, 'PUT', { revision: 1, name: 'Edited before dispatch', run: { kind: 'selected', input: { ...f.input, caseId: f.second.id } } });
    assert.equal(edit.status, 200);
    model.release();
    const stale = await pending;
    assert.equal(stale.status, 409);
    assert.equal((await stale.json()).code, 'conflict');
    assert.equal((await f.db.repo.pool.query('SELECT count(*)::int AS count FROM runs')).rows[0].count, 0);
    assert.equal((await f.db.repo.targets()).find(target => target.id === f.input.targetId).activeRunId, null);
  } finally { model.release(); await f.close(); }
});

test('archive completing during preflight fences stale schedule before insert', async () => {
  const model = gatedModel(), f = await apiFixture(model);
  try {
    const created = await (await f.request('/run-definitions', 'POST', { name: 'Racing schedule', run: { kind: 'selected', input: f.input } })).json();
    const pending = f.request('/schedules', 'POST', { name: 'Should not save', cadence: 'daily', hour: 9, minute: 0, zone: 'UTC', runDefinitionId: created.id, revision: 1 });
    await model.arrived;
    const archive = await f.request(`/run-definitions/${created.id}`, 'DELETE', { revision: 1 });
    assert.equal(archive.status, 200);
    model.release();
    const stale = await pending;
    assert.equal(stale.status, 409);
    assert.equal((await stale.json()).code, 'conflict');
    assert.equal((await f.db.repo.pool.query('SELECT count(*)::int AS count FROM schedules')).rows[0].count, 0);
  } finally { model.release(); await f.close(); }
});
