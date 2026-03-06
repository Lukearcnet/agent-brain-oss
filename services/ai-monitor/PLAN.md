# AI Developments Monitor — Plan

## Overview

Lightweight Node.js service that runs twice daily, aggregates AI developments from multiple sources, uses Claude Haiku to filter for relevance to my projects, and sends a 3-5 item briefing via ntfy.sh.

Lives at `services/ai-monitor/` within the agent-brain repo.

---

## 1. Source Analysis

### Tier 1: High-Signal Research Sources

| Source | Method | What We Get | Update Cadence |
|--------|--------|-------------|----------------|
| **ArXiv** (cs.AI, cs.CL, cs.LG) | RSS feed: `https://rss.arxiv.org/rss/cs.AI+cs.CL+cs.LG` | Title, abstract, authors, categories, announce type | Daily batches (weekdays, announced ~20:00 ET) |
| **HuggingFace Trending** | JSON API: `https://huggingface.co/api/trending` | Top ~30 trending models/spaces/datasets | Real-time |
| **HuggingFace Daily Papers** | JSON API: `https://huggingface.co/api/daily_papers` | Community-upvoted papers (~50/day) | Daily |

**ArXiv notes:** Papers are announced in daily batches, not continuously. No announcements Fri/Sat. The RSS feed returns exactly that day's batch. We filter to `announce_type: "new"` (skip cross-listings and replacements). Typical batch: 50-150 papers across the three categories. No auth required, no rate limits for single requests.

**HuggingFace notes:** The `/api/trending` endpoint mixes models, spaces, and datasets — gives the "homepage" view. `/api/daily_papers` is excellent for paper discovery with community upvote signal. We also hit `/api/models?sort=trendingScore&direction=-1&limit=20` for trending models specifically. No auth required (500 req/5min anonymous limit is more than enough).

### Tier 2: Industry & Community Signal

| Source | Method | What We Get | Update Cadence |
|--------|--------|-------------|----------------|
| **OpenAI Blog** | RSS: `https://openai.com/blog/rss.xml` | Title, summary, link, category | ~3-5x/week |
| **Google DeepMind** | RSS: `https://deepmind.google/blog/rss.xml` | Title, summary, link | ~2-4x/week |
| **Google AI Blog** | RSS: `https://blog.google/technology/ai/rss/` | Title, summary (Gemini, product launches) | ~5x/week |
| **Meta Engineering (ML)** | RSS: `https://engineering.fb.com/category/ml-applications/feed/` | Title, full HTML article | ~2x/month |
| **Anthropic Blog** | HTML scrape: `https://www.anthropic.com/news` | Title, link (parse from page HTML) | ~2-4x/month |
| **Hacker News (AI)** | JSON API: `https://hn.algolia.com/api/v1/search?tags=front_page&query=AI+LLM+Claude+GPT` | Title, URL, points, comments | Real-time |

**Anthropic blog note:** No RSS feed exists. We scrape the `/news` page, extract article links via cheerio, and diff against previously seen URLs.

**HN note:** The Algolia API is free, no auth required, returns front-page stories matching keywords. We filter to `points > 30` for signal quality.

### Tier 3: GitHub Trending

| Source | Method | What We Get | Update Cadence |
|--------|--------|-------------|----------------|
| **GitHub Search API** | REST: topics + created date + sort by stars | New repos with star velocity | Real-time |
| **OSS Insight** | JSON API: `https://api.ossinsight.io/v1/trending-repos?period=past_24_hours&language=Python` | Trending repos with composite score | Daily |

**GitHub approach:** No official trending API exists. We query the Search API with AI topics (`machine-learning`, `llm`, `generative-ai`, `deep-learning`, `artificial-intelligence`) filtered to repos created in the last 7 days with >20 stars, sorted by stars descending. This catches new projects gaining traction. Requires GitHub token for 30 req/min (vs 10 unauthenticated). 7 topic queries ≈ 18 seconds with rate-limit spacing.

**OSS Insight** supplements with a composite "trending score" factoring in stars, forks, PRs, and pushes — better velocity signal than raw star count. No auth required.

### Sources Considered and Rejected

| Source | Why Rejected |
|--------|-------------|
| **Papers With Code** | Redirects to HuggingFace papers — redundant |
| **The Gradient** | Only 1-2 articles/month — too infrequent for daily monitoring |
| **Import AI** | Weekly newsletter — can't get daily signal from it |
| **The Decoder / MIT Tech Review** | General news aggregators — adds volume without signal |

---

## 2. Filtering Strategy

### Two-Stage Pipeline

**Stage 1: Pre-filter (code-level, no API cost)**

Reduce raw item count before sending to Claude:

- **ArXiv**: Keep only `announce_type: "new"`. Deduplicate against previously seen paper IDs (stored in JSON). Typical: 50-150 papers → all sent to Claude since abstracts are concise.
- **HuggingFace**: Only trending models with `trendingScore > 20` or `likes > 10`. Skip dataset entries. Typical: 30 items → ~10-15 after filtering.
- **Company blogs**: Only items not seen in previous runs (diff against stored URLs). Typical: 0-3 new posts per run.
- **GitHub**: Only repos with >20 stars. Keyword-filter OSS Insight results for AI/ML terms. Typical: 30-50 repos → ~15-20 after filtering.
- **HN**: Only stories with >30 points. Typical: 5-15 stories per run.

**Stage 2: Claude Haiku relevance filtering**

Send the pre-filtered items (titles, short descriptions, links) plus project context to Claude Haiku with this prompt structure:

```
You are an AI developments analyst. Given these items and my project context,
pick the 3-5 most important developments. Score each as:
- "directly useful" — I can apply this to my projects right now
- "worth watching" — significant development I should be aware of
- "background noise" — skip unless nothing else qualifies

My projects:
{Agent Brain memory excerpt — architecture, current work, tech stack}
{Arc Social — iOS app context}

Focus areas: agent orchestration, Claude Code integrations, iOS development,
LLM tooling, multi-agent systems, developer experience.

For each selected item, provide:
- 1-2 sentence summary (why it matters to me)
- Score (directly useful / worth watching)
- Source link

Raw items:
{aggregated items as structured text}
```

The key insight: Claude does the hard part — understanding which of 80+ items actually matters given what I'm building. Haiku is fast and cheap enough to do this thoughtfully.

---

## 3. Cost Estimate

### Claude API (Haiku 4.5)

| Component | Tokens | Notes |
|-----------|--------|-------|
| **System prompt + instructions** | ~500 | Static |
| **Project context** (from Agent Brain memory) | ~2,000 | Architecture summary, current focus |
| **ArXiv papers** (50-100 × title + full abstract) | ~15,000-20,000 | Full abstracts for better filtering |
| **HuggingFace items** (10-15 × name + tags) | ~1,000 | Compact |
| **Company blog posts** (0-3 × title + summary) | ~500 | Usually sparse |
| **GitHub repos** (15-20 × name + description) | ~1,500 | Short descriptions |
| **HN stories** (5-15 × title + URL) | ~800 | Minimal |
| **Total input** | **~20,000-25,000** | With full ArXiv abstracts |
| **Output** (3-5 items × 2-3 sentences + scores) | **~400-600** | |

**Pricing** (claude-haiku-4-5-20251001):
- Input: $0.80/MTok
- Output: $4.00/MTok

**Cost per run:** (25K × $0.80/M) + (0.6K × $4.00/M) = $0.020 + $0.0024 = **~$0.022**

**Daily cost** (2 runs): **~$0.044**

**Monthly cost:** **~$1.35**

Negligible. Full abstracts are worth the marginal cost for better filtering.

### Other API Costs

All other sources (ArXiv, HuggingFace, GitHub, HN, RSS feeds) are free. GitHub requires a token but has no monetary cost.

---

## 4. Architecture

```
services/ai-monitor/
├── index.js              # Entry point, node-cron scheduler
├── sources/
│   ├── arxiv.js          # RSS fetch + parse (fast-xml-parser)
│   ├── huggingface.js    # API calls (trending, daily papers, models)
│   ├── github.js         # Search API + OSS Insight
│   ├── blogs.js          # RSS feeds (OpenAI, DeepMind, Google AI, Meta)
│   ├── anthropic.js      # HTML scrape + diff
│   └── hackernews.js     # Algolia API
├── filter.js             # Claude Haiku relevance filtering
├── notify.js             # ntfy.sh push notification
├── package.json
└── PLAN.md               # This file
```

### Data Flow

```
1. FETCH (parallel)
   ├── arxiv.fetchNewPapers()        → [{title, abstract, link, categories}]
   ├── huggingface.fetchTrending()   → [{name, type, score, tags, link}]
   ├── github.fetchTrending()        → [{name, description, stars, link, topics}]
   ├── blogs.fetchNew()              → [{source, title, summary, link}]
   ├── anthropic.fetchNew()          → [{title, link}]
   └── hackernews.fetchAIStories()   → [{title, url, points, comments}]

2. PRE-FILTER (code-level)
   ├── Deduplicate against state.json (seen IDs/URLs)
   ├── Apply thresholds (stars, points, trending score)
   └── Normalize to common format: [{source, title, description, link, metadata}]

3. RELEVANCE FILTER (Claude Haiku)
   ├── Load project context from Agent Brain memory API
   ├── Send normalized items + context to Haiku
   └── Receive: [{title, summary, score, link}] (3-5 items)

4. NOTIFY (ntfy.sh)
   ├── Format briefing as readable text
   └── POST to https://ntfy.sh/Agent-brain

5. PERSIST (Supabase via Agent Brain)
   ├── Update seen IDs in Supabase `ai_monitor_state` table
   ├── Store briefing in Supabase `ai_monitor_briefings` table
   └── Log briefing to Agent Brain daily log (so Claude Code sessions see it)
```

### Schedule

Two runs per day via `node-cron`:

| Run | Time (CT) | Primary Catch |
|-----|-----------|---------------|
| **Morning** | 7:00 AM | ArXiv papers (announced previous evening), overnight GitHub/HF trending |
| **Evening** | 6:00 PM | Day's blog posts, HN discussion, afternoon developments |

ArXiv announces ~7:00 PM ET (6:00 PM CT) on weekdays. The morning run catches papers from the previous evening's batch. The evening run catches the current day's batch right as it drops plus everything else from the day.

### Dependencies

```json
{
  "dependencies": {
    "@anthropic-ai/sdk": "latest",
    "fast-xml-parser": "^4.x",
    "cheerio": "^1.x",
    "node-cron": "^3.x"
  }
}
```

Only 4 dependencies. State persisted in Agent Brain's Supabase (see below). No web server — it's a pure cron job.

### ntfy.sh Notification Format

```
🔬 AI Briefing — Mar 3, 2026 (Morning)

1. [directly useful] New Claude Agent SDK supports parallel tool execution
   Anthropic released SDK v2.1 with native parallel tool calling — directly applicable to Agent Brain's orchestrator dispatch.
   → https://anthropic.com/news/agent-sdk-v2-1

2. [worth watching] Qwen 3.5 released with 35B MoE architecture
   Only 3B active params but benchmarks competitively with 70B dense models. Could be useful for local inference in iOS apps.
   → https://huggingface.co/Qwen/Qwen3.5-35B-A3B

3. [directly useful] GitHub trending: agent-protocol v2.0
   Standardized protocol for agent-to-agent communication. Aligns with Agent Brain's cross-session messaging architecture.
   → https://github.com/AI-Engineer-Foundation/agent-protocol

---
Filtered from 87 items across 6 sources.
```

Priority tag in ntfy.sh set to `3` (default) for normal briefings, `4` (high) if any item scores "directly useful".

### Supabase Schema

Two new tables in Agent Brain's Supabase:

```sql
-- Deduplication state: tracks seen item IDs per source
CREATE TABLE ai_monitor_state (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  source TEXT NOT NULL,          -- 'arxiv', 'huggingface', 'github', etc.
  item_id TEXT NOT NULL,         -- source-specific ID (arxiv ID, repo full_name, URL)
  first_seen TIMESTAMPTZ DEFAULT now(),
  UNIQUE(source, item_id)
);

-- Auto-cleanup: delete entries older than 7 days
-- (handled in code after each run)

-- Briefing archive: every generated briefing
CREATE TABLE ai_monitor_briefings (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  created_at TIMESTAMPTZ DEFAULT now(),
  run_type TEXT NOT NULL,        -- 'morning' or 'evening'
  raw_item_count INTEGER,        -- items before filtering
  filtered_items JSONB,          -- the 3-5 selected items with scores
  briefing_text TEXT,            -- formatted notification text
  sources_summary JSONB          -- {arxiv: 45, github: 12, ...} counts per source
);
```

### Integration with Agent Brain

1. **Read** project memory via `GET /api/memory/-Users-lukeblanton-agent-brain` to inject as context for Claude filtering
2. **Store** each briefing in `ai_monitor_briefings` for history and review
3. **Write** each briefing to the daily log via `POST /api/memory/-Users-lukeblanton-agent-brain/daily` — future Claude Code sessions see "what's new in AI" automatically
4. Agent Brain cron reads the latest briefing and incorporates it into session context

### Running

```bash
# Development / one-shot test
node services/ai-monitor/index.js --run-now

# Production (self-scheduling via node-cron)
node services/ai-monitor/index.js

# Or via system cron (alternative to node-cron)
# 0 7,18 * * * cd /Users/lukeblanton/agent-brain && node services/ai-monitor/index.js --run-now
```

For production, recommend running via `pm2` or `launchd` (macOS) to keep the node-cron process alive.

---

## 5. Resolved Decisions

1. **ArXiv abstracts**: Send full abstracts (no truncation). Better filtering is worth the ~$0.005/run marginal cost.

2. **Anthropic blog**: HTML scrape via cheerio as primary approach. The scraper parses article links from `anthropic.com/news` and diffs against seen URLs in Supabase. If the page structure changes and scraping fails, it logs a warning and falls back gracefully (just no Anthropic items that run). The scraper is isolated in `sources/anthropic.js` — easy to fix when breakage is detected.

3. **State persistence**: Supabase via Agent Brain. Two new tables: `ai_monitor_state` (dedup) and `ai_monitor_briefings` (archive). Survives machine wipes, accessible from any session, and the briefing archive lets Agent Brain serve past briefings to Claude Code sessions.

4. **Weekend runs**: Yes, run on weekends. ArXiv won't have new papers, but GitHub, HuggingFace, blogs, and HN still produce content. If a run finds nothing notable, it sends no notification (silent skip rather than an empty briefing).

5. **Deduplication window**: 7 days. After each run, purge `ai_monitor_state` entries older than 7 days to prevent unbounded growth.
