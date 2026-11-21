/**
 * Research module — entry point.
 *
 * Gives Agent Brain itself (not just Claude sessions) grounded web research:
 * MCP tools reach it over HTTP, and the cron services call it directly.
 */

const cron = require("node-cron");
const perplexity = require("./perplexity");
const briefings = require("./briefings");
const automationFlags = require("../automation-flags");

const DEFAULT_BRIEFING_CRON = "0 6 * * *";   // 06:00 local
const TZ = "America/Chicago";

let jobs = [];

function init(db, sendPush, getSettings) {
  if (!process.env.PERPLEXITY_API_KEY) {
    console.log("[research] PERPLEXITY_API_KEY not set — skipping");
    return;
  }
  const settings = (getSettings && getSettings()) || {};
  if (settings.enabled === false) {
    console.log("[research] Disabled in settings");
    return;
  }

  const schedule = settings.briefingCron || DEFAULT_BRIEFING_CRON;
  jobs.push(cron.schedule(schedule, async () => {
    if (automationFlags.getFlags().researchBriefings === false) return;
    try {
      const out = await briefings.runAll(db, sendPush);
      console.log(`[research] briefings: ${out.regions} regions, $${out.cost}`);
    } catch (e) {
      console.error("[research] briefing run failed:", e.message);
    }
  }, { timezone: settings.timezone || TZ }));

  // Nightly cache sweep — expired rows serve no one.
  jobs.push(cron.schedule("30 3 * * *", async () => {
    try {
      const n = await perplexity.purgeCache(db);
      if (n) console.log(`[research] purged ${n} expired cache rows`);
    } catch (e) {
      console.error("[research] cache purge failed:", e.message);
    }
  }, { timezone: settings.timezone || TZ }));

  console.log(`[research] Module initialized (briefings at "${schedule}")`);
}

function shutdown() {
  jobs.forEach((j) => { try { j.stop(); } catch (_) {} });
  jobs = [];
}

function registerRoutes(app, db, sendPush) {

  // Raw ranked results. The cheap path — $0.005/query.
  app.post("/api/research/search", async (req, res) => {
    try {
      const { query, queries, recency, domains, country, maxResults, ttlSeconds, caller } = req.body || {};
      const q = queries || query;
      if (!q || (Array.isArray(q) && !q.length)) {
        return res.status(400).json({ error: "query or queries required" });
      }
      const out = await perplexity.search(q, {
        db, recency, domains, country,
        maxResults, ttlSeconds,
        caller: caller || "api",
      });
      res.json({
        results: out.results,
        cached: out._cached,
        cost_usd: out._cost,
        requests: out._requests,
      });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // Grounded natural-language answer with citations.
  app.post("/api/research/ask", async (req, res) => {
    try {
      const { input, preset, domains, recency, ttlSeconds, caller } = req.body || {};
      if (!input) return res.status(400).json({ error: "input required" });
      const out = await perplexity.ask(input, {
        db, preset, domains, recency, ttlSeconds,
        caller: caller || "api",
      });
      res.json({
        answer: out.answer,
        sources: out.sources,
        model: out.model,
        cached: out._cached,
        cost_usd: out._cost,
      });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // Check a batch of claims against the live web. One search per claim.
  app.post("/api/research/factcheck", async (req, res) => {
    try {
      const { claims, domains, recency } = req.body || {};
      if (!Array.isArray(claims) || !claims.length) {
        return res.status(400).json({ error: "claims (array of strings) required" });
      }
      if (claims.length > 40) {
        return res.status(400).json({ error: "max 40 claims per request" });
      }
      const out = await perplexity.search(claims, {
        db, domains, recency, maxResults: 5, caller: "factcheck",
      });
      res.json({
        claims: claims.length,
        results: out.results,
        cost_usd: out._cost,
        requests: out._requests,   // claims are batched 5 per request
        cached: out._cached,
        note: "Results are the evidence set — judge support with a model, not by result count alone.",
      });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ── Regions ───────────────────────────────────────────────────────────────

  app.get("/api/research/regions", async (_req, res) => {
    try {
      const { data, error } = await db.from("research_regions").select("*").order("name");
      if (error) throw new Error(error.message);
      res.json(data || []);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.put("/api/research/regions/:id", async (req, res) => {
    try {
      const { name, country_code, queries, domains, social_domains, enabled } = req.body || {};
      if (!name) return res.status(400).json({ error: "name required" });
      if (queries && !Array.isArray(queries)) {
        return res.status(400).json({ error: "queries must be an array of strings" });
      }
      if (social_domains && !Array.isArray(social_domains)) {
        return res.status(400).json({ error: "social_domains must be an array of domains" });
      }
      const { data, error } = await db.from("research_regions").upsert({
        id: req.params.id,
        name,
        country_code: country_code || null,
        queries: queries || [],
        domains: domains || null,
        social_domains: social_domains && social_domains.length ? social_domains : null,
        enabled: enabled !== false,
      }).select().maybeSingle();
      if (error) throw new Error(error.message);
      res.json(data);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.delete("/api/research/regions/:id", async (req, res) => {
    try {
      const { error } = await db.from("research_regions").delete().eq("id", req.params.id);
      if (error) throw new Error(error.message);
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ── Briefings ─────────────────────────────────────────────────────────────

  app.get("/api/research/briefings", async (req, res) => {
    try {
      let q = db.from("research_briefings").select("*").order("ts", { ascending: false })
        .limit(Math.min(Number(req.query.limit) || 20, 100));
      if (req.query.region) q = q.eq("region_id", req.query.region);
      const { data, error } = await q;
      if (error) throw new Error(error.message);
      res.json(data || []);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // Manual trigger — all regions, or one via ?region=slug
  app.post("/api/research/briefings/run", async (req, res) => {
    try {
      if (req.query.region) {
        const { data: region, error } = await db.from("research_regions")
          .select("*").eq("id", req.query.region).maybeSingle();
        if (error) throw new Error(error.message);
        if (!region) return res.status(404).json({ error: "region not found" });
        const out = await briefings.runRegion(db, region);
        return res.json(out);
      }
      const out = await briefings.runAll(db, sendPush);
      res.json(out);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ── Spend ─────────────────────────────────────────────────────────────────

  app.get("/api/research/usage", async (req, res) => {
    try {
      const out = await perplexity.spendSummary(db, Math.min(Number(req.query.days) || 30, 365));
      res.json(out);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });
}

module.exports = { init, shutdown, registerRoutes, perplexity, briefings };
