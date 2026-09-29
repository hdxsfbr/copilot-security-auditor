CREATE TABLE IF NOT EXISTS schedules (
  id uuid PRIMARY KEY, definition jsonb NOT NULL, run_snapshot jsonb NOT NULL, model_snapshot jsonb NOT NULL,
  next_fire_at timestamptz NOT NULL, paused boolean NOT NULL DEFAULT false,
  deleted boolean NOT NULL DEFAULT false, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS schedules_due ON schedules(next_fire_at) WHERE NOT paused AND NOT deleted;
CREATE TABLE IF NOT EXISTS schedule_occurrences (
  id uuid PRIMARY KEY, schedule_id uuid NOT NULL REFERENCES schedules(id),
  scheduled_for timestamptz NOT NULL, run_id uuid UNIQUE REFERENCES runs(id),
  state text NOT NULL CHECK (state IN ('queued','running','finished','skipped','blocked')),
  reason text, created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(schedule_id,scheduled_for)
);
CREATE INDEX IF NOT EXISTS occurrences_schedule ON schedule_occurrences(schedule_id,scheduled_for DESC);
