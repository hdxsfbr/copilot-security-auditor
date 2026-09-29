-- F00: leased report jobs with independent post-run model accounting.
-- A run without a policy row has report generation disabled and no allowance.
CREATE TABLE IF NOT EXISTS run_report_policies (
  run_id uuid PRIMARY KEY REFERENCES runs(id),
  model jsonb NOT NULL, price jsonb,
  allowance_nanos numeric(30,0) NOT NULL CHECK (allowance_nanos >= 0),
  review_window_seconds integer NOT NULL CHECK (review_window_seconds BETWEEN 60 AND 604800),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE OR REPLACE FUNCTION run_report_policy_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Run report policy is immutable'; END $$;
DROP TRIGGER IF EXISTS run_report_policy_immutable ON run_report_policies;
CREATE TRIGGER run_report_policy_immutable BEFORE UPDATE OR DELETE ON run_report_policies
  FOR EACH ROW EXECUTE FUNCTION run_report_policy_immutable();

-- Presence closes the run allowance to new job transfers. unused_nanos records what was
-- provably unheld at that moment; in-flight and unresolved holds stay on their jobs.
CREATE TABLE IF NOT EXISTS report_allowance_releases (
  run_id uuid PRIMARY KEY REFERENCES run_report_policies(run_id),
  reason text NOT NULL CHECK (reason IN ('review_window_expired','run_cancelled','operator_cancelled')),
  unused_nanos numeric(30,0) NOT NULL CHECK (unused_nanos >= 0),
  released_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS report_jobs (
  id uuid PRIMARY KEY,
  run_id uuid NOT NULL REFERENCES runs(id),
  candidate_id uuid NOT NULL REFERENCES candidates(id),
  evidence_revision integer NOT NULL CHECK (evidence_revision > 0),
  state text NOT NULL CHECK (state IN ('report_needed','queued','running','completed','failed','cancelled')),
  reason text,
  funding text CHECK (funding IN ('run_allowance','explicit_authorization')),
  model jsonb, price jsonb,
  reserved_nanos numeric(30,0) NOT NULL DEFAULT 0 CHECK (reserved_nanos >= 0),
  held_nanos numeric(30,0) NOT NULL DEFAULT 0 CHECK (held_nanos >= 0),
  attempts integer NOT NULL DEFAULT 0,
  lease_owner text, lease_generation integer NOT NULL DEFAULT 0, lease_until timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  authorized_at timestamptz, started_at timestamptz, finished_at timestamptz,
  UNIQUE (candidate_id, evidence_revision),
  CHECK (state = 'report_needed' OR (funding IS NOT NULL AND model IS NOT NULL)),
  CHECK (state <> 'report_needed' OR (held_nanos = 0 AND reserved_nanos = 0))
);
CREATE INDEX IF NOT EXISTS report_jobs_claim ON report_jobs(created_at, id) WHERE state = 'queued';
CREATE INDEX IF NOT EXISTS report_jobs_run ON report_jobs(run_id);
ALTER TABLE model_calls ADD COLUMN IF NOT EXISTS report_job_id uuid REFERENCES report_jobs(id);
CREATE INDEX IF NOT EXISTS model_calls_report_job ON model_calls(report_job_id) WHERE report_job_id IS NOT NULL;
