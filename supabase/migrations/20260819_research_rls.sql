-- Enable RLS on the research tables, matching 20260407_enable_rls.sql.
-- Agent Brain connects with the service_role key, which bypasses RLS, so this is
-- defense-in-depth against an anon/public key reaching these tables.

ALTER TABLE IF EXISTS research_cache ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS research_usage ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS research_regions ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS research_briefings ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS research_seen_urls ENABLE ROW LEVEL SECURITY;
