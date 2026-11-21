-- Add context snapshot to checkpoints for dashboard expansion
-- Stores recent messages from the session at checkpoint creation time
ALTER TABLE session_checkpoints ADD COLUMN IF NOT EXISTS context_snapshot JSONB;
