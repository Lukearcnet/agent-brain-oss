-- Maintenance checks tracking
CREATE TABLE IF NOT EXISTS maintenance_checks (
  id TEXT PRIMARY KEY,
  check_type TEXT NOT NULL,      -- 'docs_drift', 'security', 'db_health', 'code_cleanup'
  status TEXT NOT NULL,          -- 'ok', 'warning', 'critical'
  findings JSONB NOT NULL DEFAULT '[]',
  summary TEXT,
  auto_actions JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_maintenance_checks_type ON maintenance_checks (check_type, created_at DESC);

-- Maintenance thresholds (configurable)
CREATE TABLE IF NOT EXISTS maintenance_thresholds (
  check_type TEXT PRIMARY KEY,
  config JSONB NOT NULL DEFAULT '{}',
  enabled BOOLEAN DEFAULT true,
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- Insert default thresholds
INSERT INTO maintenance_thresholds (check_type, config, enabled) VALUES
  ('docs_drift', '{"max_stale_references": 3, "critical_file_patterns": ["CLAUDE.md", "handoff"]}', true),
  ('security', '{"audit_level": "moderate", "scan_secrets": true, "check_rls": true}', true),
  ('db_health', '{"max_total_mb": 500, "max_hot_rows": 100000, "archive_days": 30, "log_retention_days": 14}', true),
  ('code_cleanup', '{"stale_branch_days": 7, "archive_session_days": 30, "scan_unused_deps": true}', true)
ON CONFLICT (check_type) DO NOTHING;

-- Track fix sessions spawned from maintenance findings
CREATE TABLE IF NOT EXISTS maintenance_fix_sessions (
  id SERIAL PRIMARY KEY,
  check_type TEXT NOT NULL,
  finding_index INTEGER DEFAULT 0,
  finding_message TEXT,
  session_id TEXT,
  status TEXT DEFAULT 'started',  -- 'started', 'fixed', 'failed'
  created_at TIMESTAMPTZ DEFAULT now(),
  fixed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_maintenance_fix_sessions_check ON maintenance_fix_sessions (check_type, finding_index);
