import express from 'express';
import { z, ZodError } from 'zod';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { targetInput, targetUpdateInput, caseInput, startInput, adaptiveStart, scheduleInput, scheduleState } from '../../../packages/contracts/src/index.js';
import { Repository } from './repository.js';
import { auditArtifactVolume, storePdf, loadPdf } from './artifacts.js';
import { catalog, installedOllama, legacyRoles, snapshot } from '../../worker/src/models.js';

export function createApp(repo: Repository) {
  const app = express();
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
      if (migrations.rows[0].count !== 8) return res.status(503).json({ status: 'unavailable', database: 'migration_incomplete' });
      return res.json({ status: 'ok', database: 'ready', migrations: migrations.rows[0].count });
    } catch {
      return res.status(503).json({ status: 'unavailable', database: 'unavailable' });
    }
  });
  app.get('/api/integrity', async (_req, res) => res.json(await auditArtifactVolume(repo)));
  app.get('/api/schedules', async (_req, res) => res.json(await repo.schedules()));
  app.get('/api/schedules/:id/occurrences', async (req, res) => res.json(await repo.occurrences(z.uuid().parse(req.params.id))));
  const saveSchedule = async (body: unknown, id?: string) => {
    const definition = scheduleInput.parse(body);
    const run = definition.run.input;
    const roles = definition.run.kind === 'selected' ? definition.run.input.roles ?? legacyRoles(definition.run.input.model!) : definition.run.input.roles;
    if (!roles) throw new Error('Invalid role selection');
    if (Object.values(roles).some(role => role.provider === 'ollama')) {
      const installed = await installedOllama(run.ollamaUrl);
      if (Object.values(roles).some(role => role.provider === 'ollama' && !installed.includes(role.model))) throw new Error('Ollama model unavailable');
    }
    const models = await snapshot(roles);
    return repo.saveSchedule(definition, models, new Date(), id);
  };
  app.post('/api/schedules', async (req, res) => {
    try { return res.status(201).json(await saveSchedule(req.body)); }
    catch (error) { if (error instanceof ZodError) throw error; return res.status(400).json({ message: 'Target, case, model or pricing unavailable' }); }
  });
  app.put('/api/schedules/:id', async (req, res) => {
    try {
      const result = await saveSchedule(req.body, z.uuid().parse(req.params.id));
      return result ? res.json(result) : res.status(404).json({ message: 'Schedule not found' });
    } catch (error) { if (error instanceof ZodError) throw error; return res.status(400).json({ message: 'Target, case, model or pricing unavailable' }); }
  });
  app.patch('/api/schedules/:id', async (req, res) => {
    const result = await repo.scheduleState(z.uuid().parse(req.params.id), scheduleState.parse(req.body).paused);
    return result ? res.json(result) : res.status(404).json({ message: 'Schedule not found' });
  });
  app.delete('/api/schedules/:id', async (req, res) => (await repo.deleteSchedule(z.uuid().parse(req.params.id))) ? res.status(204).end() : res.status(404).json({ message: 'Schedule not found' }));
  app.get('/api/config', (_req, res) => res.json({ ollamaUrl: process.env.OLLAMA_URL ?? '', model: process.env.OLLAMA_MODEL ?? '' }));
  app.get('/api/models', async (_req, res) => {
    const models = process.env.OPENROUTER_API_KEY ? await catalog() : [];
    const ollama = process.env.OLLAMA_URL ? await installedOllama(process.env.OLLAMA_URL).catch(() => []) : [];
    return res.json({ openrouter: models.filter(m => !!m && typeof m === 'object' && 'id' in m && typeof m.id === 'string').map(m => (m as { id: string }).id), ollama, configured: !!process.env.OPENROUTER_API_KEY });
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
  app.post('/api/cases', async (req, res) => res.status(201).json(await repo.createCase(caseInput.parse(req.body))));
  app.put('/api/cases/:id', async (req, res) => {
    const result = await repo.updateCase(z.uuid().parse(req.params.id), caseInput.parse(req.body));
    return !result ? res.status(404).json({ message: 'Case not found' }) : 'conflict' in result ? res.status(409).json({ message: 'Case already used; create a new version' }) : 'invalid' in result ? res.status(400).json({ message: 'Artifact not linked to case' }) : res.json(result);
  });
  app.post('/api/cases/:id/artifacts', express.raw({ type: 'application/pdf', limit: '21mb' }), async (req, res) => {
    const id = z.uuid().parse(req.params.id);
    const type = z.enum(['lab_pdf', 'intake_form']).parse(req.query.documentType);
    if (!(await repo.cases()).some(c => c.id === id)) return res.status(404).json({ v: 1, code: 'not_found', message: 'Case not found' });
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
    const input = startInput.parse(req.body);
    if (input.roles && Object.values(input.roles).some(role => role.provider === 'ollama')) {
      const installed = await installedOllama(input.ollamaUrl).catch(() => null);
      if (!installed) return res.status(503).json({ v: 1, code: 'unavailable', message: 'Ollama model catalog unavailable' });
      if (Object.values(input.roles).some(role => role.provider === 'ollama' && !installed.includes(role.model))) return res.status(400).json({ v: 1, code: 'invalid', message: 'Selected Ollama model is not installed' });
    }
    let models;
    try { models = input.roles ? await snapshot(input.roles) : undefined; }
    catch { return res.status(400).json({ v: 1, code: 'invalid', message: 'OpenRouter model or verified pricing unavailable; check output bounds and provider configuration' }); }
    const result = await repo.start(input, models);
    if (!result) return res.status(404).json({ v: 1, code: 'not_found', message: 'Target or case not found' });
    if ('active_run_id' in result) return res.status(409).json({ v: 1, code: 'conflict', message: 'Target already reserved', active_run_id: result.active_run_id });
    return res.status(202).json(result);
  });
  app.post('/api/adaptive-runs', async (req, res) => {
    const input = adaptiveStart.parse(req.body);
    const installed = Object.values(input.roles).some(role => role.provider === 'ollama') ? await installedOllama(input.ollamaUrl).catch(() => null) : [];
    if (!installed || Object.values(input.roles).some(role => role.provider === 'ollama' && !installed.includes(role.model))) return res.status(400).json({ v: 1, code: 'invalid', message: 'Selected Ollama model unavailable' });
    let models;
    try { models = await snapshot(input.roles); }
    catch { return res.status(400).json({ v: 1, code: 'invalid', message: 'OpenRouter pricing or model unavailable' }); }
    try {
      const result = await repo.startAdaptive(input, models);
      if (!result) return res.status(404).json({ message: 'Target not found' });
      if ('active_run_id' in result) return res.status(409).json({ message: 'Target reserved', active_run_id: result.active_run_id });
      return res.status(202).json(result);
    } catch { return res.status(400).json({ message: 'Selected cases, categories, artifacts or budget invalid' }); }
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
    return !result ? res.status(404).json({ message: 'Finding not found' }) : 'conflict' in result ? res.status(409).json({ message: 'Decision already final' }) : res.json(result);
  });
  app.post('/api/findings/:id/approve-export', async (req, res) => {
    const result = await repo.approveExport(z.uuid().parse(req.params.id));
    return result ? res.json({ approved: true, approvedAt: result.export_approved_at }) : res.status(409).json({ message: 'Only confirmed findings can be exported' });
  });
  app.get('/api/findings/:id/export', async (req, res) => {
    const result = await repo.exportData(z.uuid().parse(req.params.id));
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
