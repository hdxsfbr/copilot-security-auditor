import express from 'express';
import { z, ZodError } from 'zod';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { targetInput, targetUpdateInput, caseInput, caseDraftInput, startInput, adaptiveStart, runDefinition, runDefinitionInput, runDefinitionEdit, runDefinitionRef, scheduleInput, scheduleDefinitionRef, scheduleState, type RunDefinition } from '../../../packages/contracts/src/index.js';
import { DefinitionRevisionConflict, Repository, type CandidateIntegrity, type RunDefinitionReference } from './repository.js';
import { auditArtifactVolume, storePdf, loadPdf } from './artifacts.js';
import { catalog, installedOllama, preflightModels } from '../../worker/src/models.js';

export function createApp(repo: Repository) {
  const app = express();
  const evidenceConflict = (res: express.Response, integrity: CandidateIntegrity) => res.status(409).json({
    v: 1, code: 'conflict', reason: 'evidence_integrity_failed',
    message: 'Required finding evidence is unavailable or changed. Restore the linked artifact and retry.',
    integrity,
  });
  const targetAllowed = (url: string) => {
    const configured = process.env.TARGET_ALLOWED_HOSTS?.split(',').map(host => host.trim().toLowerCase()).filter(Boolean) ?? [];
    if (!configured.length) return false;
    try { return configured.includes(new URL(url).hostname.toLowerCase()); } catch { return false; }
  };
  app.disable('x-powered-by');
  app.use(express.json({ limit: '32kb' }));
  app.get('/api/health', async (_req, res) => {
    try {
      await repo.pool.query('SELECT 1');
      const migrations = await repo.pool.query('SELECT count(*)::int AS count FROM schema_migrations');
      if (migrations.rows[0].count !== 12) return res.status(503).json({ status: 'unavailable', database: 'migration_incomplete' });
      return res.json({ status: 'ok', database: 'ready', migrations: migrations.rows[0].count });
    } catch {
      return res.status(503).json({ status: 'unavailable', database: 'unavailable' });
    }
  });
  app.get('/api/integrity', async (_req, res) => res.json(await auditArtifactVolume(repo)));
  app.get('/api/schedules', async (_req, res) => res.json(await repo.schedules()));
  app.get('/api/schedules/:id/occurrences', async (req, res) => res.json(await repo.occurrences(z.uuid().parse(req.params.id))));
  const preflight = (run: RunDefinition) => preflightModels(run);
  class DefinitionSelectionError extends Error { constructor(readonly code: 'not_found' | 'conflict') { super(code); } }
  const resolveDefinition = async (id: string, revision: number) => {
    const result = await repo.resolveRunDefinition(id, revision);
    if (result.status !== 'ok') throw new DefinitionSelectionError(result.status);
    return result.run;
  };
  const definitionSelectionResponse = (res: express.Response, error: DefinitionSelectionError) => res.status(error.code === 'not_found' ? 404 : 409).json({ v: 1, code: error.code, message: error.code === 'not_found' ? 'Run definition not found' : 'Run definition changed or archived; reload before continuing' });
  const saveSchedule = async (body: unknown, id?: string) => {
    const reference = scheduleDefinitionRef.safeParse(body);
    const definition = reference.success ? scheduleInput.parse({ name: reference.data.name, cadence: reference.data.cadence, weekday: reference.data.weekday,
      hour: reference.data.hour, minute: reference.data.minute, zone: reference.data.zone,
      run: await resolveDefinition(reference.data.runDefinitionId, reference.data.revision) }) : scheduleInput.parse(body);
    const checked = await preflight(definition.run);
    if (checked.status !== 'available' || !checked.models) throw new Error('Selected model unavailable');
    return repo.saveSchedule(definition, checked.models, new Date(), id, reference.success ? { id: reference.data.runDefinitionId, revision: reference.data.revision } : undefined);
  };
  app.post('/api/schedules', async (req, res) => {
    try { return res.status(201).json(await saveSchedule(req.body)); }
    catch (error) { if (error instanceof DefinitionSelectionError) return definitionSelectionResponse(res, error); if (error instanceof DefinitionRevisionConflict) return definitionSelectionResponse(res, new DefinitionSelectionError('conflict')); if (error instanceof ZodError) throw error; return res.status(400).json({ message: 'Target, case, model or pricing unavailable' }); }
  });
  app.put('/api/schedules/:id', async (req, res) => {
    try {
      const result = await saveSchedule(req.body, z.uuid().parse(req.params.id));
      return result ? res.json(result) : res.status(404).json({ message: 'Schedule not found' });
    } catch (error) { if (error instanceof DefinitionSelectionError) return definitionSelectionResponse(res, error); if (error instanceof DefinitionRevisionConflict) return definitionSelectionResponse(res, new DefinitionSelectionError('conflict')); if (error instanceof ZodError) throw error; return res.status(400).json({ message: 'Target, case, model or pricing unavailable' }); }
  });
  app.patch('/api/schedules/:id', async (req, res) => {
    const result = await repo.scheduleState(z.uuid().parse(req.params.id), scheduleState.parse(req.body).paused);
    return result ? res.json(result) : res.status(404).json({ message: 'Schedule not found' });
  });
  app.delete('/api/schedules/:id', async (req, res) => (await repo.deleteSchedule(z.uuid().parse(req.params.id))) ? res.status(204).end() : res.status(404).json({ message: 'Schedule not found' }));
  app.get('/api/config', (_req, res) => res.json({ ollamaUrl: process.env.OLLAMA_URL ?? '', model: process.env.OLLAMA_MODEL ?? '' }));
  app.get('/api/models', async (_req, res) => {
    const paidConfigured = !!process.env.OPENROUTER_API_KEY, localConfigured = !!process.env.OLLAMA_URL;
    const [paid, local] = await Promise.allSettled([paidConfigured ? catalog() : Promise.resolve([]), localConfigured ? installedOllama(process.env.OLLAMA_URL!) : Promise.resolve([])]);
    const models = paid.status === 'fulfilled' ? paid.value : [];
    return res.json({ openrouter: models.filter(m => !!m && typeof m === 'object' && 'id' in m && typeof m.id === 'string').map(m => (m as { id: string }).id), ollama: local.status === 'fulfilled' ? local.value : [], configured: paidConfigured, inferenceHealth: 'unverified',
      availability: { openrouter: !paidConfigured ? 'not_configured' : paid.status === 'fulfilled' ? 'available' : 'unavailable', ollama: !localConfigured ? 'not_configured' : local.status === 'fulfilled' ? 'available' : 'unavailable' } });
  });
  app.post('/api/model-preflight', async (req, res) => {
    const checked = await preflight(runDefinition.parse(req.body));
    const { models: _models, ...result } = checked;
    return res.json(result);
  });
  const dispatchRun = async (run: RunDefinition, res: express.Response, reference?: RunDefinitionReference) => {
    const checked = await preflight(run);
    if (checked.status !== 'available' || !checked.models) {
      const offline = checked.issues.some(issue => issue.code.endsWith('unavailable'));
      const message = checked.issues.some(issue => issue.code === 'local_catalog_unavailable') ? 'Ollama model catalog unavailable' :
        checked.issues.some(issue => issue.code === 'paid_catalog_or_pricing_unavailable') ? 'OpenRouter catalog or verified pricing unavailable' :
        'Selected Ollama model is not installed';
      return res.status(offline ? 503 : 400).json({ v: 1, code: offline ? 'unavailable' : 'invalid', message, issues: checked.issues });
    }
    try {
      const result = run.kind === 'selected' ? await repo.start(run.input, checked.models, reference) : await repo.startAdaptive(run.input, checked.models, reference);
      if (!result) return res.status(404).json({ v: 1, code: 'not_found', message: 'Target or case not found' });
      if ('active_run_id' in result) return res.status(409).json({ v: 1, code: 'conflict', message: 'Target already reserved', active_run_id: result.active_run_id });
      return res.status(202).json(result);
    } catch (error) { if (error instanceof DefinitionRevisionConflict) return definitionSelectionResponse(res, new DefinitionSelectionError('conflict')); return res.status(400).json({ v: 1, code: 'invalid', message: 'Selected cases, categories, artifacts or budget invalid' }); }
  };
  app.get('/api/run-definitions', async (_req, res) => res.set('Cache-Control', 'no-store').json(await repo.runDefinitions()));
  app.get('/api/run-definitions/:id', async (req, res) => {
    const found = await repo.runDefinition(z.uuid().parse(req.params.id));
    return found ? res.set('Cache-Control', 'no-store').json(found) : res.status(404).json({ v: 1, code: 'not_found', message: 'Run definition not found' });
  });
  app.post('/api/run-definitions', async (req, res) => res.status(201).json(await repo.createRunDefinition(runDefinitionInput.parse(req.body))));
  app.put('/api/run-definitions/:id', async (req, res) => {
    const { revision, ...input } = runDefinitionEdit.parse(req.body);
    const result = await repo.editRunDefinition(z.uuid().parse(req.params.id), revision, input);
    return result.status === 'ok' ? res.json(result.value) : definitionSelectionResponse(res, new DefinitionSelectionError(result.status));
  });
  app.delete('/api/run-definitions/:id', async (req, res) => {
    const { revision } = runDefinitionRef.parse(req.body);
    const result = await repo.archiveRunDefinition(z.uuid().parse(req.params.id), revision);
    return result.status === 'ok' ? res.json(result.value) : definitionSelectionResponse(res, new DefinitionSelectionError(result.status));
  });
  app.post('/api/run-definitions/:id/launch', async (req, res) => {
    try {
      const reference = { id: z.uuid().parse(req.params.id), revision: runDefinitionRef.parse(req.body).revision };
      return dispatchRun(await resolveDefinition(reference.id, reference.revision), res, reference);
    }
    catch (error) { if (error instanceof DefinitionSelectionError) return definitionSelectionResponse(res, error); throw error; }
  });
  app.get('/api/targets', async (_req, res) => res.json(await repo.targets()));
  app.post('/api/targets', async (req, res) => {
    const input = targetInput.parse(req.body);
    if (!targetAllowed(input.baseUrl)) return res.status(400).json({ v: 1, code: 'invalid', message: 'Target host is not in TARGET_ALLOWED_HOSTS' });
    return res.status(201).json(await repo.target(input));
  });
  app.get('/api/targets/:id/edit', async (req, res) => {
    const target = await repo.targetForEdit(z.uuid().parse(req.params.id));
    return target ? res.set('Cache-Control', 'no-store').json(target) : res.status(404).json({ v: 1, code: 'not_found', message: 'Target not found' });
  });
  app.put('/api/targets/:id', async (req, res) => {
    const input = targetUpdateInput.parse(req.body);
    if (!targetAllowed(input.baseUrl)) return res.status(400).json({ v: 1, code: 'invalid', message: 'Target host is not in TARGET_ALLOWED_HOSTS' });
    const result = await repo.updateTarget(z.uuid().parse(req.params.id), input);
    if (!result) return res.status(404).json({ v: 1, code: 'not_found', message: 'Target not found' });
    if ('active_run_id' in result) return res.status(409).json({ v: 1, code: 'conflict', message: 'Target already reserved', active_run_id: result.active_run_id });
    return res.json(result);
  });
  app.get('/api/cases', async (_req, res) => res.json(await repo.cases()));
  app.post('/api/cases', async (req, res) => {
    const input = caseInput.parse(req.body);
    if (input.actions.some(action => action.kind === 'attach_pdf')) return res.status(400).json({ v: 1, code: 'invalid', message: 'Upload PDFs to a draft before publishing' });
    return res.status(201).json(await repo.createCase(input));
  });
  app.get('/api/cases/drafts', async (_req, res) => res.json(await repo.drafts()));
  app.get('/api/cases/archived', async (_req, res) => res.json(await repo.archivedCases()));
  app.post('/api/cases/drafts', async (req, res) => res.status(201).json(await repo.createDraft(caseDraftInput.parse(req.body))));
  app.put('/api/cases/drafts/:id', async (req, res) => {
    const result = await repo.updateDraft(z.uuid().parse(req.params.id), caseDraftInput.parse(req.body));
    return result ? res.json(result) : res.status(409).json({ v: 1, code: 'conflict', message: 'Draft unavailable or already published' });
  });
  app.post('/api/cases/drafts/:id/publish', async (req, res) => {
    const result = await repo.publishDraft(z.uuid().parse(req.params.id));
    return !result ? res.status(409).json({ v: 1, code: 'conflict', message: 'Draft unavailable or already published' }) :
      'invalid' in result ? res.status(409).json({ v: 1, code: 'conflict', reason: result.invalid, ...result }) : res.json(result);
  });
  app.get('/api/cases/:id', async (req, res) => {
    const result = await repo.caseRecord(z.uuid().parse(req.params.id));
    return result ? res.json(result) : res.status(404).json({ v: 1, code: 'not_found', message: 'Case not found' });
  });
  app.get('/api/cases/:id/versions', async (req, res) => {
    const versions = await repo.caseVersions(z.uuid().parse(req.params.id));
    return versions ? res.json(versions) : res.status(404).json({ v: 1, code: 'not_found', message: 'Case not found' });
  });
  app.get('/api/cases/:id/executions', async (req, res) => {
    const id = z.uuid().parse(req.params.id);
    if (!await repo.caseRecord(id)) return res.status(404).json({ v: 1, code: 'not_found', message: 'Case not found' });
    return res.json(await repo.caseExecutions(id));
  });
  app.post('/api/cases/:id/clone', async (req, res) => {
    const result = await repo.cloneCase(z.uuid().parse(req.params.id));
    return !result ? res.status(404).json({ v: 1, code: 'not_found', message: 'Published case not found' }) :
      'copyFailed' in result ? res.status(409).json({ v: 1, code: 'conflict', reason: 'artifact_copy_failed', draftId: result.id, message: 'Draft created; copy PDF again and publish when complete' }) : res.status(201).json(result);
  });
  app.post('/api/cases/:id/archive', async (req, res) => {
    const result = await repo.archiveCase(z.uuid().parse(req.params.id));
    return result ? res.json(result) : res.status(409).json({ v: 1, code: 'conflict', message: 'Case unavailable or already archived' });
  });
  app.put('/api/cases/:id', async (req, res) => {
    const result = await repo.updateCase(z.uuid().parse(req.params.id), caseInput.parse(req.body));
    return !result ? res.status(404).json({ message: 'Case not found' }) : 'conflict' in result ? res.status(409).json({ message: 'Case already used; create a new version' }) : 'invalid' in result ? res.status(400).json({ message: 'Artifact not linked to case' }) : res.json(result);
  });
  app.post('/api/cases/:id/artifacts', express.raw({ type: 'application/pdf', limit: '21mb' }), async (req, res) => {
    const id = z.uuid().parse(req.params.id);
    const type = z.enum(['lab_pdf', 'intake_form']).parse(req.query.documentType);
    if (!(await repo.canUploadArtifact(id))) return res.status(409).json({ v: 1, code: 'conflict', message: 'Case unavailable or published version is immutable' });
    if (!Buffer.isBuffer(req.body)) return res.status(400).json({ v: 1, code: 'invalid', message: 'PDF required' });
    try { return res.status(201).json(await storePdf(repo, id, type, req.body)); }
    catch { return res.status(400).json({ v: 1, code: 'invalid', message: 'PDF invalid or over limit' }); }
  });
  app.get('/api/cases/:id/artifacts/:artifactId', async (req, res) => {
    const caseId = z.uuid().parse(req.params.id), artifactId = z.uuid().parse(req.params.artifactId);
    const type = z.enum(['lab_pdf', 'intake_form']).parse(req.query.documentType);
    try { return res.set({ 'Content-Type': 'application/pdf', 'Content-Disposition': 'attachment; filename="synthetic-evidence.pdf"', 'Cache-Control': 'no-store' }).send(await loadPdf(repo, caseId, artifactId, type)); }
    catch { return res.status(404).json({ message: 'Artifact unavailable or integrity failed' }); }
  });
  app.post('/api/runs', async (req, res) => {
    return dispatchRun({ kind: 'selected', input: startInput.parse(req.body) }, res);
  });
  app.post('/api/adaptive-runs', async (req, res) => {
    return dispatchRun({ kind: 'adaptive', input: adaptiveStart.parse(req.body) }, res);
  });
  app.post('/api/runs/:id/stop', async (req, res) => {
    return (await repo.stop(z.uuid().parse(req.params.id))) ? res.status(202).json({ stopRequested: true }) : res.status(409).json({ message: 'No active adaptive run' });
  });
  app.get('/api/runs/:id/cases', async (req, res) => res.json(await repo.adaptiveCases(z.uuid().parse(req.params.id))));
  app.get('/api/runs/:id', async (req, res) => {
    const run = await repo.run(z.uuid().parse(req.params.id));
    return run ? res.json(run) : res.status(404).json({ v: 1, code: 'not_found', message: 'Run not found' });
  });
  app.get('/api/runs/:id/events', async (req, res) => res.json(await repo.events(z.uuid().parse(req.params.id))));
  app.get('/api/runs/:id/usage', async (req, res) => res.json(await repo.usage(z.uuid().parse(req.params.id))));
  app.get('/api/candidates', async (_req, res) => res.json(await repo.candidates()));
  app.get('/api/findings', async (_req, res) => res.json(await repo.findings()));
  app.get('/api/findings/:id/integrity', async (req, res) => {
    const integrity = await repo.candidateIntegrity(z.uuid().parse(req.params.id));
    return integrity ? res.set('Cache-Control', 'no-store').json(integrity) : res.status(404).json({ v: 1, code: 'not_found', message: 'Finding not found' });
  });
  app.get('/api/regressions', async (_req, res) => res.json(await repo.regressions()));
  app.post('/api/regressions/:id/select', async (req, res) => {
    try {
      const result = await repo.selectRegression(z.uuid().parse(req.params.id));
      return result ? res.json(result) : res.status(404).json({ message: 'Regression not found' });
    } catch { return res.status(409).json({ message: 'Regression evidence or attachment unavailable' }); }
  });
  app.get('/api/coverage', async (_req, res) => res.json(await repo.coverage()));
  app.post('/api/findings/:id/review', async (req, res) => {
    const result = await repo.review(z.uuid().parse(req.params.id), z.enum(['confirm', 'reject']).parse(req.body?.decision));
    return !result ? res.status(404).json({ message: 'Finding not found' }) : 'integrityFailure' in result && result.integrityFailure ? evidenceConflict(res, result.integrityFailure) : 'conflict' in result ? res.status(409).json({ message: 'Decision already final' }) : res.json(result);
  });
  app.post('/api/findings/:id/approve-export', async (req, res) => {
    const result = await repo.approveExport(z.uuid().parse(req.params.id));
    return !result ? res.status(409).json({ message: 'Only confirmed findings can be exported' }) : 'integrityFailure' in result && result.integrityFailure ? evidenceConflict(res, result.integrityFailure) : res.json({ approved: true, approvedAt: result.export_approved_at });
  });
  app.get('/api/findings/:id/export', async (req, res) => {
    const result = await repo.exportData(z.uuid().parse(req.params.id));
    if (result && 'integrityFailure' in result && result.integrityFailure) return evidenceConflict(res, result.integrityFailure);
    if (!result?.export_approved_at) return res.status(403).json({ message: 'Export requires operator approval' });
    const definition = caseInput.parse(result.definition);
    return res.set('Cache-Control', 'no-store').json({ v: 1, findingId: req.params.id, sourceRunId: result.run_id, targetVersion: 'Withheld in shared export; see restricted run evidence', category: definition.category ?? 'prompt_injection',
      impact: 'Confirmed user-facing trust-boundary violation; inspect private run evidence for patient-specific details.',
      reproduction: definition.actions.map((a, index) => ({ step: index + 1, action: a.kind, instruction: 'Replay this step from the restricted case definition; patient details and document contents are omitted from shared exports.' })),
      expected: 'The Co-Pilot must maintain the case-defined safety boundary.', observed: 'Confirmed violation; patient-specific response omitted from shared export.', approvedAt: result.export_approved_at });
  });
  const dist = fileURLToPath(new URL('../../../dist/web/', import.meta.url));
  if (existsSync(dist)) { app.use(express.static(dist)); app.get(/^(?!\/api\/).*/, (_req, res) => res.sendFile('index.html', { root: dist })); }
  app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    if (err instanceof ZodError) return res.status(400).json({ v: 1, code: 'invalid', message: 'Invalid request', issues: err.issues.map(i => ({ path: i.path, code: i.code })) });
    console.error('Request failed (details suppressed)');
    return res.status(500).json({ v: 1, code: 'internal', message: 'Request failed' });
  });
  return app;
}
