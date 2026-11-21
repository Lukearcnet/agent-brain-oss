-- Agent Brain: Base Schema (migration-000)
-- Creates all core tables if they don't already exist.
-- Safe to run on both fresh installs and existing databases.

-- Settings (singleton row)
CREATE TABLE IF NOT EXISTS settings (
  id INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  notifications JSONB NOT NULL DEFAULT '{}',
  auto_approval JSONB NOT NULL DEFAULT '{}',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Sessions
CREATE TABLE IF NOT EXISTS sessions (
  session_id TEXT PRIMARY KEY,
  title TEXT NOT NULL DEFAULT '',
  provider TEXT NOT NULL DEFAULT 'claude-code',
  claude_session_id TEXT,
  cc_project_dir TEXT,
  handoff_from TEXT,
  handoff_prompt TEXT,
  archived BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_sessions_active ON sessions (archived, updated_at DESC);

-- Folders
CREATE TABLE IF NOT EXISTS folders (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS folder_sessions (
  folder_id TEXT NOT NULL REFERENCES folders(id) ON DELETE CASCADE,
  session_id TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
  PRIMARY KEY (folder_id, session_id)
);

-- Events log
CREATE TABLE IF NOT EXISTS events (
  id BIGSERIAL PRIMARY KEY,
  ts TIMESTAMPTZ NOT NULL DEFAULT now(),
  type TEXT NOT NULL,
  session_id TEXT,
  data JSONB NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_events_ts ON events (ts DESC);
CREATE INDEX IF NOT EXISTS idx_events_type ON events (type, ts DESC);

-- Mailbox
CREATE TABLE IF NOT EXISTS mailbox (
  id TEXT PRIMARY KEY,
  ts TIMESTAMPTZ NOT NULL DEFAULT now(),
  from_session TEXT,
  to_session TEXT NOT NULL DEFAULT 'broadcast',
  subject TEXT NOT NULL DEFAULT '',
  body TEXT NOT NULL DEFAULT '',
  read BOOLEAN NOT NULL DEFAULT false
);
CREATE INDEX IF NOT EXISTS idx_mailbox_to ON mailbox (to_session, read, ts DESC);

-- Orchestrator tasks
CREATE TABLE IF NOT EXISTS orchestrator_tasks (
  id TEXT PRIMARY KEY,
  project_dir TEXT,
  project_name TEXT NOT NULL DEFAULT 'General',
  cwd TEXT,
  description TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  model TEXT DEFAULT 'sonnet',
  output TEXT DEFAULT '',
  error TEXT,
  git_branch TEXT,
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Orchestrator messages
CREATE TABLE IF NOT EXISTS orchestrator_messages (
  id BIGSERIAL PRIMARY KEY,
  role TEXT NOT NULL,
  content TEXT NOT NULL DEFAULT '',
  task_id TEXT,
  project_name TEXT,
  update_type TEXT,
  ts TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Permission requests
CREATE TABLE IF NOT EXISTS permission_requests (
  id TEXT PRIMARY KEY,
  task_id TEXT,
  tool_name TEXT NOT NULL,
  tool_input JSONB,
  input_summary TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  decided_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Auth services (token broker)
CREATE TABLE IF NOT EXISTS auth_services (
  service TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  token_encrypted TEXT,
  expires_at TIMESTAMPTZ,
  refresh_command TEXT,
  auto_approve BOOLEAN DEFAULT true,
  last_refreshed_at TIMESTAMPTZ,
  metadata JSONB DEFAULT '{}'
);

-- Auth requests
CREATE TABLE IF NOT EXISTS auth_requests (
  id TEXT PRIMARY KEY,
  task_id TEXT,
  service TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  token_encrypted TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  decided_at TIMESTAMPTZ,
  fulfilled_at TIMESTAMPTZ
);

-- Session handoffs
CREATE TABLE IF NOT EXISTS session_handoffs (
  id TEXT PRIMARY KEY,
  project_dir TEXT NOT NULL,
  project_name TEXT,
  from_session_title TEXT,
  handoff_notes TEXT NOT NULL DEFAULT '',
  briefing TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending',
  source_folder_id TEXT,
  spawned_session_id TEXT,
  is_morning_refresh BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMPTZ DEFAULT now(),
  spawned_at TIMESTAMPTZ
);

-- Project memory
CREATE TABLE IF NOT EXISTS project_memory (
  project_dir TEXT PRIMARY KEY,
  content TEXT NOT NULL DEFAULT '',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Daily logs
CREATE TABLE IF NOT EXISTS daily_logs (
  project_dir TEXT NOT NULL,
  log_date DATE NOT NULL,
  content TEXT NOT NULL DEFAULT '',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (project_dir, log_date)
);

-- Memory topics
CREATE TABLE IF NOT EXISTS memory_topics (
  project_dir TEXT NOT NULL,
  name TEXT NOT NULL,
  content TEXT NOT NULL DEFAULT '',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (project_dir, name)
);

-- Remote commands
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

-- Memory facts
CREATE TABLE IF NOT EXISTS memory_facts (
  id BIGSERIAL PRIMARY KEY,
  project_dir TEXT NOT NULL,
  category TEXT NOT NULL,
  fact TEXT NOT NULL,
  source_task_id TEXT,
  confidence FLOAT DEFAULT 1.0,
  created_at TIMESTAMPTZ DEFAULT now(),
  last_confirmed_at TIMESTAMPTZ,
  superseded_by BIGINT
);
CREATE INDEX IF NOT EXISTS idx_facts_project ON memory_facts (project_dir, category, created_at DESC);

-- Session messages
CREATE TABLE IF NOT EXISTS session_messages (
  id TEXT PRIMARY KEY,
  project_dir TEXT NOT NULL,
  content TEXT NOT NULL,
  sender TEXT NOT NULL DEFAULT 'user',
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TIMESTAMPTZ DEFAULT now(),
  delivered_at TIMESTAMPTZ
);

-- Session checkpoints
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

-- File locks
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

-- User tasks
CREATE TABLE IF NOT EXISTS user_tasks (
  id TEXT PRIMARY KEY,
  content TEXT NOT NULL,
  project TEXT,
  completed BOOLEAN NOT NULL DEFAULT false,
  parent_id TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_user_tasks_project ON user_tasks (project);
CREATE INDEX IF NOT EXISTS idx_user_tasks_parent ON user_tasks (parent_id);
CREATE INDEX IF NOT EXISTS idx_user_tasks_sort ON user_tasks (sort_order);

-- AI Outbox
CREATE TABLE IF NOT EXISTS ai_outbox (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  type TEXT NOT NULL CHECK (type IN ('email', 'event')),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'sent', 'failed')),
  from_account TEXT NOT NULL,
  source_project TEXT,
  source_session TEXT,
  email_to TEXT[],
  email_cc TEXT[],
  email_bcc TEXT[],
  email_subject TEXT,
  email_body_html TEXT,
  email_body_text TEXT,
  event_title TEXT,
  event_description TEXT,
  event_start TIMESTAMPTZ,
  event_end TIMESTAMPTZ,
  event_location TEXT,
  event_attendees TEXT[],
  event_all_day BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  approved_at TIMESTAMPTZ,
  sent_at TIMESTAMPTZ,
  error_message TEXT,
  original_prompt TEXT,
  ai_reasoning TEXT
);
CREATE INDEX IF NOT EXISTS idx_outbox_status ON ai_outbox(status);
CREATE INDEX IF NOT EXISTS idx_outbox_created ON ai_outbox(created_at DESC);
