-- Bind checkpoints to a specific Agent Brain session when available.
-- This makes session views deterministic instead of inferring from project_dir/title.

ALTER TABLE session_checkpoints
  ADD COLUMN IF NOT EXISTS session_id TEXT;

CREATE INDEX IF NOT EXISTS idx_checkpoints_session_pending
  ON session_checkpoints (session_id, status, created_at DESC)
  WHERE session_id IS NOT NULL AND status = 'pending';

CREATE INDEX IF NOT EXISTS idx_checkpoints_project_provider_pending
  ON session_checkpoints (project_dir, provider, status, created_at DESC)
  WHERE status = 'pending';
