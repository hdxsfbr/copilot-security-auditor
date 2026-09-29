-- F01: append-only human decision/correction history and immutable, separately approved report revisions.
-- A report revision is never stored unredacted; approval belongs to one exact revision and never to the finding.
CREATE TABLE IF NOT EXISTS finding_decisions (
  id bigserial PRIMARY KEY,
  candidate_id uuid NOT NULL REFERENCES candidates(id),
  kind text NOT NULL CHECK (kind IN ('decision','correction')),
  decision text CHECK (decision IN ('confirm','reject')),
  route text CHECK (route IN ('automatic','operator')),
  rationale jsonb, reason text,
  -- A correction of a decision recorded before F01 has no earlier row to point at; none is manufactured.
  corrects bigint REFERENCES finding_decisions(id),
  actor text NOT NULL CHECK (actor IN ('operator','worker')),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((kind = 'decision' AND decision IS NOT NULL AND route IS NOT NULL AND corrects IS NULL)
    OR (kind = 'correction' AND decision IS NULL AND route IS NULL AND rationale IS NOT NULL AND reason IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS finding_decisions_candidate ON finding_decisions(candidate_id, id);
CREATE OR REPLACE FUNCTION finding_decisions_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Finding decision history is append-only'; END $$;
DROP TRIGGER IF EXISTS finding_decisions_append_only ON finding_decisions;
CREATE TRIGGER finding_decisions_append_only BEFORE UPDATE OR DELETE ON finding_decisions
  FOR EACH ROW EXECUTE FUNCTION finding_decisions_append_only();

CREATE TABLE IF NOT EXISTS report_revisions (
  id uuid PRIMARY KEY,
  candidate_id uuid NOT NULL REFERENCES candidates(id),
  evidence_revision integer NOT NULL CHECK (evidence_revision > 0),
  revision integer NOT NULL CHECK (revision > 0),
  author text NOT NULL CHECK (author IN ('documentation','operator')),
  job_id uuid REFERENCES report_jobs(id),
  parent_id uuid REFERENCES report_revisions(id),
  content jsonb NOT NULL,
  content_hash text NOT NULL CHECK (content_hash ~ '^[0-9a-f]{64}$'),
  redaction_status text NOT NULL CHECK (redaction_status = 'redacted'),
  sequence_fingerprint text NOT NULL CHECK (sequence_fingerprint ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  approved_at timestamptz, approved_by text,
  approval_invalidated_at timestamptz, invalidated_by uuid REFERENCES report_revisions(id),
  UNIQUE (candidate_id, revision),
  CHECK ((author = 'documentation') = (job_id IS NOT NULL)),
  CHECK (approval_invalidated_at IS NULL OR approved_at IS NOT NULL)
);
-- One draft per job makes retried drafting idempotent even across generations.
CREATE UNIQUE INDEX IF NOT EXISTS report_revisions_job ON report_revisions(job_id) WHERE job_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS report_revisions_sequence ON report_revisions(sequence_fingerprint);
-- Content is immutable; only the approval columns can change, and never to un-approve without invalidation metadata.
CREATE OR REPLACE FUNCTION report_revisions_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'Report revisions are immutable'; END IF;
  IF (NEW.id, NEW.candidate_id, NEW.evidence_revision, NEW.revision, NEW.author, NEW.job_id, NEW.parent_id, NEW.content, NEW.content_hash, NEW.redaction_status, NEW.sequence_fingerprint, NEW.created_at)
    IS DISTINCT FROM (OLD.id, OLD.candidate_id, OLD.evidence_revision, OLD.revision, OLD.author, OLD.job_id, OLD.parent_id, OLD.content, OLD.content_hash, OLD.redaction_status, OLD.sequence_fingerprint, OLD.created_at)
    OR (OLD.approved_at IS NOT NULL AND NEW.approved_at IS DISTINCT FROM OLD.approved_at)
    OR (OLD.approval_invalidated_at IS NOT NULL AND NEW.approval_invalidated_at IS DISTINCT FROM OLD.approval_invalidated_at)
  THEN RAISE EXCEPTION 'Report revisions are immutable'; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS report_revisions_guard ON report_revisions;
CREATE TRIGGER report_revisions_guard BEFORE UPDATE OR DELETE ON report_revisions
  FOR EACH ROW EXECUTE FUNCTION report_revisions_guard();
