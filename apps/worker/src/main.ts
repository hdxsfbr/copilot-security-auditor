import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { Repository } from '../../api/src/repository.js';
import { workerCycleErrorCode } from '../../api/src/operations.js';
import { startWorkerHeartbeat } from './heartbeat.js';
import { processNext } from './process.js';
import { processNextReportJob, registerReportJobHandler } from './report-jobs.js';
import { createDocumentationHandler } from './reports.js';
import { loadEvidenceRuntime } from './evidence/runtime.js';

if (!process.env.CREDENTIAL_KEY) throw new Error('CREDENTIAL_KEY required');
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const repo = new Repository(pool);
const evidenceRuntime = loadEvidenceRuntime();
registerReportJobHandler(createDocumentationHandler(repo));
// One random identity per process start; it is also the run lease owner.
const workerId = randomUUID();
const heartbeat = startWorkerHeartbeat(pool, workerId);
for (;;) {
  try { await processNext(repo, workerId, fetch, fetch, evidenceRuntime); heartbeat.setCycleError(null); }
  catch (error) { heartbeat.setCycleError(workerCycleErrorCode(error)); console.error('Worker cycle failed (details suppressed)'); }
  try { await processNextReportJob(repo, workerId); }
  catch { console.error('Report cycle failed (details suppressed)'); }
  await new Promise(resolve => setTimeout(resolve, 1500));
}
