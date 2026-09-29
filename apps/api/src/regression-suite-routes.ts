import type express from 'express';
import { z } from 'zod';
import { runDefinition } from '../../../packages/contracts/src/index.js';
import { suiteLaunch, suiteQuery, suiteSettings, versionTriggerInput, type SuiteSettings } from '../../../packages/contracts/src/regression-suites.js';
import { preflightModels } from '../../worker/src/models.js';
import type { Repository } from './repository.js';

// A suite's item runs are ordinary selected runs (Judge only), so preflight checks exactly what each item will use.
const asRun = (targetId: string, settings: Pick<SuiteSettings, 'roles' | 'ollamaUrl' | 'openRouterCapUsd'>) => runDefinition.parse({ kind: 'selected', input: { targetId, caseId: '00000000-0000-4000-8000-000000000000', roles: settings.roles, ollamaUrl: settings.ollamaUrl, openRouterCapUsd: settings.openRouterCapUsd } });
const invalid = (res: express.Response, message: string) => res.status(400).json({ v: 1, code: 'invalid', message });

// G02 surface: bounded regression suites and the opt-in version-change trigger. Nothing here deploys or patches a target.
export function registerRegressionSuiteRoutes(app: express.Express, repo: Repository) {
  const checked = async (res: express.Response, targetId: string, settings: SuiteSettings) => {
    const result = await preflightModels(asRun(targetId, settings));
    if (result.status === 'available' && result.models) return result.models;
    const offline = result.issues.some(issue => issue.code.endsWith('unavailable'));
    res.status(offline ? 503 : 400).json({ v: 1, code: offline ? 'unavailable' : 'invalid', message: 'Selected models unavailable for the suite', issues: result.issues });
    return null;
  };
  app.post('/api/regression-suites/preflight', async (req, res) => {
    const input = suiteLaunch.parse(req.body);
    const { models: _models, ...result } = await preflightModels(asRun(input.targetId, input));
    return res.json(result);
  });
  app.post('/api/regression-suites', async (req, res) => {
    const input = suiteLaunch.parse(req.body);
    const models = await checked(res, input.targetId, input);
    if (!models) return;
    const made = await repo.suites.create(input, models);
    if (made.status === 'reserved') return res.status(409).json({ v: 1, code: 'conflict', message: 'Target already reserved', active_run_id: made.activeRunId });
    if (made.status === 'not_found') return res.status(404).json({ v: 1, code: 'not_found', message: 'Target or regression identity not found' });
    if (made.status !== 'created') return invalid(res, 'No confirmed regression identities to replay');
    return res.status(202).json(await repo.suites.detail(made.id));
  });
  app.get('/api/regression-suites', async (req, res) => {
    const query = suiteQuery.safeParse(req.query);
    return query.success ? res.set('Cache-Control', 'no-store').json(await repo.suites.list(query.data)) : invalid(res, 'Invalid suite query');
  });
  app.get('/api/regression-suites/:id', async (req, res) => {
    const detail = await repo.suites.detail(z.uuid().parse(req.params.id));
    return detail ? res.set('Cache-Control', 'no-store').json(detail) : res.status(404).json({ v: 1, code: 'not_found', message: 'Regression suite not found' });
  });
  app.post('/api/regression-suites/:id/stop', async (req, res) => {
    const stopped = await repo.suites.stop(z.uuid().parse(req.params.id));
    return stopped === null ? res.status(404).json({ v: 1, code: 'not_found', message: 'Regression suite not found' })
      : stopped === 'finished' ? res.status(409).json({ v: 1, code: 'conflict', message: 'Suite already finished' }) : res.status(202).json(stopped);
  });
  app.get('/api/regression-triggers', async (_req, res) => res.set('Cache-Control', 'no-store').json(await repo.suites.triggers()));
  app.put('/api/regression-triggers/:targetId', async (req, res) => {
    const targetId = z.uuid().parse(req.params.targetId), input = versionTriggerInput.parse(req.body);
    const models = input.enabled ? await checked(res, targetId, input.settings) : undefined;
    if (input.enabled && !models) return;
    const trigger = await repo.suites.setTrigger(targetId, input.enabled ? input.settings : null, models ?? undefined);
    return trigger ? res.json(trigger) : res.status(404).json({ v: 1, code: 'not_found', message: 'Target not found' });
  });
}
