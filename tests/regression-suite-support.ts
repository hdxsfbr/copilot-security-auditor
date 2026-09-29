import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { modelFixture } from './support.js';
import { local, type Db } from './finding-reports-support.js';
import { createApp } from '../apps/api/src/app.js';

export type Call = (method: string, path: string, body?: unknown) => Promise<{ status: number; json: any }>;
// The model fixture only answers the local model catalog, so preflight is real but no inference or paid call happens anywhere.
export async function serve(db: Db, work: (call: Call, judge: { roles: { judge: typeof local }; ollamaUrl: string }) => Promise<void>) {
  const model = modelFixture('safe'), ollamaUrl = await model.start();
  const server = createApp(db.repo).listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
  try { await work(async (method, path, body) => { const response = await fetch(`${base}${path}`, { method, ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }) }); return { status: response.status, json: await response.json() }; }, { roles: { judge: local }, ollamaUrl }); }
  finally { await new Promise<void>(resolve => server.close(() => resolve())); await model.close(); }
}
export const rows = async (db: Db, sql: string, params: unknown[] = []) => (await db.repo.pool.query(sql, params)).rows;
export const identityOf = async (db: Db, candidateId: string) => (await rows(db, 'SELECT identity_id FROM regressions WHERE candidate_id=$1', [candidateId]))[0].identity_id as string;
export const finishRun = async (db: Db, runId: string, outcome: string, version?: string) => {
  const lease = (await db.repo.claim('execution'))!;
  assert.equal(lease.id, runId);
  if (version) await db.repo.append(runId, lease.lease_generation, { v: 1, agent: 'worker', kind: 'session', detail: {} }, version);
  await db.repo.finish(runId, lease.lease_generation, outcome as never);
};
// The suite item that is currently running, if any.
export const runningOf = async (db: Db, suiteId: string) => (await rows(db, "SELECT ordinal,run_id FROM regression_suite_items WHERE suite_id=$1 AND state='running'", [suiteId]))[0] as { ordinal: number; run_id: string } | undefined;
export const reservation = async (db: Db, targetId: string) => (await rows(db, 'SELECT active_run_id FROM targets WHERE id=$1', [targetId]))[0].active_run_id as string | null;

// An ordinary (non-suite) run of a replay case, as an operator or schedule would launch it, finished with the outcome and version given.
export const plainRun = async (db: Db, targetId: string, caseId: string, outcome: string, version?: string) => {
  const started = await db.repo.start({ targetId, caseId, roles: { judge: local }, ollamaUrl: 'http://ollama.fixture/' });
  assert.ok(started && 'id' in started);
  await finishRun(db, started.id, outcome, version);
  return started.id;
};
