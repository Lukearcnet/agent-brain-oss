# News Intelligence Dashboard — Build Plan

> Compiled 2026-03-03. Aggregates high-signal news across Stocks, Geopolitics, AI Advancements, and Macro Conditions.

---

## Table of Contents

1. [Data Source Selection](#1-data-source-selection)
2. [Recommended Sources Per Vertical](#2-recommended-sources-per-vertical)
3. [API Details & Pricing Summary](#3-api-details--pricing-summary)
4. [Proposed Architecture](#4-proposed-architecture)
5. [Database Schema](#5-database-schema)
6. [Phased Build Plan](#6-phased-build-plan)
7. [Appendices](#appendix-a-key-fred-series-watchlist)

---

## 1. Data Source Selection

### 1.1 Stocks — Earnings, Analyst Moves, SEC Filings, Unusual Volume

| Source | Free Tier | Earnings | Analyst Moves | SEC Filings | Volume | Sector Filter | Watchlist | Verdict |
|--------|-----------|----------|---------------|-------------|--------|---------------|-----------|---------|
| **Finnhub** | 60 req/min | Calendar + EPS | Upgrades/downgrades + price targets | Yes (secondary) | WebSocket (free) | SIC codes | Yes | **PRIMARY** |
| **SEC EDGAR** | 10 req/sec, no key | Raw 8-K/10-K XBRL | No | Yes (primary) | No | SIC codes | Via CIK | **PRIMARY** for filings |
| **MarketAux** | 100 req/day | No | No | No | No | Native industry filter | Yes | **Sector news** |
| **Alpha Vantage** | 25 req/day | Calendar + sentiment | No | No | Limited | Sector endpoint | Yes | Too restrictive free |
| **Polygon/Massive** | 5 req/min | No | No | No | OHLCV | Limited | Yes | Too restrictive free |
| **Tiingo** | 1000 req/day | No (paid) | No | No | IEX feed | No | Yes | Supplement for price data |
| **GlobeNewswire RSS** | Unlimited | Earnings releases | Analyst recs category | No | No | By category | No | **Free supplement** |
| **Seeking Alpha RSS** | Unlimited | Coverage | Commentary | No | No | Per-ticker feeds | Yes | **Free supplement** |

**Decision:** Finnhub (primary API) + SEC EDGAR (filings) + MarketAux (sector news) + GlobeNewswire/Seeking Alpha RSS (supplements). Total cost: **$0**.

**Unusual volume strategy:** No free API provides pre-computed unusual volume alerts. We'll compute it ourselves — pull daily volume from Finnhub, maintain a 20-day moving average, flag when current volume exceeds 2x average. Finnhub's free WebSocket provides real-time trade data to power this.

### 1.2 Geopolitics — Trade Policy, Sanctions, Conflicts, Elections, Regulatory

| Source | Free Tier | Type | Freshness | Signal Quality | Best For |
|--------|-----------|------|-----------|---------------|----------|
| **GDELT** (BigQuery + DOC API) | Free (BQ 1TB/mo) | Event database | 15-min updates | High (machine-coded) | Global event detection & spikes |
| **Federal Register API** | Free, no auth | REST | Same-day (6AM ET) | PRIMARY SOURCE | Exec orders, sanctions, tariffs, regulations |
| **Congress.gov API** | Free, 5000 req/hr | REST | Hours | PRIMARY SOURCE | Legislation tracking |
| **OFAC Sanctions Lists** | Free | File download | Same-day | PRIMARY SOURCE | Sanctions designations (SDN list) |
| **State Dept RSS** | Free | RSS | Same-day | PRIMARY SOURCE | Foreign policy, diplomatic actions |
| **USTR RSS** | Free | RSS | Same-day | PRIMARY SOURCE | Trade policy, tariff announcements |
| **EU Commission + EUR-Lex** | Free | RSS + SPARQL | Same-day | PRIMARY SOURCE | EU regulation, sanctions, trade |
| **OpenSanctions** | Free (non-commercial) | REST + bulk | Frequent | Aggregator (330+ lists) | Consolidated global sanctions |
| **WHO Outbreak API** | Free | REST + RSS | On-publish | PRIMARY SOURCE | Pandemic/health alerts |
| **ACLED** | Free (research, lagged) | REST | 1-2 week lag | Gold standard (human-coded) | Conflict data |
| **GPR Index** | Free | CSV download | Daily | Academic | Geopolitical risk gauge |
| **ReliefWeb API** | Free, 1000 req/day | REST | Same-day | Aggregator | Humanitarian crises |

**Decision:** GDELT + Federal Register + Congress.gov + OFAC + State/USTR/EU RSS + OpenSanctions + WHO. Total cost: **$0** (BigQuery under free tier).

### 1.3 AI Advancements — Models, Papers, Launches, Open Source

| Source | Free Tier | Type | Freshness | Signal Quality | Best For |
|--------|-----------|------|-----------|---------------|----------|
| **Hugging Face Hub API** | 1000 req/5min | REST | Real-time | Very High | Open-source models + curated papers |
| **arXiv RSS** | Unlimited | RSS | Daily | High (volume) | Research papers |
| **Semantic Scholar API** | 1 req/sec (w/ key) | REST | Days | Very High (citations) | Paper impact scoring |
| **Hacker News Algolia** | 10000 req/hr, no auth | REST | Seconds | High (community-validated) | Community-filtered AI news |
| **AI Company Blog RSS** | Unlimited | RSS | Hours | Extremely High | Primary announcements |
| **OpenRouter Models API** | Free (catalog) | REST | Real-time | High | Commercial model tracking |
| **GitHub API** | 5000 req/hr (30/min search) | REST | Real-time | High | OSS releases (targeted repos) |
| **AI Newsletter RSS** | Unlimited | RSS | Daily/Weekly | Very High (curated) | Expert synthesis |
| **Product Hunt API** | 6250 pts/15min | GraphQL | Real-time | Moderate | Consumer AI products |
| ~~Papers With Code~~ | — | — | — | — | **DEPRECATED** July 2025, absorbed by HF |

**Decision:** HF Hub + arXiv RSS + Semantic Scholar + HN Algolia + Company Blog RSS + OpenRouter + GitHub (targeted). Total cost: **$0**.

### 1.4 Macro Conditions — Fed/ECB, Inflation, Employment, Yields, Commodities

| Source | Free Tier | Type | Auth | Freshness | Best For |
|--------|-----------|------|------|-----------|----------|
| **FRED** | 120 req/min | REST | API key | Same-day | Everything US macro (816K+ series) |
| **BLS API v2** | 500 req/day | REST | API key | Release-day | Employment, CPI (primary) |
| **Fed RSS** | Unlimited | RSS | None | Minutes | FOMC decisions, speeches |
| **Treasury XML Feeds** | Unlimited | XML | None | Daily | Yield curve (all maturities) |
| **Treasury Fiscal Data** | Unlimited | REST | None | Daily | Govt debt, fiscal operations |
| **ECB SDMX** | Unlimited | REST | None | On-publish | Eurozone rates, inflation, FX |
| **BEA** | Unlimited | REST | API key | Release-day | GDP, national accounts |
| **EIA v2** | 9000 req/hr | REST | API key | Weekly | Energy/commodity prices |
| **Finnhub** | 60 req/min | REST | API key | Near real-time | Economic calendar |
| **World Bank** | Unlimited | REST | None | 1-2yr lag | Cross-country context |
| **IMF SDMX** | ~10 req/5sec | REST | None | Monthly-Quarterly | Global forecasts |

**Decision:** FRED (primary) + BLS + Fed RSS + Treasury XML + ECB + BEA + EIA + Finnhub calendar. Total cost: **$0**.

---

## 2. Recommended Sources Per Vertical

### Final Source Map

| Vertical | Primary Sources | Secondary/Supplements | Polling Frequency |
|----------|----------------|----------------------|-------------------|
| **Stocks** | Finnhub (earnings, analyst, news), SEC EDGAR (filings) | MarketAux (sector news), GlobeNewswire RSS, Seeking Alpha RSS | 15min–1hr |
| **Geopolitics** | GDELT, Federal Register, Congress.gov, OFAC, State/USTR/EU RSS | OpenSanctions, WHO, GPR Index, ReliefWeb | 15min–6hr |
| **AI** | HF Hub (models + papers), arXiv RSS, HN Algolia, Company Blog RSS | Semantic Scholar, OpenRouter, GitHub releases, Newsletter RSS | 15min–6hr |
| **Macro** | FRED, Fed RSS, Treasury XML, BLS, ECB SDMX | BEA, EIA, Finnhub calendar, IMF/World Bank | 2min–weekly |

### API Keys Required (All Free)

| Service | Registration URL | Key Type |
|---------|-----------------|----------|
| Finnhub | https://finnhub.io/register | API key |
| FRED | https://fred.stlouisfed.org/docs/api/api_key.html | API key |
| BLS v2 | https://data.bls.gov/registrationEngine/ | API key |
| BEA | https://apps.bea.gov/api/signup/ | API key |
| EIA | https://www.eia.gov/opendata/ | API key |
| Semantic Scholar | https://www.semanticscholar.org/product/api | API key |
| MarketAux | https://www.marketaux.com/ | API key |
| Congress.gov | https://api.data.gov/signup/ | API key |
| GitHub | github.com/settings/tokens | PAT |
| SEC EDGAR | N/A | User-Agent header only |
| HF Hub | huggingface.co/settings/tokens | Token (optional) |

**Total monthly cost: $0**

---

## 3. API Details & Pricing Summary

### Rate Limit Budget

| Source | Rate Limit | Planned Cadence | Daily Calls Est. |
|--------|-----------|-----------------|------------------|
| Finnhub | 60/min | Every 15 min (stocks) + 2hr (calendar) | ~200 |
| SEC EDGAR | 10/sec | Every 15 min | ~96 |
| FRED | 120/min | 1-2x daily + on release | ~50 |
| MarketAux | 100/day | 4x daily | ~4 |
| HF Hub | 1000/5min | Every 1hr | ~24 |
| arXiv RSS | N/A | Every 6hr | ~4 |
| HN Algolia | 10,000/hr | Every 15 min | ~96 |
| Semantic Scholar | 1/sec | Daily batch | ~100 |
| Congress.gov | 5,000/hr | Every 2hr | ~12 |
| Federal Register | Unlimited | Every 1hr | ~24 |
| BLS v2 | 500/day | On release schedule | ~5 |
| Treasury XML | Unlimited | 1x daily | ~1 |
| ECB SDMX | Unlimited | 1x daily | ~3 |
| EIA v2 | 9,000/hr | 1-2x daily | ~5 |
| OpenRouter | Generous | 1x daily | ~1 |
| GitHub | 5,000/hr | Every 1hr (releases) | ~24 |

All well within free tier limits.

### Key API Endpoints Reference

**Finnhub:**
```
GET /api/v1/company-news?symbol=AAPL&from=2026-03-01&to=2026-03-03&token=KEY
GET /api/v1/calendar/earnings?from=2026-03-01&to=2026-03-15&token=KEY
GET /api/v1/stock/upgrade-downgrade?symbol=AAPL&token=KEY
GET /api/v1/stock/recommendation?symbol=AAPL&token=KEY
GET /api/v1/calendar/economic?token=KEY
```

**SEC EDGAR:**
```
GET https://data.sec.gov/submissions/CIK{CIK}.json  (User-Agent required)
GET https://efts.sec.gov/LATEST/search-index?q="revenue+guidance"&forms=8-K
RSS: https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK={CIK}&type=8-K&output=atom
```

**FRED:**
```
GET /fred/series/observations?series_id=FEDFUNDS&api_key=KEY&file_type=json
GET /fred/releases?api_key=KEY
GET /fred/release/dates?release_id=ID&api_key=KEY
```

**GDELT:**
```
GET https://api.gdeltproject.org/api/v2/doc/doc?query=sanctions&mode=artlist&format=json
BigQuery: SELECT * FROM `gdelt-bq.gdeltv2.events` WHERE ...
```

**HF Hub:**
```
GET /api/models?sort=trendingScore&limit=50
GET /api/daily_papers?limit=100
```

**HN Algolia:**
```
GET /api/v1/search_by_date?query=AI+OR+LLM&tags=story&numericFilters=points>50
```

---

## 4. Proposed Architecture

### System Overview

```
┌──────────────────────────────────────────────────────────────┐
│                   News Intelligence Dashboard                 │
│                    (Node.js + Express, port 3031)             │
├──────────────────────────────────────────────────────────────┤
│                                                               │
│  ┌────────────────┐  ┌──────────────┐  ┌─────────────────┐   │
│  │   Cron Jobs    │  │   REST API   │  │   Dashboard     │   │
│  │  (Fetchers)    │  │  /api/...    │  │  (HTML/JS/CSS)  │   │
│  └───────┬────────┘  └──────┬───────┘  └───────┬─────────┘   │
│          │                  │                   │              │
│          │          ┌───────▼───────┐           │              │
│          │          │   WebSocket   │───────────┘              │
│          │          └───────────────┘                          │
│          │                                                    │
│  ┌───────▼────────────────────────────────────────────────┐   │
│  │              SQLite Database (news.db)                  │   │
│  │          WAL mode — fast concurrent reads               │   │
│  └────────────────────────────────────────────────────────┘   │
│                                                               │
└──────────────────────────────────────────────────────────────┘

External Data Sources (all free):
  ├── STOCKS
  │   ├── Finnhub API ──────── news, earnings, analyst moves, price targets
  │   ├── SEC EDGAR ─────────── 10-K, 8-K, insider trades (XBRL + RSS)
  │   ├── MarketAux API ─────── sector-filtered news + sentiment
  │   └── RSS ───────────────── GlobeNewswire, Seeking Alpha
  │
  ├── GEOPOLITICS
  │   ├── GDELT DOC API ─────── global event detection (15-min updates)
  │   ├── Federal Register ──── exec orders, sanctions, tariffs, regulations
  │   ├── Congress.gov ──────── bills, resolutions, committee actions
  │   ├── OFAC ──────────────── SDN list delta files
  │   └── RSS ───────────────── State Dept, USTR, EU Commission, WHO
  │
  ├── AI ADVANCEMENTS
  │   ├── HF Hub API ────────── trending models, daily curated papers
  │   ├── arXiv RSS ─────────── cs.AI+cs.CL+cs.LG+cs.CV daily papers
  │   ├── Semantic Scholar ──── citation counts, impact scoring
  │   ├── HN Algolia API ────── community-validated AI news (points>50)
  │   ├── OpenRouter API ────── commercial model catalog (diff for new)
  │   ├── GitHub API ────────── releases from 20-30 key AI repos
  │   └── RSS ───────────────── OpenAI, Anthropic, DeepMind blogs + newsletters
  │
  └── MACRO CONDITIONS
      ├── FRED API ──────────── 816K+ economic series (CPI, GDP, yields, etc.)
      ├── Fed RSS ───────────── FOMC decisions, speeches, Beige Book
      ├── Treasury XML ──────── daily yield curve (all maturities)
      ├── BLS API ───────────── employment, CPI (primary on release day)
      ├── BEA API ───────────── GDP, national accounts
      ├── ECB SDMX ──────────── Eurozone rates, HICP, FX
      ├── EIA API ───────────── crude oil, nat gas, energy prices
      └── Finnhub ───────────── economic calendar
```

### Tech Stack

| Component | Choice | Rationale |
|-----------|--------|-----------|
| **Runtime** | Node.js 20+ | Consistent with Agent Brain |
| **Server** | Express | Already know it, minimal |
| **Database** | SQLite (better-sqlite3) | Single file, zero-config, WAL mode |
| **Frontend** | Vanilla HTML/JS/CSS | No build step, hot-reload like Agent Brain |
| **Cron** | node-cron | In-process, no external deps |
| **RSS** | rss-parser | Lightweight RSS/Atom parser |
| **HTTP** | undici | Fast, built into Node 20+ |
| **XML** | fast-xml-parser | EDGAR, Treasury, arXiv XML |
| **WebSocket** | ws | Live dashboard updates |
| **Port** | 3031 | Next to Agent Brain (3030) |

### Directory Structure

```
news-dashboard/
├── server.js                # Express server + cron scheduler + WebSocket
├── package.json
├── news.db                  # SQLite (gitignored)
├── lib/
│   ├── db.js                # Database helpers (better-sqlite3)
│   ├── fetchers/
│   │   ├── stocks.js        # Finnhub, EDGAR, MarketAux, RSS
│   │   ├── geopolitics.js   # GDELT, Federal Register, Congress, sanctions, RSS
│   │   ├── ai.js            # HF Hub, arXiv, Sem. Scholar, HN, blogs, OpenRouter
│   │   └── macro.js         # FRED, Fed RSS, Treasury, BLS, BEA, EIA, ECB
│   ├── scheduler.js         # Cron job definitions + rate limit tracking
│   ├── dedup.js             # URL + fuzzy title matching
│   └── scoring.js           # Importance scoring per vertical
├── views/
│   ├── dashboard.html       # Main 4-column dashboard
│   └── settings.html        # Watchlists, API keys, polling config
├── public/
│   ├── css/dashboard.css
│   └── js/dashboard.js      # Client-side rendering + WebSocket
├── scripts/
│   ├── schema.sql           # SQLite schema
│   └── seed.js              # Default watchlists + FRED series
└── .env                     # API keys (gitignored)
```

### Key Design Decisions

1. **SQLite over Supabase** — Read-heavy, single-user. WAL mode handles concurrent reads. Simpler backup (copy file). No network latency.

2. **In-process cron** — node-cron runs inside Express. No external scheduler needed at this scale.

3. **Separate fetcher modules** — Each vertical is self-contained: fetch → parse → dedup → store. Easy to test and extend.

4. **URL-based dedup** — Same story from multiple sources: dedup on URL first, then fuzzy title matching (Dice coefficient > 0.8).

5. **Signal scoring** — Each item gets an importance score (0-100) based on source weight, recency, and vertical-specific signals.

6. **WebSocket for live updates** — Fetchers push new items to connected dashboard clients immediately.

7. **Separate repo** — This is a standalone project, not part of Agent Brain. Could optionally integrate later (share alerts, cross-reference).

---

## 5. Database Schema

```sql
-- Core items table — every news/data item across all verticals
CREATE TABLE items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    vertical TEXT NOT NULL CHECK(vertical IN ('stocks', 'geopolitics', 'ai', 'macro')),
    source TEXT NOT NULL,              -- e.g. 'finnhub', 'edgar', 'gdelt', 'arxiv', 'fred'
    source_id TEXT,                    -- unique ID from the source (for dedup)
    url TEXT,                          -- canonical URL
    title TEXT NOT NULL,
    summary TEXT,                      -- short description / first paragraph
    content_json TEXT,                 -- full structured data from source (JSON blob)
    importance_score REAL DEFAULT 0,   -- computed signal score (0-100)
    published_at TEXT,                 -- ISO 8601 timestamp from source
    fetched_at TEXT NOT NULL DEFAULT (datetime('now')),
    is_read INTEGER DEFAULT 0,
    is_bookmarked INTEGER DEFAULT 0,
    is_hidden INTEGER DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_items_vertical ON items(vertical, published_at DESC);
CREATE INDEX idx_items_source ON items(source, source_id);
CREATE INDEX idx_items_url ON items(url);
CREATE INDEX idx_items_importance ON items(vertical, importance_score DESC);
CREATE INDEX idx_items_published ON items(published_at DESC);
CREATE UNIQUE INDEX idx_items_dedup ON items(source, source_id) WHERE source_id IS NOT NULL;

-- Tags — flexible categorization (tickers, sectors, topics, countries)
CREATE TABLE tags (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
    tag_type TEXT NOT NULL,            -- 'ticker', 'sector', 'country', 'topic', 'category'
    tag_value TEXT NOT NULL
);

CREATE INDEX idx_tags_item ON tags(item_id);
CREATE INDEX idx_tags_type_value ON tags(tag_type, tag_value);

-- Watchlists — user-defined filters per vertical
CREATE TABLE watchlists (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    vertical TEXT NOT NULL,
    name TEXT NOT NULL,                -- e.g. 'My Tech Stocks', 'Trade Policy'
    filter_type TEXT NOT NULL,         -- 'ticker', 'sector', 'keyword', 'source', 'country'
    filter_value TEXT NOT NULL,        -- e.g. 'AAPL', 'Technology', 'sanctions'
    is_active INTEGER DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_watchlists_vertical ON watchlists(vertical);

-- Fetch log — track API calls for rate limiting and debugging
CREATE TABLE fetch_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source TEXT NOT NULL,
    endpoint TEXT NOT NULL,
    status_code INTEGER,
    items_found INTEGER DEFAULT 0,
    items_new INTEGER DEFAULT 0,
    error_message TEXT,
    duration_ms INTEGER,
    fetched_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_fetch_log_source ON fetch_log(source, fetched_at DESC);

-- API keys — stored locally (encrypted at rest optional)
CREATE TABLE api_keys (
    service TEXT PRIMARY KEY,
    api_key TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Economic time series — snapshots for macro charts
CREATE TABLE economic_series (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    series_id TEXT NOT NULL,           -- e.g. 'FEDFUNDS', 'DGS10', 'CPIAUCSL'
    source TEXT NOT NULL,              -- 'fred', 'bls', 'treasury', 'ecb', 'eia'
    observation_date TEXT NOT NULL,
    value REAL,
    fetched_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX idx_econ_series ON economic_series(series_id, observation_date);
CREATE INDEX idx_econ_series_id ON economic_series(series_id, observation_date DESC);

-- Yield curve snapshots — daily full curve
CREATE TABLE yield_curves (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    curve_date TEXT NOT NULL,
    m1 REAL, m2 REAL, m3 REAL, m4 REAL, m6 REAL,  -- months
    y1 REAL, y2 REAL, y3 REAL, y5 REAL, y7 REAL,   -- years
    y10 REAL, y20 REAL, y30 REAL,
    fetched_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX idx_yield_curve_date ON yield_curves(curve_date);

-- Economic calendar — upcoming data releases and events
CREATE TABLE economic_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event_name TEXT NOT NULL,
    country TEXT,
    event_date TEXT NOT NULL,
    event_time TEXT,                   -- HH:MM ET
    actual TEXT,
    forecast TEXT,
    previous TEXT,
    impact TEXT,                       -- 'low', 'medium', 'high'
    source TEXT NOT NULL,
    source_id TEXT,
    fetched_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_econ_events_date ON economic_events(event_date);
CREATE UNIQUE INDEX idx_econ_events_dedup ON economic_events(source, source_id) WHERE source_id IS NOT NULL;

-- FRED series watchlist — which series to track
CREATE TABLE fred_watchlist (
    series_id TEXT PRIMARY KEY,        -- e.g. 'FEDFUNDS'
    label TEXT NOT NULL,               -- human-readable name
    category TEXT,                     -- 'fed_policy', 'yield_curve', 'inflation', etc.
    poll_frequency TEXT DEFAULT 'daily' -- 'daily', 'weekly', 'on_release'
);
```

---

## 6. Phased Build Plan

### Phase 1 — Foundation + Stocks Vertical
**Goal:** Working dashboard with stocks feed end-to-end.

- [ ] Project scaffold (package.json, Express, SQLite, directory structure)
- [ ] Database schema (all tables)
- [ ] Fetcher: Finnhub (company news, earnings calendar, analyst upgrades/downgrades)
- [ ] Fetcher: SEC EDGAR (company filings RSS per CIK, EFTS search)
- [ ] Dedup logic (URL + fuzzy title matching)
- [ ] REST API: `GET /api/items`, `POST /api/items/:id/read`, `POST /api/items/:id/bookmark`
- [ ] Dashboard HTML: single-column stocks feed with item cards
- [ ] Settings page: ticker watchlist management, API key entry
- [ ] Cron scheduler: Finnhub every 15min, EDGAR every 15min
- [ ] .env for API keys, .gitignore

### Phase 2 — Remaining Verticals
**Goal:** All four columns populated.

- [ ] Fetcher: MarketAux (sector news) + RSS feeds (GlobeNewswire, Seeking Alpha)
- [ ] Fetcher: GDELT DOC API + Federal Register API + Congress.gov API
- [ ] Fetcher: Government RSS (State Dept, USTR, EU Commission)
- [ ] Fetcher: OFAC sanctions list delta monitoring
- [ ] Fetcher: HF Hub (trending models + daily papers) + arXiv RSS
- [ ] Fetcher: HN Algolia (AI stories, points>50) + AI company blog RSS
- [ ] Fetcher: Semantic Scholar (citation enrichment for new arXiv papers)
- [ ] Fetcher: FRED (key series) + Fed RSS + Treasury yield curve XML
- [ ] Fetcher: Finnhub economic calendar + EIA energy prices
- [ ] Dashboard: 4-column layout with all verticals
- [ ] WebSocket: live push when new items arrive

### Phase 3 — Intelligence Layer
**Goal:** Signal scoring, filtering, and smart alerts.

- [ ] Scoring engine: source-weighted importance per item
- [ ] Stocks scoring: analyst moves > earnings surprises > filings > general news
- [ ] Geopolitics scoring: sanctions/tariffs > exec orders > legislation > general
- [ ] AI scoring: model releases > trending papers > company blog > HN
- [ ] Macro scoring: FOMC decisions > CPI/jobs misses > yield curve moves > general
- [ ] Tag-based filtering: show only items matching active watchlists
- [ ] Watchlist management for all verticals (tickers, keywords, countries, topics)
- [ ] Dashboard: sort by importance, filter by tags, full-text search

### Phase 4 — Macro Charts & Economic Data
**Goal:** Visual economic indicators alongside the news feed.

- [ ] FRED series ingestion (daily poll of watchlist series)
- [ ] BLS + BEA polling on release schedules
- [ ] ECB SDMX data ingestion (key rates, HICP)
- [ ] Yield curve chart (daily snapshot, inversion highlighting)
- [ ] Economic calendar widget (upcoming releases with countdowns)
- [ ] Mini sparkline charts for key indicators (fed funds, CPI, unemployment, S&P)
- [ ] Yield curve visualization (current vs. 1mo/6mo/1yr ago overlays)

### Phase 5 — Polish & Ops
**Goal:** Reliable, daily-driver quality.

- [ ] Rate limit management (backoff, retry, per-source budgeting)
- [ ] Fetch error handling + alerting (ntfy.sh on repeated failures)
- [ ] Data retention / cleanup (auto-archive items older than 90 days)
- [ ] Dashboard: dark mode, keyboard navigation, read/unread state
- [ ] Mobile-responsive layout
- [ ] OpenRouter model catalog tracking (diff for new models)
- [ ] GitHub release tracking for watched AI repos
- [ ] OpenSanctions consolidated monitoring
- [ ] Optional: ntfy.sh push for high-importance items
- [ ] Optional: Agent Brain integration

---

## Appendix A: Key FRED Series Watchlist

```
# Fed Policy
DFF          -- Effective Federal Funds Rate (daily)
DFEDTARU     -- Fed Funds Target Upper
DFEDTARL     -- Fed Funds Target Lower
WALCL        -- Fed Balance Sheet

# Yield Curve
DGS1MO, DGS3MO, DGS6MO, DGS1, DGS2, DGS5, DGS10, DGS30
T10Y2Y       -- 10yr-2yr spread (inversion signal)
T10Y3M       -- 10yr-3mo spread (inversion signal)

# Inflation
CPIAUCSL     -- CPI All Urban Consumers
CPILFESL     -- Core CPI (ex food/energy)
PCEPILFE     -- Core PCE (Fed's preferred)
T5YIE        -- 5-Year Breakeven Inflation
T10YIE       -- 10-Year Breakeven Inflation
MICH         -- Michigan Inflation Expectations

# Employment
UNRATE       -- Unemployment Rate
PAYEMS       -- Total Nonfarm Payroll
CIVPART      -- Labor Force Participation
ICSA         -- Initial Jobless Claims (weekly)
CCSA         -- Continued Jobless Claims

# Growth & Activity
GDP, INDPRO, RSAFS, UMCSENT, HOUST, PERMIT

# Financial Conditions
BAMLH0A0HYM2 -- High Yield Credit Spread
VIXCLS       -- VIX
SP500        -- S&P 500
DTWEXBGS     -- Trade Weighted USD Index

# Money & Credit
M2SL         -- M2 Money Supply
TOTRESNS     -- Total Reserves
```

## Appendix B: Polling Schedule

```
Every 2 min (FOMC/ECB meeting days only):
  - Fed monetary policy RSS
  - ECB press release RSS

Every 15 min:
  - Finnhub company news (watchlist tickers)
  - Finnhub earnings calendar
  - HN Algolia (AI stories, points>50)
  - GDELT DOC API (conflict/trade events)

Every 30 min:
  - State Dept RSS, USTR RSS, EU Commission RSS
  - AI company blog RSS feeds

Every 1 hr:
  - SEC EDGAR filings RSS (watchlist CIKs)
  - Finnhub analyst upgrades/downgrades
  - Federal Register API (new documents)
  - Congress.gov (bills matching keywords)
  - HF Hub trending models + daily papers
  - OpenRouter model catalog

Every 2 hr:
  - Finnhub economic calendar

Every 4 hr:
  - MarketAux sector news (limited by 100 req/day)

Every 6 hr:
  - arXiv RSS, Semantic Scholar enrichment batch
  - OFAC sanctions delta files
  - WHO outbreak news, ReliefWeb API

Daily (6 AM ET):
  - Treasury yield curve XML
  - FRED key daily series
  - EIA spot prices (crude, nat gas)
  - GPR index download
  - OpenRouter model diff

On Release Schedule:
  - BLS CPI / Employment (monthly)
  - BEA GDP (quarterly)
  - FRED release calendar triggers
  - EIA Weekly Petroleum Status Report (Wednesdays)

Weekly:
  - AI newsletter RSS, Product Hunt AI topic
  - GitHub releases for watched repos
```

## Appendix C: AI Company Blog RSS Feeds

```
# Official
OpenAI Blog:        https://openai.com/blog/rss.xml
OpenAI News:        https://openai.com/news/rss.xml
Google DeepMind:    https://deepmind.google/blog/feed/basic
Google AI Blog:     https://blog.google/technology/ai/rss/

# Community-generated (via github.com/Olshansk/rss-feeds)
Anthropic News:     https://raw.githubusercontent.com/Olshansk/rss-feeds/main/feeds/feed_anthropic_news.xml
Anthropic Research: https://raw.githubusercontent.com/Olshansk/rss-feeds/main/feeds/feed_anthropic_research.xml
OpenAI Research:    https://raw.githubusercontent.com/Olshansk/rss-feeds/main/feeds/feed_openai_research.xml

# Newsletters
Import AI:          https://importai.substack.com/feed
TLDR AI:            https://tldr.tech/ai/rss
The Gradient:       https://thegradient.pub/rss/
```

## Appendix D: Key Government RSS Feeds (Geopolitics)

```
# U.S. Federal Reserve
All Press Releases:   https://www.federalreserve.gov/feeds/press_all.xml
FOMC (Monetary):      https://www.federalreserve.gov/feeds/press_monetary.xml
All Speeches:         https://www.federalreserve.gov/feeds/speeches.xml
Chair Powell:         https://www.federalreserve.gov/feeds/s_t_powell.xml

# U.S. State Department
Press Releases:       https://www.state.gov/rss-feeds  (multiple topical feeds)

# U.S. Treasury
OFAC SDN List:        https://ofac.treasury.gov/sanctions-list-service (XML/CSV)

# EU
EUR-Lex RSS:          https://eur-lex.europa.eu/content/help/my-eurlex/my-rss-feeds.html
EC Press Corner:      https://ec.europa.eu/commission/presscorner/

# WHO
Outbreak News:        https://www.who.int/api/news/diseaseoutbreaknews
```

## Appendix E: GitHub Repos to Watch (AI Releases)

```
ollama/ollama
vllm-project/vllm
langchain-ai/langchain
huggingface/transformers
ggerganov/llama.cpp
lm-sys/FastChat
openai/openai-python
anthropics/anthropic-sdk-python
google-gemini/generative-ai-python
mistralai/mistral-inference
deepseek-ai/DeepSeek-V3
meta-llama/llama
mlc-ai/mlc-llm
run-llama/llama_index
crewAIInc/crewAI
microsoft/autogen
Significant-Gravitas/AutoGPT
```
