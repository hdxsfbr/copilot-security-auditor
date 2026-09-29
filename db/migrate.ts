import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

export async function migrate(pool: pg.Pool) {
  const names = ['001_initial.sql', '002_findings.sql', '003_starter_cases.sql', '004_chart_context_case.sql', '005_model_spend.sql', '006_adaptive.sql', '007_schedules.sql', '008_migration_ledger.sql', '009_candidate_integrity.sql', '010_case_lifecycle.sql', '011_versioned_starter_matrix.sql'];
  for (const name of names) {
    const db = await pool.connect();
    try {
      await db.query('BEGIN');
      await db.query('SELECT pg_advisory_xact_lock(728451903)');
      await db.query('CREATE TABLE IF NOT EXISTS schema_migrations(name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
      if (!(await db.query('SELECT 1 FROM schema_migrations WHERE name=$1', [name])).rowCount) {
        const sql = await readFile(fileURLToPath(new URL(`./migrations/${name}`, import.meta.url)), 'utf8');
        await db.query(sql);
        await db.query('INSERT INTO schema_migrations(name) VALUES ($1)', [name]);
      }
      await db.query('COMMIT');
    } catch (error) { await db.query('ROLLBACK'); throw error; }
    finally { db.release(); }
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  migrate(pool).then(() => pool.end()).catch(() => { console.error('Migration failed'); process.exitCode = 1; void pool.end(); });
}
