/**
 * Regional intelligence briefings.
 *
 * For each enabled region: batch its queries through the Perplexity Search API
 * (recency-filtered), drop URLs already reported, synthesize what's left with
 * Haiku, store the briefing, and push a one-line headline.
 *
 * Cost shape: one Search API request per region, carrying all its queries as a
 * batch. Search bills per REQUEST, so a region costs $0.005/day no matter how
 * many queries it watches — six regions is ~$0.03/day, under $1/month. Synthesis
 * rides on the Anthropic key we already pay for.
 *
 * Regions with `social_domains` set spend one extra request on a separate social
 * pass; see the comment in runRegion for why it cannot share the main filter.
 */

const Anthropic = require("@anthropic-ai/sdk");
const perplexity = require("./perplexity");

const SYNTH_MODEL = "claude-haiku-4-5-20251001";
const MAX_RESULTS_PER_QUERY = 10;
const SEEN_URL_RETENTION_DAYS = 45;

let anthropic = null;
function getClient() {
  if (!anthropic) anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  return anthropic;
}

/** MM/DD/YYYY for `search_after_date_filter`, N days back from today. */
function dateFloor(days) {
  const d = new Date(Date.now() - days * 86400000);
  const p = (n) => String(n).padStart(2, "0");
  return `${p(d.getMonth() + 1)}/${p(d.getDate())}/${d.getFullYear()}`;
}

/**
 * Run one region's briefing.
 * @returns {{regionId, headline, body, sources, cost, skipped?: string}}
 */
async function runRegion(db, region, opts = {}) {
  const queries = Array.isArray(region.queries) ? region.queries : [];
  if (!queries.length) return { regionId: region.id, skipped: "no queries configured" };

  // Briefings want today's news, and a fresh call each morning — so bypass the
  // 6h cache that suits ad-hoc lookups.
  const res = await perplexity.search(queries, {
    db,
    caller: `briefing:${region.id}`,
    recency: opts.recency || "day",
    country: region.country_code || undefined,
    domains: Array.isArray(region.domains) && region.domains.length ? region.domains : undefined,
    maxResults: opts.maxResults || MAX_RESULTS_PER_QUERY,
    maxTokensPerPage: 512,
    ttlSeconds: 0,
  });

  let all = res.results || [];
  let cost = res._cost || 0;

  // Social sources get their own request: in a shared domain filter, news sites
  // routinely outrank social posts and crowd them out completely. For places
  // where ministries and local radio publish to Facebook before their own site,
  // that would silently drop the primary source.
  const social = Array.isArray(region.social_domains) ? region.social_domains : [];
  if (social.length) {
    try {
      const socialRes = await perplexity.search(queries, {
        db,
        caller: `briefing:${region.id}:social`,
        domains: social.slice(0, 20),
        // Social post dates in the index are less reliable than news; an explicit
        // date floor holds better than the relative recency filter.
        afterDate: opts.afterDate || dateFloor(opts.socialWindowDays || 7),
        maxResults: opts.maxResults || MAX_RESULTS_PER_QUERY,
        maxTokensPerPage: 700,
        ttlSeconds: 0,
      });
      cost += socialRes._cost || 0;
      const seen = new Set(all.map((r) => r.url));
      for (const r of socialRes.results || []) {
        if (r.url && !seen.has(r.url)) { seen.add(r.url); all.push(r); }
      }
    } catch (e) {
      // A social failure must not cost us the whole briefing.
      console.error(`[research] social pass failed for ${region.id}:`, e.message);
    }
  }

  const fresh = await filterSeen(db, region.id, all);

  if (!fresh.length) {
    return {
      regionId: region.id,
      headline: null,
      body: null,
      sources: [],
      cost: cost,
      skipped: `no new sources (${all.length} results, all previously seen)`,
    };
  }

  const { headline, body } = await synthesize(region, fresh);

  const { data: inserted, error } = await db.from("research_briefings").insert({
    region_id: region.id,
    headline,
    body_markdown: body,
    sources: fresh.map((r) => ({ title: r.title, url: r.url, date: r.date })),
    result_count: fresh.length,
    cost_usd: cost,
  }).select("id").maybeSingle();
  if (error) throw new Error(`briefing insert failed: ${error.message}`);

  await markSeen(db, region.id, fresh);

  return {
    regionId: region.id,
    briefingId: inserted?.id,
    headline,
    body,
    sources: fresh,
    cost: cost,
  };
}

/** Drop results whose URL we've already reported for this region. */
async function filterSeen(db, regionId, results) {
  const deduped = [];
  const seenInBatch = new Set();
  for (const r of results) {
    if (!r.url || seenInBatch.has(r.url)) continue;
    seenInBatch.add(r.url);
    deduped.push(r);
  }
  if (!deduped.length) return [];

  const { data, error } = await db
    .from("research_seen_urls")
    .select("url")
    .eq("region_id", regionId)
    .in("url", deduped.map((r) => r.url));
  if (error) {
    console.error("[research] seen-url lookup failed:", error.message);
    return deduped; // fail open — a duplicate beats a missed briefing
  }
  const seen = new Set((data || []).map((r) => r.url));
  return deduped.filter((r) => !seen.has(r.url));
}

async function markSeen(db, regionId, results) {
  if (!results.length) return;
  const rows = results.map((r) => ({ region_id: regionId, url: r.url }));
  const { error } = await db.from("research_seen_urls").upsert(rows, {
    onConflict: "region_id,url",
    ignoreDuplicates: true,
  });
  if (error) console.error("[research] seen-url write failed:", error.message);
}

async function synthesize(region, results) {
  const sourceText = results.map((r, i) =>
    `[${i + 1}] ${r.title || "(untitled)"}\n    ${r.url}\n    ${r.date || "no date"} — ${(r.snippet || "").replace(/\s+/g, " ").slice(0, 600)}`
  ).join("\n\n");

  const system = `You write daily intelligence briefings for an operator working on real deals in the region named below. You are not writing a news roundup — you are writing what someone with money and reputation at stake needs to know before their next conversation.

Rules:
- Lead with what CHANGED, not background.
- Be concrete: names, numbers, dates. Skip anything you cannot ground in the sources.
- Cite sources inline as [1], [2] matching the numbered list.
- If the sources are thin or low-quality, say so plainly rather than padding.
- No preamble, no "in conclusion", no restating the region name back.

Return JSON, no markdown fences:
{"headline": "one line, max 100 chars, the single most important development", "body": "markdown briefing, 150-400 words"}`;

  const msg = await getClient().messages.create({
    model: SYNTH_MODEL,
    max_tokens: 1500,
    system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],
    messages: [{
      role: "user",
      content: `Region: ${region.name}\n\nSources found in the last 24 hours:\n\n${sourceText}`,
    }],
  });

  const raw = (msg.content || []).filter((c) => c.type === "text").map((c) => c.text).join("").trim();
  try {
    const parsed = JSON.parse(raw.replace(/^```(?:json)?\s*|\s*```$/g, ""));
    return {
      headline: (parsed.headline || "").slice(0, 200) || `${region.name}: ${results.length} new sources`,
      body: parsed.body || raw,
    };
  } catch {
    // Model didn't return clean JSON — keep the prose rather than losing the run.
    return { headline: `${region.name}: ${results.length} new sources`, body: raw };
  }
}

/** Run every enabled region. Errors are per-region so one failure can't kill the batch. */
async function runAll(db, sendPush, opts = {}) {
  const { data: regions, error } = await db
    .from("research_regions")
    .select("*")
    .eq("enabled", true);
  if (error) throw new Error(`region load failed: ${error.message}`);
  if (!regions?.length) return { regions: 0, briefings: [], cost: 0 };

  const briefings = [];
  let cost = 0;
  for (const region of regions) {
    try {
      const result = await runRegion(db, region, opts);
      cost += result.cost || 0;
      briefings.push(result);
      if (result.headline && sendPush) {
        sendPush({
          title: `Briefing: ${region.name}`,
          message: result.headline,
          priority: 3,
        }).catch((e) => console.error("[research] push failed:", e.message));
      }
    } catch (e) {
      console.error(`[research] briefing failed for ${region.id}:`, e.message);
      briefings.push({ regionId: region.id, error: e.message });
    }
  }

  await purgeSeen(db);
  return { regions: regions.length, briefings, cost: Number(cost.toFixed(4)) };
}

async function purgeSeen(db) {
  const cutoff = new Date(Date.now() - SEEN_URL_RETENTION_DAYS * 86400000).toISOString();
  const { error } = await db.from("research_seen_urls").delete().lt("first_seen", cutoff);
  if (error) console.error("[research] seen-url purge failed:", error.message);
}

module.exports = { runRegion, runAll };
