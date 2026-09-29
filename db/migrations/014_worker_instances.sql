-- Durable worker liveness. Rows carry only a random process identity, DB-clock
-- timestamps and a fixed diagnostic code; never hostnames, environment values,
-- targets, stack traces or provider/error text. Stale rows stay diagnosable
-- until retention pruning at the next worker registration.
CREATE TABLE IF NOT EXISTS worker_instances (
  worker_id uuid PRIMARY KEY,
  started_at timestamptz NOT NULL DEFAULT now(),
  last_heartbeat_at timestamptz NOT NULL DEFAULT now(),
  last_cycle_error_code text CHECK (last_cycle_error_code IS NULL OR last_cycle_error_code ~ '^[a-z][a-z_]{0,47}$')
);
CREATE INDEX IF NOT EXISTS worker_instances_heartbeat ON worker_instances(last_heartbeat_at DESC);
CREATE INDEX IF NOT EXISTS runs_queue_age ON runs(created_at) WHERE status='queued' AND stop_requested=false;
CREATE INDEX IF NOT EXISTS runs_running_lease ON runs(lease_until) WHERE status='running';
