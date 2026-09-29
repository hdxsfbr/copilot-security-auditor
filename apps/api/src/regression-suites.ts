import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { modelAssignment } from '../../../packages/contracts/src/index.js';
import type { Snapshot } from '../../worker/src/models.js';
import type { SuiteDetail, SuiteLaunch, SuiteList, SuiteQuery, SuiteSettings, VersionTrigger } from '../../../packages/contracts/src/regression-suites.js';
import { backfillRegressionIdentities, signalFor } from './regression-identity.js';
import type { Repository } from './repository.js';

// G02 suite execution. A suite is a row plus one item per identity, each snapshotting the replay definition it will run.
// Items run strictly one at a time: an item is dispatched with the ordinary `Repository.start` (target reservation, paid-call
// ledger, replay lineage with trigger 'suite' or 'version_change'), and its launch and the item's `running` mark are one
// transaction, so an item can never be dispatched twice. When a run finishes, is stopped in the queue or loses its lease, the
// same transaction settles the item with the outcome and version that run actually recorded, and afterwards the next item is
// dispatched. A run that ends blocked or incomplete is kept as such and is NEVER re-run. If the target is reserved by someone
// else the suite waits (the API scheduler tick retries); when its time budget passes, or it is stopped, the rest are skipped
// with a reason. Nothing in this module deploys, patches or contacts a target; runs do that only through the normal worker.
type Db = pg.Pool | pg.PoolClient;
class ItemTaken extends Error {}
// jsonb does not keep key order; the launch compares the recorded roles with the assignment as validated, so re-validate on read.
const snapshotOf = (stored: unknown) => { const value = stored as Snapshot; return { ...value, roles: { judge: modelAssignment.parse(value.roles.judge) } } as Snapshot; };
export const suiteRunTrigger = (trigger: string) => trigger === 'manual' ? 'suite' as const : 'version_change' as const;

// Called inside the transaction of every place a run reaches 'finished' (beside settleReplay).
export async function settleSuiteRun(db: pg.PoolClient, runId: string) {
  await db.query("UPDATE regression_suite_items i SET state='finished',outcome=r.outcome,target_version=r.version,finished_at=r.finished_at FROM runs r WHERE i.run_id=r.id AND r.id=$1 AND r.status='finished' AND i.state='running'", [runId]);
}

const summarySql = `SELECT s.id,s.seq,s.target_id AS "targetId",t.name AS "targetName",s.trigger,s.expected_version AS "expectedVersion",s.state,s.created_at AS "createdAt",s.finished_at AS "finishedAt",
  s.max_minutes AS "maxMinutes",s.omitted_count AS "omittedCount",
  (SELECT jsonb_build_object('pending',count(*) FILTER (WHERE state='pending'),'running',count(*) FILTER (WHERE state='running'),'finished',count(*) FILTER (WHERE state='finished'),'skipped',count(*) FILTER (WHERE state='skipped')) FROM regression_suite_items WHERE suite_id=s.id) AS counts,
  COALESCE((SELECT jsonb_object_agg(outcome,n) FROM (SELECT outcome,count(*)::int AS n FROM regression_suite_items WHERE suite_id=s.id AND outcome IS NOT NULL GROUP BY outcome) o),'{}'::jsonb) AS outcomes
  FROM regression_suites s JOIN targets t ON t.id=s.target_id`;

export class RegressionSuites {
  constructor(private readonly repo: Repository) {}
  private get pool() { return this.repo.pool; }

  // Selects identities (explicit, or every one seen on the target), snapshots each replay definition and records the suite.
  async create(input: SuiteLaunch, models: Snapshot, trigger: 'manual' | 'version_change' = 'manual'): Promise<{ status: 'created'; id: string } | { status: 'not_found' | 'empty' | 'duplicate' } | { status: 'reserved'; activeRunId: string }> {
    const target = (await this.pool.query('SELECT id,active_run_id FROM targets WHERE id=$1', [input.targetId])).rows[0];
    if (!target) return { status: 'not_found' };
    if (trigger === 'manual' && target.active_run_id) return { status: 'reserved', activeRunId: target.active_run_id };
    await backfillRegressionIdentities(this.pool);
    let ids: string[];
    if (input.selection.mode === 'identities') {
      ids = input.selection.identityIds;
      if ((await this.pool.query('SELECT count(*)::int AS n FROM regression_identities WHERE id=ANY($1::uuid[])', [ids])).rows[0].n !== ids.length) return { status: 'not_found' };
    } else ids = (await this.pool.query(`SELECT i.id FROM regression_identities i WHERE EXISTS (SELECT 1 FROM regressions g JOIN runs r ON r.id=g.source_run_id WHERE g.identity_id=i.id AND r.target_id=$1)
      OR EXISTS (SELECT 1 FROM regression_replays l WHERE l.identity_id=i.id AND l.target_id=$1) ORDER BY i.seq`, [input.targetId])).rows.map(row => row.id as string);
    const taken = ids.slice(0, input.maxItems);
    if (!taken.length) return { status: 'empty' };
    const items: { identity: string; regression: string; caseId: string | null; definition: unknown }[] = [];
    for (const identity of taken) {
      const regression = (await this.pool.query('SELECT id FROM regressions WHERE identity_id=$1 ORDER BY created_at,id LIMIT 1', [identity])).rows[0].id as string;
      let caseId: string | null = null, definition: unknown = null;
      try {
        caseId = (await this.repo.selectRegression(regression))?.caseId ?? null;
        definition = caseId ? (await this.pool.query("SELECT definition FROM cases WHERE id=$1 AND state='published'", [caseId])).rows[0]?.definition ?? null : null;
      } catch { /* the item is recorded as skipped below; nothing is invented for it */ }
      items.push({ identity, regression, caseId: definition ? caseId : null, definition });
    }
    const id = randomUUID(), { roles, ollamaUrl, openRouterCapUsd, maxItems, maxMinutes } = input;
    const db = await this.pool.connect();
    try {
      await db.query('BEGIN');
      await db.query('INSERT INTO regression_suites(id,target_id,trigger,expected_version,settings,model_snapshot,max_minutes,omitted_count) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
        [id, input.targetId, trigger, input.expectedVersion ?? null, { roles, ollamaUrl, openRouterCapUsd, maxItems, maxMinutes }, models, maxMinutes, ids.length - taken.length]);
      for (const [index, item] of items.entries()) await db.query('INSERT INTO regression_suite_items(id,suite_id,ordinal,identity_id,regression_id,replay_case_id,definition,state,reason) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)',
        [randomUUID(), id, index + 1, item.identity, item.regression, item.caseId, item.definition, item.definition ? 'pending' : 'skipped', item.definition ? null : 'replay_case_unavailable']);
      await db.query('COMMIT');
    } catch (error) {
      await db.query('ROLLBACK');
      if ((error as { code?: string }).code === '23505' && trigger === 'version_change') return { status: 'duplicate' };
      throw error;
    } finally { db.release(); }
    await this.advance(input.targetId);
    return { status: 'created', id };
  }

  // Dispatches at most one item per call, oldest active suite first; safe to call from anywhere, any number of times.
  async advance(targetId: string) {
    for (const { id } of (await this.pool.query("SELECT id FROM regression_suites WHERE target_id=$1 AND state='active' ORDER BY seq", [targetId])).rows) if (await this.dispatchNext(id as string) !== 'done') return;
  }
  private skip(itemId: string, reason: string) { return this.pool.query("UPDATE regression_suite_items SET state='skipped',reason=$2 WHERE id=$1 AND state='pending'", [itemId, reason]); }
  private async dispatchNext(id: string): Promise<'dispatched' | 'waiting' | 'done'> {
    for (;;) {
      const suite = (await this.pool.query("SELECT * FROM regression_suites WHERE id=$1 AND state='active'", [id])).rows[0];
      if (!suite) return 'done';
      const open = (await this.pool.query("SELECT id,state,replay_case_id,definition FROM regression_suite_items WHERE suite_id=$1 AND state IN ('pending','running') ORDER BY ordinal", [id])).rows;
      if (open.some(item => item.state === 'running')) return 'waiting';
      const next = open[0], expired = Date.now() >= new Date(suite.created_at).getTime() + suite.max_minutes * 60000;
      if (!next || suite.stop_requested || expired) {
        await this.pool.query("UPDATE regression_suite_items SET state='skipped',reason=$2 WHERE suite_id=$1 AND state='pending'", [id, suite.stop_requested ? 'suite_stopped' : 'suite_time_budget_exhausted']);
        await this.pool.query("UPDATE regression_suites SET state=CASE WHEN stop_requested THEN 'stopped' ELSE 'completed' END,finished_at=now() WHERE id=$1 AND state='active' AND NOT EXISTS (SELECT 1 FROM regression_suite_items WHERE suite_id=$1 AND state IN ('pending','running'))", [id]);
        return 'done';
      }
      const current = (await this.pool.query("SELECT definition FROM cases WHERE id=$1 AND state='published'", [next.replay_case_id])).rows[0];
      if (!current || JSON.stringify(current.definition) !== JSON.stringify(next.definition)) { await this.skip(next.id, 'replay_definition_changed_or_archived'); continue; }
      const settings = suite.settings as SuiteSettings;
      try {
        const started = await this.repo.start({ targetId: suite.target_id, caseId: next.replay_case_id, roles: settings.roles, ...(settings.ollamaUrl ? { ollamaUrl: settings.ollamaUrl } : {}), ...(settings.openRouterCapUsd !== undefined ? { openRouterCapUsd: settings.openRouterCapUsd } : {}) },
          snapshotOf(suite.model_snapshot), undefined, { replayTrigger: suiteRunTrigger(suite.trigger), afterLaunch: async (db, runId) => {
            if (!(await db.query("UPDATE regression_suite_items SET state='running',run_id=$2,started_at=now() WHERE id=$1 AND state='pending' RETURNING id", [next.id, runId])).rowCount) throw new ItemTaken();
          } });
        if (started && 'active_run_id' in started) return 'waiting'; // another run holds the target; the tick or that run's finish retries
        if (started) return 'dispatched';
        await this.skip(next.id, 'target_or_case_unavailable');
      } catch (error) {
        if (error instanceof ItemTaken) return 'waiting';
        await this.skip(next.id, 'launch_rejected'); // the launch is one transaction, so no run exists for this item; it is not retried
      }
    }
  }
  // After any run settles: fire the opt-in version-change trigger for a newly verified version, then dispatch the next item.
  async afterSettle(runId: string) {
    try {
      const run = (await this.pool.query("SELECT target_id,version FROM runs WHERE id=$1 AND status='finished'", [runId])).rows[0];
      if (!run) return;
      if (run.version) await this.observeVersion(run.target_id, run.version);
      await this.advance(run.target_id);
    } catch { console.error('Regression suite advance failed (details suppressed)'); }
  }
  async sweep() {
    try { for (const row of (await this.pool.query("SELECT DISTINCT target_id FROM regression_suites WHERE state='active'")).rows) await this.advance(row.target_id); }
    catch { console.error('Regression suite sweep failed (details suppressed)'); }
  }
  // Exactly one finished run can move last_seen_version to a new value; the unique (target, version) index backs that up.
  private async observeVersion(targetId: string, version: string) {
    const claimed = (await this.pool.query('UPDATE regression_version_triggers SET last_seen_version=$2,updated_at=now() WHERE target_id=$1 AND enabled AND last_seen_version IS DISTINCT FROM $2 RETURNING settings,model_snapshot', [targetId, version])).rows[0];
    if (!claimed) return;
    const made = await this.create({ ...(claimed.settings as SuiteSettings), targetId, selection: { mode: 'all_confirmed' }, expectedVersion: version }, claimed.model_snapshot as Snapshot, 'version_change');
    if (made.status === 'created') await this.pool.query('UPDATE regression_version_triggers SET last_triggered_version=$2 WHERE target_id=$1', [targetId, version]);
  }

  async stop(id: string): Promise<SuiteDetail | null | 'finished'> {
    const db = await this.pool.connect();
    let runId: string | undefined, targetId: string;
    try {
      await db.query('BEGIN');
      const suite = (await db.query('SELECT state,target_id FROM regression_suites WHERE id=$1 FOR UPDATE', [id])).rows[0];
      if (!suite || suite.state !== 'active') { await db.query('ROLLBACK'); return suite ? 'finished' : null; }
      targetId = suite.target_id;
      await db.query('UPDATE regression_suites SET stop_requested=true WHERE id=$1', [id]);
      await db.query("UPDATE regression_suite_items SET state='skipped',reason='suite_stopped' WHERE suite_id=$1 AND state='pending'", [id]);
      runId = (await db.query("SELECT run_id FROM regression_suite_items WHERE suite_id=$1 AND state='running'", [id])).rows[0]?.run_id;
      await db.query('COMMIT');
    } catch (error) { await db.query('ROLLBACK'); throw error; } finally { db.release(); }
    if (runId) await this.repo.stop(runId); // releases a queued run's reservation now; a running one ends at the worker's next check
    await this.advance(targetId);
    return this.detail(id);
  }

  async list(query: SuiteQuery): Promise<SuiteList> {
    const rows = (await this.pool.query(`${summarySql} WHERE ($2::bigint IS NULL OR s.seq<$2::bigint) AND ($3::uuid IS NULL OR s.target_id=$3) ORDER BY s.seq DESC LIMIT $1`, [query.limit + 1, query.cursor ?? null, query.targetId ?? null])).rows;
    const page = rows.slice(0, query.limit);
    return { v: 1, items: page.map(({ seq, ...row }) => row), nextCursor: rows.length > query.limit ? String(page.at(-1)!.seq) : null } as SuiteList;
  }
  async detail(id: string): Promise<SuiteDetail | null> {
    const row = (await this.pool.query(`${summarySql} WHERE s.id=$1`, [id])).rows[0];
    if (!row) return null;
    const { seq, ...summary } = row;
    const settings = (await this.pool.query('SELECT settings FROM regression_suites WHERE id=$1', [id])).rows[0].settings;
    const items = (await this.pool.query(`SELECT i.ordinal,i.identity_id AS "identityId",g.definition->>'title' AS title,x.category,i.regression_id AS "regressionId",i.replay_case_id AS "replayCaseId",i.state,i.run_id AS "runId",
      i.outcome,i.target_version AS "targetVersion",i.reason,i.started_at AS "startedAt",i.finished_at AS "finishedAt"
      FROM regression_suite_items i JOIN regression_identities x ON x.id=i.identity_id JOIN regressions g ON g.id=i.regression_id WHERE i.suite_id=$1 ORDER BY i.ordinal`, [id])).rows;
    return { v: 1, ...summary, settings, items: items.map(item => ({ ...item, signal: item.state === 'running' ? 'in_progress' : item.state === 'finished' ? signalFor('finished', item.outcome) : null,
      versionCheck: item.state !== 'finished' ? null : !summary.expectedVersion ? 'not_requested' : item.targetVersion === null ? 'unverified' : item.targetVersion === summary.expectedVersion ? 'matches' : 'differs' })) } as SuiteDetail;
  }

  async triggers(): Promise<VersionTrigger[]> {
    return (await this.pool.query(`SELECT t.id AS "targetId",t.name AS "targetName",COALESCE(v.enabled,false) AS enabled,v.settings,v.last_seen_version AS "lastSeenVersion",v.last_triggered_version AS "lastTriggeredVersion",v.updated_at AS "updatedAt"
      FROM targets t LEFT JOIN regression_version_triggers v ON v.target_id=t.id ORDER BY t.created_at DESC,t.id`)).rows as VersionTrigger[];
  }
  // Opt-in only: enabling records the newest verified version as already seen, so it never fires retroactively.
  async setTrigger(targetId: string, settings: SuiteSettings | null, models?: Snapshot): Promise<VersionTrigger | null> {
    if (!(await this.pool.query('SELECT 1 FROM targets WHERE id=$1', [targetId])).rowCount) return null;
    if (settings) await this.pool.query(`INSERT INTO regression_version_triggers(target_id,enabled,settings,model_snapshot,last_seen_version) VALUES ($1,true,$2,$3,
      (SELECT version FROM runs WHERE target_id=$1 AND status='finished' AND version IS NOT NULL ORDER BY finished_at DESC LIMIT 1))
      ON CONFLICT (target_id) DO UPDATE SET enabled=true,settings=EXCLUDED.settings,model_snapshot=EXCLUDED.model_snapshot,last_seen_version=EXCLUDED.last_seen_version,updated_at=now()`, [targetId, settings, models]);
    else await this.pool.query('INSERT INTO regression_version_triggers(target_id,enabled) VALUES ($1,false) ON CONFLICT (target_id) DO UPDATE SET enabled=false,updated_at=now()', [targetId]);
    return (await this.triggers()).find(row => row.targetId === targetId) ?? null;
  }
}
