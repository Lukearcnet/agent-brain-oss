# Checkpoint Session Binding Design

## Problem

Checkpoints were originally scoped by `project_dir`. That works for dashboard-level "something in this project needs attention" flows, but it breaks down inside the Sessions page:

- a single pending checkpoint can appear in multiple sessions
- provider identity can drift when old rows are missing `provider`
- UI code has to guess which session a checkpoint belongs to

This got worse once Agent Brain started managing both Claude and Codex sessions for the same project.

## Goal

Make checkpoints attach to a specific Agent Brain `session_id` whenever possible, for both Claude and Codex, while preserving project-level visibility in the dashboard.

## Proposed Data Model

Add to `session_checkpoints`:

- `session_id TEXT NULL`

Keep existing fields:

- `project_dir`
- `provider`
- `session_title`
- `project_name`

### Meaning

- `session_id`: canonical binding to an Agent Brain session
- `project_dir`: project-level grouping and dashboard aggregation
- `provider`: useful for icons and provider-aware filtering
- `session_title`: fallback label for legacy rows / human readability

## Write Path

When Agent Brain knows the owning session, every checkpoint write should include:

- `project_dir`
- `provider`
- `session_id`
- `session_title`

To make that reliable, every spawned session briefing should include the exact Agent Brain `session_id` and instruct the agent to send it back when posting checkpoints.

## Read Path

### Session view

Priority order:

1. exact `session_id`
2. fallback `session_title` when `session_id` is missing
3. otherwise do not show the checkpoint in a specific session view

Important: missing `session_id` must never be treated as "matches all sessions in the project."

### Dashboard

Dashboard remains project-oriented, but can enrich legacy rows by matching:

1. `session_id`
2. `session_title`

That allows correct provider badges and better labels without weakening session isolation.

## Migration / Backfill

Short term:

- apply the new `session_id` column and indexes
- begin writing `session_id` for all newly created checkpoints

Optional backfill:

- for rows with null `session_id`, infer from (`project_dir`, `provider`, `session_title`)
- only backfill when the match is unique

## Positive Externalities

This helps more than just checkpoint rendering:

- cleaner provider attribution in dashboard cards
- fewer UI-side heuristics in chat/dashboard
- better auditability of which session asked which question
- future ability to show per-session checkpoint history
- stronger handoff continuity across Claude and Codex

## Implementation Notes

- Session binding should be injected into all Agent Brain-spawned briefings:
  - new sessions
  - handoff spawns
  - morning refresh sessions
  - AI Cron / maintenance spawns
- The dashboard can stay broad; the session view must stay strict.
