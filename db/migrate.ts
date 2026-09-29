import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

export async function migrate(pool: pg.Pool) {
  const sql = await readFile(fileURLToPath(new URL('./migrations/001_initial.sql', import.meta.url)), 'utf8');
  await pool.query(sql);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  migrate(pool).then(() => pool.end()).catch(() => { console.error('Migration failed'); process.exitCode = 1; void pool.end(); });
}
