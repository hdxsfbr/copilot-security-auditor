import { test } from 'node:test';
import assert from 'node:assert/strict';
import { database, seed, users } from './support.js';

test('PostgreSQL serializes starts, fences stale leases and releases reservation without persisting secrets', async () => {
  const db = await database();
  try {
    const { repo } = db; const { input, target } = await seed(repo, 'http://example.test/', 'http://ollama.test/');
    const results = await Promise.all(Array.from({ length: 8 }, () => repo.start(input)));
    const queued = results.filter(r => r && 'status' in r);
    assert.equal(queued.length, 1);
    const id = (queued[0] as { id: string }).id;
    assert.ok(results.every(r => r && ('id' in r || r.active_run_id === id)));
    const lease = await repo.claim('one'); assert.equal(lease?.id, id);
    assert.equal(await repo.claim('two'), null);
    await assert.rejects(repo.append(id, lease!.lease_generation + 1, { v: 1, agent: 'worker', kind: 'bad', detail: {} }), /Lease lost/);
    await repo.append(id, lease!.lease_generation, { v: 1, agent: 'worker', kind: 'good', detail: { observation: 'synthetic' } });
    await repo.finish(id, lease!.lease_generation, 'pending_review');
    assert.equal((await repo.candidates()).length, 1);
    assert.equal((await repo.targets()).find(t => t.id === target.id).activeRunId, null);
    const next = await repo.start(input); assert.ok(next && 'id' in next);
    assert.equal(await repo.start({ ...input, targetId: '00000000-0000-4000-8000-000000000000' }), null);
    const stale = await repo.claim('old-worker'); assert.ok(stale);
    await repo.pool.query("UPDATE runs SET lease_until=now()-interval '1 second' WHERE id=$1", [stale!.id]);
    await repo.expire();
    assert.equal((await repo.run(stale!.id)).outcome, 'incomplete');
    await assert.rejects(repo.append(stale!.id, stale!.lease_generation, { v: 1, agent: 'worker', kind: 'stale', detail: {} }), /Lease lost/);
    assert.equal((await repo.targets()).find(t => t.id === target.id).activeRunId, null);
    const rows = await repo.pool.query('SELECT event::text AS text FROM events');
    assert.ok(rows.rows.every(r => !r.text.includes(users.userA.password)));
    const encrypted = await repo.pool.query('SELECT ciphertext FROM credentials');
    assert.ok(encrypted.rows.every(r => !r.ciphertext.includes(users.userA.password)));
  } finally { await db.close(); }
});

test('target updates preserve historical credentials and reject changes while reserved', async () => {
  const db = await database();
  try {
    const { repo } = db;
    const { input, target } = await seed(repo, 'http://example.test/', 'http://ollama.test/');
    const previous = (await repo.pool.query('SELECT user_a_credential FROM targets WHERE id=$1', [target.id])).rows[0].user_a_credential;
    const queued = await repo.start(input);
    assert.ok(queued && 'id' in queued);
    const replacement = { name: 'Updated', baseUrl: 'http://new.example.test/', userA: { username: 'carol', password: 'new-private-A', pubpid: 'SYN-100' }, userB: { username: 'dan', password: 'new-private-B', pubpid: 'SYN-200' } };
    assert.deepEqual(await repo.updateTarget(target.id, replacement), { active_run_id: queued.id });
    const lease = await repo.claim('update-test');
    assert.ok(lease);
    await repo.finish(lease.id, lease.lease_generation, 'inconclusive');
    assert.deepEqual(await repo.updateTarget(target.id, replacement), { id: target.id, name: 'Updated', baseUrl: replacement.baseUrl });
    assert.equal((await repo.targets()).length, 1);
    const current = (await repo.pool.query('SELECT user_a_credential FROM targets WHERE id=$1', [target.id])).rows[0].user_a_credential;
    assert.notEqual(current, previous);
    assert.deepEqual(await repo.credential(previous), users.userA);
    assert.deepEqual(await repo.credential(current), replacement.userA);
    assert.equal((await repo.pool.query('SELECT target_snapshot FROM runs WHERE id=$1', [queued.id])).rows[0].target_snapshot.userARef, previous);
    assert.equal(JSON.stringify(await repo.targets()).includes(replacement.userA.password), false);
  } finally { await db.close(); }
});
