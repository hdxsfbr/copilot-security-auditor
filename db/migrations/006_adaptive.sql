ALTER TABLE runs ALTER COLUMN case_id DROP NOT NULL;
ALTER TABLE runs ADD COLUMN IF NOT EXISTS adaptive jsonb;
ALTER TABLE runs ADD COLUMN IF NOT EXISTS stop_requested boolean NOT NULL DEFAULT false;
ALTER TABLE runs ADD COLUMN IF NOT EXISTS started_at timestamptz;
CREATE TABLE IF NOT EXISTS adaptive_cases (
  id uuid PRIMARY KEY, run_id uuid NOT NULL REFERENCES runs(id), ordinal integer NOT NULL,
  category text NOT NULL CHECK (category IN ('prompt_injection','cross_patient','unintended_tool_action')),
  source_case_id uuid NOT NULL REFERENCES cases(id), definition jsonb,
  state text NOT NULL CHECK (state IN ('proposed','rejected','executing','safe','pending_review','auto_confirm','inconclusive','blocked','incomplete')),
  executed boolean NOT NULL DEFAULT false, reason text,
  created_at timestamptz NOT NULL DEFAULT now(), finished_at timestamptz,
  UNIQUE(run_id,ordinal)
);
ALTER TABLE candidates DROP CONSTRAINT IF EXISTS candidates_run_id_key;
ALTER TABLE candidates ADD COLUMN IF NOT EXISTS adaptive_case_id uuid REFERENCES adaptive_cases(id);
CREATE UNIQUE INDEX IF NOT EXISTS candidates_selected_run ON candidates(run_id) WHERE adaptive_case_id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS candidates_adaptive_case ON candidates(adaptive_case_id) WHERE adaptive_case_id IS NOT NULL;
CREATE TABLE IF NOT EXISTS adaptive_assessments (
  case_id uuid PRIMARY KEY REFERENCES adaptive_cases(id), checks jsonb NOT NULL, verdict jsonb,
  route text NOT NULL, policy_version integer NOT NULL DEFAULT 1
);
ALTER TABLE regressions ADD COLUMN IF NOT EXISTS replay_case_id uuid REFERENCES cases(id);
CREATE TABLE IF NOT EXISTS case_artifact_links (
  case_id uuid NOT NULL REFERENCES cases(id), artifact_id uuid NOT NULL REFERENCES artifacts(id),
  PRIMARY KEY(case_id,artifact_id)
);
