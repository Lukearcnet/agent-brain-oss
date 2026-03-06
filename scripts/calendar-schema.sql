-- Master Calendar: Supabase Schema Migration
-- Run this in the Supabase SQL Editor

-- Add calendar settings column to settings table
ALTER TABLE settings ADD COLUMN IF NOT EXISTS calendar JSONB NOT NULL DEFAULT '{}';

-- Add calendar-related columns to email_accounts (reuse for calendar too)
ALTER TABLE email_accounts ADD COLUMN IF NOT EXISTS calendar_color TEXT DEFAULT '#007aff';

-- Calendar events (aggregated from all accounts)
CREATE TABLE IF NOT EXISTS calendar_events (
  id TEXT PRIMARY KEY,                    -- accountId:googleEventId composite
  account_id TEXT NOT NULL REFERENCES email_accounts(id) ON DELETE CASCADE,
  calendar_id TEXT NOT NULL,              -- Google Calendar ID (e.g. "primary")
  calendar_name TEXT,                     -- Display name of the calendar
  title TEXT NOT NULL DEFAULT '(No title)',
  description TEXT,                       -- First 500 chars
  location TEXT,
  start_time TIMESTAMPTZ NOT NULL,
  end_time TIMESTAMPTZ NOT NULL,
  all_day BOOLEAN DEFAULT false,
  status TEXT DEFAULT 'confirmed',        -- confirmed, tentative, cancelled
  organizer TEXT,                         -- Organizer email
  attendees JSONB DEFAULT '[]',           -- [{email, name, responseStatus}]
  hangout_link TEXT,                      -- Google Meet / video call link
  recurring_event_id TEXT,                -- ID of the recurring series
  color_id TEXT,                          -- Google Calendar color ID
  notification_sent BOOLEAN DEFAULT false,
  synced_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_cal_events_time ON calendar_events (start_time, end_time);
CREATE INDEX IF NOT EXISTS idx_cal_events_account ON calendar_events (account_id, start_time);
CREATE INDEX IF NOT EXISTS idx_cal_events_notify ON calendar_events (start_time, notification_sent)
  WHERE notification_sent = false;

-- Calendar sync state (tracks incremental sync tokens per calendar per account)
CREATE TABLE IF NOT EXISTS calendar_sync_state (
  account_id TEXT NOT NULL REFERENCES email_accounts(id) ON DELETE CASCADE,
  calendar_id TEXT NOT NULL,
  sync_token TEXT,                        -- Google Calendar sync token for incremental sync
  last_synced_at TIMESTAMPTZ,
  PRIMARY KEY (account_id, calendar_id)
);
