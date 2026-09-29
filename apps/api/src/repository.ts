import { randomUUID, createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import pg from 'pg';
import type { CaseInput, EvidenceEvent, Outcome, StartInput, TargetInput, TargetUpdateInput, Verdict } from '../../../packages/contracts/src/index.js';
import type { CheckResult } from '../../worker/src/checks.js';
import { legacyRoles, nanos, reserveAmount, type Role, type Snapshot, type ModelUsage } from '../../worker/src/models.js';

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
    return (await this.pool.query('SELECT bytes,sha256 FROM artifacts WHERE case_id=$1 AND id=$2 AND document_type=$3', [caseId, id, type])).rows[0] ?? null;
  }
  async cases(): Promise<(CaseInput & { id: string })[]> { return (await this.pool.query('SELECT id,definition FROM cases ORDER BY created_at DESC')).rows.map(r => ({ id: r.id as string, ...r.definition as CaseInput })); }
  async updateCase(id: string, definition: CaseInput) {
    const db = await this.pool.connect();
    try {
      await db.query('BEGIN');
      const row = (await db.query('SELECT id FROM cases WHERE id=$1 FOR UPDATE', [id])).rows[0];
      if (!row) { await db.query('ROLLBACK'); return null; }
      if ((await db.query('SELECT 1 FROM runs WHERE case_id=$1 LIMIT 1', [id])).rowCount) { await db.query('ROLLBACK'); return { conflict: true }; }
      for (const action of definition.actions) if (action.kind === 'attach_pdf' && !(await db.query('SELECT 1 FROM artifacts WHERE case_id=$1 AND id=$2 AND document_type=$3', [id, action.artifactId, action.documentType])).rowCount) { await db.query('ROLLBACK'); return { invalid: true }; }
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
      for (const action of definition.actions) if (action.kind === 'attach_pdf' && !(await db.query('SELECT 1 FROM artifacts WHERE case_id=$1 AND id=$2 AND document_type=$3', [input.caseId, action.artifactId, action.documentType])).rowCount) throw new Error('Artifact not linked to selected case');
      const id = randomUUID();
      await db.query('INSERT INTO runs(id,target_id,case_id,definition,target_snapshot,model_snapshot,paid_cap_nanos) VALUES ($1,$2,$3,$4,$5,$6,$7)', [id, target.id, input.caseId, { ...input, case: selected.definition }, { name: target.name, baseUrl: target.base_url, userARef: target.user_a_credential, userBRef: target.user_b_credential }, modelSnapshot, input.openRouterCapUsd === undefined ? null : nanos(input.openRouterCapUsd).toString()]);
      await db.query('INSERT INTO jobs(run_id) VALUES ($1)', [id]);
      await db.query('UPDATE targets SET active_run_id=$1 WHERE id=$2', [id, target.id]);
      await db.query('COMMIT');
      return { id, status: 'queued' };
    } catch (e) { await db.query('ROLLBACK'); throw e; } finally { db.release(); }
  }
  async run(id: string) {
    return (await this.pool.query('SELECT id,target_id AS "targetId",case_id AS "caseId",status,outcome,version,created_at AS "createdAt",finished_at AS "finishedAt",model_snapshot AS "modelSnapshot",model_snapshot->\'roles\'->\'judge\'->>\'model\' AS model,paid_cap_nanos::text AS "paidCapNanos" FROM runs WHERE id=$1', [id])).rows[0] ?? null;
  }
  async usage(id: string) {
    return (await this.pool.query('SELECT id,role,provider,model,status,reserved_nanos::text AS "reservedNanos",charge_nanos::text AS "chargeNanos",input_tokens AS "inputTokens",output_tokens AS "outputTokens",latency_ms AS "latencyMs" FROM model_calls WHERE run_id=$1 ORDER BY created_at,id', [id])).rows;
  }
  async reserveCall(id: string, generation: number, role: Role, provider: 'ollama' | 'openrouter', model: string, amount: bigint) {
    const db = await this.pool.connect();
    try {
      await db.query('BEGIN');
      const run = (await db.query("SELECT paid_cap_nanos FROM runs WHERE id=$1 AND lease_generation=$2 AND status='running' AND lease_until>now() FOR UPDATE", [id, generation])).rows[0];
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
      const run = (await db.query("UPDATE runs SET status='running', lease_owner=$2,lease_generation=lease_generation+1,lease_until=now()+interval '60 seconds' WHERE id=$1 RETURNING *", [row.id, owner])).rows[0];
      await db.query('COMMIT');
      return run as { id: string; target_id: string; case_id: string; lease_generation: number; definition: StartInput & { case: CaseInput }; model_snapshot: Snapshot; target_snapshot: { baseUrl: string; userARef: string; userBRef: string } };
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
      const row = (await db.query("UPDATE runs SET status='finished',outcome=$3,finished_at=now(),lease_until=NULL WHERE id=$1 AND lease_generation=$2 AND status='running' AND lease_until>now() RETURNING target_id", [id, generation, result])).rows[0];
      if (!row) throw new Error('Lease lost');
      if (assessment) await db.query('INSERT INTO assessments(run_id,checks,verdict,route) VALUES ($1,$2,$3,$4)', [id, JSON.stringify(assessment.checks), assessment.verdict, result]);
      if (result === 'pending_review' || result === 'auto_confirm') {
        const candidate = randomUUID();
        await db.query('INSERT INTO candidates(id,run_id,state,decision_route,decided_at) VALUES ($1,$2,$3,$4,$5)', [candidate, id, result === 'auto_confirm' ? 'confirmed' : 'pending_review', result === 'auto_confirm' ? 'automatic' : null, result === 'auto_confirm' ? new Date() : null]);
        if (result === 'auto_confirm') await this.insertRegression(db, candidate, id);
      }
      await db.query('UPDATE targets SET active_run_id=NULL WHERE id=$1 AND active_run_id=$2', [row.target_id, id]);
      await db.query('COMMIT');
    } catch (e) { await db.query('ROLLBACK'); throw e; } finally { db.release(); }
  }
  private async insertRegression(db: pg.PoolClient, candidate: string, run: string) {
    await db.query('INSERT INTO regressions(id,candidate_id,source_run_id,definition) SELECT $1,$2,id,definition->\'case\' FROM runs WHERE id=$3 ON CONFLICT (candidate_id) DO NOTHING', [randomUUID(), candidate, run]);
  }
  async findings() { return (await this.pool.query("SELECT c.id,c.run_id AS \"runId\",c.state,c.decision_route AS \"decisionRoute\",c.export_approved_at AS \"exportApprovedAt\",r.version,r.outcome,r.definition->'case'->>'title' AS title FROM candidates c JOIN runs r ON r.id=c.run_id ORDER BY c.created_at DESC")).rows; }
  async regressions() { return (await this.pool.query(`SELECT g.id,g.source_run_id AS "sourceRunId",g.definition,r.version,r.target_id AS "targetId",
    COALESCE((SELECT jsonb_agg(jsonb_build_object('runId',v.id,'version',v.version,'outcome',v.outcome) ORDER BY v.created_at)
      FROM runs v WHERE v.case_id=r.case_id AND v.target_id=r.target_id AND v.id<>r.id AND v.status='finished'), '[]'::jsonb) AS replays
    FROM regressions g JOIN runs r ON r.id=g.source_run_id ORDER BY g.created_at DESC`)).rows; }
  async coverage() { return (await this.pool.query("SELECT COALESCE(definition->'case'->>'category','prompt_injection') AS category,outcome, count(*)::integer AS count FROM runs WHERE status='finished' GROUP BY 1,2")).rows; }
  async review(id: string, decision: 'confirm' | 'reject') {
    const db = await this.pool.connect();
    try {
      await db.query('BEGIN');
      const row = (await db.query('SELECT run_id,state FROM candidates WHERE id=$1 FOR UPDATE', [id])).rows[0];
      if (!row) { await db.query('ROLLBACK'); return null; }
      if (row.state === 'pending_review') {
        await db.query('UPDATE candidates SET state=$2,decision_route=$3,decided_at=now() WHERE id=$1', [id, decision === 'confirm' ? 'confirmed' : 'rejected', 'operator']);
        if (decision === 'confirm') await this.insertRegression(db, id, row.run_id);
      } else if (row.state !== (decision === 'confirm' ? 'confirmed' : 'rejected')) { await db.query('ROLLBACK'); return { conflict: true }; }
      await db.query('COMMIT');
      return { id, state: decision === 'confirm' ? 'confirmed' : 'rejected' };
    } catch (e) { await db.query('ROLLBACK'); throw e; } finally { db.release(); }
  }
  async approveExport(id: string) {
    const row = (await this.pool.query("UPDATE candidates SET export_approved_at=COALESCE(export_approved_at,now()) WHERE id=$1 AND state='confirmed' RETURNING run_id,export_approved_at", [id])).rows[0];
    return row ?? null;
  }
  async exportData(id: string) {
    return (await this.pool.query("SELECT c.export_approved_at,r.version,r.definition->'case' AS definition,r.outcome,r.id AS run_id FROM candidates c JOIN runs r ON r.id=c.run_id WHERE c.id=$1 AND c.state='confirmed'", [id])).rows[0] ?? null;
  }
  async expire() {
    const db = await this.pool.connect();
    try {
      await db.query('BEGIN');
      const rows = (await db.query("UPDATE runs SET status='finished',outcome='incomplete',finished_at=now(),lease_generation=lease_generation+1,lease_until=NULL WHERE status='running' AND lease_until<now() RETURNING id,target_id")).rows;
      for (const row of rows) {
        await db.query("UPDATE model_calls SET status='unresolved' WHERE run_id=$1 AND status='reserved'", [row.id]);
        await db.query('UPDATE targets SET active_run_id=NULL WHERE id=$1 AND active_run_id=$2', [row.target_id, row.id]);
      }
      await db.query('COMMIT');
    } catch (e) { await db.query('ROLLBACK'); throw e; } finally { db.release(); }
  }
}
