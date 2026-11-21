-- Perplexity research layer: query cache, spend tracking, and regional briefings.
-- Perplexity is used for RETRIEVAL; synthesis runs on Claude (already paid for).
-- https://docs.perplexity.ai/getting-started/pricing

-- Cache keyed by a hash of (endpoint + normalized params). A repeat query inside
-- its TTL costs $0, which is what keeps the daily crons cheap.
CREATE TABLE IF NOT EXISTS research_cache (
  cache_key TEXT PRIMARY KEY,                -- sha256 of endpoint + sorted params
  endpoint TEXT NOT NULL,                    -- 'search' | 'agent'
  params JSONB NOT NULL,                     -- request body, for debugging/replay
  response JSONB NOT NULL,                   -- normalized response we hand to callers
  cost_usd NUMERIC(10, 6) NOT NULL DEFAULT 0,-- what the ORIGINAL call cost
  hits INTEGER NOT NULL DEFAULT 0,           -- how many times the cache saved us a call
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_research_cache_expires ON research_cache (expires_at);
CREATE INDEX IF NOT EXISTS idx_research_cache_endpoint ON research_cache (endpoint, created_at DESC);

-- Every billable call, with the cost Perplexity actually reported back to us
-- (usage.cost.total_cost) rather than an estimate.
CREATE TABLE IF NOT EXISTS research_usage (
  id BIGSERIAL PRIMARY KEY,
  ts TIMESTAMPTZ NOT NULL DEFAULT now(),
  endpoint TEXT NOT NULL,                    -- 'search' | 'agent'
  preset TEXT,                               -- fast | low | medium | high | xhigh
  caller TEXT,                               -- 'mcp' | 'briefing:<region>' | 'ai-monitor' | ...
  queries INTEGER NOT NULL DEFAULT 1,        -- number of queries in the request
  cost_usd NUMERIC(10, 6) NOT NULL DEFAULT 0,
  cached BOOLEAN NOT NULL DEFAULT false,     -- true = served from cache, cost 0
  meta JSONB
);

CREATE INDEX IF NOT EXISTS idx_research_usage_ts ON research_usage (ts DESC);
CREATE INDEX IF NOT EXISTS idx_research_usage_caller ON research_usage (caller, ts DESC);

-- Regions watched by the daily briefing cron. Seeded empty; managed via
-- /api/research/regions so the dashboard can edit without a deploy.
CREATE TABLE IF NOT EXISTS research_regions (
  id TEXT PRIMARY KEY,                       -- slug, e.g. 'south-sudan'
  name TEXT NOT NULL,                        -- display name
  country_code TEXT,                         -- ISO 3166-1 alpha-2 for Search API `country`
  queries JSONB NOT NULL,                    -- array of search strings run each morning
  domains JSONB,                             -- optional allowlist (max 20 per Perplexity)
  enabled BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One synthesized briefing per region per run.
CREATE TABLE IF NOT EXISTS research_briefings (
  id BIGSERIAL PRIMARY KEY,
  region_id TEXT NOT NULL REFERENCES research_regions(id) ON DELETE CASCADE,
  ts TIMESTAMPTZ NOT NULL DEFAULT now(),
  headline TEXT,                             -- one-line summary for the push notification
  body_markdown TEXT NOT NULL,               -- full briefing
  sources JSONB,                             -- [{title, url, date}]
  result_count INTEGER NOT NULL DEFAULT 0,
  cost_usd NUMERIC(10, 6) NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_research_briefings_region_ts ON research_briefings (region_id, ts DESC);

-- URLs already reported, so a briefing surfaces what's NEW rather than repeating
-- yesterday's headlines.
CREATE TABLE IF NOT EXISTS research_seen_urls (
  region_id TEXT NOT NULL REFERENCES research_regions(id) ON DELETE CASCADE,
  url TEXT NOT NULL,
  first_seen TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (region_id, url)
);

CREATE INDEX IF NOT EXISTS idx_research_seen_first ON research_seen_urls (first_seen);
