import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Session, TargetFailure, TurnFailure } from '../apps/worker/src/session.js';
import { fixture, users } from './support.js';

test('302 login retains cookie, chart, CSRF conversation and fresh tickets; fallback is observed', async () => {
  const toy = fixture({ mode: 'fallback' }); const base = await toy.start();
  try {
    const session = new Session(base, users.userA); assert.equal(await session.open(), 'toy-v1');
    assert.equal((await session.turn('first', 1)).observation.status, 'fallback');
    assert.match((await session.turn('second', 2)).observation.response, /Synthetic assistant response/); await session.close();
    assert.ok(toy.requests.some(r => r.path.includes('dynamic_finder_ajax.php') && r.path.includes('sSearch=SYN-900001') && r.cookie.includes('session=example')));
    assert.ok(toy.requests.some(r => r.path.includes('set_pid=42') && r.cookie.includes('session=example')));
    assert.deepEqual(toy.requests.filter(r => r.path.includes('/turns')).map(r => r.ticket), ['ticket-1', 'ticket-2']);
    assert.ok(toy.requests.some(r => r.path.includes('session.php') && r.cookie.includes('session=example')));
  } finally { await toy.close(); }
});
test('patient finder fails closed before chart selection on missing, ambiguous, mismatched or malformed pubpid result', async () => {
  for (const lookup of ['missing', 'ambiguous', 'mismatch', 'malformed', 'unavailable'] as const) {
    const toy = fixture({ lookup }); const url = await toy.start();
    try {
      await assert.rejects(new Session(url, users.userA).open(), (e: unknown) => e instanceof TargetFailure && e.kind === 'blocked');
      assert.equal(toy.requests.some(r => r.path.includes('set_pid=') || r.path.includes('ticket.php')), false);
    } finally { await toy.close(); }
  }
});
test('200 login and closed chart block, not safe', async () => {
  for (const options of [{ login: 200 }, { session: false }]) {
    const toy = fixture(options); const url = await toy.start();
    try { await assert.rejects(new Session(url, users.userA).open(), (e: unknown) => e instanceof TargetFailure && e.kind === 'blocked'); }
    finally { await toy.close(); }
  }
});
test('proven unprocessed turn retries once with a new ticket; ambiguous does not replay', async () => {
  for (const mode of ['retry', 'ambiguous'] as const) {
    const toy = fixture({ mode }); const url = await toy.start();
    try {
      const session = new Session(url, users.userA); await session.open();
      if (mode === 'retry') assert.deepEqual((await session.turn('hello', 1)).attempts.map(a => a.outcome), ['unprocessed', 'observed']);
      else await assert.rejects(session.turn('hello', 1), (e: unknown) => e instanceof TurnFailure && e.attempts.length === 1);
      assert.equal(toy.requests.filter(r => r.path.includes('/turns')).length, mode === 'retry' ? 2 : 1);
      await session.close();
    } finally { await toy.close(); }
  }
});
test('accepted turn reports exact UTC send/receive times; a proven-unprocessed first attempt and an ambiguous turn expose none', async () => {
  const toy = fixture({ mode: 'retry' }); const url = await toy.start();
  const posts: { start: number; end: number }[] = [];
  const transport: typeof fetch = async (input, init) => {
    if (!String(input).includes('/turns')) return fetch(input, init);
    const start = Date.now(); const response = await fetch(input, init); posts.push({ start, end: Date.now() }); return response;
  };
  try {
    const session = new Session(url, users.userA, transport); await session.open();
    const { timing, attempts } = await session.turn('hello', 1);
    assert.deepEqual(attempts.map(a => a.outcome), ['unprocessed', 'observed']);
    assert.match(timing.sentAt, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/); assert.match(timing.receivedAt, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
    assert.ok(Date.parse(timing.sentAt) >= posts[0].end - 1, 'the discarded first attempt does not supply the window');
    assert.ok(Date.parse(timing.sentAt) <= posts[1].start && Date.parse(timing.receivedAt) >= posts[1].end - 1 && timing.sentAt <= timing.receivedAt);
    await session.close();
  } finally { await toy.close(); }
  const ambiguous = fixture({ mode: 'ambiguous' }); const base = await ambiguous.start();
  try {
    const session = new Session(base, users.userA); await session.open();
    await assert.rejects(session.turn('hello', 1), (e: unknown) => e instanceof TurnFailure && !('timing' in e));
    await session.close();
  } finally { await ambiguous.close(); }
});
