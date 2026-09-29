-- M02: preserve the provider generation reference and reconcile unresolved paid spend explicitly.
-- The reference is nullable: local inference has none, and a response can arrive without one.
ALTER TABLE model_calls ADD COLUMN IF NOT EXISTS provider_generation_id text
  CONSTRAINT model_calls_generation_ref CHECK (provider_generation_id IS NULL OR (provider = 'openrouter' AND length(provider_generation_id) BETWEEN 1 AND 200));
CREATE INDEX IF NOT EXISTS model_calls_unresolved ON model_calls(created_at, id) WHERE status = 'unresolved' AND provider = 'openrouter';

-- One row per reconciled call, never updated or deleted. The row is the operator attestation: it keeps the
-- pre-reconciliation reserve and any provider-reported charge so the transition stays reviewable.
CREATE TABLE IF NOT EXISTS spend_reconciliations (
  id uuid PRIMARY KEY,
  call_id uuid NOT NULL UNIQUE REFERENCES model_calls(id),
  previous_status text NOT NULL CHECK (previous_status = 'unresolved'),
  previous_reserved_nanos numeric(30,0) NOT NULL,
  previous_charge_nanos numeric(30,0),
  resolution text NOT NULL CHECK (resolution IN ('settled_by_operator','confirmed_not_billed')),
  charge_nanos numeric(30,0) NOT NULL CHECK (charge_nanos >= 0),
  evidence text NOT NULL CHECK (length(btrim(evidence)) BETWEEN 1 AND 500),
  idempotency_key text NOT NULL UNIQUE CHECK (length(idempotency_key) BETWEEN 8 AND 128),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((resolution = 'confirmed_not_billed' AND charge_nanos = 0) OR (resolution = 'settled_by_operator' AND charge_nanos > 0))
);
CREATE OR REPLACE FUNCTION spend_reconciliation_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP <> 'INSERT' THEN RAISE EXCEPTION 'Spend reconciliations are append-only'; END IF;
  IF NOT EXISTS (SELECT 1 FROM model_calls WHERE id = NEW.call_id AND provider = 'openrouter' AND status = 'unresolved') THEN
    RAISE EXCEPTION 'Only unresolved paid calls can be reconciled';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS spend_reconciliation_guard ON spend_reconciliations;
CREATE TRIGGER spend_reconciliation_guard BEFORE INSERT OR UPDATE OR DELETE ON spend_reconciliations
  FOR EACH ROW EXECUTE FUNCTION spend_reconciliation_guard();
DROP TRIGGER IF EXISTS spend_reconciliation_truncate ON spend_reconciliations;
CREATE TRIGGER spend_reconciliation_truncate BEFORE TRUNCATE ON spend_reconciliations
  FOR EACH STATEMENT EXECUTE FUNCTION spend_reconciliation_guard();
