-- Add provider field to checkpoints for dashboard icon
-- Values: "claude" (default) or "codex"
--
-- TO APPLY: Run this SQL in the Supabase Dashboard SQL Editor
-- The server code gracefully handles the missing column until this is applied
--
ALTER TABLE session_checkpoints ADD COLUMN IF NOT EXISTS provider TEXT DEFAULT 'claude';
