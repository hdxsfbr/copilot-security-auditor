CREATE TABLE IF NOT EXISTS credentials (
  id uuid PRIMARY KEY, ciphertext text NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS targets (
  id uuid PRIMARY KEY, name text NOT NULL, base_url text NOT NULL,
  user_a_credential uuid NOT NULL REFERENCES credentials(id), user_b_credential uuid NOT NULL REFERENCES credentials(id),
  active_run_id uuid, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS cases (
  id uuid PRIMARY KEY, definition jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS runs (
  id uuid PRIMARY KEY, target_id uuid NOT NULL REFERENCES targets(id), case_id uuid NOT NULL REFERENCES cases(id),
  definition jsonb NOT NULL, target_snapshot jsonb NOT NULL, status text NOT NULL DEFAULT 'queued',
  outcome text, version text, lease_generation integer NOT NULL DEFAULT 0, lease_owner text,
  lease_until timestamptz, created_at timestamptz NOT NULL DEFAULT now(), finished_at timestamptz
);
ALTER TABLE targets DROP CONSTRAINT IF EXISTS targets_active_run_fk;
ALTER TABLE targets ADD CONSTRAINT targets_active_run_fk FOREIGN KEY (active_run_id) REFERENCES runs(id);
CREATE TABLE IF NOT EXISTS jobs (run_id uuid PRIMARY KEY REFERENCES runs(id), created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS events (
  id bigserial PRIMARY KEY, run_id uuid NOT NULL REFERENCES runs(id), event jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS events_run_order ON events(run_id, id);
CREATE TABLE IF NOT EXISTS candidates (
  id uuid PRIMARY KEY, run_id uuid NOT NULL UNIQUE REFERENCES runs(id), state text NOT NULL DEFAULT 'pending_review',
  created_at timestamptz NOT NULL DEFAULT now()
);
