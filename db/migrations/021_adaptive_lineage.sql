-- A17: mutation lineage and selection basis for adaptive execution cases.
-- parent_execution_case_id is the earlier execution case of the same run whose recorded verdict the Red Team was shown
-- (same seed preferred, then same category); NULL means the proposal mutates only its seed (source_case_id).
-- selection records why the seed was chosen (coverage gap, regression state, unresolved severity) and which earlier
-- outcomes were fed back. follow_up_turn is the turn number of the one response-conditioned action, if any.
-- Rows that predate this migration keep NULLs: their lineage was not recorded and is not guessed.
ALTER TABLE adaptive_cases ADD COLUMN IF NOT EXISTS parent_execution_case_id uuid REFERENCES adaptive_cases(id);
ALTER TABLE adaptive_cases ADD COLUMN IF NOT EXISTS selection jsonb;
ALTER TABLE adaptive_cases ADD COLUMN IF NOT EXISTS follow_up_turn integer;
ALTER TABLE adaptive_cases DROP CONSTRAINT IF EXISTS adaptive_cases_lineage_bounds;
ALTER TABLE adaptive_cases ADD CONSTRAINT adaptive_cases_lineage_bounds CHECK (
  (parent_execution_case_id IS NULL OR parent_execution_case_id <> id) AND (follow_up_turn IS NULL OR follow_up_turn BETWEEN 2 AND 3));
CREATE INDEX IF NOT EXISTS adaptive_cases_parent ON adaptive_cases(parent_execution_case_id) WHERE parent_execution_case_id IS NOT NULL;
