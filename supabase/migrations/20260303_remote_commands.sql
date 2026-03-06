CREATE TABLE IF NOT EXISTS remote_commands (
  id TEXT PRIMARY KEY,
  task_id TEXT,
  command TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  output_encrypted TEXT,
  error TEXT,
  timeout_ms INTEGER DEFAULT 30000,
  created_at TIMESTAMPTZ DEFAULT now(),
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ
);
