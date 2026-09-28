import { randomUUID, createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import pg from 'pg';
import type { CaseInput, EvidenceEvent, Outcome, StartInput, TargetInput } from '../../../packages/contracts/src/index.js';

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
  async updateTarget(id: string, input: TargetInput): Promise<{ id: string; name: string; baseUrl: string } | { active_run_id: string } | null> {
    const db = await this.pool.connect();
    try {
      await db.query('BEGIN');
      const target = (await db.query('SELECT active_run_id FROM targets WHERE id=$1 FOR UPDATE', [id])).rows[0];
      if (!target) { await db.query('ROLLBACK'); return null; }
      if (target.active_run_id) { await db.query('ROLLBACK'); return { active_run_id: target.active_run_id }; }
      const a = randomUUID(), b = randomUUID();
      await db.query('INSERT INTO credentials(id,ciphertext) VALUES ($1,$2),($3,$4)', [a, encrypt(input.userA), b, encrypt(input.userB)]);
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
  async cases() { return (await this.pool.query('SELECT id,definition FROM cases ORDER BY created_at DESC')).rows.map(r => ({ id: r.id, ...r.definition as object })); }
  async start(input: StartInput): Promise<{ id: string; status: 'queued' } | { active_run_id: string } | null> {
    const db = await this.pool.connect();
    try {
      await db.query('BEGIN');
      const target = (await db.query('SELECT id,name,base_url,active_run_id,user_a_credential,user_b_credential FROM targets WHERE id=$1 FOR UPDATE', [input.targetId])).rows[0];
      const selected = (await db.query('SELECT definition FROM cases WHERE id=$1', [input.caseId])).rows[0];
      if (!target || !selected) { await db.query('ROLLBACK'); return null; }
      if (target.active_run_id) { await db.query('ROLLBACK'); return { active_run_id: target.active_run_id }; }
      const id = randomUUID();
      await db.query('INSERT INTO runs(id,target_id,case_id,definition,target_snapshot) VALUES ($1,$2,$3,$4,$5)', [id, target.id, input.caseId, { ...input, case: selected.definition }, { name: target.name, baseUrl: target.base_url, userARef: target.user_a_credential, userBRef: target.user_b_credential }]);
      await db.query('INSERT INTO jobs(run_id) VALUES ($1)', [id]);
      await db.query('UPDATE targets SET active_run_id=$1 WHERE id=$2', [id, target.id]);
      await db.query('COMMIT');
      return { id, status: 'queued' };
    } catch (e) { await db.query('ROLLBACK'); throw e; } finally { db.release(); }
  }
  async run(id: string) {
    return (await this.pool.query('SELECT id,target_id AS "targetId",case_id AS "caseId",status,outcome,version,created_at AS "createdAt",finished_at AS "finishedAt",definition->>\'model\' AS model FROM runs WHERE id=$1', [id])).rows[0] ?? null;
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
      return run as { id: string; target_id: string; lease_generation: number; definition: StartInput & { case: CaseInput }; target_snapshot: { baseUrl: string; userARef: string; userBRef: string } };
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
  async finish(id: string, generation: number, result: Outcome) {
    const db = await this.pool.connect();
    try {
      await db.query('BEGIN');
      const row = (await db.query("UPDATE runs SET status='finished',outcome=$3,finished_at=now(),lease_until=NULL WHERE id=$1 AND lease_generation=$2 AND status='running' AND lease_until>now() RETURNING target_id", [id, generation, result])).rows[0];
      if (!row) throw new Error('Lease lost');
      if (result === 'pending_review') await db.query('INSERT INTO candidates(id,run_id) VALUES ($1,$2)', [randomUUID(), id]);
      await db.query('UPDATE targets SET active_run_id=NULL WHERE id=$1 AND active_run_id=$2', [row.target_id, id]);
      await db.query('COMMIT');
    } catch (e) { await db.query('ROLLBACK'); throw e; } finally { db.release(); }
  }
  async expire() {
    const db = await this.pool.connect();
    try {
      await db.query('BEGIN');
      const rows = (await db.query("UPDATE runs SET status='finished',outcome='incomplete',finished_at=now(),lease_generation=lease_generation+1,lease_until=NULL WHERE status='running' AND lease_until<now() RETURNING id,target_id")).rows;
      for (const row of rows) await db.query('UPDATE targets SET active_run_id=NULL WHERE id=$1 AND active_run_id=$2', [row.target_id, row.id]);
      await db.query('COMMIT');
    } catch (e) { await db.query('ROLLBACK'); throw e; } finally { db.release(); }
  }
}
