import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import { createApp } from '../apps/api/src/app.js';
import { processNext } from '../apps/worker/src/process.js';
import { database, fixture, modelFixture, users, testCase } from './support.js';

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
      assert.equal((await processNext(db.repo))?.outcome, 'pending_review');
      const candidates = await (await fetch(`${url}/api/candidates`)).json(); assert.equal(candidates.length, 1);
    } finally { await unsafe.close(); }
  } finally {
    await new Promise<void>((resolve, reject) => (server as Server).close(err => err ? reject(err) : resolve()));
    await toy.close(); await model.close(); await db.close();
  }
});
