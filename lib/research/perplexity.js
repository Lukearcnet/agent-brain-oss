/**
 * Perplexity client — retrieval layer for Agent Brain.
 *
 * Two endpoints:
 *   search(queries, opts)  POST /search      $0.005/REQUEST, raw ranked results
 *   ask(input, opts)       POST /v1/agent    grounded answer + citations
 *
 * Search bills per request, not per query, so pass an array whenever you have
 * several related lookups — twelve queries in one call still costs $0.005.
 *
 * Design rule: Perplexity does RETRIEVAL, Claude does REASONING. The daily crons
 * pull results with search() and synthesize with Haiku, which we already pay for.
 * Reach for ask() only when a cited natural-language answer is the actual product.
 *
 * Every response reports its real spend in usage.cost.total_cost, so research_usage
 * records what we were actually billed rather than an estimate.
 */

const crypto = require("crypto");

const API_BASE = "https://api.perplexity.ai";
const SEARCH_PATH = "/search";
const AGENT_PATH = "/v1/agent";

// Search bills per request regardless of query count or result count, so both
// batching queries and asking for more results are free wins — but the API caps
// a request at 5 queries, so larger batches are chunked and billed per chunk.
const SEARCH_COST_PER_REQUEST = 0.005;
const MAX_QUERIES_PER_REQUEST = 5;
const DEFAULT_MAX_RESULTS = 10;
const DEFAULT_TTL_SECONDS = 6 * 60 * 60;   // 6h — news moves, but not minute to minute
const REQUEST_TIMEOUT_MS = 120000;         // deep presets legitimately take minutes
const AGENT_TIMEOUT_MS = 300000;

function apiKey() {
  const key = process.env.PERPLEXITY_API_KEY;
  if (!key) throw new Error("PERPLEXITY_API_KEY not set");
  return key;
}

function cacheKey(endpoint, params) {
  // Sort keys so param order never splits the cache.
  const canonical = JSON.stringify(params, Object.keys(params).sort());
  return crypto.createHash("sha256").update(`${endpoint}:${canonical}`).digest("hex");
}

async function post(path, body, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${API_BASE}${path}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey()}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await res.text();
    let data;
    try { data = JSON.parse(text); } catch { data = { raw: text }; }
    if (!res.ok) {
      const detail = data?.error?.message || data?.detail || text.slice(0, 300);
      const err = new Error(`Perplexity ${path} ${res.status}: ${detail}`);
      err.status = res.status;
      throw err;
    }
    return data;
  } catch (e) {
    if (e.name === "AbortError") throw new Error(`Perplexity ${path} timed out after ${timeoutMs}ms`);
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Wraps a call with the Supabase cache. `db` may be null (cache disabled) so this
 * module stays usable from scripts that never touch Supabase.
 */
async function withCache(db, { endpoint, params, ttlSeconds, caller, preset, queries }, fetchFn) {
  const key = cacheKey(endpoint, params);
  const ttl = ttlSeconds ?? DEFAULT_TTL_SECONDS;

  if (db && ttl > 0) {
    try {
      const { data } = await db
        .from("research_cache")
        .select("response, cost_usd, hits")
        .eq("cache_key", key)
        .gt("expires_at", new Date().toISOString())
        .maybeSingle();

      if (data) {
        // Fire-and-forget: a cache-hit counter is not worth blocking the caller.
        db.from("research_cache").update({ hits: (data.hits || 0) + 1 })
          .eq("cache_key", key).then(() => {}, () => {});
        recordUsage(db, { endpoint, preset, caller, queries, cost: 0, cached: true });
        return { ...data.response, _cached: true, _cost: 0 };
      }
    } catch (e) {
      console.error("[research] cache read failed:", e.message);
    }
  }

  const { response, cost } = await fetchFn();

  if (db && ttl > 0) {
    try {
      await db.from("research_cache").upsert({
        cache_key: key,
        endpoint,
        params,
        response,
        cost_usd: cost,
        expires_at: new Date(Date.now() + ttl * 1000).toISOString(),
      });
    } catch (e) {
      console.error("[research] cache write failed:", e.message);
    }
  }

  recordUsage(db, { endpoint, preset, caller, queries, cost, cached: false });
  return { ...response, _cached: false, _cost: cost };
}

function recordUsage(db, { endpoint, preset, caller, queries, cost, cached, meta }) {
  if (!db) return;
  db.from("research_usage").insert({
    endpoint,
    preset: preset || null,
    caller: caller || "unknown",
    queries: queries || 1,
    cost_usd: cost || 0,
    cached: !!cached,
    meta: meta || null,
  }).then(() => {}, (e) => console.error("[research] usage log failed:", e.message));
}

/**
 * Search API — the cheap workhorse.
 *
 * @param {string|string[]} queries  one query or a batch (the API accepts an array)
 * @param {object} opts
 *   maxResults, recency ('hour'|'day'|'week'|'month'|'year'), domains (max 20),
 *   country (ISO alpha-2), afterDate/beforeDate ('MM/DD/YYYY'), maxTokensPerPage,
 *   ttlSeconds, caller, db
 * @returns {{results: Array, _cost: number, _cached: boolean}}
 */
async function search(queries, opts = {}) {
  const list = (Array.isArray(queries) ? queries : [queries]).filter((q) => q && q.trim());
  if (!list.length) throw new Error("search() requires at least one query");

  const filters = {};
  if (opts.maxTokensPerPage) filters.max_tokens_per_page = opts.maxTokensPerPage;
  if (opts.recency) filters.search_recency_filter = opts.recency;
  if (opts.domains?.length) filters.search_domain_filter = opts.domains.slice(0, 20);
  if (opts.country) filters.country = opts.country;
  if (opts.afterDate) filters.search_after_date_filter = opts.afterDate;
  if (opts.beforeDate) filters.search_before_date_filter = opts.beforeDate;
  if (opts.language) filters.search_language_filter = opts.language;

  // The API rejects more than 5 queries per request, so split and bill per chunk.
  // Chunks are cached independently, which also improves reuse across callers.
  const chunks = [];
  for (let i = 0; i < list.length; i += MAX_QUERIES_PER_REQUEST) {
    chunks.push(list.slice(i, i + MAX_QUERIES_PER_REQUEST));
  }

  const merged = [];
  const seenUrls = new Set();
  let totalCost = 0;
  let allCached = true;

  for (const chunk of chunks) {
    const body = {
      query: chunk.length === 1 ? chunk[0] : chunk,
      max_results: opts.maxResults || DEFAULT_MAX_RESULTS,
      ...filters,
    };

    const out = await withCache(opts.db, {
      endpoint: "search",
      params: body,
      ttlSeconds: opts.ttlSeconds,
      caller: opts.caller,
      queries: chunk.length,
    }, async () => {
      const data = await post(SEARCH_PATH, body, REQUEST_TIMEOUT_MS);
      const results = (data.results || []).map((r) => ({
        title: r.title,
        url: r.url,
        snippet: r.snippet,
        date: r.date,
        last_updated: r.last_updated,
      }));
      // No usage block on this endpoint. It bills per REQUEST, not per query —
      // "including a successful request with multiple queries".
      return { response: { results }, cost: SEARCH_COST_PER_REQUEST };
    });

    totalCost += out._cost || 0;
    if (!out._cached) allCached = false;
    for (const r of out.results || []) {
      if (!r.url || seenUrls.has(r.url)) continue;
      seenUrls.add(r.url);
      merged.push(r);
    }
  }

  return {
    results: merged,
    _cached: allCached,
    _cost: Number(totalCost.toFixed(6)),
    _requests: chunks.length,
  };
}

/**
 * Agent API — grounded natural-language answer with citations.
 *
 * @param {string} input
 * @param {object} opts  preset ('fast'|'low'|'medium'|'high'|'xhigh'), domains,
 *                       recency, ttlSeconds, caller, db
 * @returns {{answer: string, sources: Array, _cost: number, _cached: boolean}}
 */
async function ask(input, opts = {}) {
  if (!input || !input.trim()) throw new Error("ask() requires input");

  const body = { preset: opts.preset || "fast", input };
  if (opts.domains?.length || opts.recency) {
    const tool = { type: "web_search", filters: {} };
    if (opts.domains?.length) tool.filters.search_domain_filter = opts.domains.slice(0, 20);
    if (opts.recency) tool.filters.search_recency_filter = opts.recency;
    body.tools = [tool];
  }

  return withCache(opts.db, {
    endpoint: "agent",
    params: body,
    ttlSeconds: opts.ttlSeconds,
    caller: opts.caller,
    preset: body.preset,
    queries: 1,
  }, async () => {
    const data = await post(AGENT_PATH, body, AGENT_TIMEOUT_MS);
    return {
      response: { answer: extractText(data), sources: extractSources(data), model: data.model },
      cost: data?.usage?.cost?.total_cost || 0,
    };
  });
}

// The Agent API returns an OpenAI-Responses-style `output` array rather than a
// flat output_text, so pull the assistant message content out of it.
function extractText(data) {
  if (typeof data.output_text === "string" && data.output_text) return data.output_text;
  const parts = [];
  for (const item of data.output || []) {
    if (item.type !== "message") continue;
    const content = item.content;
    if (typeof content === "string") { parts.push(content); continue; }
    for (const c of content || []) {
      if (typeof c === "string") parts.push(c);
      else if (c.text) parts.push(c.text);
    }
  }
  return parts.join("\n").trim();
}

function extractSources(data) {
  const seen = new Set();
  const out = [];
  for (const item of data.output || []) {
    for (const r of item.results || []) {
      if (!r.url || seen.has(r.url)) continue;
      seen.add(r.url);
      out.push({ title: r.title, url: r.url, date: r.date, snippet: r.snippet });
    }
  }
  return out;
}

/** Spend over the trailing N days, split by caller — powers the cost guard. */
async function spendSummary(db, days = 30) {
  if (!db) return { total: 0, byCaller: {}, days };
  const since = new Date(Date.now() - days * 86400000).toISOString();
  const { data, error } = await db
    .from("research_usage")
    .select("caller, cost_usd, cached")
    .gte("ts", since);
  if (error) throw new Error(error.message);

  const byCaller = {};
  let total = 0, cachedCalls = 0;
  for (const row of data || []) {
    const cost = Number(row.cost_usd) || 0;
    total += cost;
    byCaller[row.caller] = (byCaller[row.caller] || 0) + cost;
    if (row.cached) cachedCalls++;
  }
  return {
    days,
    total: Number(total.toFixed(4)),
    calls: (data || []).length,
    cachedCalls,
    byCaller: Object.fromEntries(
      Object.entries(byCaller).map(([k, v]) => [k, Number(v.toFixed(4))])
    ),
  };
}

/** Drop expired cache rows. Called by the daily cron. */
async function purgeCache(db) {
  if (!db) return 0;
  const { data, error } = await db
    .from("research_cache")
    .delete()
    .lt("expires_at", new Date().toISOString())
    .select("cache_key");
  if (error) throw new Error(error.message);
  return (data || []).length;
}

module.exports = { search, ask, spendSummary, purgeCache, cacheKey };
