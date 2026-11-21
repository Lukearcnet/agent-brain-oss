-- Log summaries for daily log compaction (hipocampus-inspired)
-- Stores weekly and monthly summaries of daily logs to reduce token usage
-- for long-running projects.

CREATE TABLE IF NOT EXISTS log_summaries (
  project_dir TEXT NOT NULL,
  period_type TEXT NOT NULL CHECK (period_type IN ('weekly', 'monthly')),
  start_date DATE NOT NULL,
  end_date DATE NOT NULL,
  content TEXT NOT NULL DEFAULT '',
  source_count INTEGER NOT NULL DEFAULT 0,
  summarized BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (project_dir, period_type, start_date)
);

CREATE INDEX IF NOT EXISTS idx_log_summaries_project ON log_summaries (project_dir, period_type, start_date DESC);

-- Track which daily logs have been compacted (to avoid re-processing)
CREATE TABLE IF NOT EXISTS log_compaction_state (
  project_dir TEXT NOT NULL,
  last_weekly_compaction DATE,
  last_monthly_compaction DATE,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (project_dir)
);
