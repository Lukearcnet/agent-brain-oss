# Agent Brain

**Supervised agentic coding** — Claude Code is your IDE, Agent Brain is your project manager.

Agent Brain provides persistent memory, cross-session communication, and mobile control for Claude Code sessions. Run AI agents on your projects while staying in the loop from your phone.

## Features

- **Persistent Memory** — Sessions remember context across runs
- **Cross-Session Communication** — Agents can message each other
- **Mobile Dashboard** — Monitor and control sessions from your phone
- **Checkpoints** — Agents ask for approval before making big changes
- **Push Notifications** — Get notified when agents need your input
- **Session Handoffs** — Clean context transfer between sessions

## Quick Start

```bash
git clone https://github.com/Lukearcnet/agent-brain-oss.git agent-brain
cd agent-brain
npm install
cp .env.example .env
cp projects.example.json projects.json
# Edit .env and projects.json with your config
npm start
```

See [SETUP.md](SETUP.md) for detailed instructions.

## Requirements

- Node.js 18+
- [Supabase](https://supabase.com) account (free tier works)
- [Anthropic](https://anthropic.com) API key

## How It Works

1. **Start Agent Brain** on your local machine
2. **Configure Claude Code** to use Agent Brain for memory
3. **Open the dashboard** on your phone via Tailscale
4. **Run Claude Code sessions** — they automatically connect
5. **Approve checkpoints** from your phone when agents need decisions

## Architecture

```
┌─────────────────┐     ┌─────────────────┐
│  Claude Code    │────▶│   Agent Brain   │
│   Session 1     │     │    (server)     │
└─────────────────┘     │                 │
                        │  ┌───────────┐  │
┌─────────────────┐     │  │  Memory   │  │
│  Claude Code    │────▶│  ├───────────┤  │
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

## Configuration

### Environment Variables

Copy `.env.example` to `.env`:

```env
ANTHROPIC_API_KEY=sk-ant-...
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_ANON_KEY=eyJ...
SUPABASE_SERVICE_KEY=eyJ...
NTFY_TOPIC=your-notification-topic
PORT=3030
```

### Projects

Copy `projects.example.json` to `projects.json`:

```json
{
  "my-app": {
    "dir": "-Users-yourname-code-my-app",
    "name": "My App",
    "cwd": "/Users/yourname/code/my-app"
  }
}
```

## Dashboard

Access at `http://localhost:3030`:

- **Sessions** — Active Claude Code sessions
- **Memory** — Project context and history
- **Mailbox** — Cross-session messages
- **Checkpoints** — Pending approvals

## Remote Access

Use Tailscale for secure remote access:

```bash
brew install tailscale
tailscale up
# Access from anywhere: http://100.x.x.x:3030
```

## License

MIT

## Contributing

Contributions welcome! Please open an issue first to discuss changes.
