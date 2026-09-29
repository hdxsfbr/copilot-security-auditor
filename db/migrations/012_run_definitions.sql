CREATE TABLE IF NOT EXISTS run_definitions (
  id uuid PRIMARY KEY,
  name text NOT NULL,
  definition jsonb NOT NULL,
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  archived boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS run_definitions_current ON run_definitions(updated_at DESC, id) WHERE NOT archived;
