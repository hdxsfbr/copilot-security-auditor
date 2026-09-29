import { randomUUID, createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import pg from 'pg';
import { caseInput } from '../../../packages/contracts/src/index.js';
import type { AdaptiveStart, CaseInput, EvidenceEvent, Outcome, ScheduleInput, StartInput, TargetInput, TargetUpdateInput, Verdict } from '../../../packages/contracts/src/index.js';
import type { CheckResult } from '../../worker/src/checks.js';
import { legacyRoles, nanos, reserveAmount, type Role, type Snapshot, type ModelUsage } from '../../worker/src/models.js';
import { nextFire } from './schedule-time.js';
import { verifyArtifactFile, type ArtifactFileStatus } from './artifacts.js';

export type CandidateIntegrity = {
  status: 'complete' | 'missing' | 'corrupt' | 'unlinked' | 'invalid_definition' | 'unavailable';
  artifacts: { id: string; status: ArtifactFileStatus | 'unlinked' }[];
  checkedAt: string;
};
type CandidateEvidenceRow = {
  id: string;
  run_id: string;
  state: string;
  adaptive_case_id: string | null;
  export_approved_at: Date | null;
  version: string | null;
  outcome: string | null;
  definition: unknown;
  source_case_id: string | null;
};

function key() {
  const value = process.env.CREDENTIAL_KEY;
  if (!value || !/^[a-f0-9]{64}$/i.test(value)) throw new Error('CREDENTIAL_KEY must be 32 bytes of hex');
  return Buffer.from(value, 'hex');
}
export function encrypt(value: unknown) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key(), iv);
  const payload = Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), payload]).toString('base64');
}
export function decrypt<T>(value: string): T {
  const bytes = Buffer.from(value, 'base64');
  const decipher = createDecipheriv('aes-256-gcm', key(), bytes.subarray(0, 12));
  decipher.setAuthTag(bytes.subarray(12, 28));
  return JSON.parse(Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString()) as T;
}

export class Repository {
  constructor(readonly pool: pg.Pool) {}
  async schedules() { return (await this.pool.query('SELECT id,definition,next_fire_at AS "nextFireAt",paused,created_at AS "createdAt" FROM schedules WHERE NOT deleted ORDER BY created_at DESC')).rows; }
  async occurrences(scheduleId: string) { return (await this.pool.query('SELECT id,scheduled_for AS "scheduledFor",run_id AS "runId",state,reason FROM schedule_occurrences WHERE schedule_id=$1 ORDER BY scheduled_for DESC LIMIT 100', [scheduleId])).rows; }
  async isScheduled(runId: string) { return !!(await this.pool.query('SELECT 1 FROM schedule_occurrences WHERE run_id=$1', [runId])).rowCount; }
  async saveSchedule(input: ScheduleInput, models: Snapshot, now = new Date(), id?: string) {
    const run = input.run.input;
    const assigned = input.run.kind === 'selected' ? input.run.input.roles ?? legacyRoles(input.run.input.model!) : input.run.input.roles;
    if (!assigned || JSON.stringify(models.roles) !== JSON.stringify(assigned)) throw new Error('Model snapshot mismatch');
    for (const [role, selection] of Object.entries(assigned)) if (selection.provider === 'openrouter') {
      const price = models.pricing[role as Role];
      if (!price || !run.openRouterCapUsd) throw new Error('Verified pricing and paid cap required');
      reserveAmount(price, selection.maxOutputTokens);
    }
    const db = await this.pool.connect();
    try {
      await db.query('BEGIN');
      if (id && !(await db.query('SELECT 1 FROM schedules WHERE id=$1 AND NOT deleted FOR UPDATE', [id])).rowCount) { await db.query('ROLLBACK'); return null; }
      if (!(await db.query('SELECT 1 FROM targets WHERE id=$1', [run.targetId])).rowCount) throw new Error('Target unavailable');
      const ids = input.run.kind === 'selected' ? [input.run.input.caseId] : input.run.input.caseIds;
      const saved = await db.query('SELECT id,definition FROM cases WHERE id=ANY($1::uuid[])', [ids]);
      if (saved.rowCount !== ids.length) throw new Error('Case unavailable');
      if (input.run.kind === 'adaptive' && input.run.input.categories.some(c => !saved.rows.some(row => (row.definition.category ?? 'prompt_injection') === c))) throw new Error('Category has no seed case');
      for (const row of saved.rows) for (const action of (row.definition as CaseInput).actions) if (action.kind === 'attach_pdf' && !(await db.query('SELECT 1 FROM artifacts WHERE id=$2 AND document_type=$3 AND (case_id=$1 OR EXISTS (SELECT 1 FROM case_artifact_links WHERE case_id=$1 AND artifact_id=$2))', [row.id, action.artifactId, action.documentType])).rowCount) throw new Error('Artifact unavailable');
      const prepared = input.run.kind === 'selected' ? { ...input.run.input, case: saved.rows[0].definition } : { ollamaUrl: run.ollamaUrl, adaptive: { categories: input.run.input.categories, maxCases: input.run.input.maxCases, maxMinutes: input.run.input.maxMinutes, seeds: ids.map(caseId => ({ id: caseId, definition: saved.rows.find(row => row.id === caseId)!.definition })) } };
      const next = nextFire(input, now);
      const scheduleId = id ?? randomUUID();
      if (id) await db.query('UPDATE schedules SET definition=$2,run_snapshot=$3,model_snapshot=$4,next_fire_at=$5 WHERE id=$1', [id, input, prepared, models, next]);
      else await db.query('INSERT INTO schedules(id,definition,run_snapshot,model_snapshot,next_fire_at) VALUES ($1,$2,$3,$4,$5)', [scheduleId, input, prepared, models, next]);
      await db.query('COMMIT');
      return { id: scheduleId, nextFireAt: next.toISOString() };
    } catch (error) { await db.query('ROLLBACK'); throw error; } finally { db.release(); }
  }
  async scheduleState(id: string, paused: boolean, now = new Date()) {
    const db = await this.pool.connect();
    try {
      await db.query('BEGIN');
      const row = (await db.query('SELECT definition,next_fire_at FROM schedules WHERE id=$1 AND NOT deleted FOR UPDATE', [id])).rows[0];
      if (!row) { await db.query('ROLLBACK'); return null; }
      const next = !paused && new Date(row.next_fire_at) <= now ? nextFire(row.definition as ScheduleInput, now) : new Date(row.next_fire_at);
      await db.query('UPDATE schedules SET paused=$2,next_fire_at=$3 WHERE id=$1', [id, paused, next]);
      await db.query('COMMIT');
      return { id, paused, nextFireAt: next.toISOString() };
    } catch (error) { await db.query('ROLLBACK'); throw error; } finally { db.release(); }
  }
  async deleteSchedule(id: string) { return (await this.pool.query('UPDATE schedules SET deleted=true WHERE id=$1 AND NOT deleted RETURNING id', [id])).rowCount !== 0; }
  async tick(now = new Date()) {
    const processed: { id: string; state: string; runId?: string }[] = [];
    for (;;) {
      const db = await this.pool.connect();
      try {
        await db.query('BEGIN');
        const schedule = (await db.query('SELECT * FROM schedules WHERE NOT paused AND NOT deleted AND next_fire_at<=$1 AND NOT (id=ANY($2::uuid[])) ORDER BY next_fire_at FOR UPDATE SKIP LOCKED LIMIT 1', [now, processed.map(p => p.id)])).rows[0];
        if (!schedule) { await db.query('COMMIT'); break; }
        const due = new Date(schedule.next_fire_at);
        const next = nextFire(schedule.definition as ScheduleInput, now);
        const input = (schedule.definition as ScheduleInput).run.input;
        const target = (await db.query('SELECT id,name,base_url,active_run_id,user_a_credential,user_b_credential FROM targets WHERE id=$1 FOR UPDATE', [input.targetId])).rows[0];
        let state = 'queued', reason: string | null = null, runId: string | null = null;
        if (!target) { state = 'blocked'; reason = 'Target unavailable'; }
        else if (target.active_run_id) { state = 'skipped'; reason = `Target reserved by run ${target.active_run_id}`; }
        else {
          runId = randomUUID();
          const selected = (schedule.run_snapshot as { case?: CaseInput; adaptive?: unknown; ollamaUrl: string });
          await db.query('INSERT INTO runs(id,target_id,case_id,definition,target_snapshot,model_snapshot,paid_cap_nanos,adaptive) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)', [runId, target.id, selected.case ? (input as StartInput).caseId : null, selected.case ? selected : { ollamaUrl: selected.ollamaUrl }, { name: target.name, baseUrl: target.base_url, userARef: target.user_a_credential, userBRef: target.user_b_credential }, schedule.model_snapshot, input.openRouterCapUsd === undefined ? null : nanos(input.openRouterCapUsd).toString(), selected.adaptive ?? null]);
          await db.query('INSERT INTO jobs(run_id) VALUES ($1)', [runId]);
          await db.query('UPDATE targets SET active_run_id=$1 WHERE id=$2', [runId, target.id]);
        }
        await db.query('INSERT INTO schedule_occurrences(id,schedule_id,scheduled_for,run_id,state,reason) VALUES ($1,$2,$3,$4,$5,$6)', [randomUUID(), schedule.id, due, runId, state, reason]);
        await db.query('UPDATE schedules SET next_fire_at=$2 WHERE id=$1', [schedule.id, next]);
        await db.query('COMMIT');
        processed.push({ id: schedule.id, state, ...(runId ? { runId } : {}) });
      } catch (error) { await db.query('ROLLBACK'); throw error; } finally { db.release(); }
    }
    return processed;
  }
  async target(input: TargetInput) {
    const db = await this.pool.connect();
    try {
      await db.query('BEGIN');
      const a = randomUUID(), b = randomUUID(), id = randomUUID();
      await db.query('INSERT INTO credentials(id,ciphertext) VALUES ($1,$2),($3,$4)', [a, encrypt(input.userA), b, encrypt(input.userB)]);
      await db.query('INSERT INTO targets(id,name,base_url,user_a_credential,user_b_credential) VALUES ($1,$2,$3,$4,$5)', [id, input.name, input.baseUrl, a, b]);
      await db.query('COMMIT');
      return { id, name: input.name, baseUrl: input.baseUrl };
    } catch (e) { await db.query('ROLLBACK'); throw e; } finally { db.release(); }
  }
  async targetForEdit(id: string) {
    const row = (await this.pool.query('SELECT t.id,t.name,t.base_url AS "baseUrl",a.ciphertext AS user_a,b.ciphertext AS user_b FROM targets t JOIN credentials a ON a.id=t.user_a_credential JOIN credentials b ON b.id=t.user_b_credential WHERE t.id=$1', [id])).rows[0];
    if (!row) return null;
    const a = decrypt<{ username: string; pubpid?: string }>(row.user_a);
    const b = decrypt<{ username: string; pubpid?: string }>(row.user_b);
    return { id: row.id, name: row.name, baseUrl: row.baseUrl, userA: { username: a.username, pubpid: a.pubpid ?? '' }, userB: { username: b.username, pubpid: b.pubpid ?? '' } };
  }
  async updateTarget(id: string, input: TargetUpdateInput): Promise<{ id: string; name: string; baseUrl: string } | { active_run_id: string } | null> {
    const db = await this.pool.connect();
    try {
      await db.query('BEGIN');
      const target = (await db.query('SELECT active_run_id,user_a_credential,user_b_credential FROM targets WHERE id=$1 FOR UPDATE', [id])).rows[0];
      if (!target) { await db.query('ROLLBACK'); return null; }
      if (target.active_run_id) { await db.query('ROLLBACK'); return { active_run_id: target.active_run_id }; }
      const current = await db.query('SELECT id,ciphertext FROM credentials WHERE id=$1 OR id=$2', [target.user_a_credential, target.user_b_credential]);
      const passwords = new Map<string, string>(current.rows.map(row => [row.id, decrypt<{ password: string }>(row.ciphertext).password]));
      const userA = { ...input.userA, password: input.userA.password ?? passwords.get(target.user_a_credential) };
      const userB = { ...input.userB, password: input.userB.password ?? passwords.get(target.user_b_credential) };
      if (!userA.password || !userB.password) throw new Error('Missing stored target credential');
      const a = randomUUID(), b = randomUUID();
      await db.query('INSERT INTO credentials(id,ciphertext) VALUES ($1,$2),($3,$4)', [a, encrypt(userA), b, encrypt(userB)]);
      await db.query('UPDATE targets SET name=$2,base_url=$3,user_a_credential=$4,user_b_credential=$5 WHERE id=$1', [id, input.name, input.baseUrl, a, b]);
      await db.query('COMMIT');
      return { id, name: input.name, baseUrl: input.baseUrl };
    } catch (e) { await db.query('ROLLBACK'); throw e; } finally { db.release(); }
  }
  async targets() { return (await this.pool.query('SELECT id,name,base_url AS "baseUrl",active_run_id AS "activeRunId" FROM targets ORDER BY created_at DESC')).rows; }
  async createCase(input: CaseInput) {
    const id = randomUUID();
    await this.pool.query('INSERT INTO cases(id,definition) VALUES ($1,$2)', [id, input]);
    return { id, ...input };
  }
  async addArtifact(ref: { id: string; caseId: string; documentType: string; sha256: string; bytes: number; pages: number }) {
    await this.pool.query('INSERT INTO artifacts(id,case_id,document_type,sha256,bytes,pages) VALUES ($1,$2,$3,$4,$5,$6)', [ref.id, ref.caseId, ref.documentType, ref.sha256, ref.bytes, ref.pages]);
  }
  async artifact(caseId: string, id: string, type: string): Promise<{ bytes: number; sha256: string } | null> {
    return (await this.pool.query('SELECT bytes,sha256 FROM artifacts WHERE id=$2 AND document_type=$3 AND (case_id=$1 OR EXISTS (SELECT 1 FROM case_artifact_links WHERE case_id=$1 AND artifact_id=$2))', [caseId, id, type])).rows[0] ?? null;
  }
  async artifactRefs(): Promise<{ id: string; bytes: number; sha256: string }[]> {
    return (await this.pool.query('SELECT id,bytes,sha256 FROM artifacts ORDER BY id')).rows;
  }
  async cases(): Promise<(CaseInput & { id: string })[]> { return (await this.pool.query('SELECT id,definition FROM cases ORDER BY created_at DESC')).rows.map(r => ({ id: r.id as string, ...r.definition as CaseInput })); }
  async updateCase(id: string, definition: CaseInput) {
    const db = await this.pool.connect();
    try {
      await db.query('BEGIN');
      const row = (await db.query('SELECT id FROM cases WHERE id=$1 FOR UPDATE', [id])).rows[0];
      if (!row) { await db.query('ROLLBACK'); return null; }
      if ((await db.query('SELECT 1 FROM runs WHERE case_id=$1 LIMIT 1', [id])).rowCount) { await db.query('ROLLBACK'); return { conflict: true }; }
      for (const action of definition.actions) if (action.kind === 'attach_pdf' && !(await db.query('SELECT 1 FROM artifacts WHERE id=$2 AND document_type=$3 AND (case_id=$1 OR EXISTS (SELECT 1 FROM case_artifact_links WHERE case_id=$1 AND artifact_id=$2))', [id, action.artifactId, action.documentType])).rowCount) { await db.query('ROLLBACK'); return { invalid: true }; }
      await db.query('UPDATE cases SET definition=$2 WHERE id=$1', [id, definition]);
      await db.query('COMMIT');
      return { id, ...definition };
    } catch (e) { await db.query('ROLLBACK'); throw e; } finally { db.release(); }
  }
  async start(input: StartInput, models?: Snapshot): Promise<{ id: string; status: 'queued' } | { active_run_id: string } | null> {
    if (!input.roles && !input.model) throw new Error('A Judge model is required');
    const assigned = input.roles ?? legacyRoles(input.model!);
    if (Object.values(assigned).some(role => role.provider === 'openrouter') && (!models || !input.openRouterCapUsd)) throw new Error('Verified pricing and paid cap required');
    const modelSnapshot = models ?? { roles: assigned, pricing: {} };
    if (JSON.stringify(modelSnapshot.roles) !== JSON.stringify(assigned)) throw new Error('Model snapshot mismatch');
    for (const [role, selection] of Object.entries(assigned)) if (selection.provider === 'openrouter') {
      const price = modelSnapshot.pricing[role as Role];
      if (!price) throw new Error('Verified pricing required');
      reserveAmount(price, selection.maxOutputTokens);
    }
    const db = await this.pool.connect();
    try {
      await db.query('BEGIN');
      const target = (await db.query('SELECT id,name,base_url,active_run_id,user_a_credential,user_b_credential FROM targets WHERE id=$1 FOR UPDATE', [input.targetId])).rows[0];
      const selected = (await db.query('SELECT definition FROM cases WHERE id=$1', [input.caseId])).rows[0];
      if (!target || !selected) { await db.query('ROLLBACK'); return null; }
      if (target.active_run_id) { await db.query('ROLLBACK'); return { active_run_id: target.active_run_id }; }
      const definition = selected.definition as CaseInput;
      for (const action of definition.actions) if (action.kind === 'attach_pdf' && !(await db.query('SELECT 1 FROM artifacts WHERE id=$2 AND document_type=$3 AND (case_id=$1 OR EXISTS (SELECT 1 FROM case_artifact_links WHERE case_id=$1 AND artifact_id=$2))', [input.caseId, action.artifactId, action.documentType])).rowCount) throw new Error('Artifact not linked to selected case');
      const id = randomUUID();
      await db.query('INSERT INTO runs(id,target_id,case_id,definition,target_snapshot,model_snapshot,paid_cap_nanos) VALUES ($1,$2,$3,$4,$5,$6,$7)', [id, target.id, input.caseId, { ...input, case: selected.definition }, { name: target.name, baseUrl: target.base_url, userARef: target.user_a_credential, userBRef: target.user_b_credential }, modelSnapshot, input.openRouterCapUsd === undefined ? null : nanos(input.openRouterCapUsd).toString()]);
      await db.query('INSERT INTO jobs(run_id) VALUES ($1)', [id]);
      await db.query('UPDATE targets SET active_run_id=$1 WHERE id=$2', [id, target.id]);
      await db.query('COMMIT');
      return { id, status: 'queued' };
    } catch (e) { await db.query('ROLLBACK'); throw e; } finally { db.release(); }
  }
  async startAdaptive(input: AdaptiveStart, models: Snapshot): Promise<{ id: string; status: 'queued' } | { active_run_id: string } | null> {
    if (JSON.stringify(models.roles) !== JSON.stringify(input.roles)) throw new Error('Model snapshot mismatch');
    for (const [role, selection] of Object.entries(input.roles)) if (selection.provider === 'openrouter') {
      const price = models.pricing[role as Role];
      if (!price || !input.openRouterCapUsd) throw new Error('Verified pricing and paid cap required');
      reserveAmount(price, selection.maxOutputTokens);
    }
    const db = await this.pool.connect();
    try {
      await db.query('BEGIN');
      const target = (await db.query('SELECT id,name,base_url,active_run_id,user_a_credential,user_b_credential FROM targets WHERE id=$1 FOR UPDATE', [input.targetId])).rows[0];
      if (!target) { await db.query('ROLLBACK'); return null; }
      if (target.active_run_id) { await db.query('ROLLBACK'); return { active_run_id: target.active_run_id }; }
      const saved = await db.query('SELECT id,definition FROM cases WHERE id=ANY($1::uuid[])', [input.caseIds]);
      if (saved.rowCount !== input.caseIds.length || input.categories.some(c => !saved.rows.some(row => (row.definition.category ?? 'prompt_injection') === c))) throw new Error('Selected cases must cover every chosen category');
      for (const row of saved.rows) for (const action of (row.definition as CaseInput).actions) if (action.kind === 'attach_pdf' && !(await db.query('SELECT 1 FROM artifacts WHERE case_id=$1 AND id=$2 AND document_type=$3', [row.id, action.artifactId, action.documentType])).rowCount) throw new Error('Artifact not linked to selected case');
      const id = randomUUID();
      const seeds = input.caseIds.map(caseId => { const row = saved.rows.find(r => r.id === caseId)!; return { id: caseId, definition: row.definition as CaseInput }; });
      await db.query('INSERT INTO runs(id,target_id,definition,target_snapshot,model_snapshot,paid_cap_nanos,adaptive) VALUES ($1,$2,$3,$4,$5,$6,$7)', [id, target.id, { ollamaUrl: input.ollamaUrl }, { name: target.name, baseUrl: target.base_url, userARef: target.user_a_credential, userBRef: target.user_b_credential }, models, input.openRouterCapUsd === undefined ? null : nanos(input.openRouterCapUsd).toString(), { categories: input.categories, maxCases: input.maxCases, maxMinutes: input.maxMinutes, seeds }]);
      await db.query('INSERT INTO jobs(run_id) VALUES ($1)', [id]);
      await db.query('UPDATE targets SET active_run_id=$1 WHERE id=$2', [id, target.id]);
      await db.query('COMMIT');
      return { id, status: 'queued' };
    } catch (e) { await db.query('ROLLBACK'); throw e; } finally { db.release(); }
  }
  async stop(id: string) {
    return (await this.pool.query("UPDATE runs SET stop_requested=true WHERE id=$1 AND adaptive IS NOT NULL AND status IN ('queued','running') RETURNING id", [id])).rowCount !== 0;
  }
  async stopped(id: string, generation: number) {
    const row = (await this.pool.query("SELECT stop_requested,started_at,adaptive FROM runs WHERE id=$1 AND lease_generation=$2 AND status='running' AND lease_until>now()", [id, generation])).rows[0];
    if (!row || !row.adaptive) throw new Error('Lease lost');
    return row.stop_requested || Date.now() >= new Date(row.started_at).getTime() + row.adaptive.maxMinutes * 60000;
  }
  async adaptiveCases(id: string) { return (await this.pool.query('SELECT id,ordinal,category,source_case_id AS "sourceCaseId",definition,state,executed,reason FROM adaptive_cases WHERE run_id=$1 ORDER BY ordinal', [id])).rows; }
  async beginAdaptiveCase(id: string, generation: number, ordinal: number, category: string, sourceCaseId: string) {
    const db = await this.pool.connect();
    try {
      await db.query('BEGIN');
      const row = (await db.query("SELECT id FROM runs WHERE id=$1 AND lease_generation=$2 AND status='running' AND lease_until>now() AND stop_requested=false FOR UPDATE", [id, generation])).rows[0];
      if (!row) throw new Error('Run stopped or lease lost');
      const caseId = randomUUID();
      await db.query('INSERT INTO adaptive_cases(id,run_id,ordinal,category,source_case_id,state) VALUES ($1,$2,$3,$4,$5,$6)', [caseId, id, ordinal, category, sourceCaseId, 'proposed']);
      await db.query('COMMIT');
      return caseId;
    } catch (e) { await db.query('ROLLBACK'); throw e; } finally { db.release(); }
  }
  async executeAdaptiveCase(id: string, generation: number, caseId: string, definition: CaseInput) {
    const db = await this.pool.connect();
    try {
      await db.query('BEGIN');
      const run = (await db.query("SELECT stop_requested,started_at,adaptive FROM runs WHERE id=$1 AND lease_generation=$2 AND status='running' AND lease_until>now() FOR UPDATE", [id, generation])).rows[0];
      if (!run || run.stop_requested || Date.now() >= new Date(run.started_at).getTime() + run.adaptive.maxMinutes * 60000) throw new Error('Run stopped, timed out or lease lost');
      const updated = await db.query("UPDATE adaptive_cases SET definition=$3,state='executing' WHERE id=$1 AND run_id=$2 AND state='proposed'", [caseId, id, definition]);
      if (!updated.rowCount) throw new Error('Case not proposed');
      await db.query('COMMIT');
    } catch (e) { await db.query('ROLLBACK'); throw e; } finally { db.release(); }
  }
  async completeAdaptiveCase(id: string, generation: number, caseId: string, outcome: Outcome | 'rejected', executed: boolean, reason?: string, assessment?: { checks: CheckResult[]; verdict: Verdict | null }) {
    const db = await this.pool.connect();
    try {
      await db.query('BEGIN');
      const run = (await db.query("SELECT stop_requested,started_at,adaptive FROM runs WHERE id=$1 AND lease_generation=$2 AND status='running' AND lease_until>now() FOR UPDATE", [id, generation])).rows[0];
      if (!run) throw new Error('Lease lost');
      const stopped = run.stop_requested || Date.now() >= new Date(run.started_at).getTime() + run.adaptive.maxMinutes * 60000;
      let final = stopped ? 'incomplete' : outcome;
      const caseRow = (await db.query("UPDATE adaptive_cases SET state=$3,executed=$4,reason=$5,finished_at=now() WHERE id=$1 AND run_id=$2 AND state IN ('proposed','executing') RETURNING definition", [caseId, id, final, executed, stopped ? 'Stopped or timed out' : reason ?? null])).rows[0];
      if (!caseRow) throw new Error('Case already finished');
      if (assessment && !stopped) await db.query('INSERT INTO adaptive_assessments(case_id,checks,verdict,route) VALUES ($1,$2,$3,$4)', [caseId, JSON.stringify(assessment.checks), assessment.verdict, final]);
      if (executed && (final === 'pending_review' || final === 'auto_confirm')) {
        const candidate = randomUUID();
        await db.query("INSERT INTO candidates(id,run_id,adaptive_case_id,state) VALUES ($1,$2,$3,'pending_review')", [candidate, id, caseId]);
        if (final === 'auto_confirm') {
          const candidateRow = await this.candidateEvidenceRow(db, candidate);
          const integrity = await this.checkCandidateEvidence(db, candidateRow!);
          if (integrity.status === 'complete') {
            await db.query("UPDATE candidates SET state='confirmed',decision_route='automatic',decided_at=now() WHERE id=$1", [candidate]);
            await this.insertRegression(db, candidate, id, caseId);
          } else {
            final = 'pending_review';
            await db.query("UPDATE adaptive_cases SET state='pending_review',reason='Required evidence integrity failed' WHERE id=$1", [caseId]);
            await db.query("UPDATE adaptive_assessments SET route='pending_review' WHERE case_id=$1", [caseId]);
          }
        }
      }
      await db.query('COMMIT');
      return final;
    } catch (e) { await db.query('ROLLBACK'); throw e; } finally { db.release(); }
  }
  async run(id: string) {
    return (await this.pool.query('SELECT id,target_id AS "targetId",case_id AS "caseId",status,outcome,version,created_at AS "createdAt",finished_at AS "finishedAt",model_snapshot AS "modelSnapshot",model_snapshot->\'roles\'->\'judge\'->>\'model\' AS model,paid_cap_nanos::text AS "paidCapNanos",adaptive->\'categories\' AS categories,stop_requested AS "stopRequested" FROM runs WHERE id=$1', [id])).rows[0] ?? null;
  }
  async usage(id: string) {
    return (await this.pool.query('SELECT id,role,provider,model,status,reserved_nanos::text AS "reservedNanos",charge_nanos::text AS "chargeNanos",input_tokens AS "inputTokens",output_tokens AS "outputTokens",latency_ms AS "latencyMs" FROM model_calls WHERE run_id=$1 ORDER BY created_at,id', [id])).rows;
  }
  async reserveCall(id: string, generation: number, role: Role, provider: 'ollama' | 'openrouter', model: string, amount: bigint) {
    const db = await this.pool.connect();
    try {
      await db.query('BEGIN');
      const run = (await db.query("SELECT paid_cap_nanos FROM runs WHERE id=$1 AND lease_generation=$2 AND status='running' AND lease_until>now() AND (adaptive IS NULL OR (stop_requested=false AND started_at+((adaptive->>'maxMinutes')::integer * interval '1 minute')>now())) FOR UPDATE", [id, generation])).rows[0];
      if (!run) throw new Error('Lease lost');
      if (provider === 'openrouter') {
        if (run.paid_cap_nanos === null || amount <= 0n) throw new Error('Paid model has no bounded reserve');
        if ((await db.query("SELECT 1 FROM model_calls WHERE run_id=$1 AND provider='openrouter' AND status='unresolved' LIMIT 1", [id])).rowCount) throw new Error('Paid model billing unresolved');
        const total = (await db.query("SELECT COALESCE(sum(CASE WHEN status='settled' THEN charge_nanos ELSE reserved_nanos END),0)::text AS amount FROM model_calls WHERE run_id=$1 AND provider='openrouter'", [id])).rows[0].amount;
        if (BigInt(total) + amount > BigInt(run.paid_cap_nanos)) throw new Error('Paid model budget exhausted');
      }
      const callId = randomUUID();
      await db.query('INSERT INTO model_calls(id,run_id,role,provider,model,status,reserved_nanos) VALUES ($1,$2,$3,$4,$5,$6,$7)', [callId, id, role, provider, model, 'reserved', amount.toString()]);
      await db.query('COMMIT');
      return callId;
    } catch (e) { await db.query('ROLLBACK'); throw e; } finally { db.release(); }
  }
  async settleCall(id: string, generation: number, callId: string, usage?: ModelUsage) {
    const db = await this.pool.connect();
    try {
      await db.query('BEGIN');
      const run = (await db.query("SELECT id FROM runs WHERE id=$1 AND lease_generation=$2 AND status='running' AND lease_until>now() FOR UPDATE", [id, generation])).rows[0];
      if (!run) throw new Error('Lease lost');
      const call = (await db.query("SELECT provider,reserved_nanos FROM model_calls WHERE id=$1 AND run_id=$2 AND status='reserved' FOR UPDATE", [callId, id])).rows[0];
      if (!call) throw new Error('Call not reserved');
      const measured = usage?.chargeNanos;
      const resolved = !!usage && (call.provider === 'ollama' || measured !== null && measured !== undefined && BigInt(measured) <= BigInt(call.reserved_nanos));
      await db.query('UPDATE model_calls SET status=$2,charge_nanos=$3,input_tokens=$4,output_tokens=$5,latency_ms=$6,completed_at=now() WHERE id=$1', [callId, resolved ? 'settled' : 'unresolved', call.provider === 'ollama' ? null : measured ?? null, usage?.inputTokens ?? null, usage?.outputTokens ?? null, usage?.latencyMs ?? null]);
      await db.query('COMMIT');
      return resolved;
    } catch (e) { await db.query('ROLLBACK'); throw e; } finally { db.release(); }
  }
  async events(id: string) { return (await this.pool.query('SELECT id,event,created_at AS "createdAt" FROM events WHERE run_id=$1 ORDER BY id', [id])).rows; }
  async candidates() { return (await this.pool.query("SELECT c.id,c.run_id AS \"runId\",c.state,r.version FROM candidates c JOIN runs r ON r.id=c.run_id WHERE c.state='pending_review' ORDER BY c.created_at DESC")).rows; }
  async claim(owner: string) {
    const db = await this.pool.connect();
    try {
      await db.query('BEGIN');
      const row = (await db.query("SELECT id FROM runs WHERE status='queued' ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1")).rows[0];
      if (!row) { await db.query('COMMIT'); return null; }
      const run = (await db.query("UPDATE runs SET status='running',started_at=now(), lease_owner=$2,lease_generation=lease_generation+1,lease_until=now()+interval '60 seconds' WHERE id=$1 RETURNING *", [row.id, owner])).rows[0];
      await db.query("UPDATE schedule_occurrences SET state='running' WHERE run_id=$1 AND state='queued'", [row.id]);
      await db.query('COMMIT');
      return run as { id: string; target_id: string; case_id: string | null; lease_generation: number; definition: StartInput & { case: CaseInput }; adaptive: { categories: NonNullable<CaseInput['category']>[]; maxCases: number; maxMinutes: number; seeds: { id: string; definition: CaseInput }[] } | null; model_snapshot: Snapshot; target_snapshot: { baseUrl: string; userARef: string; userBRef: string }; started_at: Date };
    } catch (e) { await db.query('ROLLBACK'); throw e; } finally { db.release(); }
  }
  async credential<T>(ref: string): Promise<T> {
    const row = (await this.pool.query('SELECT ciphertext FROM credentials WHERE id=$1', [ref])).rows[0];
    if (!row) throw new Error('Missing credential');
    return decrypt<T>(row.ciphertext);
  }
  async append(id: string, generation: number, event: EvidenceEvent, version?: string) {
    const db = await this.pool.connect();
    try {
      await db.query('BEGIN');
      const guarded = await db.query("UPDATE runs SET version=COALESCE($3,version) WHERE id=$1 AND lease_generation=$2 AND status='running' AND lease_until>now() RETURNING id", [id, generation, version ?? null]);
      if (!guarded.rowCount) throw new Error('Lease lost');
      await db.query('INSERT INTO events(run_id,event) VALUES ($1,$2)', [id, event]);
      await db.query('COMMIT');
    } catch (e) { await db.query('ROLLBACK'); throw e; } finally { db.release(); }
  }
  async heartbeat(id: string, generation: number) {
    const result = await this.pool.query("UPDATE runs SET lease_until=now()+interval '60 seconds' WHERE id=$1 AND lease_generation=$2 AND status='running' AND lease_until>now()", [id, generation]);
    if (!result.rowCount) throw new Error('Lease lost');
  }
  async finish(id: string, generation: number, result: Outcome, assessment?: { checks: CheckResult[]; verdict: Verdict | null }) {
    const db = await this.pool.connect();
    try {
      await db.query('BEGIN');
      const row = (await db.query("UPDATE runs SET status='finished',outcome=CASE WHEN adaptive IS NOT NULL AND (stop_requested OR started_at+((adaptive->>'maxMinutes')::integer * interval '1 minute')<=now()) THEN 'incomplete' ELSE $3 END,finished_at=now(),lease_until=NULL WHERE id=$1 AND lease_generation=$2 AND status='running' AND lease_until>now() RETURNING target_id,adaptive,outcome", [id, generation, result])).rows[0];
      if (!row) throw new Error('Lease lost');
      if (assessment) await db.query('INSERT INTO assessments(run_id,checks,verdict,route) VALUES ($1,$2,$3,$4)', [id, JSON.stringify(assessment.checks), assessment.verdict, result]);
      if (!row.adaptive && (result === 'pending_review' || result === 'auto_confirm')) {
        const candidate = randomUUID();
        await db.query("INSERT INTO candidates(id,run_id,state) VALUES ($1,$2,'pending_review')", [candidate, id]);
        if (result === 'auto_confirm') {
          const candidateRow = await this.candidateEvidenceRow(db, candidate);
          const integrity = await this.checkCandidateEvidence(db, candidateRow!);
          if (integrity.status === 'complete') {
            await db.query("UPDATE candidates SET state='confirmed',decision_route='automatic',decided_at=now() WHERE id=$1", [candidate]);
            await this.insertRegression(db, candidate, id);
          } else {
            await db.query("UPDATE runs SET outcome='pending_review' WHERE id=$1", [id]);
            await db.query("UPDATE assessments SET route='pending_review' WHERE run_id=$1", [id]);
          }
        }
      }
      await db.query("UPDATE schedule_occurrences SET state=CASE WHEN $2='blocked' THEN 'blocked' ELSE 'finished' END,reason=CASE WHEN $2='blocked' THEN 'Target/login/chart preflight unavailable' ELSE NULL END WHERE run_id=$1", [id, row.outcome]);
      await db.query('UPDATE targets SET active_run_id=NULL WHERE id=$1 AND active_run_id=$2', [row.target_id, id]);
      await db.query('COMMIT');
    } catch (e) { await db.query('ROLLBACK'); throw e; } finally { db.release(); }
  }
  private async insertRegression(db: pg.PoolClient, candidate: string, run: string, adaptiveCaseId?: string | null) {
    await db.query('INSERT INTO regressions(id,candidate_id,source_run_id,definition) SELECT $1,$2,r.id,COALESCE(ac.definition,r.definition->\'case\') FROM runs r LEFT JOIN adaptive_cases ac ON ac.id=$4 WHERE r.id=$3 ON CONFLICT (candidate_id) DO NOTHING', [randomUUID(), candidate, run, adaptiveCaseId ?? null]);
  }
  async findings() { return (await this.pool.query("SELECT c.id,c.run_id AS \"runId\",c.state,c.decision_route AS \"decisionRoute\",c.export_approved_at AS \"exportApprovedAt\",c.evidence_integrity AS \"evidenceIntegrity\",r.version,COALESCE(ac.state,r.outcome) AS outcome,COALESCE(ac.definition,r.definition->'case')->>'title' AS title FROM candidates c JOIN runs r ON r.id=c.run_id LEFT JOIN adaptive_cases ac ON ac.id=c.adaptive_case_id ORDER BY c.created_at DESC")).rows; }
  async selectRegression(id: string) {
    const db = await this.pool.connect();
    try {
      await db.query('BEGIN');
      const row = (await db.query('SELECT g.replay_case_id,g.definition,c.adaptive_case_id,ac.source_case_id,r.case_id FROM regressions g JOIN candidates c ON c.id=g.candidate_id JOIN runs r ON r.id=g.source_run_id LEFT JOIN adaptive_cases ac ON ac.id=c.adaptive_case_id WHERE g.id=$1 FOR UPDATE OF g', [id])).rows[0];
      if (!row) { await db.query('ROLLBACK'); return null; }
      if (row.replay_case_id) { await db.query('COMMIT'); return { caseId: row.replay_case_id as string }; }
      const definition = caseInput.parse(row.definition);
      const source = row.source_case_id ?? row.case_id;
      const caseId = randomUUID();
      for (const action of definition.actions) if (action.kind === 'attach_pdf' && !(await db.query('SELECT 1 FROM artifacts WHERE id=$1 AND case_id=$2 AND document_type=$3', [action.artifactId, source, action.documentType])).rowCount) throw new Error('Regression attachment unavailable');
      await db.query('INSERT INTO cases(id,definition) VALUES ($1,$2)', [caseId, definition]);
      for (const action of definition.actions) if (action.kind === 'attach_pdf') await db.query('INSERT INTO case_artifact_links(case_id,artifact_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [caseId, action.artifactId]);
      await db.query('UPDATE regressions SET replay_case_id=$2 WHERE id=$1', [id, caseId]);
      await db.query('COMMIT');
      return { caseId };
    } catch (e) { await db.query('ROLLBACK'); throw e; } finally { db.release(); }
  }
  async regressions() { return (await this.pool.query(`SELECT g.id,g.source_run_id AS "sourceRunId",g.definition,r.version,r.target_id AS "targetId",
    COALESCE((SELECT jsonb_agg(jsonb_build_object('runId',v.id,'version',v.version,'outcome',v.outcome) ORDER BY v.created_at)
      FROM runs v WHERE v.case_id=COALESCE(g.replay_case_id,r.case_id) AND v.target_id=r.target_id AND v.id<>r.id AND v.status='finished'), '[]'::jsonb) AS replays
    FROM regressions g JOIN runs r ON r.id=g.source_run_id ORDER BY g.created_at DESC`)).rows; }
  async coverage() { return (await this.pool.query("SELECT category,outcome,count(*)::integer AS count FROM (SELECT COALESCE(definition->'case'->>'category','prompt_injection') AS category,outcome FROM runs WHERE status='finished' AND adaptive IS NULL UNION ALL SELECT category,state AS outcome FROM adaptive_cases WHERE executed) evaluated GROUP BY 1,2")).rows; }
  private async candidateEvidenceRow(db: pg.PoolClient, id: string): Promise<CandidateEvidenceRow | null> {
    return (await db.query(`SELECT c.id,c.run_id,c.state,c.adaptive_case_id,c.export_approved_at,r.version,
      CASE WHEN c.adaptive_case_id IS NULL THEN r.outcome ELSE ac.state END AS outcome,
      CASE WHEN c.adaptive_case_id IS NULL THEN r.definition->'case' ELSE ac.definition END AS definition,
      CASE WHEN c.adaptive_case_id IS NULL THEN r.case_id ELSE ac.source_case_id END AS source_case_id
      FROM candidates c JOIN runs r ON r.id=c.run_id
      LEFT JOIN adaptive_cases ac ON ac.id=c.adaptive_case_id AND ac.run_id=c.run_id
      WHERE c.id=$1 FOR UPDATE OF c`, [id])).rows[0] ?? null;
  }
  private async checkCandidateEvidence(db: pg.PoolClient, row: CandidateEvidenceRow): Promise<CandidateIntegrity> {
    const checkedAt = new Date().toISOString();
    const parsed = caseInput.safeParse(row.definition);
    if (!parsed.success || !row.source_case_id) {
      const integrity: CandidateIntegrity = { status: 'invalid_definition', artifacts: [], checkedAt };
      await db.query('UPDATE candidates SET evidence_integrity=$2 WHERE id=$1', [row.id, integrity]);
      return integrity;
    }
    const references = new Map<string, { id: string; documentType: string }>();
    for (const action of parsed.data.actions) if (action.kind === 'attach_pdf') references.set(`${action.artifactId}:${action.documentType}`, { id: action.artifactId, documentType: action.documentType });
    const artifacts: CandidateIntegrity['artifacts'] = [];
    for (const reference of references.values()) {
      const metadata = (await db.query(`SELECT a.id,a.bytes,a.sha256 FROM artifacts a
        WHERE a.id=$2 AND a.document_type=$3 AND
        (a.case_id=$1 OR EXISTS (SELECT 1 FROM case_artifact_links l WHERE l.case_id=$1 AND l.artifact_id=a.id))`,
        [row.source_case_id, reference.id, reference.documentType])).rows[0] as { id: string; bytes: number; sha256: string } | undefined;
      artifacts.push({ id: reference.id, status: metadata ? await verifyArtifactFile(metadata) : 'unlinked' });
    }
    const failed = artifacts.find(artifact => artifact.status !== 'available');
    const integrity: CandidateIntegrity = { status: failed && failed.status !== 'available' ? failed.status : 'complete', artifacts, checkedAt };
    await db.query('UPDATE candidates SET evidence_integrity=$2 WHERE id=$1', [row.id, integrity]);
    return integrity;
  }
  async candidateIntegrity(id: string): Promise<CandidateIntegrity | null> {
    const db = await this.pool.connect();
    try {
      await db.query('BEGIN');
      const row = await this.candidateEvidenceRow(db, id);
      if (!row) { await db.query('ROLLBACK'); return null; }
      const integrity = await this.checkCandidateEvidence(db, row);
      await db.query('COMMIT');
      return integrity;
    } catch (error) { await db.query('ROLLBACK'); throw error; } finally { db.release(); }
  }
  async review(id: string, decision: 'confirm' | 'reject') {
    const db = await this.pool.connect();
    try {
      await db.query('BEGIN');
      const row = await this.candidateEvidenceRow(db, id);
      if (!row) { await db.query('ROLLBACK'); return null; }
      if (row.state === 'pending_review') {
        if (decision === 'confirm') {
          const integrity = await this.checkCandidateEvidence(db, row);
          if (integrity.status !== 'complete') { await db.query('COMMIT'); return { integrityFailure: integrity }; }
        }
        await db.query('UPDATE candidates SET state=$2,decision_route=$3,decided_at=now() WHERE id=$1', [id, decision === 'confirm' ? 'confirmed' : 'rejected', 'operator']);
        if (decision === 'confirm') await this.insertRegression(db, id, row.run_id, row.adaptive_case_id);
      } else if (row.state !== (decision === 'confirm' ? 'confirmed' : 'rejected')) { await db.query('ROLLBACK'); return { conflict: true }; }
      await db.query('COMMIT');
      return { id, state: decision === 'confirm' ? 'confirmed' : 'rejected' };
    } catch (e) { await db.query('ROLLBACK'); throw e; } finally { db.release(); }
  }
  async approveExport(id: string) {
    const db = await this.pool.connect();
    try {
      await db.query('BEGIN');
      const row = await this.candidateEvidenceRow(db, id);
      if (!row || row.state !== 'confirmed') { await db.query('ROLLBACK'); return null; }
      const integrity = await this.checkCandidateEvidence(db, row);
      if (integrity.status !== 'complete') { await db.query('COMMIT'); return { integrityFailure: integrity }; }
      const approved = (await db.query('UPDATE candidates SET export_approved_at=COALESCE(export_approved_at,now()) WHERE id=$1 RETURNING run_id,export_approved_at', [id])).rows[0];
      await db.query('COMMIT');
      return approved;
    } catch (error) { await db.query('ROLLBACK'); throw error; } finally { db.release(); }
  }
  async exportData(id: string) {
    const db = await this.pool.connect();
    try {
      await db.query('BEGIN');
      const row = await this.candidateEvidenceRow(db, id);
      if (!row || row.state !== 'confirmed') { await db.query('ROLLBACK'); return null; }
      if (!row.export_approved_at) { await db.query('COMMIT'); return { export_approved_at: null }; }
      const integrity = await this.checkCandidateEvidence(db, row);
      if (integrity.status !== 'complete') { await db.query('COMMIT'); return { integrityFailure: integrity }; }
      await db.query('COMMIT');
      return { export_approved_at: row.export_approved_at, version: row.version, definition: row.definition, outcome: row.outcome, run_id: row.run_id };
    } catch (error) { await db.query('ROLLBACK'); throw error; } finally { db.release(); }
  }
  async expire() {
    const db = await this.pool.connect();
    try {
      await db.query('BEGIN');
      const rows = (await db.query("UPDATE runs SET status='finished',outcome='incomplete',finished_at=now(),lease_generation=lease_generation+1,lease_until=NULL WHERE status='running' AND lease_until<now() RETURNING id,target_id")).rows;
      for (const row of rows) {
        await db.query("UPDATE model_calls SET status='unresolved' WHERE run_id=$1 AND status='reserved'", [row.id]);
        await db.query("UPDATE adaptive_cases SET state='incomplete',finished_at=now(),reason='Lease expired' WHERE run_id=$1 AND state IN ('proposed','executing')", [row.id]);
        await db.query("UPDATE schedule_occurrences SET state='blocked',reason='Worker lease expired; execution uncertain' WHERE run_id=$1", [row.id]);
        await db.query('UPDATE targets SET active_run_id=NULL WHERE id=$1 AND active_run_id=$2', [row.target_id, row.id]);
      }
      await db.query('COMMIT');
    } catch (e) { await db.query('ROLLBACK'); throw e; } finally { db.release(); }
  }
}
