// dotenv v17 requires override:true to write to process.env
require("dotenv").config({ path: require("path").resolve(__dirname, "../../.env"), override: true });

const cron = require("node-cron");
const { createClient } = require("@supabase/supabase-js");

// Sources
const arxiv = require("./sources/arxiv");
const huggingface = require("./sources/huggingface");
const github = require("./sources/github");
const blogs = require("./sources/blogs");
const anthropic = require("./sources/anthropic");
const hackernews = require("./sources/hackernews");

// Pipeline
const { filterItems } = require("./filter");
const { sendNotification, saveBriefing } = require("./notify");

// Supabase client
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// ── Deduplication ──────────────────────────────────────────────────────────

async function getSeenIds(source) {
  const { data } = await supabase
    .from("ai_monitor_state")
    .select("item_id")
    .eq("source", source);
  return new Set((data || []).map((r) => r.item_id));
}

async function markSeen(items) {
  if (items.length === 0) return;
  const rows = items.map((item) => ({
    source: item.source,
    item_id: item.id,
  }));
  // Upsert to avoid unique constraint violations
  await supabase
    .from("ai_monitor_state")
    .upsert(rows, { onConflict: "source,item_id", ignoreDuplicates: true });
}

async function purgeOldState() {
  const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  await supabase
    .from("ai_monitor_state")
    .delete()
    .lt("first_seen", cutoff);
}

// ── Dedup helper ───────────────────────────────────────────────────────────

async function dedup(items) {
  // Group by source, batch-check seen IDs
  const sources = [...new Set(items.map((i) => i.source))];
  const seenSets = {};
  await Promise.all(
    sources.map(async (src) => {
      seenSets[src] = await getSeenIds(src);
    })
  );

  return items.filter((item) => {
    const seen = seenSets[item.source];
    return !seen || !seen.has(item.id);
  });
}

// ── Main pipeline ──────────────────────────────────────────────────────────

async function run(runType) {
  const startTime = Date.now();
  console.log(
    `\n[ai-monitor] Starting ${runType} run at ${new Date().toISOString()}`
  );

  // 1. Fetch from all sources in parallel
  console.log("[ai-monitor] Fetching from all sources...");
  const results = await Promise.allSettled([
    arxiv.fetchNewPapers(),
    huggingface.fetchTrending(),
    github.fetchTrending(),
    blogs.fetchNew(),
    anthropic.fetchNew(),
    hackernews.fetchAIStories(),
  ]);

  const sourceNames = [
    "arxiv",
    "huggingface",
    "github",
    "blogs",
    "anthropic",
    "hackernews",
  ];
  const allItems = [];
  const sourcesSummary = {};

  results.forEach((result, i) => {
    const name = sourceNames[i];
    if (result.status === "fulfilled") {
      const items = result.value || [];
      sourcesSummary[name] = items.length;
      allItems.push(...items);
      console.log(`  [${name}] ${items.length} items`);
    } else {
      sourcesSummary[name] = 0;
      console.warn(`  [${name}] FAILED: ${result.reason?.message}`);
    }
  });

  console.log(`[ai-monitor] Total raw items: ${allItems.length}`);

  // 2. Deduplicate against Supabase state
  const newItems = await dedup(allItems);
  console.log(
    `[ai-monitor] After dedup: ${newItems.length} new items (${allItems.length - newItems.length} seen before)`
  );

  if (newItems.length === 0) {
    console.log("[ai-monitor] No new items. Skipping.");
    return;
  }

  // 2b. Pre-filter: cap items sent to Haiku to reduce token usage
  // Prioritize by signal strength (points/stars/trending), cap at 150
  const MAX_ITEMS_FOR_HAIKU = 150;
  let filteredItems = newItems;
  if (newItems.length > MAX_ITEMS_FOR_HAIKU) {
    // Score each item by available signals
    const scored = newItems.map(item => {
      let score = 0;
      const m = item.metadata || {};
      if (m.points) score += m.points;
      if (m.stars) score += m.stars;
      if (m.trendingScore) score += m.trendingScore * 2;
      if (m.likes) score += m.likes;
      if (m.upvotes) score += m.upvotes * 5;
      // Boost blogs/anthropic (always low volume, always relevant)
      if (item.source === "blogs" || item.source === "anthropic") score += 1000;
      return { item, score };
    });
    scored.sort((a, b) => b.score - a.score);
    filteredItems = scored.slice(0, MAX_ITEMS_FOR_HAIKU).map(s => s.item);
    console.log(`[ai-monitor] Pre-filtered: ${newItems.length} → ${filteredItems.length} (top by signal strength)`);
  }

  // 3. Claude Haiku relevance filtering
  console.log("[ai-monitor] Filtering with Claude Haiku...");
  const { picks, totalItems } = await filterItems(filteredItems);
  console.log(`[ai-monitor] Claude picked ${picks.length} items`);

  // 4. Send notification
  await sendNotification(picks, totalItems, runType);

  // 5. Persist: mark all fetched items as seen + save briefing
  await markSeen(allItems);
  await saveBriefing(supabase, picks, totalItems, runType, sourcesSummary);
  await purgeOldState();

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`[ai-monitor] Done in ${elapsed}s\n`);
}

// ── Determine run type ─────────────────────────────────────────────────────

function getRunType() {
  const hour = new Date().getHours();
  return hour < 12 ? "morning" : "evening";
}

// ── Entry point ────────────────────────────────────────────────────────────

const args = process.argv.slice(2);

if (args.includes("--run-now")) {
  // One-shot mode
  run(getRunType())
    .then(() => process.exit(0))
    .catch((e) => {
      console.error("[ai-monitor] Fatal error:", e);
      process.exit(1);
    });
} else {
  // Cron mode: 7:00 AM and 6:00 PM CT (America/Chicago)
  console.log("[ai-monitor] Scheduled: 7:00 AM and 6:00 PM CT");

  cron.schedule("0 7 * * *", () => run("morning"), {
    timezone: "America/Chicago",
  });
  cron.schedule("0 18 * * *", () => run("evening"), {
    timezone: "America/Chicago",
  });

  console.log("[ai-monitor] Waiting for next scheduled run...");
  console.log("[ai-monitor] Use --run-now to run immediately.");
}
