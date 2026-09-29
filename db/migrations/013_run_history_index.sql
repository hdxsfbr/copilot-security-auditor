CREATE INDEX IF NOT EXISTS runs_history_order ON runs(created_at DESC,id DESC);

-- Older adaptive stop requests could leave queued rows behind. Terminalize
-- them before the new claim predicate excludes every stopped queued run.
WITH stopped AS (
  UPDATE runs SET status='finished',outcome='incomplete',finished_at=now(),lease_until=NULL
  WHERE status='queued' AND stop_requested=true
  RETURNING id,target_id
), occurrences AS (
  UPDATE schedule_occurrences so SET state='finished',reason='Stopped before dispatch'
  FROM stopped s WHERE so.run_id=s.id AND so.state='queued'
  RETURNING so.id
)
UPDATE targets t SET active_run_id=NULL FROM stopped s
WHERE t.id=s.target_id AND t.active_run_id=s.id;
