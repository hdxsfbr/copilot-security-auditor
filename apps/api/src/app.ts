import express from 'express';
import { z, ZodError } from 'zod';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { targetInput, caseInput, startInput } from '../../../packages/contracts/src/index.js';
import { Repository } from './repository.js';

export function createApp(repo: Repository) {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '32kb' }));
  app.get('/api/health', (_req, res) => res.json({ status: 'ok' }));
  app.get('/api/config', (_req, res) => res.json({ ollamaUrl: process.env.OLLAMA_URL ?? '', model: process.env.OLLAMA_MODEL ?? '' }));
  app.get('/api/targets', async (_req, res) => res.json(await repo.targets()));
  app.post('/api/targets', async (req, res) => res.status(201).json(await repo.target(targetInput.parse(req.body))));
  app.put('/api/targets/:id', async (req, res) => {
    const result = await repo.updateTarget(z.uuid().parse(req.params.id), targetInput.parse(req.body));
    if (!result) return res.status(404).json({ v: 1, code: 'not_found', message: 'Target not found' });
    if ('active_run_id' in result) return res.status(409).json({ v: 1, code: 'conflict', message: 'Target already reserved', active_run_id: result.active_run_id });
    return res.json(result);
  });
  app.get('/api/cases', async (_req, res) => res.json(await repo.cases()));
  app.post('/api/cases', async (req, res) => res.status(201).json(await repo.createCase(caseInput.parse(req.body))));
  app.post('/api/runs', async (req, res) => {
    const result = await repo.start(startInput.parse(req.body));
    if (!result) return res.status(404).json({ v: 1, code: 'not_found', message: 'Target or case not found' });
    if ('active_run_id' in result) return res.status(409).json({ v: 1, code: 'conflict', message: 'Target already reserved', active_run_id: result.active_run_id });
    return res.status(202).json(result);
  });
  app.get('/api/runs/:id', async (req, res) => {
    const run = await repo.run(z.uuid().parse(req.params.id));
    return run ? res.json(run) : res.status(404).json({ v: 1, code: 'not_found', message: 'Run not found' });
  });
  app.get('/api/runs/:id/events', async (req, res) => res.json(await repo.events(z.uuid().parse(req.params.id))));
  app.get('/api/candidates', async (_req, res) => res.json(await repo.candidates()));
  const dist = fileURLToPath(new URL('../../../dist/web/', import.meta.url));
  if (existsSync(dist)) { app.use(express.static(dist)); app.get(/^(?!\/api\/).*/, (_req, res) => res.sendFile('index.html', { root: dist })); }
  app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    if (err instanceof ZodError) return res.status(400).json({ v: 1, code: 'invalid', message: 'Invalid request', issues: err.issues.map(i => ({ path: i.path, code: i.code })) });
    console.error('Request failed (details suppressed)');
    return res.status(500).json({ v: 1, code: 'internal', message: 'Request failed' });
  });
  return app;
}
