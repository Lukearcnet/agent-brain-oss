-- File lock registry for cross-session file editing safety
CREATE TABLE IF NOT EXISTS file_locks (
  id TEXT PRIMARY KEY,
  file_path TEXT NOT NULL,
  project_dir TEXT NOT NULL,
  session_id TEXT NOT NULL,
  session_title TEXT,
  acquired_at TIMESTAMPTZ DEFAULT now(),
  last_activity_at TIMESTAMPTZ DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  status TEXT NOT NULL DEFAULT 'active'
);

-- Only one active lock per file path
CREATE UNIQUE INDEX idx_file_locks_active_path
  ON file_locks (file_path)
  WHERE status = 'active';

CREATE INDEX idx_file_locks_session
  ON file_locks (session_id, status);

CREATE INDEX idx_file_locks_expiry
  ON file_locks (expires_at)
  WHERE status = 'active';

CREATE INDEX idx_file_locks_project
  ON file_locks (project_dir, status);
