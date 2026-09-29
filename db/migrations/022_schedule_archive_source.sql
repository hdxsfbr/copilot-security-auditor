-- Schedules are archived (soft-deleted), never removed: record when, and which saved run definition revision they were created from.
ALTER TABLE schedules
  ADD COLUMN IF NOT EXISTS archived_at timestamptz,
  ADD COLUMN IF NOT EXISTS source_definition_id uuid REFERENCES run_definitions(id),
  ADD COLUMN IF NOT EXISTS source_revision integer CHECK (source_revision > 0);
CREATE INDEX IF NOT EXISTS schedules_archived ON schedules(archived_at DESC NULLS LAST, created_at DESC) WHERE deleted;
