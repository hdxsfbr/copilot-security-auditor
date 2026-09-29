import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createApp } from '../apps/api/src/app.js';
import { readEventPage, InvalidEventPage } from '../apps/api/src/event-page.js';
import type { Repository } from '../apps/api/src/repository.js';
import { compareEventIds, eventPageQuery, isEventId } from '../packages/contracts/src/event-page.js';
import { appendNewerEvents, drainEventPages } from '../apps/web/src/pages/run-events.js';
import { database, testCase, users } from './support.js';

type Page = { items: { id: string; event: { agent: string; kind: string; detail: { n: number } }; createdAt: string }[]; hasMore: boolean; nextCursor: string | null };
async function newRun(repo: Repository, name: string) {
  const target = await repo.target({ name, baseUrl: 'http://synthetic.invalid/', ...users });
  const saved = await repo.createCase({ ...testCase, title: `${name} case` });
  const run = await repo.start({ targetId: target.id, caseId: saved.id, model: 'stub', ollamaUrl: 'http://ollama.invalid/' });
  assert.ok(run && 'id' in run);
  return run.id;
}
const addEvents = (repo: Repository, runId: string, from: number, count: number) => repo.pool.query(
  "INSERT INTO events(run_id,event) SELECT $1,jsonb_build_object('v',1,'agent','worker','kind','synthetic','detail',jsonb_build_object('n',n)) FROM generate_series($2::int,$3::int) AS n ORDER BY n", [runId, from, from + count - 1]);

test('event ids and page queries validate exact decimal cursors without number coercion', () => {
  for (const good of ['0', '1', '9007199254740993', '9223372036854775807']) assert.equal(isEventId(good), true, good);
  for (const bad of ['', '-1', '01', '1.5', '1e3', '0x10', ' 1', '1 ', '+1', '9223372036854775808', '12345678901234567890', '١٢٣']) assert.equal(isEventId(bad), false, bad);
  assert.equal(compareEventIds('9007199254740993', '9007199254740992'), 1);
  assert.equal(compareEventIds('9007199254740992', '9007199254740993'), -1);
  assert.equal(Number('9007199254740993') === Number('9007199254740992'), true, 'sanity: Number would merge these IDs');
  assert.deepEqual(eventPageQuery.parse({}), { limit: 100 });
  assert.deepEqual(eventPageQuery.parse({ after: '9223372036854775807', limit: '200' }), { after: '9223372036854775807', limit: 200 });
  for (const bad of [{ limit: '0' }, { limit: '201' }, { limit: '1e2' }, { limit: '2.5' }, { limit: '-1' }, { limit: ['1', '2'] }, { after: ['1', '2'] }, { after: '9223372036854775808' }, { cursor: '1' }]) assert.equal(eventPageQuery.safeParse(bad).success, false, JSON.stringify(bad));
});

test('event pages are bounded, exclusive, ordered, resumable and lossless for high bigint ids', async () => {
  const db = await database();
  const server = createApp(db.repo).listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  try {
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/api`;
    const get = async (path: string) => { const response = await fetch(url + path); return { status: response.status, body: await response.json() as any, cache: response.headers.get('cache-control') }; };
    const runId = await newRun(db.repo, 'Page target'), other = await newRun(db.repo, 'Other page target');
    // Empty run: an empty page preserves the caller's cursor and reports caught up.
    assert.deepEqual((await get(`/runs/${runId}/events/page`)).body, { items: [], hasMore: false, nextCursor: null });
    assert.deepEqual((await get(`/runs/${runId}/events/page?after=42`)).body, { items: [], hasMore: false, nextCursor: '42' });

    // Start beyond Number.MAX_SAFE_INTEGER so any Number coercion would merge or reorder ids.
    await db.repo.pool.query("SELECT setval(pg_get_serial_sequence('events','id'), 9007199254740990)");
    await addEvents(db.repo, runId, 1, 3);
    await addEvents(db.repo, other, 1, 2);
    await addEvents(db.repo, runId, 4, 4);
    const all = (await db.repo.pool.query('SELECT id::text AS id FROM events WHERE run_id=$1 ORDER BY id', [runId])).rows.map(row => row.id as string);
    assert.deepEqual(all.slice(0, 3), ['9007199254740991', '9007199254740992', '9007199254740993']);
    assert.equal(all.length, 7);

    // Pages are limited at the database boundary, exclusive of the cursor, and chain without gaps or repeats.
    const first = await get(`/runs/${runId}/events/page?limit=3`);
    assert.equal(first.status, 200); assert.equal(first.cache, 'no-store');
    const firstPage = first.body as Page;
    assert.deepEqual([firstPage.items.map(item => item.id), firstPage.hasMore, firstPage.nextCursor], [all.slice(0, 3), true, all[2]]);
    assert.ok(firstPage.items.every(item => typeof item.id === 'string'));
    const seen = [...firstPage.items.map(item => item.id)];
    let cursor = firstPage.nextCursor, guard = 0;
    while (cursor && guard++ < 10) {
      const page = (await get(`/runs/${runId}/events/page?limit=3&after=${cursor}`)).body as Page;
      assert.ok(page.items.length <= 3);
      assert.ok(page.items.every(item => compareEventIds(item.id, cursor!) === 1), 'cursor is exclusive');
      seen.push(...page.items.map(item => item.id));
      if (!page.hasMore) { cursor = page.nextCursor; break; }
      cursor = page.nextCursor;
    }
    assert.deepEqual(seen, all);
    assert.equal(cursor, all.at(-1));
    // Events belong to their run only, and the exact-fit page does not claim more.
    assert.equal(((await get(`/runs/${runId}/events/page?limit=7`)).body as Page).hasMore, false);
    assert.equal(((await get(`/runs/${other}/events/page`)).body as Page).items.length, 2);

    // Caught up now; a later append is visible when resuming from the last accepted id.
    const caughtUp = (await get(`/runs/${runId}/events/page?after=${all.at(-1)}`)).body as Page;
    assert.deepEqual(caughtUp, { items: [], hasMore: false, nextCursor: all.at(-1) });
    await addEvents(db.repo, runId, 8, 2);
    const resumed = (await get(`/runs/${runId}/events/page?after=${all.at(-1)}`)).body as Page;
    assert.deepEqual(resumed.items.map(item => item.event.detail.n), [8, 9]);
    assert.equal(compareEventIds(resumed.items[0].id, all.at(-1)!), 1);

    // The largest bigint is a valid empty cursor; beyond it is invalid.
    assert.deepEqual((await get(`/runs/${runId}/events/page?after=9223372036854775807`)).body, { items: [], hasMore: false, nextCursor: '9223372036854775807' });
    // Malformed input gets one fixed typed response with no echo of the input or database details.
    for (const query of ['after=', 'after=-1', 'after=01', 'after=1.5', 'after=1e3', 'after=0x1', 'after=9223372036854775808', 'after=99999999999999999999', 'after=1&after=2', 'after=%271%20OR%201%3D1', 'limit=0', 'limit=201', 'limit=abc', 'limit=1e2', 'limit=1&limit=2', 'cursor=1']) {
      const bad = await get(`/runs/${runId}/events/page?${query}`);
      assert.deepEqual([bad.status, bad.body], [400, { v: 1, code: 'invalid', message: 'Invalid event cursor or limit' }], query);
    }
    assert.equal((await get('/runs/not-a-uuid/events/page')).status, 400);
    assert.deepEqual([(await get(`/runs/${randomUUID()}/events/page`)).status, (await get(`/runs/${randomUUID()}/events/page`)).body.code], [404, 'not_found']);
    await assert.rejects(readEventPage(db.repo.pool, runId, '9223372036854775808'), InvalidEventPage);
    await assert.rejects(readEventPage(db.repo.pool, runId, undefined, 201), InvalidEventPage);
    // The unversioned array read is unchanged for existing callers.
    const legacy = await fetch(`${url}/runs/${runId}/events`);
    assert.equal(Array.isArray(await legacy.json()), true);
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await db.close();
  }
});

test('client merge and drain never coerce ids, keep accepted pages on failure and refuse non-advancing cursors', async () => {
  const row = (id: string) => ({ id, createdAt: '2026-09-29T12:00:00.000Z', event: { agent: 'worker', kind: 'synthetic', detail: {} } });
  const merged = appendNewerEvents([row('9007199254740992')], [row('9007199254740993'), row('9007199254740993'), row('9007199254740992'), row('9007199254740994')]);
  assert.deepEqual(merged.map(item => item.id), ['9007199254740992', '9007199254740993', '9007199254740994'], 'high ids stay distinct; duplicates and older rows are dropped');
  const same = [row('5')];
  assert.equal(appendNewerEvents(same, [row('5'), row('4')]), same, 'nothing newer keeps the same array');

  const original = globalThis.fetch;
  const requests: string[] = [];
  let script: (query: URLSearchParams) => { status?: number; body: unknown } = () => ({ body: {} });
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = new URL(String(input), 'http://fixture.invalid');
    requests.push(url.pathname + url.search);
    const { status = 200, body } = script(url.searchParams);
    return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
  try {
    const accepted: [string[], string | null][] = [];
    const accept = (items: { id: string | number }[], cursor: string | null) => accepted.push([items.map(item => String(item.id)), cursor]);
    // Second page fails: the first page and cursor were already accepted, and a retry starts after it.
    let failSecond = true;
    script = query => {
      const after = query.get('after');
      if (after === null) return { body: { items: [row('9007199254740993'), row('9007199254740994')], hasMore: true, nextCursor: '9007199254740994' } };
      if (failSecond) return { status: 503, body: { message: 'Synthetic page offline' } };
      return { body: { items: [row('9007199254740995')], hasMore: false, nextCursor: '9007199254740995' } };
    };
    await assert.rejects(drainEventPages(randomUUID(), null, accept), /Synthetic page offline/);
    assert.deepEqual(accepted, [[['9007199254740993', '9007199254740994'], '9007199254740994']]);
    failSecond = false;
    const before = requests.length;
    await drainEventPages('run', '9007199254740994', accept);
    assert.match(requests[before], /after=9007199254740994&?/);
    assert.equal(requests.length, before + 1);
    assert.deepEqual(accepted.at(-1), [['9007199254740995'], '9007199254740995']);

    // Malformed or non-advancing pages are errors, never loops or silent skips.
    script = () => ({ body: { items: [], hasMore: true, nextCursor: '7' } });
    await assert.rejects(drainEventPages('run', '7', accept), /did not advance/);
    script = () => ({ body: { items: [row('3')], hasMore: false, nextCursor: '3' } });
    await assert.rejects(drainEventPages('run', '9', accept), /backwards/);
    script = () => ({ body: { items: [{ ...row('1'), id: 1 }], hasMore: false, nextCursor: '1' } });
    await assert.rejects(drainEventPages('run', null, accept), /Unexpected response/);
    script = () => ({ body: { items: [{ ...row('01') }], hasMore: false, nextCursor: '01' } });
    await assert.rejects(drainEventPages('run', null, accept), /Unexpected response/);
    // A superseded caller stops before asking for another page.
    let calls = 0;
    script = () => ({ body: { items: [row(String(++calls))], hasMore: true, nextCursor: String(calls) } });
    let allowed = 4; // proceed() is consulted before each request and again after each response
    await drainEventPages('run', null, accept, () => allowed-- > 0);
    assert.equal(calls, 2);
  } finally { globalThis.fetch = original; }
});
