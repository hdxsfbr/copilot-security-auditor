-- The latest check is a diagnostic snapshot, never proof that a file still exists.
-- Review, approval and export revalidate the candidate's exact attachments.
ALTER TABLE candidates ADD COLUMN IF NOT EXISTS evidence_integrity jsonb;
