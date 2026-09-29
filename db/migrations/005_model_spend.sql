ALTER TABLE runs ADD COLUMN IF NOT EXISTS model_snapshot jsonb;
ALTER TABLE runs ADD COLUMN IF NOT EXISTS paid_cap_nanos numeric(30,0);
CREATE TABLE IF NOT EXISTS model_calls (
  id uuid PRIMARY KEY,
  run_id uuid NOT NULL REFERENCES runs(id),
  role text NOT NULL CHECK (role IN ('orchestrator','redTeam','judge','documentation')),
  provider text NOT NULL CHECK (provider IN ('ollama','openrouter')),
  model text NOT NULL,
  status text NOT NULL CHECK (status IN ('reserved','settled','unresolved')),
  reserved_nanos numeric(30,0) NOT NULL DEFAULT 0,
  charge_nanos numeric(30,0),
  input_tokens integer,
  output_tokens integer,
  latency_ms integer,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);
CREATE INDEX IF NOT EXISTS model_calls_run ON model_calls(run_id,created_at);
