# Changelog

All notable changes to Agent Brain are documented in this file.

## [2.0.0] - 2026-03-10

### Shareability & Update System
- **View override system**: Customize views by placing files in `views/custom/` without touching core code
- **Instruction file split**: `CLAUDE.md` and `AGENTS.md` are now generated from templates; user overrides go in `instructions/local.md`
- **Auto-migration runner**: Database schema migrations apply automatically on server startup
- **`bin/ab-update`**: One-command upgrade script (backup, pull, install, regenerate)
- **`bin/ab-setup`**: Interactive setup wizard for new installations
- **Startup config validator**: Clear messages for missing required/optional configuration
- **Startup version check**: Notifies when a newer version is available on GitHub
- **AGPL-3.0 license**: Open source with copyleft protection

### Codex Support
- Codex CLI integration with atomic cycle checkpoint polling
- `bin/ab-checkpoint` wrapper for checkpoint operations
- Codex option in New Session flow
- Server-held checkpoint recovery for Codex sessions

### Session Management
- Redesigned Sessions tab with two-panel layout
- Session-binding for checkpoints with folder-based labeling
- Session recap extraction for morning refresh recommendations
- Show sessions active in last 6 hours on dashboard
- Fix session-to-folder auto-assignment bug

### Email & Calendar
- AI Outbox feature for email and calendar drafting
- Combined client-side email search across inbox/sent/drafts
- Email triage UI overhaul with desktop split-preview
- Calendar header/switcher alignment with shared workspace shell

### Reliability
- Checkpoint polling watchdog and recovery mechanisms
- Server-side field resolution for checkpoint reliability
- Morning refresh session recaps in dashboard cards
- Fix back button in chat view when embedded in iframe

### Infrastructure
- Supabase migration from file-based storage
- Fly.io agent runner support
- Permission request hook system for cross-session approval
- Push notification header sanitization via shared helper

## [1.0.0] - 2026-03-06

### Initial Open Source Release
- Persistent memory system with cross-session communication
- Mobile dashboard for monitoring and controlling AI sessions
- Checkpoint system for agent-user approval flow
- Push notifications via ntfy.sh
- Session handoff system for context transfer
- Claude Code terminal session management
- Morning refresh with ranked recommendations
- Supabase backend for all persistent data
- Comprehensive setup guide and README
