# Agent Brain Maintenance Module Design

## Overview

Daily automated health checks for Agent Brain, running via node-cron. Each check produces a report stored in Supabase. Issues trigger notifications. Claude sessions only spawn when human-in-loop decisions are needed.

## Checks

### 1. Documentation Drift Checker

**Purpose**: Ensure CLAUDE.md, handoff prompts, and project memory stay accurate as code evolves.

**What it checks**:
- `CLAUDE.md` references files that no longer exist
- `CLAUDE.md` mentions features that have changed
- Project memory mentions outdated architecture
- Handoff briefing templates reference stale patterns

**How it works**:
```
1. Parse CLAUDE.md for file paths, function names, API endpoints
2. Compare against actual codebase (glob/grep)
3. Flag references that don't match reality
4. Compare against last N git commits to detect unsynced changes
```

**Output**: List of potential drift items with confidence score

**Action threshold**: >3 medium-confidence items OR any high-confidence item

### 2. Security Scanner

**Purpose**: Detect security issues before they become problems.

**What it checks**:
- `.env` file not in `.gitignore`
- Exposed secrets in code (API keys, tokens)
- Known vulnerable dependencies (`npm audit`)
- Unsafe patterns in code (eval, innerHTML with user input)
- Files with overly permissive permissions
- Supabase RLS policies disabled

**How it works**:
```
1. Run npm audit --json
2. Scan files for secret patterns (regex for API keys, tokens)
3. Check .gitignore for sensitive files
4. Run basic pattern matching for unsafe code
5. Query Supabase for RLS status
```

**Output**: Security report with severity levels (critical/high/medium/low)

**Action threshold**: Any critical or high immediately; medium items batched weekly

### 3. Database Health Checker

**Purpose**: Prevent unbounded data growth and keep DB performant.

**What it checks**:
- Table row counts vs expected ranges
- Orphaned data (sessions without messages, tasks without parent)
- Old data that can be archived (sessions >30 days, logs >7 days)
- Large text/jsonb columns (memory blobs, message histories)
- Index health and query performance

**How it works**:
```
1. Query pg_stat_user_tables for row counts
2. Run orphan detection queries
3. Calculate data age distribution
4. Check column sizes with pg_column_size
5. Query pg_stat_statements for slow queries (if available)
```

**Auto-actions** (safe, reversible):
- Archive sessions older than 30 days to cold storage
- Truncate event_log entries older than 14 days
- Compress large memory sections

**Manual action threshold**: >1GB total DB size, >100k rows in hot tables

### 4. Code Cleanup Reporter

**Purpose**: Keep codebase clean and maintainable.

**What it checks**:
- Stale git branches (no commits in 7+ days, not merged)
- Unused dependencies in package.json
- Dead code detection (unreferenced functions/files)
- TODO/FIXME comments older than 14 days
- Archived sessions that can be deleted
- Test files without corresponding source

**How it works**:
```
1. git branch --list --sort=-committerdate
2. depcheck for unused dependencies
3. Simple analysis: exports vs imports
4. git blame on TODO comments for age
5. Query archived sessions > 30 days
```

**Output**: Cleanup report with actionable items

**Action**: Generate cleanup script for human review, don't auto-delete

---

## Data Model

### maintenance_checks table
```sql
CREATE TABLE maintenance_checks (
  id TEXT PRIMARY KEY,
  check_type TEXT NOT NULL,      -- 'docs_drift', 'security', 'db_health', 'code_cleanup'
  status TEXT NOT NULL,          -- 'ok', 'warning', 'critical'
  findings JSONB NOT NULL,       -- detailed results
  summary TEXT,                  -- human-readable one-liner
  auto_actions JSONB,            -- what was auto-fixed
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_maintenance_checks_type ON maintenance_checks (check_type, created_at DESC);
```

### maintenance_thresholds table (configurable)
```sql
CREATE TABLE maintenance_thresholds (
  check_type TEXT PRIMARY KEY,
  config JSONB NOT NULL,         -- threshold values
  enabled BOOLEAN DEFAULT true,
  updated_at TIMESTAMPTZ DEFAULT now()
);
```

---

## Module Structure

```
lib/maintenance/
├── index.js           # Module init, scheduler, exports
├── scheduler.js       # node-cron scheduling
├── docs-checker.js    # CLAUDE.md drift detection
├── security.js        # Security scanning
├── db-health.js       # Database health checks
├── code-cleanup.js    # Code cleanup analysis
├── reporter.js        # Format and store reports
└── notifier.js        # Send notifications
```

---

## Schedule

- **Daily at 6 AM CT**: All checks run
- **Hourly**: Security check only (lightweight)
- **On-demand**: Manual trigger via UI or API

---

## UI Integration

Reuse `views/system.html` or create `views/maintenance.html`:

1. **Summary cards**: One per check type, showing last status
2. **Timeline**: Recent checks with expand to see details
3. **Actions**:
   - "Run Now" per check
   - "View Report" for detailed findings
   - "Apply Fixes" for code cleanup (with confirmation)
4. **Settings**: Adjust thresholds, enable/disable checks

---

## Notifications

- **Critical/High security**: Immediate push notification
- **DB threshold exceeded**: Push notification
- **Docs drift detected**: Include in morning briefing
- **Code cleanup ready**: Weekly summary email/notification

---

## Claude Integration (when needed)

For issues requiring intelligence:
1. Spawn AI Cron session with focused prompt
2. Include relevant findings in context
3. Session creates plan for human approval
4. Human approves via checkpoint

Example triggers:
- "CLAUDE.md appears significantly out of date, need rewrite"
- "Multiple security patterns detected, need code review"
- "Database optimization needed, suggest schema changes"

---

## Implementation Priority

1. Database health (most impactful, prevents data issues)
2. Security scanner (critical for production safety)
3. Docs drift checker (improves session quality)
4. Code cleanup (nice-to-have, lower urgency)

---

## Success Metrics

- Zero security incidents from missed scans
- DB stays under 500MB for 6+ months
- CLAUDE.md accuracy score >90%
- Stale branches cleaned weekly
- Human review time per check: <5 minutes
