import express from 'express';
import { z, ZodError } from 'zod';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { targetInput, targetUpdateInput, caseInput, startInput } from '../../../packages/contracts/src/index.js';
import { Repository } from './repository.js';
import { storePdf, loadPdf } from './artifacts.js';
import { catalog, installedOllama, snapshot } from '../../worker/src/models.js';

export function createApp(repo: Repository) {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '32kb' }));
  app.get('/api/health', (_req, res) => res.json({ status: 'ok' }));
  app.get('/api/config', (_req, res) => res.json({ ollamaUrl: process.env.OLLAMA_URL ?? '', model: process.env.OLLAMA_MODEL ?? '' }));
  app.get('/api/models', async (_req, res) => {
    const models = process.env.OPENROUTER_API_KEY ? await catalog() : [];
    const ollama = process.env.OLLAMA_URL ? await installedOllama(process.env.OLLAMA_URL).catch(() => []) : [];
    return res.json({ openrouter: models.filter(m => !!m && typeof m === 'object' && 'id' in m && typeof m.id === 'string').map(m => (m as { id: string }).id), ollama, configured: !!process.env.OPENROUTER_API_KEY });
  });
  app.get('/api/targets', async (_req, res) => res.json(await repo.targets()));
  app.post('/api/targets', async (req, res) => res.status(201).json(await repo.target(targetInput.parse(req.body))));
  app.get('/api/targets/:id/edit', async (req, res) => {
    const target = await repo.targetForEdit(z.uuid().parse(req.params.id));
    return target ? res.set('Cache-Control', 'no-store').json(target) : res.status(404).json({ v: 1, code: 'not_found', message: 'Target not found' });
  });
  app.put('/api/targets/:id', async (req, res) => {
    const result = await repo.updateTarget(z.uuid().parse(req.params.id), targetUpdateInput.parse(req.body));
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
  app.get('/api/runs/:id', async (req, res) => {
    const run = await repo.run(z.uuid().parse(req.params.id));
    return run ? res.json(run) : res.status(404).json({ v: 1, code: 'not_found', message: 'Run not found' });
  });
  app.get('/api/runs/:id/events', async (req, res) => res.json(await repo.events(z.uuid().parse(req.params.id))));
  app.get('/api/runs/:id/usage', async (req, res) => res.json(await repo.usage(z.uuid().parse(req.params.id))));
  app.get('/api/candidates', async (_req, res) => res.json(await repo.candidates()));
  app.get('/api/findings', async (_req, res) => res.json(await repo.findings()));
  app.get('/api/regressions', async (_req, res) => res.json(await repo.regressions()));
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
