import pg from 'pg';
import { migrate } from '../../../db/migrate.js';
import { createApp } from './app.js';
import { Repository } from './repository.js';

const host = process.env.LAN_HOST;
if (!host || (['0.0.0.0', '::'].includes(host) && process.env.CONTAINER_BIND !== 'true')) throw new Error('Set LAN_HOST to a trusted LAN address (or 127.0.0.1 for local development)');
if (!process.env.CREDENTIAL_KEY) throw new Error('CREDENTIAL_KEY required');
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
await migrate(pool);
const repo = new Repository(pool);
createApp(repo).listen(Number(process.env.PORT ?? 3000), host, () => console.log(`Control plane listening on ${host}`));
const tick = () => { void repo.tick().catch(() => console.error('Scheduler tick failed (details suppressed)')); };
tick();
setInterval(tick, 15000);
