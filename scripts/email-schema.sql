-- Email Synthesizer: Supabase Schema Migration
-- Run this in the Supabase SQL Editor

-- Add email_synthesizer JSONB column to existing settings table
ALTER TABLE settings ADD COLUMN IF NOT EXISTS email_synthesizer JSONB NOT NULL DEFAULT '{}';

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
  account_id TEXT NOT NULL REFERENCES email_accounts(id) ON DELETE CASCADE,
  thread_id TEXT,
  from_address TEXT NOT NULL,
  from_name TEXT,
  to_addresses TEXT[],
  cc_addresses TEXT[],
  subject TEXT,
  snippet TEXT,                           -- First 500 chars of body (null for sensitive)
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
  content TEXT NOT NULL,
  stats JSONB,
  pending_responses JSONB,
  sent_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_digests_date ON email_digests (digest_date DESC);
