import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { migrate, migrationNames } from '../../db/migrate.js';
import { database } from '../support.js';
import { migration024Indexes, queryCatalog } from './index-evidence.js';
import { seedScale } from './scale-seed.js';

// Migration 024 (HDX-32 / P01): it is registered, it applies, its indexes exist, and each one is one the planner can really use for a
// query the product issues. The premise that only those reads exist (severity is projected, never filtered) is guarded too, so a
// future severity or category predicate is noticed and indexed deliberately instead of silently scanning.

const src = (path: string) => readFile(new URL(`../../${path}`, import.meta.url), 'utf8');

test('[P01] migration 024 is registered last and every registered migration exists on disk', async () => {
  assert.equal(migrationNames.at(-1), '024_severity_category_indexes.sql');
  const onDisk = new Set(await readdir(new URL('../../db/migrations/', import.meta.url)));
  for (const name of migrationNames) assert.ok(onDisk.has(name), `${name} is registered but missing`);
  assert.equal(new Set(migrationNames).size, migrationNames.length, 'no migration is registered twice');
});

test('[P01] migration 024 applies, is idempotent, and creates exactly the indexes it documents', async () => {
  const db = await database(); // applies every registered migration, 024 included
  try {
    const ledger = (await db.repo.pool.query("SELECT count(*)::int AS count FROM schema_migrations WHERE name='024_severity_category_indexes.sql'")).rows[0].count;
    assert.equal(ledger, 1);
    const defined = async () => Object.fromEntries((await db.repo.pool.query("SELECT indexname, indexdef FROM pg_indexes WHERE indexname = ANY($1::text[])", [[...migration024Indexes]])).rows.map(row => [row.indexname, row.indexdef as string]));
    const indexes = await defined();
    assert.deepEqual(Object.keys(indexes).sort(), [...migration024Indexes].sort());
    assert.match(indexes.adaptive_cases_executed_category, /ON public\.adaptive_cases USING btree \(category, state\) WHERE executed/);
    assert.match(indexes.runs_target_version, /ON public\.runs USING btree \(target_id, version\)$/);
    assert.match(indexes.runs_finished_version, /ON public\.runs USING btree \(target_id, finished_at DESC\) WHERE \(\(status = 'finished'::text\) AND \(version IS NOT NULL\)\)/);
    // Running the migration again (same ledger) and re-running its SQL directly must both be no-ops.
    await migrate(db.repo.pool);
    await db.repo.pool.query(await src('db/migrations/024_severity_category_indexes.sql'));
    assert.deepEqual(await defined(), indexes);
    assert.equal((await db.repo.pool.query('SELECT count(*)::int AS count FROM schema_migrations')).rows[0].count, migrationNames.length);
  } finally { await db.close(); }
});

test('[P01] each index is usable by the product query it was added for (planner choice with sequential scans disabled)', async () => {
  const db = await database();
  try {
    await seedScale(db.repo.pool, { runs: 4000, cases: 20, targets: 4 });
    const catalog = await queryCatalog(db.repo.pool);
    const checked = new Set<string>();
    for (const entry of catalog.filter(item => item.uses.length)) {
      const client = await db.repo.pool.connect();
      try {
        await client.query('BEGIN');
        await client.query('SET LOCAL enable_seqscan = off');
        const plan = JSON.stringify((await client.query(`EXPLAIN (FORMAT JSON) ${entry.sql}`, entry.params)).rows[0]['QUERY PLAN']);
        for (const index of entry.uses) { assert.ok(plan.includes(`"Index Name":"${index}"`), `${entry.name} should be able to use ${index}`); checked.add(index); }
      } finally { await client.query('ROLLBACK'); client.release(); }
    }
    assert.deepEqual([...checked].sort(), [...migration024Indexes].sort(), 'every index in migration 024 is exercised by at least one real query');
  } finally { await db.close(); }
});

test('[P01] premise guard: severity is read by one projection and never filtered; category is filtered in exactly one place', async () => {
  const listing = async (dir: string) => (await readdir(new URL(`../../${dir}`, import.meta.url))).filter(name => name.endsWith('.ts')).map(name => `${dir}${name}`);
  const files = [...await listing('apps/api/src/'), ...await listing('apps/worker/src/')];
  const severityExtractions: string[] = [], categoryPredicates: string[] = [];
  for (const file of files) {
    const text = await src(file);
    // Severity exists only inside JSONB (case rubric, report revision), so any SQL that filters on it must extract it with ->> or #>>.
    for (const match of text.matchAll(/(?:->>|#>>)\s*'\{?severity\}?'/g)) severityExtractions.push(`${file}: ${text.slice(Math.max(0, match.index! - 24), match.index! + match[0].length + 40).replace(/\s+/g, ' ')}`);
    // A SQL category predicate compares a column or a JSON path with a parameter or a literal; TypeScript comparisons use === and never match.
    for (const match of text.matchAll(/(?:->>'category'|\b(?:[a-z]{1,3}\.)?category)\s*(?:=|<>|!=)\s*(?:\$\d|')/g)) categoryPredicates.push(`${file}: ${match[0]}`);
  }
  assert.equal(severityExtractions.length, 1, `severity is read by exactly one SQL statement: ${JSON.stringify(severityExtractions)}`);
  assert.match(severityExtractions[0], /^apps\/api\/src\/exploration\.ts: .*->>'severity'.*,'unknown'\) AS severity/, 'and it only projects severity (COALESCE(..., \'unknown\') AS severity), it does not filter on it');
  for (const name of migrationNames) assert.doesNotMatch(await src(`db/migrations/${name}`), /ADD COLUMN[^;]*\bseverity\b|\bseverity\s+(?:text|integer|smallint|varchar)/i, `${name} adds no severity column`);
  assert.deepEqual(categoryPredicates, ['apps/api/src/regression-identity.ts: i.category=$3'], 'category is filtered in SQL only by the regression identity list');
});
