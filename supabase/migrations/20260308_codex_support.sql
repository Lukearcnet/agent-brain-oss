-- Add Codex support fields to sessions table
-- Run this in Supabase SQL Editor

-- Add codex_session_id field (nullable, for Codex-linked sessions)
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS codex_session_id TEXT;

-- Add index for Codex session lookups
CREATE INDEX IF NOT EXISTS idx_sessions_codex_id ON sessions (codex_session_id) WHERE codex_session_id IS NOT NULL;

-- Update provider default to be more generic (already exists but may have old default)
-- ALTER TABLE sessions ALTER COLUMN provider SET DEFAULT 'claude-code';

-- Note: Existing sessions with claude_session_id will continue to work
-- New Codex sessions will have codex_session_id set instead
