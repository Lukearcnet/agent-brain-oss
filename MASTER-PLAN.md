# Agent Brain — Master Plan

> Last updated: 2026-03-16

---

## Vision

Agent Brain is a **local agent supervision console** for Claude Code power users — a control tower for monitoring and governing multiple AI coding sessions from your phone. Target user: founders and indie devs who code with Claude but can't sit at a desk all day.

**Defensible position:** Aggregated supervision across all sessions, policy-based auto-approval, cross-session memory, personal context moat, and deep Google/tool integrations. Things Anthropic doesn't do.

**Business model:** Open core. Engine free on GitHub, supervision UX paid ($20 one-time on Gumroad). Grandfather early buyers if switching to subscription ($5/mo or $30/year).

---

## What's Built (as of March 2026)

### Core Infrastructure
- **Node.js/Express server** on port 3030, Supabase for all persistence
- **Views:** dashboard, chat, orchestrator, email-triage, calendar, memory, settings, tasks, briefings, apps, mailbox, messages, system, maintenance
- **Hook system** for phone-based permission approval
- **Checkpoint system** for async user approval (4-hour timeout, push via ntfy.sh)
- **WebSocket** real-time updates (replaced polling)
- **Handoff system** for session continuity across context windows
- **Codex discovery** for multi-provider session tracking

### Session Management
- Real-time JSONL monitoring of Claude Code sessions
- Permission prompt detection + phone-based Allow/Deny
- Session chat view with message injection
- Cross-session memory and mailbox system
- Morning refresh with session recap cards

### Orchestrator
- Task dispatch to Fly.io (`fly-agent-runner/`) or local Claude sessions
- Runner registry with `fly-claude` and `local` runners (`lib/runners/`)
- Streaming progress via Supabase Realtime → SSE to dashboard
- Branch-based workflow: agents commit to `orchestrator/task-xyz` branches

### Email Synthesizer (`lib/email-synth/`)
- 5 Gmail accounts with OAuth, encrypted tokens in Supabase
- Inbox sync, classification via Claude Haiku (RESPOND_NOW / RESPOND_TODAY / FYI / IGNORE)
- Daily digest generation, push notifications via ntfy.sh
- Email compose with contact autocomplete
- AI-powered email/event drafting (Haiku)
- **Google People API** integration: 430+ contacts merged from gws CLI
- Privacy tier system (sensitive email detection)

### Calendar (`lib/calendar/`)
- Google Calendar sync, event CRUD
- Attendee autocomplete with master contacts
- Conflict detection, event notifications

### Google Workspace Integration
- **gws CLI** fully authenticated (Gmail, Calendar, Drive, Docs, Sheets, People API)
- OAuth Desktop client on `arcsocial` GCP project
- Scopes: contacts.readonly, contacts.other.readonly, gmail.modify, calendar, drive, documents, spreadsheets
- Documented in instruction templates for all sessions

### Security & Auth
- Auth broker (`lib/auth-broker.js`) for token relay between Mac and Fly.io
- AES-256-GCM token encryption at rest

### Distribution
- OSS repo synced: `github.com/Lukearcnet/agent-brain-oss`
- One-line installer: `curl -fsSL https://raw.githubusercontent.com/Lukearcnet/agent-brain-oss/main/install.sh | bash`
- Setup wizard, Docker support, update script
- AgentBrainHelper.app for macOS Accessibility

### AI Monitor (`services/ai-monitor/`)
- Source modules built: ArXiv, HuggingFace, GitHub, blogs, Anthropic, HN
- Claude Haiku filtering pipeline
- ntfy.sh notifications
- **Status:** Code exists but not yet wired to production schedule

---

## Roadmap

### Tier 1: Near-Term (Next 1-2 weeks)

#### 1A. Agent Brain as MCP Server
Expose Agent Brain's memory, mailbox, orchestrator, and email APIs as MCP tools so any Claude Code session can natively call Agent Brain without curl commands.

**Why:** Eliminates the awkward curl-based integration in CLAUDE.md instruction templates. Sessions get typed tool access to memory read/write, checkpoint posting, mailbox, contacts, calendar, and task dispatch.

**Scope:**
- MCP server implementation (stdio transport for local, SSE for remote)
- Tools: `memory_read`, `memory_write`, `checkpoint_post`, `mailbox_send`, `contacts_search`, `calendar_agenda`, `task_dispatch`, `email_triage`
- Update instruction templates to reference MCP tools instead of curl
- Register in Claude Code's MCP config

#### 1B. Gemini CLI as Third Provider
Add Gemini CLI (`gemini`) as a provider alongside Claude Code and Codex.

**Why:** Diversifies capabilities. Gemini has strengths in multimodal and large-context tasks.

**Scope:**
- Discover Gemini CLI session artifacts (find JSONL/log format)
- Add Gemini adapter to session discovery
- Add Gemini runner to `lib/runners/`
- Dashboard support for Gemini sessions

#### 1C. Phase 2 Contacts (Proper OAuth)
Add `contacts.readonly` scope to `gmail-client.js` SCOPES for all 5 email-synth accounts, replacing the gws CLI shortcut with proper in-process Google People API calls.

**Why:** Removes dependency on gws binary, faster, works in Fly.io runners.

#### 1D. Outstanding Improvements
*(Task list items — to be populated from your task list)*

---

### Tier 2: Medium-Term (Weeks 3-6)

#### 2A. Agent Brain as a Native App
Evaluate PWA-first vs native macOS/iOS:

**Current approach (PWA):** Already works — service worker, home screen install, push via ntfy.sh. Cost: ~50 lines for manifest improvements.

**Native app option:** Swift macOS menubar app + iOS companion. Benefits: native notifications, better background behavior, Shortcuts integration, proper app store presence. Cost: significant development effort.

**Recommended path:**
1. Polish PWA first (offline support, better caching, app-like transitions)
2. Build native macOS menubar app (replaces AgentBrainHelper.app, handles Accessibility + launchd + status bar)
3. iOS native only if PWA push notifications prove unreliable

#### 2B. Improve Shareability
Make it dead simple for anyone to set up Agent Brain:

- **Zero-config mode:** Auto-detect Claude Desktop, skip Tailscale requirement for local-only use
- **Guided setup wizard** improvements: detect prerequisites, show progress, handle errors gracefully
- **Video walkthrough:** 2-minute demo for landing page
- **Homebrew tap:** `brew install agentbrain/tap/agent-brain`
- **Node.js SEA** (Single Executable Application): compile to standalone binary, no npm install needed
- **Template projects:** Pre-configured CLAUDE.md templates for common setups (solo dev, team, specific frameworks)

#### 2C. AI Monitor Production
Wire the existing `services/ai-monitor/` to run on schedule:

- Connect to launchd or pm2 for process management
- Enable 7am + 6pm CT cron runs
- Surface briefings in dashboard
- Feed relevant items into session context automatically

#### 2D. Security Hardening (GitHub Injection)
Implement the SECURITY-HARDENING-PLAN.md mitigations:

- Trust-level tool restrictions for external-sourced tasks (Phase 1.1 — critical)
- Maintainer approval label requirement (Phase 2.2 — critical)
- Framed untrusted content in prompts
- Input sanitization and pattern blocking
- Audit logging for external tasks

---

### Tier 3: Longer-Term (Months 2-3)

#### 3A. Structured Memory Facts
Auto-extract learnings from every orchestrator task (conventions, gotchas, commands, patterns). See PLAN.md Phase 6 for full spec.

#### 3B. GitHub Issues Integration
Label a GitHub Issue with `agent-task` → webhook → agent dispatches → works → opens PR → links back. See PLAN.md Phase 7 for full spec.

#### 3C. Multi-Model Routing
Smart routing based on task type, cost, and model strengths. A/B testing across providers.

#### 3D. Policy Engine Evolution
Auto-approve rules that learn from behavior. Per-project policies. Audit log. Role-based access for teams.

#### 3E. Integrations (Linear, Slack, etc.)
Same webhook pattern as GitHub Issues extended to other tools.

---

### Future Consideration
- Multi-Mac support
- Voice input via iOS speech-to-text
- Plugin/recipe ecosystem
- Community Discord
- Enterprise/team features
- Stripe subscriptions + license keys

---

## Architecture Reference

```
agent-brain/
├── server.js                    # Express server, API routes, WebSocket
├── lib/
│   ├── db.js                    # Supabase client + queries
│   ├── auth-broker.js           # Token relay for Fly.io runners
│   ├── handoff.js               # Session continuity
│   ├── codex-discovery.js       # Multi-provider session tracking
│   ├── sdk-adapter.js           # Claude SDK integration
│   ├── terminal-manager.js      # Terminal session management
│   ├── session-titles.js        # Session naming
│   ├── runners/                 # Task dispatch
│   │   ├── registry.js
│   │   ├── fly-claude.js
│   │   └── local.js
│   ├── email-synth/             # Email module
│   │   ├── index.js
│   │   ├── gmail-client.js
│   │   ├── classifier.js
│   │   ├── google-contacts.js
│   │   ├── notifier.js
│   │   ├── digest.js
│   │   ├── privacy.js
│   │   └── scheduler.js
│   ├── calendar/                # Calendar module
│   │   ├── index.js
│   │   ├── gcal-client.js
│   │   ├── conflict.js
│   │   ├── notifier.js
│   │   └── scheduler.js
│   └── maintenance/             # System maintenance
├── views/                       # Vanilla HTML views (15 pages)
├── services/
│   └── ai-monitor/              # AI developments monitor
├── fly-agent-runner/            # Fly.io remote runner
├── scripts/                     # Schema, migrations
├── instructions/                # Instruction templates
└── AgentBrainHelper.app/        # macOS Accessibility helper
```

---

## Superseded Documents

The following documents are consolidated into this master plan. They remain in the repo for reference but this document is the source of truth:

| Document | Status | Notes |
|----------|--------|-------|
| PLANNING.md | Superseded | Core vision incorporated above |
| PLAN.md | Superseded | Phases 3-7 incorporated into Tiers 2-3 |
| PRODUCT_ROADMAP.md | Superseded | Distribution/moat strategy incorporated |
| PLAN-email-synthesizer.md | Completed | Email synth is built |
| NEWS-DASHBOARD-PLAN.md | Deferred | Standalone project, not prioritized |
| SECURITY-HARDENING-PLAN.md | Active | Referenced in Tier 2D, keep as implementation spec |
| services/ai-monitor/PLAN.md | Active | Referenced in Tier 2C, keep as implementation spec |
