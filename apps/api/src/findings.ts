import { createHash } from 'node:crypto';
import type pg from 'pg';
import { caseInput, observation, type CaseInput, type Observation } from '../../../packages/contracts/src/index.js';
import { assessedChecks, assessedVerdict, rationaleFits, reportFacts, type ReportContent, type ReportFacts, type ReviewRationale } from '../../../packages/contracts/src/report.js';
import type { z } from 'zod';
import type { Identity } from '../../worker/src/session.js';
import type { Repository } from './repository.js';

type Db = pg.Pool | pg.PoolClient;

// Report text never carries a real identifier. Aliases are fixed by the target's user slot, so the same person or
// chart keeps the same alias in every report and revision while the attack mechanism stays legible.
const SECRETS = /(?:Cookie|Set-Cookie)\s*[:=]\s*[^\s;,"}]+(?:;\s*[^\s;,"}]+)*|(?:csrf[_-]?token|clearPass|X-Copilot-Token|PHPSESSID|OpenEMR|session[_-]?id)\s*[:=]\s*[^\s;,"}]+|Authorization\s*[:=]\s*(?:(?:Bearer|Basic)\s+)?[^\s;,"}]+|\bsession\s*=\s*[^\s;,"}]+|\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi;
const literal = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
export function makeRedactor(identities: Identity[]) {
  const named = identities.flatMap((user, index) => [[user.pubpid, `Patient ${'AB'[index]}`], [user.username, `Clinician ${'AB'[index]}`]] as const)
    .filter(([value]) => value).sort((a, b) => b[0].length - a[0].length)
    .map(([value, alias]) => ({ pattern: new RegExp(`(?<![A-Za-z0-9])${literal(value)}(?![A-Za-z0-9])`, 'gi'), alias }));
  const passwords = identities.map(user => user.password).filter(Boolean);
  const text = (value: string) => {
    let result = value.replace(SECRETS, '[REDACTED]');
    for (const password of passwords) result = result.replaceAll(password, '[REDACTED]');
    for (const { pattern, alias } of named) result = result.replace(pattern, alias);
    return result;
  };
  const deep = <T>(value: T): T => typeof value === 'string' ? text(value) as T : Array.isArray(value) ? value.map(deep) as T
    : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([key, item]) => [key, deep(item)])) as T : value;
  // A final independent scan: any surviving identifier means the revision must not be stored.
  const leaks = (value: unknown): boolean => typeof value === 'string' ? named.some(({ pattern }) => { pattern.lastIndex = 0; return pattern.test(value); }) || passwords.some(password => value.includes(password))
    : Array.isArray(value) ? value.some(leaks) : value && typeof value === 'object' ? Object.values(value).some(leaks) : false;
  return { text, deep, leaks };
}
export type Redactor = ReturnType<typeof makeRedactor>;
export async function redactorFor(repo: Repository, runId: string): Promise<Redactor> {
  const snapshot = (await repo.pool.query('SELECT target_snapshot FROM runs WHERE id=$1', [runId])).rows[0]?.target_snapshot;
  if (!snapshot) throw new Error('Run not found');
  return makeRedactor(await Promise.all([snapshot.userARef, snapshot.userBRef].map((ref: string) => repo.credential<Identity>(ref))));
}

export type FindingEvidence = { id: string; runId: string; state: string; route: string | null; decidedAt: Date | null; adaptiveCaseId: string | null; sourceCaseId: string | null; targetId: string; targetName: string; version: string | null;
  definition: CaseInput | null; observations: Observation[]; checks: z.infer<typeof assessedChecks> | null; verdict: z.infer<typeof assessedVerdict> | null; missing: string[] };

// Reads only what the run persisted. Anything absent or invalid is listed in `missing`; nothing is inferred or filled in.
export async function loadEvidence(db: Db, id: string): Promise<FindingEvidence | null> {
  const row = (await db.query(`SELECT c.id,c.run_id,c.state,c.decision_route,c.decided_at,c.adaptive_case_id,r.target_id,r.target_snapshot->>'name' AS target_name,r.version,
    CASE WHEN c.adaptive_case_id IS NULL THEN r.case_id ELSE ac.source_case_id END AS source_case_id,
    CASE WHEN c.adaptive_case_id IS NULL THEN r.definition->'case' ELSE ac.definition END AS definition,
    CASE WHEN c.adaptive_case_id IS NULL THEN a.checks ELSE aa.checks END AS checks,
    CASE WHEN c.adaptive_case_id IS NULL THEN a.verdict ELSE aa.verdict END AS verdict
    FROM candidates c JOIN runs r ON r.id=c.run_id LEFT JOIN adaptive_cases ac ON ac.id=c.adaptive_case_id AND ac.run_id=c.run_id
    LEFT JOIN assessments a ON a.run_id=r.id LEFT JOIN adaptive_assessments aa ON aa.case_id=ac.id WHERE c.id=$1`, [id])).rows[0];
  if (!row) return null;
  const definition = caseInput.safeParse(row.definition), verdict = assessedVerdict.safeParse(row.verdict), checks = assessedChecks.safeParse(row.checks);
  const observations = (await db.query("SELECT event->'detail'->'observation' AS observation FROM events WHERE run_id=$1 AND event->>'agent'='target' AND event->>'kind'='turn' AND ($2::text IS NULL OR event->'detail'->>'executionCaseId'=$2) ORDER BY id", [row.run_id, row.adaptive_case_id])).rows
    .flatMap(event => { const parsed = observation.safeParse(event.observation); return parsed.success ? [parsed.data] : []; });
  const missing: string[] = [];
  if (!definition.success) missing.push('attack_category', 'reproduction_steps', 'expected_behavior');
  else if (!definition.data.category) missing.push('attack_category');
  if (!observations.length || definition.success && observations.length !== definition.data.actions.length) missing.push('observed_behavior');
  if (!verdict.success) missing.push('verdict');
  else if (!verdict.data.evidenceRefs.length || verdict.data.evidenceRefs.some(ref => !observations.some(o => o.ref === ref))) missing.push('evidence_citations');
  if (row.state === 'confirmed' && (row.decision_route === 'automatic' ? verdict.success && verdict.data.policy.outcome !== 'auto_confirm' : row.decision_route !== 'operator')) missing.push('decision_basis');
  return { id, runId: row.run_id, state: row.state, route: row.decision_route, decidedAt: row.decided_at, adaptiveCaseId: row.adaptive_case_id, sourceCaseId: row.source_case_id, targetId: row.target_id, targetName: row.target_name, version: row.version,
    definition: definition.success ? definition.data : null, observations, checks: checks.success ? checks.data : null, verdict: verdict.success ? verdict.data : null, missing };
}

export const sequenceFingerprint = (definition: CaseInput) => createHash('sha256').update(JSON.stringify([definition.category, definition.user,
  definition.actions.map(action => action.kind === 'attach_pdf' ? [action.kind, action.message, action.documentType, action.artifactId] : [action.kind, action.message])])).digest('hex');
// One report per attack sequence, target and version: a second confirmed finding for the same sequence is a duplicate
// once the first has a report. Earlier same-sequence findings on other versions leave the regression label unknown, never asserted.
export async function sequenceState(db: Db, evidence: FindingEvidence, fingerprint: string) {
  const rows = (await db.query(`SELECT c.id,r.version,EXISTS (SELECT 1 FROM report_revisions x WHERE x.candidate_id=c.id) AS drafted,
    CASE WHEN c.adaptive_case_id IS NULL THEN r.definition->'case' ELSE ac.definition END AS definition
    FROM candidates c JOIN runs r ON r.id=c.run_id LEFT JOIN adaptive_cases ac ON ac.id=c.adaptive_case_id
    WHERE c.state='confirmed' AND c.id<>$1 AND r.target_id=$2`, [evidence.id, evidence.targetId])).rows
    .filter(row => { const parsed = caseInput.safeParse(row.definition); return parsed.success && sequenceFingerprint(parsed.data) === fingerprint; });
  return { duplicateOf: (rows.find(row => row.drafted && row.version === evidence.version)?.id ?? null) as string | null, regression: (rows.length ? 'unknown' : 'new') as ReportFacts['regression'] };
}
export async function validationHistory(db: Db, candidateId: string): Promise<ReportFacts['validationHistory']> {
  return (await db.query(`SELECT v.id AS "runId",v.version,v.outcome FROM regressions g JOIN runs r ON r.id=g.source_run_id
    JOIN runs v ON v.case_id=COALESCE(g.replay_case_id,r.case_id) AND v.target_id=r.target_id AND v.id<>r.id AND v.status='finished'
    WHERE g.candidate_id=$1 ORDER BY v.created_at LIMIT 50`, [candidateId])).rows;
}

// Deterministic, aliased facts for one confirmed (or pending) finding. Requires complete evidence.
export function buildFacts(evidence: FindingEvidence, redact: Redactor, extra: { evidenceRevision: number; regression: ReportFacts['regression']; validationHistory: ReportFacts['validationHistory'] }): ReportFacts {
  const { definition, verdict } = evidence;
  if (!definition || !verdict || evidence.missing.length) throw new Error('Finding evidence incomplete');
  const otherPatient = definition.user === 'A' ? 'Patient B' : 'Patient A';
  return reportFacts.parse(redact.deep({
    findingId: evidence.id, runId: evidence.runId, evidenceRevision: extra.evidenceRevision, category: definition.category,
    target: { name: evidence.targetName, version: evidence.version },
    basis: evidence.state !== 'confirmed' ? null : evidence.route === 'automatic' ? 'auto_confirmed' : evidence.route === 'operator' ? 'human_confirmed' : null, regression: extra.regression,
    rubric: definition.rubric ? { severity: definition.rubric.severity, severityRationale: definition.rubric.severityRationale, exploitabilityRationale: definition.rubric.exploitabilityRationale } : null,
    expectedSafeBehavior: definition.expectedSafeBehavior,
    reproduction: definition.actions.map((action, index) => ({ step: index + 1, kind: action.kind, instruction: action.message.replaceAll('{{OTHER_PATIENT_ID}}', otherPatient), ...(action.kind === 'attach_pdf' ? { attachment: { documentType: action.documentType, artifactId: action.artifactId } } : {}) })),
    evidence: evidence.observations.map(item => ({ ref: item.ref, turn: item.turn, status: item.status, excerpt: item.response.slice(0, 3000) })),
    checks: (evidence.checks ?? []).map((check, index) => ({ ref: `check-${index + 1}`, kind: check.kind, outcome: check.outcome, coveredClaim: check.coveredClaim })),
    verdict: { outcome: verdict.outcome, claim: verdict.claim, evidenceQuote: verdict.evidenceQuote, evidenceRefs: verdict.evidenceRefs, reproductionComplete: verdict.reproductionComplete, materialUncertainties: verdict.materialUncertainties },
    policy: verdict.policy, status: 'open', validationHistory: extra.validationHistory }));
}

// Decision history is append-only. The original review endpoint keeps working; its rationale is optional and stored as absent when omitted.
export async function recordDecision(db: pg.PoolClient, candidateId: string, decision: 'confirm' | 'reject', rationale?: ReviewRationale) {
  await db.query("INSERT INTO finding_decisions(candidate_id,kind,decision,route,rationale,actor) VALUES ($1,'decision',$2,'operator',$3,'operator')", [candidateId, decision, rationale ?? null]);
}
// Called at every confirmation site: only an automatic route is recorded here (operator decisions record their own rationale).
export async function recordAutomaticDecision(db: pg.PoolClient, candidateId: string) {
  await db.query("INSERT INTO finding_decisions(candidate_id,kind,decision,route,actor) SELECT id,'decision','confirm','automatic','worker' FROM candidates WHERE id=$1 AND decision_route='automatic'", [candidateId]);
}
export async function correctDecision(pool: pg.Pool, id: string, input: { rationale: ReviewRationale; reason: string }) {
  const db = await pool.connect();
  try {
    await db.query('BEGIN');
    const row = (await db.query('SELECT state FROM candidates WHERE id=$1 FOR UPDATE', [id])).rows[0];
    if (!row) { await db.query('ROLLBACK'); return { status: 'not_found' as const }; }
    if (!['confirmed', 'rejected'].includes(row.state) || !rationaleFits(row.state === 'confirmed' ? 'confirm' : 'reject', input.rationale)) { await db.query('ROLLBACK'); return { status: 'conflict' as const }; }
    const previous = (await db.query("SELECT id FROM finding_decisions WHERE candidate_id=$1 AND kind='decision' ORDER BY id DESC LIMIT 1", [id])).rows[0];
    const entry = (await db.query("INSERT INTO finding_decisions(candidate_id,kind,rationale,reason,corrects,actor) VALUES ($1,'correction',$2,$3,$4,'operator') RETURNING id::text AS id", [id, input.rationale, input.reason, previous?.id ?? null])).rows[0];
    await db.query('COMMIT');
    return { status: 'ok' as const, id: entry.id as string };
  } catch (error) { await db.query('ROLLBACK'); throw error; } finally { db.release(); }
}
export async function decisionHistory(pool: pg.Pool, id: string) {
  const current = (await pool.query('SELECT state,decision_route AS route,decided_at AS "decidedAt" FROM candidates WHERE id=$1', [id])).rows[0];
  if (!current) return null;
  const entries = (await pool.query('SELECT id::text AS id,kind,decision,route,rationale,reason,corrects::text AS corrects,actor,created_at AS "createdAt" FROM finding_decisions WHERE candidate_id=$1 ORDER BY id', [id])).rows;
  return { v: 1, findingId: id, current, entries };
}

export async function findingMetadata(repo: Repository, id: string) {
  const evidence = await loadEvidence(repo.pool, id);
  if (!evidence) return null;
  const revision = (await repo.pool.query('SELECT id,revision,content,approved_at,approval_invalidated_at FROM report_revisions WHERE candidate_id=$1 ORDER BY revision DESC LIMIT 1', [id])).rows[0];
  const job = (await repo.pool.query('SELECT id,state,reason,attempts,evidence_revision AS "evidenceRevision" FROM report_jobs WHERE candidate_id=$1 ORDER BY created_at DESC,id DESC LIMIT 1', [id])).rows[0] ?? null;
  const narrative = (revision?.content as ReportContent | undefined)?.narrative ?? null;
  const facts = evidence.missing.some(item => item !== 'decision_basis') ? null : buildFacts({ ...evidence, missing: [] }, await redactorFor(repo, evidence.runId),
    { evidenceRevision: job?.evidenceRevision ?? 1, regression: 'unknown', validationHistory: await validationHistory(repo.pool, id) });
  const missing = [...evidence.missing, ...(narrative ? [] : ['clinical_impact', 'remediation', ...(facts?.rubric ? [] : ['severity'])])];
  return { v: 1, findingId: id, runId: evidence.runId, executionCaseId: evidence.adaptiveCaseId, sourceCaseId: evidence.sourceCaseId, state: evidence.state, decisionRoute: evidence.route, decidedAt: evidence.decidedAt,
    target: { id: evidence.targetId, name: evidence.targetName, version: evidence.version }, category: evidence.definition?.category ?? null,
    severity: narrative ? { level: narrative.severity.level, rationale: narrative.severity.rationale, source: 'report_revision' as const } : facts?.rubric ? { level: facts.rubric.severity, rationale: facts.rubric.severityRationale, source: 'case_rubric' as const } : null,
    completeness: { status: evidence.missing.length ? 'evidence_incomplete' as const : narrative ? 'complete' as const : 'pending_report' as const, missing },
    facts, narrative,
    report: { currentRevisionId: revision?.id ?? null, currentRevision: revision?.revision ?? null, approvedRevisionId: revision?.approved_at && !revision.approval_invalidated_at ? revision.id as string : null, job } };
}
