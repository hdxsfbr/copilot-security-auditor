-- G02: bounded regression suites and the opt-in version-change trigger.
-- A suite replays confirmed regression identities against one target, one run at a time through the ordinary target reservation.
-- Nothing here deploys, patches or retries: an item whose run ends blocked or incomplete keeps that result and is never re-run.
CREATE TABLE IF NOT EXISTS regression_suites (
  id uuid PRIMARY KEY,
  seq bigserial NOT NULL UNIQUE,
  target_id uuid NOT NULL REFERENCES targets(id),
  -- 'manual': started by an operator (replays record trigger 'suite'); 'version_change': the opt-in trigger (replays record 'version_change').
  trigger text NOT NULL CHECK (trigger IN ('manual','version_change')),
  -- The version the operator named, or the newly observed verified version that fired the trigger. It is a label only:
  -- every item records the version its own run observed, and states are derived from those observations.
  expected_version text,
  state text NOT NULL DEFAULT 'active' CHECK (state IN ('active','completed','stopped')),
  settings jsonb NOT NULL,
  model_snapshot jsonb NOT NULL,
  max_minutes integer NOT NULL CHECK (max_minutes BETWEEN 1 AND 240),
  omitted_count integer NOT NULL DEFAULT 0 CHECK (omitted_count >= 0),
  stop_requested boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  CHECK (trigger <> 'version_change' OR expected_version IS NOT NULL)
);
-- At most one automatic suite for each (target, verified version), whatever order finishing runs arrive in.
CREATE UNIQUE INDEX IF NOT EXISTS regression_suites_version_once ON regression_suites(target_id, expected_version) WHERE trigger = 'version_change';
CREATE INDEX IF NOT EXISTS regression_suites_active ON regression_suites(target_id, seq) WHERE state = 'active';

-- One row per selected identity, created with the suite. The replay definition is snapshotted here: if the replay case is
-- archived or its definition differs at dispatch time, the item is skipped rather than run against something else.
CREATE TABLE IF NOT EXISTS regression_suite_items (
  id uuid PRIMARY KEY,
  suite_id uuid NOT NULL REFERENCES regression_suites(id),
  ordinal integer NOT NULL CHECK (ordinal > 0),
  identity_id uuid NOT NULL REFERENCES regression_identities(id),
  regression_id uuid NOT NULL REFERENCES regressions(id),
  replay_case_id uuid REFERENCES cases(id),
  definition jsonb,
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','running','finished','skipped')),
  run_id uuid UNIQUE REFERENCES runs(id),
  outcome text,
  target_version text,
  reason text,
  started_at timestamptz,
  finished_at timestamptz,
  UNIQUE (suite_id, ordinal),
  UNIQUE (suite_id, identity_id),
  CHECK (state <> 'skipped' OR (run_id IS NULL AND reason IS NOT NULL)),
  CHECK (state <> 'finished' OR (run_id IS NOT NULL AND outcome IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS regression_suite_items_open ON regression_suite_items(suite_id, ordinal) WHERE state IN ('pending','running');

-- Opt-in, per target, disabled by default. last_seen_version is the newest verified version any finished run reported; a change
-- to it is what fires the trigger, and enabling records the current one so it never fires retroactively.
CREATE TABLE IF NOT EXISTS regression_version_triggers (
  target_id uuid PRIMARY KEY REFERENCES targets(id),
  enabled boolean NOT NULL DEFAULT false,
  settings jsonb,
  model_snapshot jsonb,
  last_seen_version text,
  last_triggered_version text,
  updated_at timestamptz NOT NULL DEFAULT now()
);
