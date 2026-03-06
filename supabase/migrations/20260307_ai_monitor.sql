-- AI Monitor: Deduplication state and briefing archive

-- Deduplication state: tracks seen item IDs per source
CREATE TABLE ai_monitor_state (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  source TEXT NOT NULL,
  item_id TEXT NOT NULL,
  first_seen TIMESTAMPTZ DEFAULT now(),
  UNIQUE(source, item_id)
);

-- Briefing archive: every generated briefing
CREATE TABLE ai_monitor_briefings (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  created_at TIMESTAMPTZ DEFAULT now(),
  run_type TEXT NOT NULL,
  raw_item_count INTEGER,
  filtered_items JSONB,
  briefing_text TEXT,
  sources_summary JSONB
);
