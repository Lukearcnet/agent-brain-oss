# Agent Brain

**Supervised agentic coding** — Claude Code is your IDE, Agent Brain is your project manager.

Agent Brain provides persistent memory, cross-session communication, and mobile control for AI coding agents (Claude Code and Codex). Run agents on your projects while staying in the loop from your phone.

## Features

- **Persistent Memory** — Sessions remember context across runs
- **Cross-Session Communication** — Agents can message each other
- **Mobile Dashboard** — Monitor and control sessions from your phone
- **Checkpoints** — Agents ask for approval before making big changes
- **Push Notifications** — Get notified when agents need your input
- **Session Handoffs** — Clean context transfer between sessions
- **Email & Calendar** — AI-powered email triage and calendar sync
- **Codex Support** — Works with both Claude Code and Codex sessions
- **Customizable** — Override views, instructions, and settings without touching core code

## Quick Start

### One-Liner Install

```bash
curl -fsSL https://raw.githubusercontent.com/Lukearcnet/agent-brain-oss/main/install.sh | bash
```

This detects Node.js, clones the repo, installs dependencies, and walks you through setup.

### Manual Install

```bash
git clone https://github.com/Lukearcnet/agent-brain-oss.git agent-brain
cd agent-brain
npm run setup    # Interactive setup wizard
npm start        # Database migrations run automatically
```

See [SETUP.md](SETUP.md) for detailed instructions.

## Requirements

- Node.js 18+
- [Supabase](https://supabase.com) account (free tier works)
- [Anthropic](https://anthropic.com) API key (optional, for AI features)

## How It Works

1. **Install Agent Brain** on your local machine (one command)
2. **Run the setup wizard** — configures Supabase, env vars, and background service
3. **Open the dashboard** on your phone (same WiFi or via Tailscale)
4. **Run AI coding sessions** — they automatically connect
5. **Approve checkpoints** from your phone when agents need decisions

## Architecture

```
┌─────────────────┐     ┌─────────────────┐
│  Claude Code    │────▶│   Agent Brain   │
│   Session 1     │     │    (server)     │
└─────────────────┘     │                 │
                        │  ┌───────────┐  │
┌─────────────────┐     │  │  Memory   │  │
│     Codex       │────▶│  ├───────────┤  │
│   Session 2     │     │  │  Mailbox  │  │
└─────────────────┘     │  ├───────────┤  │
                        │  │Checkpoints│  │
┌─────────────────┐     │  └───────────┘  │
│   Your Phone    │────▶│                 │
│   (Dashboard)   │     └────────┬────────┘
└─────────────────┘              │
                                 ▼
                        ┌─────────────────┐
                        │    Supabase     │
                        │   (database)    │
                        └─────────────────┘
```

## Dashboard

Access at `http://localhost:3030` (or from your phone on the same WiFi):

- **Sessions** — Active Claude Code and Codex sessions with live chat
- **Memory** — Project context and daily logs
- **Mailbox** — Cross-session messages
- **Checkpoints** — Pending approvals from your phone
- **Email Triage** — AI-classified email inbox
- **Calendar** — Synced calendar events

## Updating

```bash
bin/ab-update
# Then restart the server — migrations apply automatically
```

## Customization

Agent Brain is designed to be customized without conflicting with updates:

- **Views**: Copy any file from `views/` to `views/custom/` and modify it. Custom views take priority.
- **Instructions**: Create `instructions/local.md` with your preferences, then run `npm run generate`.
- **Settings**: Configure via the Settings UI at `/settings`.

## Remote Access

### Same WiFi (easiest)
Your phone can reach Agent Brain at `http://<your-mac-ip>:3030`.

### Tailscale (secure, anywhere)
```bash
brew install tailscale
tailscale up
# Access from anywhere: http://100.x.x.x:3030
```

### Cloudflare Tunnel (shareable, with auth)
See [SETUP.md](SETUP.md) for Cloudflare Tunnel setup with zero-trust authentication.

## Docker

```bash
cp .env.example .env
# Edit .env with your credentials
docker compose up -d
```

## License

AGPL-3.0 — See [LICENSE](LICENSE) for details.

## Contributing

Contributions welcome! Please open an issue first to discuss changes.
