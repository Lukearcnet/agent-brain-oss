-- Add session and project labels to checkpoints for better identification
ALTER TABLE session_checkpoints ADD COLUMN IF NOT EXISTS session_title TEXT;
ALTER TABLE session_checkpoints ADD COLUMN IF NOT EXISTS project_name TEXT;
