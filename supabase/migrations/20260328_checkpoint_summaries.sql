-- Automatic checkpoint summarization for work stream detection and handoff context
-- Part of the background memory agent system

-- Checkpoint-level summaries (1-2 sentences per checkpoint)
CREATE TABLE IF NOT EXISTS checkpoint_summaries (
  id SERIAL PRIMARY KEY,
  checkpoint_id TEXT NOT NULL UNIQUE,
  session_id TEXT,
  project_dir TEXT NOT NULL,
  summary TEXT NOT NULL,
  work_stream TEXT,  -- AI-detected work stream name (e.g., "member-directory", "events")
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  consolidated BOOLEAN NOT NULL DEFAULT false
);

CREATE INDEX IF NOT EXISTS idx_checkpoint_summaries_project
  ON checkpoint_summaries (project_dir, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_checkpoint_summaries_session
  ON checkpoint_summaries (session_id, created_at DESC) WHERE session_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_checkpoint_summaries_stream
  ON checkpoint_summaries (project_dir, work_stream, created_at DESC) WHERE work_stream IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_checkpoint_summaries_unconsolidated
  ON checkpoint_summaries (project_dir, created_at DESC) WHERE consolidated = false;

-- Session-level daily summaries (consolidates checkpoint summaries)
CREATE TABLE IF NOT EXISTS session_daily_summaries (
  id SERIAL PRIMARY KEY,
  session_id TEXT NOT NULL,
  project_dir TEXT NOT NULL,
  summary_date DATE NOT NULL,
  summary TEXT NOT NULL,
  checkpoint_count INTEGER NOT NULL DEFAULT 0,
  work_streams TEXT[],  -- Array of detected work streams for that day
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  consolidated BOOLEAN NOT NULL DEFAULT false,
  UNIQUE (session_id, summary_date)
);

CREATE INDEX IF NOT EXISTS idx_session_daily_project
  ON session_daily_summaries (project_dir, summary_date DESC);
CREATE INDEX IF NOT EXISTS idx_session_daily_session
  ON session_daily_summaries (session_id, summary_date DESC);

-- Project-level work stream summaries (used for handoff briefings)
CREATE TABLE IF NOT EXISTS project_work_streams (
  id SERIAL PRIMARY KEY,
  project_dir TEXT NOT NULL,
  stream_name TEXT NOT NULL,
  description TEXT,
  last_activity TIMESTAMPTZ,
  session_ids TEXT[],
  summary TEXT,
  active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (project_dir, stream_name)
);

CREATE INDEX IF NOT EXISTS idx_project_streams_active
  ON project_work_streams (project_dir, active, last_activity DESC) WHERE active = true;

-- Track consolidation state
CREATE TABLE IF NOT EXISTS summary_consolidation_state (
  project_dir TEXT PRIMARY KEY,
  last_checkpoint_consolidation TIMESTAMPTZ,
  last_daily_consolidation TIMESTAMPTZ,
  last_stream_detection TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
