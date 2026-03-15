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

-- Auth services (token broker)
CREATE TABLE auth_services (
  service TEXT PRIMARY KEY,                -- "gcloud", "github", "vercel", "supabase"
  display_name TEXT NOT NULL,              -- "Google Cloud"
  token_encrypted TEXT,                    -- AES-encrypted current token (cached)
  expires_at TIMESTAMPTZ,                  -- NULL = never expires (API keys)
  refresh_command TEXT,                    -- shell command to run on Mac to get fresh token
  auto_approve BOOLEAN DEFAULT true,       -- auto-fulfill or require phone tap
  last_refreshed_at TIMESTAMPTZ,
  metadata JSONB DEFAULT '{}'              -- extra info (project ID, scopes, etc.)
);

-- Auth requests (Fly.io → Mac token relay)
CREATE TABLE auth_requests (
  id TEXT PRIMARY KEY,
  task_id TEXT,                            -- which orchestrator task needs it
  service TEXT NOT NULL REFERENCES auth_services(service),
  status TEXT NOT NULL DEFAULT 'pending',  -- pending → approved → fulfilled / denied / expired
  token_encrypted TEXT,                    -- filled once fulfilled
  created_at TIMESTAMPTZ DEFAULT now(),
  decided_at TIMESTAMPTZ,
  fulfilled_at TIMESTAMPTZ
);

-- Session handoffs (context transfer between Claude sessions)
CREATE TABLE session_handoffs (
  id TEXT PRIMARY KEY,
  project_dir TEXT NOT NULL,
  project_name TEXT,
  from_session_title TEXT,              -- title of the source session
  handoff_notes TEXT NOT NULL DEFAULT '',-- what the dying session was working on
  briefing TEXT NOT NULL DEFAULT '',     -- full compiled briefing (all context)
  status TEXT NOT NULL DEFAULT 'pending',-- pending → spawned → completed
  source_folder_id TEXT,                -- folder of the source session (new session inherits)
  spawned_session_id TEXT,              -- Agent Brain session ID created on spawn
  is_morning_refresh BOOLEAN DEFAULT FALSE, -- true if this is a daily morning refresh
  created_at TIMESTAMPTZ DEFAULT now(),
  spawned_at TIMESTAMPTZ
);
-- Migration: ALTER TABLE session_handoffs ADD COLUMN IF NOT EXISTS is_morning_refresh BOOLEAN DEFAULT FALSE;

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

-- Remote commands (Fly.io → Mac command execution relay)
-- Allows remote agents to execute Mac-only commands (keychain, osascript, etc.)
CREATE TABLE remote_commands (
  id TEXT PRIMARY KEY,
  task_id TEXT,                            -- which orchestrator task requested it
  command TEXT NOT NULL,                   -- shell command to run on Mac
  status TEXT NOT NULL DEFAULT 'pending',  -- pending → running → completed / denied / failed / timeout
  output_encrypted TEXT,                   -- AES-encrypted stdout
  error TEXT,                              -- error message if failed
  timeout_ms INTEGER DEFAULT 30000,        -- max execution time
  created_at TIMESTAMPTZ DEFAULT now(),
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ
);

-- Memory facts (structured learnings extracted from tasks)
-- Auto-populated after each orchestrator task completes
CREATE TABLE memory_facts (
  id BIGSERIAL PRIMARY KEY,
  project_dir TEXT NOT NULL,               -- project directory key
  category TEXT NOT NULL,                  -- "convention", "gotcha", "command", "pattern", "dependency", "test"
  fact TEXT NOT NULL,                      -- the actual learning
  source_task_id TEXT,                     -- which task discovered this
  confidence FLOAT DEFAULT 1.0,            -- 1.0 = verified, 0.5 = inferred
  created_at TIMESTAMPTZ DEFAULT now(),
  last_confirmed_at TIMESTAMPTZ,           -- when fact was last validated
  superseded_by BIGINT REFERENCES memory_facts(id)  -- NULL = current, set when newer fact replaces
);
CREATE INDEX idx_facts_project ON memory_facts (project_dir, category, created_at DESC);
CREATE INDEX idx_facts_active ON memory_facts (project_dir, superseded_by) WHERE superseded_by IS NULL;

-- Session messages (real-time messages from phone to running Claude Code sessions)
-- Delivered via PreToolUse hook that checks for pending messages on every tool call
CREATE TABLE session_messages (
  id TEXT PRIMARY KEY,
  project_dir TEXT NOT NULL,               -- target project directory key (e.g. "-Users-yourname-agent-brain")
  content TEXT NOT NULL,                   -- message text from user
  sender TEXT NOT NULL DEFAULT 'user',     -- "user" or project key of sending session
  status TEXT NOT NULL DEFAULT 'pending',  -- pending → delivered → expired
  created_at TIMESTAMPTZ DEFAULT now(),
  delivered_at TIMESTAMPTZ
);
CREATE INDEX idx_session_messages_pending ON session_messages (project_dir, status, created_at)
  WHERE status = 'pending';

-- Session checkpoints (Claude asks a question, user responds from phone)
-- Uses long-poll pattern: Claude's curl blocks until user responds (like permission system)
CREATE TABLE session_checkpoints (
  id TEXT PRIMARY KEY,
  project_dir TEXT NOT NULL,               -- which project's session is asking
  question TEXT NOT NULL,                  -- what Claude is asking (plan summary, decision point, etc.)
  options JSONB DEFAULT '[]',              -- optional quick-reply options ["Yes, proceed", "Modify", "Cancel"]
  response TEXT,                           -- user's response (filled when they reply)
  status TEXT NOT NULL DEFAULT 'pending',  -- pending → responded → expired
  created_at TIMESTAMPTZ DEFAULT now(),
  responded_at TIMESTAMPTZ
);
CREATE INDEX idx_checkpoints_pending ON session_checkpoints (project_dir, status, created_at DESC)
  WHERE status = 'pending';

-- File lock registry for cross-session safety
CREATE TABLE file_locks (
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
CREATE UNIQUE INDEX idx_file_locks_active_path ON file_locks (file_path) WHERE status = 'active';
CREATE INDEX idx_file_locks_session ON file_locks (session_id, status);
CREATE INDEX idx_file_locks_expiry ON file_locks (expires_at) WHERE status = 'active';
CREATE INDEX idx_file_locks_project ON file_locks (project_dir, status);

-- Personal task tracker
CREATE TABLE user_tasks (
  id TEXT PRIMARY KEY,
  content TEXT NOT NULL,
  project TEXT,
  completed BOOLEAN NOT NULL DEFAULT false,
  parent_id TEXT REFERENCES user_tasks(id) ON DELETE CASCADE,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_user_tasks_project ON user_tasks (project);
CREATE INDEX idx_user_tasks_parent ON user_tasks (parent_id);
CREATE INDEX idx_user_tasks_sort ON user_tasks (sort_order);

-- AI Outbox: Pending emails and calendar events awaiting approval
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
