import { createHash, randomUUID } from 'node:crypto';
import type pg from 'pg';
import { caseInput, type CaseInput } from '../../../packages/contracts/src/index.js';
import { regressionNormalizationVersion, type CanonicalAttack, type RegressionIdentityDetail, type RegressionIdentityList, type RegressionIdentityQuery, type ReplaySignal, type ReplayTrigger } from '../../../packages/contracts/src/regressions.js';

type Db = pg.Pool | pg.PoolClient;

// Normalization v1. Two definitions share an identity exactly when these fields are equal after the steps below.
// Compared:  category (absent stays absent), user slot, and for every action in order its kind and message; an attachment
//            action also keeps its document type and artifact id (lower-cased), so different attachments never merge.
// Message:   Unicode NFC; CRLF/CR become LF; runs of blanks inside a line collapse to one space; each line and the whole
//            message are trimmed. Line breaks, letter case, punctuation, zero-width and other invisible characters are kept:
//            they can be the attack itself, so a variant that differs only there stays a distinct identity.
// Tokens:    `{{OTHER_PATIENT_ID}}` is the only placeholder the executor substitutes, and only for cross_patient cases, so
//            it is compared as written. Near-variants ({{ OTHER_PATIENT_ID }}, other case) are sent literally by the
//            executor and are therefore different attacks, not equivalent ones. Resolved patient ids stay distinct too.
// Ignored:   title, expected safe behavior, checks and rubric. They describe or judge an attack; they do not change what is sent.
// Never merged: different categories, users, action order or count, kinds, messages, or artifact ids. Byte-identical PDFs that
//            were uploaded as separate artifacts are separate identities in v1: identity is by artifact id, not content hash.
// A false split only costs an extra identity a person can read; a false merge would hide evidence, so v1 errs toward splitting.
export const normalizeMessage = (text: string) => text.normalize('NFC').replace(/\r\n?/g, '\n').split('\n').map(line => line.replace(/[^\S\n]+/g, ' ').trim()).join('\n').trim();
export function normalizeAttack(definition: CaseInput): CanonicalAttack {
  return { v: regressionNormalizationVersion, category: definition.category ?? null, user: definition.user, actions: definition.actions.map(action => action.kind === 'attach_pdf'
    ? { kind: action.kind, message: normalizeMessage(action.message), documentType: action.documentType, artifactId: action.artifactId.toLowerCase() }
    : { kind: action.kind, message: normalizeMessage(action.message) }) };
}
export const attackFingerprint = (definition: CaseInput) => {
  const attack = normalizeAttack(definition);
  return createHash('sha256').update(JSON.stringify(['regression-identity', attack.v, attack.category, attack.user,
    attack.actions.map(action => action.kind === 'attach_pdf' ? [action.kind, action.message, action.documentType, action.artifactId] : [action.kind, action.message])])).digest('hex');
};

// Attaches one regressions row to the identity its definition normalizes to, creating the identity for the first finding
// that has it. Idempotent. A definition that cannot be normalized records why and stays unlinked.
async function linkRow(db: pg.PoolClient, row: { id: string; candidate_id: string; definition: unknown }): Promise<string | null> {
  const parsed = caseInput.safeParse(row.definition);
  if (!parsed.success) {
    await db.query("UPDATE regressions SET identity_unlinked_reason='invalid_definition' WHERE id=$1 AND identity_id IS NULL", [row.id]);
    return null;
  }
  const attack = normalizeAttack(parsed.data), fingerprint = attackFingerprint(parsed.data);
  await db.query('INSERT INTO regression_identities(id,normalization_version,fingerprint,category,user_slot,canonical,first_seen_candidate_id) VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (normalization_version,fingerprint) DO NOTHING',
    [randomUUID(), attack.v, fingerprint, attack.category, attack.user, attack, row.candidate_id]);
  const identity = (await db.query('SELECT id FROM regression_identities WHERE normalization_version=$1 AND fingerprint=$2', [attack.v, fingerprint])).rows[0].id as string;
  await db.query('UPDATE regressions SET identity_id=$2 WHERE id=$1', [row.id, identity]);
  return identity;
}
export async function linkRegressionIdentity(db: pg.PoolClient, candidateId: string) {
  const row = (await db.query('SELECT id,candidate_id,definition,identity_id FROM regressions WHERE candidate_id=$1', [candidateId])).rows[0];
  if (!row) return null;
  return row.identity_id ?? await linkRow(db, row);
}

// Every run of a regression's replay case is a replay of that regression, on whichever target it was launched against.
export async function recordReplayLaunch(db: pg.PoolClient, run: { id: string; targetId: string; caseId: string }, trigger: ReplayTrigger = 'manual') {
  const unlinked = (await db.query('SELECT id,candidate_id,definition FROM regressions WHERE replay_case_id=$1 AND identity_id IS NULL AND identity_unlinked_reason IS NULL', [run.caseId])).rows;
  for (const row of unlinked) await linkRow(db, row);
  await db.query('INSERT INTO regression_replays(id,identity_id,regression_id,replay_case_id,run_id,target_id,trigger) SELECT $1,g.identity_id,g.id,g.replay_case_id,$2,$3,$5 FROM regressions g WHERE g.replay_case_id=$4 AND g.identity_id IS NOT NULL ON CONFLICT (run_id) DO NOTHING',
    [randomUUID(), run.id, run.targetId, run.caseId, trigger]);
}
// Called wherever a run reaches 'finished' (completed, stopped in the queue, lease expired): records the version and outcome
// the run actually ended with. A run that never observed a version keeps NULL rather than inheriting one.
export async function settleReplay(db: pg.PoolClient, runId: string) {
  await db.query("UPDATE regression_replays l SET target_version=r.version,outcome=r.outcome,finished_at=r.finished_at FROM runs r WHERE l.run_id=r.id AND r.id=$1 AND r.status='finished'", [runId]);
}

const backfilled = new WeakSet<pg.Pool>();
// Links legacy regressions in creation order and adopts pre-lineage replays of their replay cases as 'unrecorded'.
// Safe to repeat and to run concurrently; it never changes a row that is already linked.
export async function backfillRegressionIdentities(pool: pg.Pool, force = false) {
  if (backfilled.has(pool) && !force) return;
  for (;;) {
    const db = await pool.connect();
    try {
      await db.query('BEGIN');
      await db.query('SELECT pg_advisory_xact_lock(728451904)');
      const rows = (await db.query('SELECT id,candidate_id,definition FROM regressions WHERE identity_id IS NULL AND identity_unlinked_reason IS NULL ORDER BY created_at,id LIMIT 200')).rows;
      for (const row of rows) await linkRow(db, row);
      if (rows.length < 200) {
        await db.query(`INSERT INTO regression_replays(id,identity_id,regression_id,replay_case_id,run_id,target_id,target_version,outcome,trigger,created_at,finished_at)
          SELECT gen_random_uuid(),g.identity_id,g.id,g.replay_case_id,r.id,r.target_id,CASE WHEN r.status='finished' THEN r.version END,CASE WHEN r.status='finished' THEN r.outcome END,'unrecorded',r.created_at,CASE WHEN r.status='finished' THEN r.finished_at END
          FROM regressions g JOIN runs r ON r.case_id=g.replay_case_id WHERE g.identity_id IS NOT NULL AND g.replay_case_id IS NOT NULL ON CONFLICT (run_id) DO NOTHING`);
      }
      await db.query('COMMIT');
      if (rows.length < 200) break;
    } catch (error) { await db.query('ROLLBACK'); throw error; } finally { db.release(); }
  }
  backfilled.add(pool);
}

// A finished replay only ever supports "no violation observed" when it finished safe; everything uncertain is unknown.
export const signalFor = (status: string, outcome: string | null): ReplaySignal => status !== 'finished' ? 'in_progress'
  : outcome === 'safe' ? 'no_violation_observed' : outcome === 'pending_review' || outcome === 'auto_confirm' ? 'violation_observed' : 'unknown';

const sourceSql = `SELECT g.identity_id,g.id AS "regressionId",g.candidate_id AS "findingId",c.state,c.run_id AS "runId",c.adaptive_case_id AS "executionCaseId",
  CASE WHEN c.adaptive_case_id IS NULL THEN r.case_id ELSE ac.source_case_id END AS "sourceCaseId",g.replay_case_id AS "replayCaseId",
  r.target_id AS "targetId",r.target_snapshot->>'name' AS "targetName",r.version AS "targetVersion",g.created_at AS "createdAt",
  row_number() OVER (PARTITION BY g.identity_id ORDER BY g.created_at,g.id) AS n
  FROM regressions g JOIN candidates c ON c.id=g.candidate_id JOIN runs r ON r.id=g.source_run_id LEFT JOIN adaptive_cases ac ON ac.id=c.adaptive_case_id
  WHERE g.identity_id=ANY($1::uuid[])`;
const replaySql = `SELECT l.id,l.identity_id,l.run_id AS "runId",l.regression_id AS "regressionId",g.candidate_id AS "findingId",l.replay_case_id AS "replayCaseId",l.target_id AS "targetId",
  r.target_snapshot->>'name' AS "targetName",COALESCE(l.target_version,r.version) AS "targetVersion",r.status,
  COALESCE(l.outcome,CASE WHEN r.status='finished' THEN r.outcome END) AS outcome,l.trigger,l.created_at AS "createdAt",COALESCE(l.finished_at,r.finished_at) AS "finishedAt"
  FROM regression_replays l JOIN runs r ON r.id=l.run_id JOIN regressions g ON g.id=l.regression_id`;
type Row = Record<string, any>;
const withSignal = (row: Row) => ({ ...row, signal: signalFor(row.status, row.outcome) });
const group = (rows: Row[]) => { const map = new Map<string, Row[]>(); for (const { identity_id, ...row } of rows) map.set(identity_id, [...map.get(identity_id) ?? [], row]); return map; };

async function hydrate(db: Db, identities: Row[], sourceCap: number, replayCap: number | null) {
  if (!identities.length) return [];
  const ids = identities.map(row => row.id as string);
  const sources = group((await db.query(`SELECT * FROM (${sourceSql}) s WHERE n<=$2 ORDER BY identity_id,n`, [ids, sourceCap])).rows.map(({ n, ...row }) => row));
  const counts = new Map((await db.query('SELECT i.id,(SELECT count(*) FROM regressions g WHERE g.identity_id=i.id)::int AS sources,(SELECT count(*) FROM regression_replays l WHERE l.identity_id=i.id)::int AS replays FROM regression_identities i WHERE i.id=ANY($1::uuid[])', [ids])).rows.map(row => [row.id, row]));
  // The newest replay per (target, recorded version); a version-less replay is its own scope, not merged into a versioned one.
  const latest = group((await db.query(`SELECT * FROM (SELECT *,row_number() OVER (PARTITION BY identity_id ORDER BY "createdAt" DESC,id DESC) AS n FROM (
      SELECT DISTINCT ON (x.identity_id,x."targetId",COALESCE(x."targetVersion",'')) x.* FROM (${replaySql} WHERE l.identity_id=ANY($1::uuid[])) x
      ORDER BY x.identity_id,x."targetId",COALESCE(x."targetVersion",''),x."createdAt" DESC,x.id DESC) d) e WHERE n<=20 ORDER BY identity_id,"createdAt" DESC,id DESC`, [ids])).rows.map(({ n, ...row }) => withSignal(row)));
  const replays = replayCap === null ? new Map() : group((await db.query(`SELECT * FROM (SELECT x.*,row_number() OVER (PARTITION BY x.identity_id ORDER BY x."createdAt" DESC,x.id DESC) AS n FROM (${replaySql} WHERE l.identity_id=ANY($1::uuid[])) x) y WHERE n<=$2 ORDER BY identity_id,n`, [ids, replayCap])).rows.map(({ n, ...row }) => withSignal(row)));
  return identities.map(row => {
    const { seq, canonical, first_seen_candidate_id, normalization_version, user_slot, created_at, ...rest } = row;
    return { ...rest, normalizationVersion: normalization_version, user: user_slot, createdAt: created_at, firstSeenFindingId: first_seen_candidate_id, canonical,
      sourceFindingCount: counts.get(row.id)?.sources ?? 0, replayCount: counts.get(row.id)?.replays ?? 0, sourceFindings: sources.get(row.id) ?? [], latestReplays: latest.get(row.id) ?? [], replays: replays.get(row.id) ?? [] };
  });
}
const identitySql = `SELECT i.id,i.seq,i.normalization_version,i.fingerprint,i.category,i.user_slot,i.canonical,i.first_seen_candidate_id,i.created_at,
  (SELECT g.definition->>'title' FROM regressions g WHERE g.candidate_id=i.first_seen_candidate_id) AS title FROM regression_identities i`;

export async function listRegressionIdentities(pool: pg.Pool, query: RegressionIdentityQuery): Promise<RegressionIdentityList> {
  await backfillRegressionIdentities(pool);
  const rows = (await pool.query(`${identitySql} WHERE ($2::bigint IS NULL OR i.seq<$2::bigint) AND ($3::text IS NULL OR i.category=$3)
    AND ($4::uuid IS NULL OR EXISTS (SELECT 1 FROM regressions g JOIN runs r ON r.id=g.source_run_id WHERE g.identity_id=i.id AND r.target_id=$4)
      OR EXISTS (SELECT 1 FROM regression_replays l WHERE l.identity_id=i.id AND l.target_id=$4)) ORDER BY i.seq DESC LIMIT $1`,
    [query.limit + 1, query.cursor ?? null, query.category ?? null, query.targetId ?? null])).rows;
  const page = rows.slice(0, query.limit);
  const items = (await hydrate(pool, page, 20, null)).map(({ canonical, replays, ...item }) => ({ ...item, actionCount: canonical.actions.length,
    attachmentCount: canonical.actions.filter((action: { kind: string }) => action.kind === 'attach_pdf').length, firstMessage: String(canonical.actions[0].message).slice(0, 160) }));
  const unlinked = (await pool.query(`SELECT g.id AS "regressionId",g.candidate_id AS "findingId",g.identity_unlinked_reason AS reason,count(*) OVER ()::int AS count FROM regressions g
    WHERE g.identity_id IS NULL AND g.identity_unlinked_reason IS NOT NULL ORDER BY g.created_at,g.id LIMIT 20`)).rows;
  return { v: 1, items, nextCursor: rows.length > query.limit ? String(page.at(-1)!.seq) : null,
    unlinked: { count: unlinked[0]?.count ?? 0, items: unlinked.map(({ count, ...row }) => row) } } as RegressionIdentityList;
}
export async function regressionIdentityLineage(pool: pg.Pool, id: string): Promise<RegressionIdentityDetail | null> {
  await backfillRegressionIdentities(pool);
  const row = (await pool.query(`${identitySql} WHERE i.id=$1`, [id])).rows[0];
  if (!row) return null;
  const [identity] = await hydrate(pool, [row], 200, 501);
  const { replays, ...rest } = identity;
  return { v: 1, ...rest, replays: replays.slice(0, 500), replaysTruncated: replays.length > 500 } as RegressionIdentityDetail;
}
