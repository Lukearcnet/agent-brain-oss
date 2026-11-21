-- Optional social-source pass for regional briefings.
--
-- Why a separate column instead of just adding facebook.com to `domains`:
-- when social and conventional news domains share one search_domain_filter, the
-- news sites usually outrank the social posts and Facebook can be crowded out
-- entirely (measured: 0/10 results on one query, 0/6 on another). Running social
-- as its OWN request guarantees coverage. Costs one extra $0.005 request per
-- region per run.
--
-- Empty/null = no social pass, so existing regions are unaffected.

ALTER TABLE research_regions
  ADD COLUMN IF NOT EXISTS social_domains JSONB;

COMMENT ON COLUMN research_regions.social_domains IS
  'Domains searched in a separate pass so they are not outranked by news sites, e.g. ["facebook.com"]. Null/empty disables the pass.';
