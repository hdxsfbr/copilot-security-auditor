-- P01 (HDX-32): indexes for the category and target-version read paths, each chosen from EXPLAIN evidence on a synthetic
-- database of 100,000 runs (evals/results/performance/2026-09-30/query-plan-evidence.json; repeat with
-- `npm run perf:plans`). An index is here only because the planner chooses it for a query the product really issues.
--
-- Severity is deliberately NOT indexed. It exists only in case-definition JSONB (definition->'rubric'->>'severity') and in report
-- revisions, and the one SQL read of it (apps/api/src/exploration.ts, the unresolved-finding scan) projects it without filtering
-- on it, so no index could serve that read. tests/performance/migration-024.test.ts fails if a severity or category predicate is
-- ever added to the product's SQL, which is the moment an expression index on it becomes justified.
-- Expression indexes on definition->'case'->>'category' were measured and rejected the same way: category is grouped, never
-- filtered, on runs, and PostgreSQL cannot answer a GROUP BY from an expression index without reading the heap.
--
-- Plain CREATE INDEX (not CONCURRENTLY) because the migration runner wraps each file in a transaction; the tables are small
-- at the scales this service is sized for (100K runs builds in well under a second).

-- Category: adaptive execution cases carry category and outcome state as real columns. The all-cases coverage summary
-- (repository.ts coverage()) reads exactly (category, state) of executed cases, now from this index alone (index-only scan).
CREATE INDEX IF NOT EXISTS adaptive_cases_executed_category ON adaptive_cases (category, state) WHERE executed;

-- Target version: every per-target read of runs (scoped coverage, the unresolved-finding scan behind adaptive seed selection, the
-- confirmed-finding comparison in findings.ts) filters runs by target_id, and runs had no index on it. Version is the second
-- key so a (target, observed version) scope is one contiguous range.
CREATE INDEX IF NOT EXISTS runs_target_version ON runs (target_id, version);

-- Latest verified version of a target (regression-suites.ts, enabling the version-change trigger): newest finished run that
-- observed a version, per target, without sorting the target's whole history.
CREATE INDEX IF NOT EXISTS runs_finished_version ON runs (target_id, finished_at DESC) WHERE status = 'finished' AND version IS NOT NULL;
