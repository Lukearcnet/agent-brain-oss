-- Personal task tracker
CREATE TABLE IF NOT EXISTS user_tasks (
  id TEXT PRIMARY KEY,
  content TEXT NOT NULL,
  project TEXT,
  completed BOOLEAN NOT NULL DEFAULT false,
  parent_id TEXT REFERENCES user_tasks(id) ON DELETE CASCADE,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_user_tasks_project ON user_tasks (project);
CREATE INDEX IF NOT EXISTS idx_user_tasks_parent ON user_tasks (parent_id);
CREATE INDEX IF NOT EXISTS idx_user_tasks_sort ON user_tasks (sort_order);
