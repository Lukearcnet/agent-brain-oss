-- Agent Brain: Supabase Schema
-- Run this in the Supabase SQL Editor to create all tables

-- Settings (singleton row)
CREATE TABLE settings (
  id INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  notifications JSONB NOT NULL DEFAULT '{}',
  auto_approval JSONB NOT NULL DEFAULT '{}',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Sessions
CREATE TABLE sessions (
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
CREATE INDEX idx_sessions_active ON sessions (archived, updated_at DESC);

-- Folders
CREATE TABLE folders (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE folder_sessions (
  folder_id TEXT NOT NULL REFERENCES folders(id) ON DELETE CASCADE,
  session_id TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
  PRIMARY KEY (folder_id, session_id)
);

-- Events log
CREATE TABLE events (
  id BIGSERIAL PRIMARY KEY,
  ts TIMESTAMPTZ NOT NULL DEFAULT now(),
  type TEXT NOT NULL,
  session_id TEXT,
  data JSONB NOT NULL DEFAULT '{}'
);
CREATE INDEX idx_events_ts ON events (ts DESC);
CREATE INDEX idx_events_type ON events (type, ts DESC);

-- Mailbox
CREATE TABLE mailbox (
  id TEXT PRIMARY KEY,
  ts TIMESTAMPTZ NOT NULL DEFAULT now(),
  from_session TEXT,
  to_session TEXT NOT NULL DEFAULT 'broadcast',
  subject TEXT NOT NULL DEFAULT '',
  body TEXT NOT NULL DEFAULT '',
  read BOOLEAN NOT NULL DEFAULT false
);
CREATE INDEX idx_mailbox_to ON mailbox (to_session, read, ts DESC);

-- Orchestrator tasks
CREATE TABLE orchestrator_tasks (
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
CREATE TABLE orchestrator_messages (
  id BIGSERIAL PRIMARY KEY,
  role TEXT NOT NULL,
  content TEXT NOT NULL DEFAULT '',
  task_id TEXT,
  project_name TEXT,
  update_type TEXT,
  ts TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Permission requests (for Fly.io agent runner)
CREATE TABLE permission_requests (
  id TEXT PRIMARY KEY,
  task_id TEXT,
  tool_name TEXT NOT NULL,
  tool_input JSONB,
  input_summary TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  decided_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Project memory
CREATE TABLE project_memory (
  project_dir TEXT PRIMARY KEY,
  content TEXT NOT NULL DEFAULT '',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Daily logs
CREATE TABLE daily_logs (
  project_dir TEXT NOT NULL,
  log_date DATE NOT NULL,
  content TEXT NOT NULL DEFAULT '',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (project_dir, log_date)
);

-- Memory topics
CREATE TABLE memory_topics (
  project_dir TEXT NOT NULL,
  name TEXT NOT NULL,
  content TEXT NOT NULL DEFAULT '',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (project_dir, name)
);
