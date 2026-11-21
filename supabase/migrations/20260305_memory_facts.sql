-- Memory facts (structured learnings extracted from tasks)
-- Auto-populated after each orchestrator task completes
CREATE TABLE IF NOT EXISTS memory_facts (
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

CREATE INDEX IF NOT EXISTS idx_facts_project ON memory_facts (project_dir, category, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_facts_active ON memory_facts (project_dir, superseded_by) WHERE superseded_by IS NULL;
