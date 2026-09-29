CREATE TABLE IF NOT EXISTS artifacts (
  id uuid PRIMARY KEY, case_id uuid NOT NULL REFERENCES cases(id), document_type text NOT NULL,
  sha256 text NOT NULL, bytes integer NOT NULL, pages integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (document_type IN ('lab_pdf','intake_form'))
);
CREATE TABLE IF NOT EXISTS assessments (
  run_id uuid PRIMARY KEY REFERENCES runs(id), checks jsonb NOT NULL, verdict jsonb,
  route text NOT NULL, policy_version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE candidates ADD COLUMN IF NOT EXISTS decided_at timestamptz;
ALTER TABLE candidates ADD COLUMN IF NOT EXISTS decision_route text;
ALTER TABLE candidates ADD COLUMN IF NOT EXISTS export_approved_at timestamptz;
CREATE TABLE IF NOT EXISTS regressions (
  id uuid PRIMARY KEY, candidate_id uuid NOT NULL UNIQUE REFERENCES candidates(id),
  source_run_id uuid NOT NULL REFERENCES runs(id), definition jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
