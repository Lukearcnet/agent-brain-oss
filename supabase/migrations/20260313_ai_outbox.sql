-- AI Outbox: Pending emails and calendar events awaiting approval

CREATE TABLE IF NOT EXISTS ai_outbox (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  type TEXT NOT NULL CHECK (type IN ('email', 'event')),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'sent', 'failed')),

  -- Common fields
  from_account TEXT NOT NULL,  -- Email account to send from
  source_project TEXT,         -- Which project created this (for tracking)
  source_session TEXT,         -- Session that created it

  -- Email-specific fields (null for events)
  email_to TEXT[],             -- Recipients
  email_cc TEXT[],
  email_bcc TEXT[],
  email_subject TEXT,
  email_body_html TEXT,        -- Rich HTML body
  email_body_text TEXT,        -- Plain text fallback

  -- Event-specific fields (null for emails)
  event_title TEXT,
  event_description TEXT,
  event_start TIMESTAMPTZ,
  event_end TIMESTAMPTZ,
  event_location TEXT,
  event_attendees TEXT[],      -- Email addresses of attendees
  event_all_day BOOLEAN DEFAULT false,

  -- Metadata
  created_at TIMESTAMPTZ DEFAULT NOW(),
  approved_at TIMESTAMPTZ,
  sent_at TIMESTAMPTZ,
  error_message TEXT,          -- If sending failed

  -- AI chat context (for editing/follow-ups)
  original_prompt TEXT,        -- What the user/session asked for
  ai_reasoning TEXT            -- Why AI drafted it this way
);

-- Index for dashboard queries
CREATE INDEX idx_outbox_status ON ai_outbox(status);
CREATE INDEX idx_outbox_created ON ai_outbox(created_at DESC);

-- Enable realtime for live dashboard updates
ALTER PUBLICATION supabase_realtime ADD TABLE ai_outbox;

COMMENT ON TABLE ai_outbox IS 'Pending emails and calendar events created by AI, awaiting user approval';
