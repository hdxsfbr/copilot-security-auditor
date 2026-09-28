import pg from 'pg';
import { Repository } from '../../api/src/repository.js';
import { processNext } from './process.js';

if (!process.env.CREDENTIAL_KEY) throw new Error('CREDENTIAL_KEY required');
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const repo = new Repository(pool);
for (;;) {
  try { await processNext(repo); }
  catch { console.error('Worker cycle failed (details suppressed)'); }
  await new Promise(resolve => setTimeout(resolve, 1500));
}
