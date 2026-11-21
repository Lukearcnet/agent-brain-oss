-- Session messages (real-time messages from phone to running Claude Code sessions)
-- Delivered via PreToolUse hook that checks for pending messages on every tool call
CREATE TABLE IF NOT EXISTS session_messages (
  id TEXT PRIMARY KEY,
  project_dir TEXT NOT NULL,
  content TEXT NOT NULL,
  sender TEXT NOT NULL DEFAULT 'user',
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TIMESTAMPTZ DEFAULT now(),
  delivered_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_session_messages_pending ON session_messages (project_dir, status, created_at)
  WHERE status = 'pending';
