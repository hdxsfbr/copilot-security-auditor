import type express from 'express';
import { z } from 'zod';
import { findingCorrection, reportApproval, reportAuthorization, reportJobRequest, reportRevisionEdit } from '../../../packages/contracts/src/report.js';
import { catalog, installedOllama, nanos, verifiedPrice, type Price } from '../../worker/src/models.js';
import { correctDecision, decisionHistory, findingMetadata } from './findings.js';
import { renderReportMarkdown } from './report-revisions.js';
import type { CandidateIntegrity, Repository } from './repository.js';

// F01/F02 surface: finding metadata, append-only decision history, report revisions (edit, approve, approved download)
// and the small report-job controls that sit on top of the F00 job API.
export function registerFindingRoutes(app: express.Express, repo: Repository, evidenceConflict: (res: express.Response, integrity: CandidateIntegrity) => unknown) {
  const notFound = (res: express.Response, message: string) => res.status(404).json({ v: 1, code: 'not_found', message });
  const conflict = (res: express.Response, reason: string, message: string) => res.status(409).json({ v: 1, code: 'conflict', reason, message });
  const id = (req: express.Request, name = 'id') => z.uuid().parse(req.params[name]);
  app.get('/api/findings/:id/metadata', async (req, res) => {
    const metadata = await findingMetadata(repo, id(req));
    return metadata ? res.set('Cache-Control', 'no-store').json(metadata) : notFound(res, 'Finding not found');
  });
  app.get('/api/findings/:id/history', async (req, res) => {
    const history = await decisionHistory(repo.pool, id(req));
    return history ? res.set('Cache-Control', 'no-store').json(history) : notFound(res, 'Finding not found');
  });
  app.post('/api/findings/:id/corrections', async (req, res) => {
    const result = await correctDecision(repo.pool, id(req), findingCorrection.parse(req.body));
    return result.status === 'not_found' ? notFound(res, 'Finding not found') : result.status === 'conflict' ? conflict(res, 'not_decided_or_rationale_mismatch', 'Only a decided finding can be corrected, with a rationale that fits its decision') : res.status(201).json({ id: result.id });
  });
  app.get('/api/findings/:id/report-revisions', async (req, res) => {
    const revisions = await repo.reportRevisions.list(id(req));
    return revisions ? res.set('Cache-Control', 'no-store').json({ v: 1, findingId: req.params.id, revisions }) : notFound(res, 'Finding not found');
  });
  app.get('/api/findings/:id/report-revisions/:revisionId', async (req, res) => {
    const revision = await repo.reportRevisions.get(id(req), id(req, 'revisionId'));
    return revision ? res.set('Cache-Control', 'no-store').json(revision) : notFound(res, 'Report revision not found');
  });
  app.post('/api/findings/:id/report-revisions', async (req, res) => {
    const result = await repo.reportRevisions.edit(id(req), reportRevisionEdit.parse(req.body));
    return result.status === 'not_found' ? notFound(res, 'Finding or report revision not found') : result.status === 'conflict' ? conflict(res, result.reason, 'Edit the current revision of a confirmed finding')
      : result.status === 'invalid' ? res.status(400).json({ v: 1, code: 'invalid', reason: result.problem, message: 'Edit cites or quotes evidence the finding does not contain' })
      : res.status(result.status === 'ok' ? 201 : 200).json({ ...result.revision, unchanged: result.status === 'unchanged' });
  });
  app.post('/api/findings/:id/report-revisions/:revisionId/approve', async (req, res) => {
    const result = await repo.reportRevisions.approve(id(req), id(req, 'revisionId'), reportApproval.parse(req.body).contentHash);
    return !result ? conflict(res, 'not_confirmed', 'Only confirmed findings can have an approved report')
      : 'integrityFailure' in result ? evidenceConflict(res, result.integrityFailure)
      : result.status === 'not_found' ? notFound(res, 'Report revision not found') : result.status === 'conflict' ? conflict(res, result.reason, 'Approve the exact current revision you reviewed') : res.json({ approved: true, revisionId: result.revision.id, contentHash: result.revision.contentHash, approvedAt: result.revision.approval!.approvedAt });
  });
  // The approved, redacted current revision only; `?format=markdown` renders it for download.
  app.get('/api/findings/:id/report', async (req, res) => {
    const result = await repo.reportRevisions.approved(id(req));
    if (result && 'integrityFailure' in result) return evidenceConflict(res, result.integrityFailure);
    if (!result || result.status !== 'ok') return res.status(403).json({ v: 1, code: 'forbidden', message: 'Report requires operator approval of the current revision' });
    return req.query.format === 'markdown' ? res.set({ 'Cache-Control': 'no-store', 'Content-Type': 'text/markdown; charset=utf-8' }).send(renderReportMarkdown(result.revision)) : res.set('Cache-Control', 'no-store').json(result.revision);
  });
  app.post('/api/findings/:id/report-jobs', async (req, res) => {
    const finding = id(req), input = reportJobRequest.parse(req.body ?? {});
    if (!(await repo.pool.query('SELECT 1 FROM candidates WHERE id=$1', [finding])).rowCount) return notFound(res, 'Finding not found');
    try { const job = await repo.reports.enqueue(finding, input.evidenceRevision); return res.status(job.created ? 201 : 200).json(job); }
    catch { return conflict(res, 'not_confirmed', 'Only confirmed findings can be reported'); }
  });
  app.post('/api/report-jobs/:id/authorize', async (req, res) => {
    const job = id(req), input = reportAuthorization.parse(req.body);
    const found = (await repo.pool.query("SELECT j.state,r.definition->>'ollamaUrl' AS ollama FROM report_jobs j JOIN runs r ON r.id=j.run_id WHERE j.id=$1", [job])).rows[0];
    if (!found) return notFound(res, 'Report job not found');
    if (found.state !== 'report_needed') return conflict(res, 'not_report_needed', 'Only a report-needed job can be authorized');
    try {
      let price: Price | undefined;
      if (input.model.provider === 'openrouter') price = verifiedPrice(await catalog(), input.model.model);
      else if (!found.ollama || !(await installedOllama(found.ollama)).includes(input.model.model)) throw new Error('Local Documentation model unavailable');
      const result = await repo.reports.authorize(job, { model: input.model, price, allowanceNanos: input.allowanceUsd === undefined ? 0n : nanos(input.allowanceUsd) });
      return result.status === 'ok' ? res.json({ id: job, state: 'queued' }) : result.status === 'not_found' ? notFound(res, 'Report job not found') : conflict(res, 'not_report_needed', 'Only a report-needed job can be authorized');
    } catch { return res.status(400).json({ v: 1, code: 'invalid', message: 'Documentation model, pricing or allowance unavailable' }); }
  });
  app.post('/api/report-jobs/:id/cancel', async (req, res) => {
    const result = await repo.reports.cancel(id(req));
    return result.status === 'ok' ? res.json({ state: 'cancelled', heldNanos: result.heldNanos }) : result.status === 'not_found' ? notFound(res, 'Report job not found') : conflict(res, 'not_queued', 'Only a queued report job can be cancelled');
  });
  app.post('/api/runs/:id/report-allowance/cancel', async (req, res) => {
    const run = id(req);
    return await repo.run(run) ? res.json({ released: await repo.reports.cancelAllowance(run) }) : notFound(res, 'Run not found');
  });
}
