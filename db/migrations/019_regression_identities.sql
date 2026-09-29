-- G01: stable regression identities and explicit replay lineage.
-- An identity is the versioned normalization of a confirmed attack sequence (rules: apps/api/src/regression-identity.ts).
-- Every confirmed finding keeps its own regressions row as evidence and is linked to the identity it normalizes to.
-- Identities are immutable: a future normalization version creates new identities instead of rewriting these.
CREATE TABLE IF NOT EXISTS regression_identities (
  id uuid PRIMARY KEY,
  seq bigserial NOT NULL UNIQUE,
  normalization_version integer NOT NULL CHECK (normalization_version > 0),
  fingerprint text NOT NULL CHECK (fingerprint ~ '^[0-9a-f]{64}$'),
  -- NULL only when the definition never recorded a category; it never merges with a categorized identity.
  category text CHECK (category IN ('prompt_injection','cross_patient','unintended_tool_action')),
  user_slot text NOT NULL CHECK (user_slot IN ('A','B')),
  canonical jsonb NOT NULL,
  first_seen_candidate_id uuid NOT NULL REFERENCES candidates(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (normalization_version, fingerprint)
);
CREATE OR REPLACE FUNCTION regression_identities_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Regression identities are immutable'; END $$;
DROP TRIGGER IF EXISTS regression_identities_immutable ON regression_identities;
CREATE TRIGGER regression_identities_immutable BEFORE UPDATE OR DELETE ON regression_identities
  FOR EACH ROW EXECUTE FUNCTION regression_identities_immutable();

-- Legacy rows are linked on first read (the normalization lives in TypeScript, never duplicated in SQL).
-- A definition that cannot be normalized stays unlinked and records why; nothing is invented for it.
ALTER TABLE regressions ADD COLUMN IF NOT EXISTS identity_id uuid REFERENCES regression_identities(id);
ALTER TABLE regressions ADD COLUMN IF NOT EXISTS identity_unlinked_reason text;
ALTER TABLE regressions DROP CONSTRAINT IF EXISTS regressions_identity_reason;
ALTER TABLE regressions ADD CONSTRAINT regressions_identity_reason CHECK (identity_id IS NULL OR identity_unlinked_reason IS NULL);
CREATE INDEX IF NOT EXISTS regressions_identity ON regressions(identity_id, created_at, id) WHERE identity_id IS NOT NULL;
-- One replay case belongs to exactly one regression, so a run of it resolves to exactly one source finding.
CREATE UNIQUE INDEX IF NOT EXISTS regressions_replay_case ON regressions(replay_case_id) WHERE replay_case_id IS NOT NULL;

-- One row per run of a regression's replay case. outcome, target_version and finished_at stay NULL until the run finishes
-- (or is stopped/expired); target_version stays NULL when the run never observed one. Absence is never read as a fix.
CREATE TABLE IF NOT EXISTS regression_replays (
  id uuid PRIMARY KEY,
  identity_id uuid NOT NULL REFERENCES regression_identities(id),
  regression_id uuid NOT NULL REFERENCES regressions(id),
  replay_case_id uuid NOT NULL REFERENCES cases(id),
  run_id uuid NOT NULL UNIQUE REFERENCES runs(id),
  target_id uuid NOT NULL REFERENCES targets(id),
  target_version text,
  outcome text,
  -- 'unrecorded' marks replays that predate lineage; their launch reason is unknown and is not guessed.
  trigger text NOT NULL CHECK (trigger IN ('manual','suite','version_change','unrecorded')),
  created_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz
);
CREATE INDEX IF NOT EXISTS regression_replays_identity ON regression_replays(identity_id, target_id, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS regression_replays_recent ON regression_replays(identity_id, created_at DESC, id DESC);
