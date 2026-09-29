import type express from 'express';
import { z } from 'zod';
import { regressionIdentityQuery } from '../../../packages/contracts/src/regressions.js';
import { listRegressionIdentities, regressionIdentityLineage } from './regression-identity.js';
import type { Repository } from './repository.js';

// G01 surface: regression identities with their source findings and explicit replay lineage. The older /api/regressions
// endpoints stay per-finding for the current page; G02 suites build on these.
export function registerRegressionRoutes(app: express.Express, repo: Repository) {
  app.get('/api/regression-identities', async (req, res) => {
    const query = regressionIdentityQuery.safeParse(req.query);
    if (!query.success) return res.status(400).json({ v: 1, code: 'invalid', message: 'Invalid regression identity query' });
    return res.set('Cache-Control', 'no-store').json(await listRegressionIdentities(repo.pool, query.data));
  });
  app.get('/api/regression-identities/:id', async (req, res) => {
    const detail = await regressionIdentityLineage(repo.pool, z.uuid().parse(req.params.id));
    return detail ? res.set('Cache-Control', 'no-store').json(detail) : res.status(404).json({ v: 1, code: 'not_found', message: 'Regression identity not found' });
  });
}
