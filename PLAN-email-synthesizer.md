# Email Synthesizer — Implementation Plan

## Overview

An intelligent email assistant that connects to Gmail inboxes (personal + work), classifies incoming emails by urgency, and surfaces what actually needs attention via push notifications and a daily digest. Designed as an Agent Brain module, managed from the phone dashboard.

---

## Architecture Diagram

```
┌─────────────────────────────────────────────────────────────────┐
│                        Agent Brain (Mac)                        │
│                         localhost:3030                           │
│                                                                 │
│  ┌──────────────┐   ┌──────────────┐   ┌────────────────────┐  │
│  │  Gmail OAuth  │   │  Email Poller │   │  Classification    │  │
│  │  Manager      │   │  / Pub/Sub    │   │  Engine            │  │
│  │              │   │  Listener     │   │  (Claude Haiku)    │  │
│  │  - Auth flow │   │              │   │                    │  │
│  │  - Token     │   │  - Pull sub  │   │  - Few-shot prompt │  │
│  │    refresh   │   │  - Polling   │   │  - Batch classify  │  │
│  │  - Multi-    │   │    fallback  │   │  - Summarize       │  │
│  │    account   │   │  - History   │   │  - Privacy filter  │  │
│  └──────┬───────┘   │    tracking  │   └────────┬───────────┘  │
│         │           └──────┬───────┘            │              │
│         │                  │                    │              │
│         ▼                  ▼                    ▼              │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │                    lib/email-synth/                      │   │
│  │         Core module: fetch → classify → notify          │   │
│  └─────────────────────────┬───────────────────────────────┘   │
│                            │                                    │
│         ┌──────────────────┼──────────────────┐                │
│         ▼                  ▼                  ▼                │
│  ┌────────────┐   ┌──────────────┐   ┌──────────────────┐     │
│  │  Supabase   │   │  ntfy.sh     │   │  Phone Dashboard │     │
│  │  (storage)  │   │  (push)      │   │  /email-triage   │     │
│  │            │   │              │   │                  │     │
│  │  - emails  │   │  - 🔴 Now   │   │  - Email cards   │     │
│  │  - accounts│   │  - 🟡 Today │   │  - Digest view   │     │
│  │  - digests │   │  - 📋 Daily │   │  - Account mgmt  │     │
│  │  - state   │   │    digest   │   │  - Settings      │     │
│  └────────────┘   └──────────────┘   └──────────────────┘     │
│                                                                 │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │                    Scheduler                             │   │
│  │  - Pub/Sub pull listener (always on)                    │   │
│  │  - Polling fallback (30min biz / 60min off-hours)       │   │
│  │  - Daily digest generation (8am)                        │   │
│  │  - Watch renewal (daily)                                │   │
│  └─────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────┘

External Services:
  Google Cloud ──── Gmail API (read emails)
                └── Pub/Sub (change notifications, pull subscription)
  Anthropic ─────── Claude Haiku API (classification + summarization)
  ntfy.sh ────────── Push notifications to phone
```

---

## Key Decisions

### 1. Gmail REST API, Not IMAP

Gmail API via `googleapis` npm package. Full access to labels, threads, categories (Primary/Social/Promotions/Updates), snippets, and metadata. IMAP gives raw MIME only — no Gmail-specific features. The History API enables efficient incremental sync.

**Scope**: `https://www.googleapis.com/auth/gmail.readonly` — read-only. This is "sensitive" (not restricted), so verification requires only a consent screen review, no security audit.

### 2. Hybrid: Pub/Sub Pull Subscription + Polling Fallback

**Primary**: Google Cloud Pub/Sub with a **pull subscription**. Uses outbound gRPC from the Mac — works behind NAT, no public IP or tunnel needed. Near-instant email notifications (seconds, not 30 minutes).

**Fallback**: Polling via `users.history.list` at adaptive intervals (30min business hours, 60min otherwise). Catches edge cases: watch expiration, Pub/Sub outages, restarts.

**Cost**: Zero at this scale (~6,000 notifications/month, well within free tier).

**Implementation order**: Build polling first (it's the foundation regardless), then layer Pub/Sub on top.

### 3. Claude Haiku for Classification + Summarization

Single API call per batch handles both classification and the "what do they need from me" summary. No separate calls needed — the summary adds ~20 output tokens on top of classification.

**Why Haiku, not rules**: Rules would save ~$0.68/month but add a rules engine, VIP sender lists, pattern maintenance, and two code paths. Not worth it at $1/month total.

**Pre-filter**: Gmail's built-in category labels (Promotions, Social) auto-classify as IGNORE for free. Only Primary/Updates category emails go to the LLM. This cuts API calls by ~50% with zero custom rules.

### 4. Privacy: Tiered Data Handling

| Tier | Detection | Data Sent to Claude |
|------|-----------|-------------------|
| Normal | Default | Headers + first 500 chars plain text body |
| Sensitive | Known financial/medical sender domains, subject keywords | Nothing — local rules only, generic summary |
| Confidential | Encrypted or confidential-marked | Nothing — flagged RESPOND_TODAY, generic summary |

500 chars captures ~93% classification accuracy (vs ~85% with 200 chars). The marginal 8% accuracy gain is worth the ~100 extra tokens per email.

### 5. Token Storage

OAuth tokens encrypted with AES-256-GCM in Supabase `email_accounts` table. Matches the existing `auth_services` pattern. The `googleapis` library handles token refresh automatically — just listen for the `'tokens'` event and persist.

**7-day refresh token gotcha**: In Google Cloud testing mode, refresh tokens expire after 7 days. Start in testing mode (accept weekly re-auth), submit for `gmail.readonly` consent screen review once stable (few business days, removes the limit).

### 6. Multi-Account by Design

Each account is a row in `email_accounts` with independent OAuth tokens, historyId, and Pub/Sub watch. Adding a new provider later (Outlook, etc.) means adding a new client module — the classification pipeline is provider-agnostic.

---

## Supabase Schema

```sql
-- Email account configurations and OAuth tokens
CREATE TABLE email_accounts (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  label TEXT NOT NULL,                    -- "personal", "work"
  email TEXT NOT NULL UNIQUE,             -- user@gmail.com
  tokens_encrypted TEXT,                  -- AES-256-GCM encrypted OAuth tokens JSON
  history_id TEXT,                        -- Last processed Gmail historyId
  watch_expiration BIGINT,               -- Pub/Sub watch expiry (Unix ms)
  category_filter TEXT[] DEFAULT '{Primary,Updates}',
  enabled BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Processed emails with classification
CREATE TABLE emails (
  id TEXT PRIMARY KEY,                    -- Gmail message ID
  account_id TEXT NOT NULL REFERENCES email_accounts(id),
  thread_id TEXT,
  from_address TEXT NOT NULL,
  from_name TEXT,
  to_addresses TEXT[],
  cc_addresses TEXT[],
  subject TEXT,
  snippet TEXT,                           -- First 500 chars of body (or null for sensitive)
  gmail_labels TEXT[],
  received_at TIMESTAMPTZ NOT NULL,
  classification TEXT,                    -- RESPOND_NOW | RESPOND_TODAY | FYI_NO_ACTION | IGNORE
  summary TEXT,                           -- One-sentence action summary
  confidence TEXT,                        -- high | medium | low
  is_sensitive BOOLEAN DEFAULT false,
  notification_sent BOOLEAN DEFAULT false,
  responded BOOLEAN DEFAULT false,        -- User marked as handled
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_emails_account ON emails (account_id, received_at DESC);
CREATE INDEX idx_emails_classification ON emails (classification, notification_sent);
CREATE INDEX idx_emails_unclassified ON emails (created_at) WHERE classification IS NULL;

-- Daily digest records
CREATE TABLE email_digests (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  digest_date DATE NOT NULL UNIQUE,
  content TEXT NOT NULL,                  -- Rendered digest text
  stats JSONB,                            -- { total, respond_now, respond_today, fyi, ignore }
  pending_responses JSONB,                -- [{id, from, subject, classification, received_at}]
  sent_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

---

## File Structure

```
lib/
  email-synth/
    index.js          -- Module init, start scheduler, export route handlers
    gmail-client.js   -- OAuth flow, token encrypt/decrypt, Gmail API wrapper
    classifier.js     -- Claude Haiku classification + summarization
    notifier.js       -- ntfy.sh push notification formatting
    digest.js         -- Daily digest generation (8am)
    privacy.js        -- Sensitive email detection (domain + subject rules)
    scheduler.js      -- Pub/Sub listener, polling fallback, cron jobs

views/
  email-triage.html   -- Phone dashboard: email cards, digest, account management

scripts/
  email-schema.sql    -- Supabase migration for email tables
```

---

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/email/accounts` | List configured email accounts |
| `POST` | `/api/email/accounts` | Start OAuth flow for new account (returns auth URL) |
| `GET` | `/api/email/accounts/callback` | OAuth callback handler |
| `DELETE` | `/api/email/accounts/:id` | Remove account + revoke tokens |
| `GET` | `/api/email/inbox` | List emails (filters: ?classification=, ?account=, ?since=) |
| `POST` | `/api/email/inbox/:id/responded` | Mark email as handled |
| `POST` | `/api/email/classify` | Force re-classify (body: { email_ids: [...] }) |
| `GET` | `/api/email/digest` | Get today's digest (or ?date=YYYY-MM-DD) |
| `POST` | `/api/email/digest/generate` | Force generate digest now |
| `GET` | `/api/email/stats` | Counts by category, daily trends |
| `GET` | `/email-triage` | Phone dashboard view |

---

## Classification Prompt

```
You are an email triage assistant. Classify each email and provide a one-sentence
action summary.

Categories:
- RESPOND_NOW: Needs reply within hours. Direct questions, time-sensitive requests,
  urgent work from real people.
- RESPOND_TODAY: Needs attention today. Non-urgent questions, scheduling, follow-ups.
- FYI_NO_ACTION: Informational. Confirmations, shipping, newsletters you read.
- IGNORE: No value. Marketing, spam, mass emails, social notifications.

Rules:
- Summary MUST state what action is expected and any deadline mentioned.
- If recipient is CC'd (not in To), lean toward FYI_NO_ACTION unless directly addressed.
- Calendar invites without conflicts = FYI_NO_ACTION.
- Tool notifications (Jira, GitHub) = RESPOND_TODAY only if directly assigned.

Return JSON array: [{ "email_id": "...", "classification": "...", "summary": "..." }]

Emails:
{emails_json}
```

**Batch size**: 10-20 emails per call. Beyond 20, classification quality can degrade and a single failure loses the batch.

---

## Notification Format

**RESPOND_NOW**:
```
🔴 Email: John Smith
Re: Q3 Budget — Needs your budget feedback before 2pm today.
[Priority: urgent | Tags: email,urgent]
```

**RESPOND_TODAY**:
```
🟡 Email: Sarah Chen
Dinner Saturday? — Asking if you're free Saturday evening.
[Priority: high | Tags: email]
```

**Daily Digest (8am)**:
```
📋 Email Digest — Mar 3
Yesterday: 47 emails (2🔴, 5🟡, 18🟢, 22⚫)
Still needs response:
• John Smith — Q3 Budget Review
• Sarah Chen — Dinner Saturday?
[Priority: default | Tags: email,digest]
```

---

## Cost Estimate (100 emails/day, 2 inboxes)

| Service | Monthly Cost | Notes |
|---------|-------------|-------|
| Gmail API | $0.00 | ~1,800 quota units/day vs 1B daily limit |
| Cloud Pub/Sub | $0.00 | ~6K msgs/month, free tier = 10 GB |
| Claude Haiku | ~$1.05 | 10 batches × $0.0035. With Gmail pre-filter: ~$0.50 |
| ntfy.sh | $0.00 | Free for personal use |
| Supabase | $0.00 | Already running |
| **Total** | **~$1/month** | |

---

## Implementation Phases

### Phase 1: Gmail OAuth + Polling (Foundation)
- Google Cloud project setup (Gmail API + Pub/Sub)
- OAuth consent screen + credentials
- `gmail-client.js`: OAuth flow, token encryption/storage, auto-refresh
- `scheduler.js`: Polling with `history.list`, historyId persistence in Supabase
- API: account CRUD endpoints, OAuth callback
- **Deliverable**: Connect both accounts, fetch and store new messages

### Phase 2: Classification + Push Notifications
- `classifier.js`: Haiku few-shot prompt, batch classification, JSON response parsing
- `privacy.js`: Sensitive email detection (domain list + subject patterns)
- Gmail category pre-filter (auto-IGNORE for Promotions/Social)
- `notifier.js`: ntfy.sh push for RESPOND_NOW and RESPOND_TODAY
- Store classifications in Supabase
- **Deliverable**: End-to-end: new email → classify → push notification to phone

### Phase 3: Daily Digest
- `digest.js`: Aggregate previous day's emails, identify pending responses
- 8am daily cron trigger
- ntfy.sh digest notification
- Supabase `email_digests` table for history
- **Deliverable**: Automated morning briefing

### Phase 4: Phone Dashboard
- `email-triage.html`: Email list with classification badges, mark as responded
- Account management (connect/disconnect, status indicators)
- Digest view (today + historical)
- Settings panel (sensitive domains, notification preferences, poll intervals)
- Nav link from main Agent Brain dashboard
- **Deliverable**: Full email triage from phone

### Phase 5: Pub/Sub Real-Time (Enhancement)
- Pub/Sub topic + pull subscription via `@google-cloud/pubsub`
- Streaming pull listener in `scheduler.js`
- `users.watch()` setup + daily renewal cron
- Polling demoted to fallback only
- **Deliverable**: Near-instant email notifications (seconds vs 30 min)

---

## Risks and Mitigations

| Risk | Mitigation |
|------|-----------|
| 7-day token expiry (testing mode) | Start testing; submit for consent review once stable |
| Haiku misclassification | Conservative bias (lean urgent); user feedback via dashboard |
| Sensitive data sent to LLM | Local detection of financial/medical domains; never send body |
| historyId goes stale (>30 days offline) | Detect 404 → full resync + notify user |
| Pub/Sub watch expires silently | Daily renewal cron + polling fallback |

---

## Dependencies to Add

```bash
npm install googleapis @google-cloud/pubsub
```

No email parsing library needed — Gmail API returns structured data (headers, snippet, body parts), not raw MIME.

---

## Google Cloud Setup Checklist

1. Google Cloud Console → Create project (or reuse `arcsocial`)
2. Enable: Gmail API, Cloud Pub/Sub API
3. OAuth consent screen → External, Testing mode
   - Add both Gmail accounts as test users
   - Scope: `https://www.googleapis.com/auth/gmail.readonly`
4. Create OAuth 2.0 credentials → Web application
   - Redirect URI: `http://localhost:3030/api/email/accounts/callback`
5. Create Pub/Sub topic: `gmail-notifications`
6. IAM: Grant `gmail-api-push@system.gserviceaccount.com` → Pub/Sub Publisher on topic
7. Create pull subscription: `gmail-email-synth-sub`
8. Store in `.env`: `GMAIL_CLIENT_ID`, `GMAIL_CLIENT_SECRET`
9. Pub/Sub auth: reuse existing `GOOGLE_APPLICATION_CREDENTIALS` or gcloud SA

---

## Settings Schema

```json
{
  "emailSynthesizer": {
    "enabled": false,
    "pollIntervalBusinessHours": 1800000,
    "pollIntervalOffHours": 3600000,
    "businessHoursStart": 8,
    "businessHoursEnd": 18,
    "digestTime": "08:00",
    "classificationModel": "claude-haiku-4-5-20251001",
    "batchSize": 15,
    "maxBodyChars": 500,
    "sensitiveDomains": [
      "chase.com", "bankofamerica.com", "wellsfargo.com",
      "paypal.com", "venmo.com", "fidelity.com", "vanguard.com"
    ],
    "sensitiveSubjectPatterns": [
      "statement", "balance", "tax return", "W-2", "1099",
      "diagnosis", "prescription", "confidential"
    ],
    "notifyRespondNow": true,
    "notifyRespondToday": true,
    "notifyDigest": true
  }
}
```
