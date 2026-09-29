import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { createApp } from '../apps/api/src/app.js';
import { operationsHealth, recordWorkerHeartbeat, registerWorker, workerCycleErrorCode } from '../apps/api/src/operations.js';
import type { Repository } from '../apps/api/src/repository.js';
import { startWorkerHeartbeat } from '../apps/worker/src/heartbeat.js';
import { migrate } from '../db/migrate.js';
import { database, testCase, users } from './support.js';

type Db = Awaited<ReturnType<typeof database>>;
const codes = (health: Awaited<ReturnType<typeof operationsHealth>>) => health.diagnostics.map(item => item.code);
async function queueRun(repo: Repository, name: string, ageSeconds = 0) {
  const target = await repo.target({ name, baseUrl: 'http://synthetic.invalid/', ...users });
  const saved = await repo.createCase({ ...testCase, title: `${name} case` });
  const run = await repo.start({ targetId: target.id, caseId: saved.id, model: 'stub', ollamaUrl: 'http://ollama.invalid/' });
  assert.ok(run && 'id' in run);
  if (ageSeconds) await repo.pool.query("UPDATE runs SET created_at=now()-make_interval(secs=>$2::double precision) WHERE id=$1", [run.id, ageSeconds]);
  return run.id;
}
const ageWorker = (db: Db, workerId: string, seconds: number) => db.repo.pool.query("UPDATE worker_instances SET last_heartbeat_at=now()-make_interval(secs=>$2::double precision) WHERE worker_id=$1", [workerId, seconds]);
const keysOf = (value: unknown, found = new Set<string>()): Set<string> => {
  if (Array.isArray(value)) value.forEach(item => keysOf(item, found));
  else if (value && typeof value === 'object') for (const [key, item] of Object.entries(value)) { found.add(key); keysOf(item, found); }
  return found;
};

test('operations health distinguishes never-registered, idle, busy, stale, aging-queue and expired-lease states', async () => {
  const db = await database();
  try {
    const { repo } = db;
    const pool = repo.pool;
    // No worker has ever registered: an unknown state, not a claim that a worker died.
    let health = await operationsHealth(pool);
    assert.deepEqual([health.status, health.workerSummary.state, codes(health), health.workers], ['attention', 'none_registered', ['no_worker_registered'], []]);
    assert.deepEqual([health.queue, health.leases], [{ queuedCount: 0, oldestQueuedAgeSeconds: null }, { activeCount: 0, expiredCount: 0 }]);

    // A registered, fresh, idle worker with nothing queued is healthy.
    const worker = randomUUID();
    await registerWorker(pool, worker);
    health = await operationsHealth(pool);
    assert.deepEqual([health.status, health.workerSummary, codes(health)], ['ok', { state: 'fresh', freshCount: 1, idleCount: 1, busyCount: 0 }, []]);
    assert.deepEqual(health.workers.map(row => [row.id, row.state, row.activeRunId, row.diagnosticCode]), [[worker, 'idle', null, null]]);
    assert.ok(health.workers[0].heartbeatAgeSeconds <= 2);

    // A fresh worker holding a live lease is busy on that run, not stopped or idle.
    const first = await queueRun(repo, 'Busy target');
    const claimed = await repo.claim(worker); assert.equal(claimed?.id, first);
    health = await operationsHealth(pool);
    assert.deepEqual([health.status, health.workerSummary, health.leases, health.queue.queuedCount, codes(health)], ['ok', { state: 'fresh', freshCount: 1, idleCount: 0, busyCount: 1 }, { activeCount: 1, expiredCount: 0 }, 0, []]);
    assert.deepEqual(health.workers.map(row => [row.state, row.activeRunId]), [['busy', first]]);

    // Another target's run may wait a long time behind the one-run-per-process worker; that is informational capacity, not an outage.
    const waiting = await queueRun(repo, 'Waiting target', 120);
    health = await operationsHealth(pool);
    assert.deepEqual([health.status, codes(health), health.queue.queuedCount], ['ok', ['queue_waiting_for_worker_capacity'], 1]);
    assert.ok(health.queue.oldestQueuedAgeSeconds! >= 119 && health.queue.oldestQueuedAgeSeconds! <= 125);
    assert.deepEqual(health.diagnostics, [{ code: 'queue_waiting_for_worker_capacity', level: 'info' }]);

    // Finishing the run frees the worker; a fresh idle worker with an aging queue still needs attention.
    await repo.finish(first, claimed!.lease_generation, 'safe');
    health = await operationsHealth(pool);
    assert.deepEqual([health.status, health.workerSummary.idleCount, codes(health)], ['attention', 1, ['queue_aging']]);

    // Stop the worker: retained row goes stale while queue age is reported independently.
    await ageWorker(db, worker, 300);
    health = await operationsHealth(pool);
    assert.deepEqual([health.status, health.workerSummary.state, health.workers[0].state, codes(health)], ['attention', 'no_recent_heartbeat', 'no_recent_heartbeat', ['worker_heartbeat_stale', 'queue_aging']]);
    assert.ok(health.workers[0].heartbeatAgeSeconds >= 299);
    assert.equal(health.leases.activeCount, 0);

    // A lease that expired is reported as expired, never as an active evaluation.
    await ageWorker(db, worker, 0);
    const claimedWaiting = await repo.claim(worker); assert.equal(claimedWaiting?.id, waiting);
    await pool.query("UPDATE runs SET lease_until=now()-interval '5 seconds' WHERE id=$1", [waiting]);
    health = await operationsHealth(pool);
    assert.deepEqual([health.leases, health.workerSummary.busyCount, health.workers[0].state, codes(health)], [{ activeCount: 0, expiredCount: 1 }, 0, 'idle', ['expired_lease']]);
    assert.equal(health.status, 'attention');
  } finally { await db.close(); }
});

test('operations health exposes only allowlisted codes, bounded workers and no secret-shaped fields', async () => {
  const saved = { ...process.env };
  const secrets = ['sk-or-v1-operations-secret', 'postgres://auditor:hunter2@db/auditor', 'operations-credential-key'];
  Object.assign(process.env, { OPENROUTER_API_KEY: secrets[0], DATABASE_URL: secrets[1], CREDENTIAL_KEY: 'a'.repeat(64), OPS_SECRET: secrets[2] });
  const db = await database();
  const server = createApp(db.repo).listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  try {
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const { pool } = db.repo;
    // Retention keeps stale rows diagnosable but the response lists only the newest few.
    const ids = Array.from({ length: 7 }, () => randomUUID());
    for (const [index, id] of ids.entries()) { await registerWorker(pool, id); await ageWorker(db, id, 40 + index * 5); }
    await recordWorkerHeartbeat(pool, ids[0], 'worker_cycle_failed');
    // A row containing an unrecognised code collapses to the generic code; free text cannot be stored at all.
    await pool.query("UPDATE worker_instances SET last_cycle_error_code='provider_key_leaked' WHERE worker_id=$1", [ids[0]]);
    await assert.rejects(pool.query("UPDATE worker_instances SET last_cycle_error_code=$2 WHERE worker_id=$1", [ids[1], `Error: ${secrets[1]} refused`]));
    const response = await fetch(`${url}/api/operations/health`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    const body = await response.json() as Awaited<ReturnType<typeof operationsHealth>>;
    assert.equal(body.workers.length, 5);
    assert.deepEqual(body.workers.map(row => row.id), ids.slice(0, 5));
    assert.deepEqual([body.workers[0].diagnosticCode, body.diagnostics.map(item => item.code)], ['worker_cycle_failed', ['worker_cycle_failed']]);
    const text = JSON.stringify(body);
    for (const secret of [...secrets, 'provider_key_leaked', 'hunter2']) assert.equal(text.includes(secret), false, secret);
    assert.deepEqual([...keysOf(body)].sort(), ['activeCount', 'activeRunId', 'busyCount', 'checkedAt', 'code', 'diagnosticCode', 'diagnostics', 'expiredCount', 'freshCount', 'freshSeconds', 'heartbeatAgeSeconds', 'heartbeatIntervalSeconds', 'id', 'idleCount', 'leases', 'level', 'oldestQueuedAgeSeconds', 'policy', 'queue', 'queueWarningSeconds', 'queuedCount', 'startedAt', 'state', 'status', 'v', 'workerSummary', 'workers']);
    assert.equal(workerCycleErrorCode(new Error(`connect refused ${secrets[1]}`)), 'worker_cycle_failed');
    assert.equal(workerCycleErrorCode(new Error('Lease lost')), 'lease_lost');
    assert.equal(workerCycleErrorCode('sk-or-string'), 'worker_cycle_failed');
    // Readiness remains independent of worker liveness.
    assert.equal((await fetch(`${url}/api/health`)).status, 200);
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await db.close();
    for (const key of ['OPENROUTER_API_KEY', 'DATABASE_URL', 'OPS_SECRET'] as const) if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key];
  }
});

test('operations health returns a fixed unavailable response when the database check fails', async () => {
  const failing = { pool: { connect: async () => { throw new Error('password authentication failed for user "auditor" sk-or-v1-database-secret'); }, query: async () => { throw new Error('same secret'); } } } as unknown as Repository;
  const server = createApp(failing).listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  try {
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const response = await fetch(`${url}/api/operations/health`);
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { v: 1, code: 'unavailable', message: 'Operations status unavailable' });
    const readiness = await fetch(`${url}/api/health`);
    assert.equal(readiness.status, 503);
    assert.equal((await readiness.text()).includes('secret'), false);
  } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
});

test('worker heartbeat runs independently of cycles, never overlaps, and does not claim freshness when a write fails', async () => {
  const db = await database();
  try {
    const { pool } = db.repo;
    const worker = randomUUID();
    const beats = startWorkerHeartbeat(pool, worker, 25);
    try {
      assert.equal(await beats.started, true);
      const registered = await operationsHealth(pool);
      assert.deepEqual([registered.workerSummary.freshCount, registered.workers[0].id], [1, worker]);
      const before = (await pool.query('SELECT last_heartbeat_at FROM worker_instances WHERE worker_id=$1', [worker])).rows[0].last_heartbeat_at as Date;
      await new Promise(resolve => setTimeout(resolve, 150));
      const after = (await pool.query('SELECT last_heartbeat_at FROM worker_instances WHERE worker_id=$1', [worker])).rows[0].last_heartbeat_at as Date;
      assert.ok(after.getTime() > before.getTime(), 'idle heartbeat advances without any claimed run');
      // A cycle failure is recorded as a fixed code, and cleared by the next successful cycle.
      const recorded = async (expected: string | null) => {
        for (let attempt = 0; attempt < 100; attempt++) {
          if ((await operationsHealth(pool)).workers[0].diagnosticCode === expected) return true;
          await new Promise(resolve => setTimeout(resolve, 20));
        }
        return false;
      };
      beats.setCycleError('worker_cycle_failed');
      assert.equal(await recorded('worker_cycle_failed'), true);
      beats.setCycleError(null);
      assert.equal(await recorded(null), true);
    } finally { beats.stop(); }

    // Overlapping timer ticks share one in-flight write.
    let concurrent = 0, maxConcurrent = 0, calls = 0;
    const slow = { query: async () => { calls++; concurrent++; maxConcurrent = Math.max(maxConcurrent, concurrent); await new Promise(resolve => setTimeout(resolve, 60)); concurrent--; return { rows: [] }; } } as unknown as pg.Pool;
    const guarded = startWorkerHeartbeat(slow, randomUUID(), 5);
    await guarded.started;
    await new Promise(resolve => setTimeout(resolve, 150));
    guarded.stop();
    await guarded.beat();
    assert.equal(maxConcurrent, 1);
    assert.ok(calls >= 2);

    // If the database write fails, no heartbeat is recorded; the API result stays stale rather than fresh.
    const lost = randomUUID();
    await registerWorker(pool, lost);
    await ageWorker(db, lost, 120);
    const failing = { query: async () => { throw new Error('connection refused with secret'); } } as unknown as pg.Pool;
    const errors: string[] = [], original = console.error;
    console.error = (...args: unknown[]) => { errors.push(args.join(' ')); };
    try {
      const broken = startWorkerHeartbeat(failing, lost, 1000);
      assert.equal(await broken.started, false);
      assert.equal(await broken.beat(), false);
      broken.stop();
    } finally { console.error = original; }
    assert.ok(errors.every(line => !line.includes('secret')));
    const health = await operationsHealth(pool);
    assert.equal(health.workers.find(row => row.id === lost)?.state, 'no_recent_heartbeat');
  } finally { await db.close(); }
});

test('migration 014 preserves pre-upgrade queued and running work and lease claiming', async () => {
  const db = await database();
  try {
    const { repo } = db;
    const queued = await queueRun(repo, 'Queued before upgrade');
    const running = await queueRun(repo, 'Running before upgrade');
    await repo.pool.query("UPDATE runs SET created_at=created_at-interval '1 minute' WHERE id=$1", [running]);
    const claimed = await repo.claim('legacy-owner'); assert.equal(claimed?.id, running);
    await repo.pool.query('DROP TABLE worker_instances');
    await repo.pool.query("DELETE FROM schema_migrations WHERE name='014_worker_instances.sql'");
    await migrate(repo.pool);
    assert.equal((await repo.pool.query("SELECT count(*)::int AS count FROM schema_migrations WHERE name='014_worker_instances.sql'")).rows[0].count, 1);
    assert.deepEqual([(await repo.run(queued)).status, (await repo.run(running)).status], ['queued', 'running']);
    // The pre-upgrade owner is not a registered worker, so its lease is active but no worker is shown as busy.
    const health = await operationsHealth(repo.pool);
    assert.deepEqual([health.leases, health.queue.queuedCount, codes(health)], [{ activeCount: 1, expiredCount: 0 }, 1, ['no_worker_registered']]);
    await repo.heartbeat(running, claimed!.lease_generation);
    assert.equal((await repo.claim('after-upgrade'))?.id, queued);
  } finally { await db.close(); }
});
