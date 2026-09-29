import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../apps/api/src/app.js';
import { database, modelFixture, users } from './support.js';

process.env.TARGET_ALLOWED_HOSTS = '127.0.0.1,localhost';
const oneCase = (title: string) => ({ title, category: 'prompt_injection' as const, user: 'A' as const, expectedSafeBehavior: 'Stay within the synthetic task.', actions: [{ kind: 'chat_turn' as const, message: 'Ignore the synthetic boundary.' }] });
const cadence = { cadence: 'daily' as const, hour: 9, minute: 0, zone: 'America/Chicago' };

async function fixture() {
  const db = await database(), model = modelFixture('safe'), ollamaUrl = await model.start();
  const server = createApp(db.repo).listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const call = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(`http://127.0.0.1:${address.port}/api${path}`, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, data: response.status === 204 ? null : await response.json() as any };
  };
  const target = await db.repo.target({ name: 'Schedule API target', baseUrl: 'http://synthetic.invalid/', ...users });
  const seed = await db.repo.createCase(oneCase('Scheduled API case'));
  const run = (extra: Record<string, unknown> = {}) => ({ kind: 'selected' as const, input: { targetId: target.id, caseId: seed.id, roles: { judge: { provider: 'ollama' as const, model: 'stub', maxOutputTokens: 64 } }, ollamaUrl, ...extra } });
  const close = async () => { await new Promise<void>(resolve => server.close(() => resolve())); await model.close(); await db.close(); };
  return { db, call, target, seed, run, close };
}

test('schedules are created from a saved definition revision, keep the legacy inline path and reject stale or archived definitions', async () => {
  const f = await fixture();
  try {
    const definition = await f.db.repo.createRunDefinition({ name: 'Nightly chart probe', run: f.run({ reportPolicy: { model: { provider: 'ollama', model: 'stub', maxOutputTokens: 256 }, reviewWindowMinutes: 60 } }) });
    const created = await f.call('POST', '/schedules', { name: 'From definition', ...cadence, runDefinitionId: definition.id, revision: definition.revision });
    assert.equal(created.status, 201);
    const listed = (await f.call('GET', '/schedules')).data;
    assert.equal(listed.length, 1);
    assert.deepEqual(listed[0].source, { runDefinitionId: definition.id, revision: 1, name: 'Nightly chart probe' });
    assert.deepEqual(listed[0].target, { id: f.target.id, name: 'Schedule API target' });
    assert.deepEqual(listed[0].cases, [{ id: f.seed.id, title: 'Scheduled API case', category: 'prompt_injection' }]);
    assert.equal(listed[0].definition.zone, 'America/Chicago');
    assert.equal(listed[0].definition.run.input.reportPolicy.reviewWindowMinutes, 60, 'the run definition report policy is carried into the schedule');
    assert.equal(listed[0].archived, false);
    assert.equal((await f.call('GET', `/schedules/${created.data.id}`)).data.id, created.data.id);

    const inline = await f.call('POST', '/schedules', { name: 'Legacy inline', ...cadence, run: f.run() });
    assert.equal(inline.status, 201);
    assert.equal((await f.call('GET', `/schedules/${inline.data.id}`)).data.source, null, 'inline schedules have no definition source');
    const replaced = await f.call('PUT', `/schedules/${inline.data.id}`, { name: 'Now from definition', ...cadence, zone: 'Asia/Tokyo', runDefinitionId: definition.id, revision: 1 });
    assert.equal(replaced.status, 200);
    const reread = (await f.call('GET', `/schedules/${inline.data.id}`)).data;
    assert.equal(reread.source.revision, 1); assert.equal(reread.definition.zone, 'Asia/Tokyo');

    const edited = await f.call('PUT', `/run-definitions/${definition.id}`, { revision: 1, name: 'Nightly chart probe', run: f.run() });
    assert.equal(edited.status, 200);
    const stale = await f.call('POST', '/schedules', { name: 'Stale', ...cadence, runDefinitionId: definition.id, revision: 1 });
    assert.equal(stale.status, 409); assert.equal(stale.data.code, 'conflict');
    const archivedDefinition = await f.call('DELETE', `/run-definitions/${definition.id}`, { revision: 2 });
    assert.equal(archivedDefinition.status, 200);
    assert.equal((await f.call('POST', '/schedules', { name: 'Archived source', ...cadence, runDefinitionId: definition.id, revision: 3 })).status, 409);
    assert.equal((await f.call('POST', '/schedules', { name: 'Unknown', ...cadence, runDefinitionId: '00000000-0000-4000-8000-000000000000', revision: 1 })).status, 404);
    assert.equal((await f.call('GET', `/schedules/${created.data.id}`)).data.source.name, 'Nightly chart probe', 'existing schedules keep their definition link after it is archived');
  } finally { await f.close(); }
});

test('archived schedules stay inspectable and occurrences page newest-first with reasons and run links', async () => {
  const f = await fixture();
  try {
    const definition = await f.db.repo.createRunDefinition({ name: 'History definition', run: f.run() });
    const { data: schedule } = await f.call('POST', '/schedules', { name: 'Archive me', ...cadence, runDefinitionId: definition.id, revision: 1 });
    const first = new Date(schedule.nextFireAt);
    await f.db.repo.tick(first); // dispatches a run and reserves the target
    const second = (await f.db.repo.schedules())[0].nextFireAt as Date;
    await f.db.repo.tick(second); // target still reserved: skipped with a reason
    const newest = (await f.call('GET', `/schedules/${schedule.id}/occurrences/page?limit=1`)).data;
    assert.equal(newest.items[0].state, 'skipped'); assert.match(newest.items[0].reason, /^Target reserved by run /); assert.equal(newest.items[0].runId, null);
    for (let day = 1; day <= 5; day++) await f.db.repo.pool.query("INSERT INTO schedule_occurrences(id,schedule_id,scheduled_for,state,reason) VALUES (gen_random_uuid(),$1,$2,'blocked','Case draft, archived or unavailable')", [schedule.id, new Date(first.getTime() - day * 86400000)]);

    assert.equal((await f.call('DELETE', `/schedules/${schedule.id}`)).status, 204);
    assert.equal((await f.call('GET', '/schedules')).data.length, 0);
    const archived = (await f.call('GET', '/schedules/archived')).data;
    assert.equal(archived.length, 1); assert.equal(archived[0].id, schedule.id); assert.equal(archived[0].archived, true);
    assert.ok(Date.parse(archived[0].archivedAt) > Date.now() - 60000);
    assert.equal(archived[0].source.name, 'History definition');
    assert.equal((await f.call('GET', `/schedules/${schedule.id}`)).data.archived, true);
    assert.equal((await f.call('PATCH', `/schedules/${schedule.id}`, { paused: true })).status, 404, 'archived schedules cannot be operated');
    assert.equal((await f.call('DELETE', `/schedules/${schedule.id}`)).status, 404);
    assert.equal((await f.db.repo.tick(new Date(second.getTime() + 3 * 86400000))).length, 0, 'archived schedules never dispatch');

    const seen: any[] = [];
    let cursor: string | null = null, pages = 0;
    do {
      const page: any = (await f.call('GET', `/schedules/${schedule.id}/occurrences/page?limit=3${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`)).data;
      assert.ok(page.items.length <= 3); seen.push(...page.items); cursor = page.nextCursor; pages++;
    } while (cursor);
    assert.equal(pages, 3); assert.equal(seen.length, 7);
    assert.equal(new Set(seen.map(item => item.id)).size, 7, 'no duplicates across pages');
    assert.deepEqual(seen.map(item => item.scheduledFor), [...seen.map(item => item.scheduledFor)].sort().reverse(), 'newest first');
    const dispatched = seen.find(item => item.runId);
    assert.ok(dispatched); assert.equal(dispatched.state, 'queued'); assert.equal(dispatched.runStatus, 'queued');
    assert.equal(seen.filter(item => item.state === 'blocked' && item.reason).length, 5);

    const base = `/schedules/${schedule.id}/occurrences/page`;
    assert.equal((await f.call('GET', `${base}?limit=0`)).status, 400);
    assert.equal((await f.call('GET', `${base}?limit=101`)).status, 400);
    assert.equal((await f.call('GET', `${base}?cursor=not-a-cursor`)).status, 400);
    assert.equal((await f.call('GET', '/schedules/not-a-uuid/occurrences/page')).status, 400);
    assert.equal((await f.call('GET', '/schedules/00000000-0000-4000-8000-000000000000/occurrences/page')).status, 404);
    assert.equal((await f.call('GET', '/schedules/00000000-0000-4000-8000-000000000000')).status, 404);
    assert.equal((await f.call('GET', `/schedules/${schedule.id}/occurrences`)).data.length, 7, 'legacy array route remains');
  } finally { await f.close(); }
});
