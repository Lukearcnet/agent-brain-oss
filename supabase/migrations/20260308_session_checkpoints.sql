-- Session checkpoints (Claude asks a question, user responds from phone)
-- Uses long-poll pattern: Claude's curl blocks until user responds
CREATE TABLE IF NOT EXISTS session_checkpoints (
  id TEXT PRIMARY KEY,
  project_dir TEXT NOT NULL,
  question TEXT NOT NULL,
  options JSONB DEFAULT '[]',
  response TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TIMESTAMPTZ DEFAULT now(),
  responded_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_checkpoints_pending ON session_checkpoints (project_dir, status, created_at DESC)
  WHERE status = 'pending';
