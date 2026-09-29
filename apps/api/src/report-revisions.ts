import { createHash, randomUUID } from 'node:crypto';
import type pg from 'pg';
import { documentationReport, reportContent, type DocumentationReport, type ReportContent, type ReportFacts } from '../../../packages/contracts/src/report.js';
import { redactorFor, sequenceState } from './findings.js';
import type { Repository } from './repository.js';

// Revisions are immutable. An edit (or a newer Documentation draft) is a new revision, and any earlier approval is
// invalidated in the same transaction, so an approval can only ever describe the exact bytes that were reviewed.
const canonical = (value: unknown): string => Array.isArray(value) ? `[${value.map(canonical).join(',')}]`
  : value && typeof value === 'object' ? `{${Object.entries(value).filter(([, item]) => item !== undefined).sort(([a], [b]) => a < b ? -1 : 1).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}` : JSON.stringify(value);
export const hashContent = (content: unknown) => createHash('sha256').update(canonical(content)).digest('hex');
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const flat = (value: string) => value.replace(/\s+/g, ' ').trim();

// The Documentation contract: a narrative may only cite evidence that exists in the facts, quote it verbatim, and stay
// within the identifiers already present. Returns a machine-readable problem or null.
export function narrativeProblem(narrative: DocumentationReport, facts: ReportFacts, author: 'documentation' | 'operator'): string | null {
  const allowed = new Set(['case', 'verdict', ...facts.evidence.map(item => item.ref), ...facts.checks.map(item => item.ref)]);
  const { expectedBehavior, observedBehavior } = narrative;
  if ([...expectedBehavior.citations, ...observedBehavior.citations].some(id => !allowed.has(id))) return 'unknown_citation';
  if (expectedBehavior.citations.some(id => id !== 'case')) return 'expected_behavior_citation';
  if (!observedBehavior.citations.some(id => id.startsWith('turn-')) || observedBehavior.citations.includes('case')) return 'observed_behavior_uncited';
  const cited = facts.evidence.filter(item => observedBehavior.citations.includes(item.ref)).map(item => flat(item.excerpt));
  if (observedBehavior.quotes.some(quote => !cited.some(excerpt => excerpt.includes(flat(quote))))) return 'quote_not_in_evidence';
  if (author === 'documentation' && facts.rubric && facts.rubric.severity !== 'unknown' && narrative.severity.level !== facts.rubric.severity) return 'severity_contradicts_rubric';
  const serialized = JSON.stringify(narrative), known = new Set([facts.findingId, facts.runId, ...facts.reproduction.flatMap(step => step.attachment ? [step.attachment.artifactId] : [])]);
  if (/\b(?:Patient|Clinician) (?![AB]\b)[A-Z]\b/.test(serialized) || (serialized.match(UUID) ?? []).some(id => !known.has(id))) return 'introduced_identifier';
  return null;
}

// Runs inside a transaction that already holds the candidate row lock (completion or gatedConfirmed).
export async function insertRevision(db: pg.PoolClient, input: { candidateId: string; evidenceRevision: number; author: 'documentation' | 'operator'; jobId?: string; content: ReportContent; fingerprint: string }) {
  await db.query('SELECT 1 FROM candidates WHERE id=$1 FOR UPDATE', [input.candidateId]);
  if (input.jobId) { const existing = (await db.query('SELECT id FROM report_revisions WHERE job_id=$1', [input.jobId])).rows[0]; if (existing) return existing.id as string; }
  const latest = (await db.query('SELECT id,revision FROM report_revisions WHERE candidate_id=$1 ORDER BY revision DESC LIMIT 1', [input.candidateId])).rows[0];
  const id = randomUUID();
  await db.query('INSERT INTO report_revisions(id,candidate_id,evidence_revision,revision,author,job_id,parent_id,content,content_hash,redaction_status,sequence_fingerprint) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)',
    [id, input.candidateId, input.evidenceRevision, (latest?.revision ?? 0) + 1, input.author, input.jobId ?? null, latest?.id ?? null, input.content, hashContent(input.content), 'redacted', input.fingerprint]);
  await db.query('UPDATE report_revisions SET approval_invalidated_at=now(),invalidated_by=$2 WHERE candidate_id=$1 AND approved_at IS NOT NULL AND approval_invalidated_at IS NULL AND id<>$2', [input.candidateId, id]);
  return id;
}
// Called from the fenced job completion. A concurrent job for the same sequence cannot both draft: the loser fails and rolls back.
export async function commitDraft(db: pg.PoolClient, input: { evidence: Parameters<typeof sequenceState>[1]; evidenceRevision: number; jobId: string; content: ReportContent; fingerprint: string }) {
  await db.query('SELECT pg_advisory_xact_lock(hashtext($1))', [input.fingerprint]);
  if ((await sequenceState(db, input.evidence, input.fingerprint)).duplicateOf) throw new Error('duplicate_attack_sequence');
  return insertRevision(db, { candidateId: input.evidence.id, evidenceRevision: input.evidenceRevision, author: 'documentation', jobId: input.jobId, content: input.content, fingerprint: input.fingerprint });
}

const view = (row: Record<string, unknown>) => ({ id: row.id as string, findingId: row.candidate_id as string, revision: row.revision as number, evidenceRevision: row.evidence_revision as number, author: row.author as string, jobId: row.job_id as string | null,
  parentId: row.parent_id as string | null, contentHash: row.content_hash as string, redaction: row.redaction_status as string, content: row.content as ReportContent, createdAt: row.created_at as Date,
  approval: row.approved_at ? { approvedAt: row.approved_at as Date, approvedBy: row.approved_by as string, invalidatedAt: (row.approval_invalidated_at ?? null) as Date | null, invalidatedBy: (row.invalidated_by ?? null) as string | null } : null });
export type ReportRevisionView = ReturnType<typeof view>;

export class ReportRevisions {
  constructor(private readonly repo: Repository) {}
  async list(candidateId: string) {
    if (!(await this.repo.pool.query('SELECT 1 FROM candidates WHERE id=$1', [candidateId])).rowCount) return null;
    return (await this.repo.pool.query('SELECT * FROM report_revisions WHERE candidate_id=$1 ORDER BY revision DESC', [candidateId])).rows.map(view);
  }
  async get(candidateId: string, id: string) {
    const row = (await this.repo.pool.query('SELECT * FROM report_revisions WHERE candidate_id=$1 AND id=$2', [candidateId, id])).rows[0];
    return row ? view(row) : null;
  }
  // Operator edit of the narrative only: facts come from the parent and cannot be changed, so an edit cannot add evidence.
  async edit(candidateId: string, input: { parentRevisionId: string; narrative: DocumentationReport }) {
    const db = await this.repo.pool.connect();
    try {
      await db.query('BEGIN');
      const candidate = (await db.query('SELECT state FROM candidates WHERE id=$1 FOR UPDATE', [candidateId])).rows[0];
      const parent = (await db.query('SELECT * FROM report_revisions WHERE id=$1 AND candidate_id=$2', [input.parentRevisionId, candidateId])).rows[0];
      if (!candidate || !parent) { await db.query('ROLLBACK'); return { status: 'not_found' as const }; }
      const latest = (await db.query('SELECT max(revision) AS revision FROM report_revisions WHERE candidate_id=$1', [candidateId])).rows[0].revision;
      if (candidate.state !== 'confirmed' || parent.revision !== latest) { await db.query('ROLLBACK'); return { status: 'conflict' as const, reason: candidate.state !== 'confirmed' ? 'not_confirmed' : 'stale_parent' }; }
      const facts = (parent.content as ReportContent).facts;
      const redactor = await redactorFor(this.repo, facts.runId);
      const narrative = documentationReport.parse(redactor.deep(input.narrative));
      const problem = narrativeProblem(narrative, facts, 'operator');
      if (problem) { await db.query('ROLLBACK'); return { status: 'invalid' as const, problem }; }
      const content = reportContent.parse({ v: 1, facts, narrative });
      if (redactor.leaks(content)) throw new Error('Redaction incomplete');
      if (hashContent(content) === parent.content_hash) { await db.query('ROLLBACK'); return { status: 'unchanged' as const, revision: view(parent) }; }
      const id = await insertRevision(db, { candidateId, evidenceRevision: parent.evidence_revision, author: 'operator', content, fingerprint: parent.sequence_fingerprint });
      const created = view((await db.query('SELECT * FROM report_revisions WHERE id=$1', [id])).rows[0]);
      await db.query('COMMIT');
      return { status: 'ok' as const, revision: created };
    } catch (error) { await db.query('ROLLBACK'); throw error; } finally { db.release(); }
  }
  // Approval is separate from confirmation and, like export approval, needs current evidence integrity.
  approve(candidateId: string, id: string, contentHash: string) {
    return this.repo.gatedConfirmed(candidateId, async db => {
      const row = (await db.query('SELECT * FROM report_revisions WHERE id=$1 AND candidate_id=$2 FOR UPDATE', [id, candidateId])).rows[0];
      if (!row) return { status: 'not_found' as const };
      const latest = (await db.query('SELECT max(revision) AS revision FROM report_revisions WHERE candidate_id=$1', [candidateId])).rows[0].revision;
      if (row.revision !== latest) return { status: 'conflict' as const, reason: 'superseded' };
      if (row.content_hash !== contentHash || hashContent(row.content) !== row.content_hash) return { status: 'conflict' as const, reason: 'content_changed' };
      const approved = (await db.query("UPDATE report_revisions SET approved_at=COALESCE(approved_at,now()),approved_by=COALESCE(approved_by,'operator') WHERE id=$1 RETURNING *", [id])).rows[0];
      return { status: 'ok' as const, revision: view(approved) };
    });
  }
  // The approved download: only the current revision, only while its approval stands and evidence is still intact.
  approved(candidateId: string) {
    return this.repo.gatedConfirmed(candidateId, async db => {
      const row = (await db.query('SELECT * FROM report_revisions WHERE candidate_id=$1 ORDER BY revision DESC LIMIT 1', [candidateId])).rows[0];
      return row?.approved_at && !row.approval_invalidated_at && hashContent(row.content) === row.content_hash ? { status: 'ok' as const, revision: view(row) } : { status: 'unapproved' as const };
    });
  }
}

export function renderReportMarkdown(revision: Pick<ReportRevisionView, 'findingId' | 'revision' | 'contentHash' | 'content' | 'approval'>) {
  const { facts, narrative } = revision.content, list = (items: string[]) => items.length ? items.map(item => `- ${item}`).join('\n') : '- None recorded';
  return [`# ${narrative.title}`, '',
    `| Field | Value |\n| --- | --- |\n| Finding ID | ${facts.findingId} |\n| Severity | ${narrative.severity.level} |\n| Category | ${facts.category} |\n| Target / version | ${facts.target.name} / ${facts.target.version ?? 'unknown'} |\n| Status | ${facts.status} |\n| Regression | ${facts.regression} |\n| Confirmation | ${facts.basis ?? 'unconfirmed'} |`,
    '', '## Severity rationale', narrative.severity.rationale, '', '## Clinical impact', narrative.clinicalImpact, '', '## Description', narrative.description,
    '', '## Expected behavior', narrative.expectedBehavior.text, `_Cites: ${narrative.expectedBehavior.citations.join(', ')}_`,
    '', '## Observed behavior', narrative.observedBehavior.text, ...narrative.observedBehavior.quotes.map(quote => `> ${flat(quote)}`), `_Cites: ${narrative.observedBehavior.citations.join(', ')}_`,
    '', '## Minimal reproduction', ...facts.reproduction.map(step => `${step.step}. (${step.kind}${step.attachment ? `: ${step.attachment.documentType} ${step.attachment.artifactId}` : ''}) ${step.instruction}`), ...narrative.reproductionNotes.map(note => `\n_Note: ${note}_`),
    '', '## Remediation', list(narrative.remediation), '', '## Uncertainty and limits', list([...narrative.uncertainty, ...facts.verdict.materialUncertainties]),
    '', '## Evidence excerpts', ...facts.evidence.map(item => `**${item.ref}** (${item.status})\n\n> ${flat(item.excerpt)}`),
    '', '## Fix-validation history', facts.validationHistory.length ? facts.validationHistory.map(item => `- run ${item.runId} version ${item.version ?? 'unknown'}: ${item.outcome ?? 'unknown'}`).join('\n') : '- No later validation run recorded',
    '', `---\nRevision ${revision.revision}, content hash ${revision.contentHash}${revision.approval ? `, approved ${new Date(revision.approval.approvedAt).toISOString()}` : ', not approved'}.`].join('\n');
}
