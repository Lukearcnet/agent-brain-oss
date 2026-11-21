# Agent Brain Setup Guide

This guide helps you set up Agent Brain from scratch.

## Quick Start (Recommended)

The fastest way to get started:

```bash
curl -fsSL https://raw.githubusercontent.com/Lukearcnet/agent-brain-oss/main/install.sh | bash
```

This handles everything: Node.js detection, cloning, dependencies, and walks you through an interactive setup wizard. If you prefer manual setup, continue reading.

## Prerequisites

**Required:**
- **Node.js 18+** — [nodejs.org](https://nodejs.org)
- **Supabase** — Free tier database ([supabase.com](https://supabase.com))

**Optional (for extra features):**
- **Anthropic API key** — AI briefings and drafting ([anthropic.com](https://anthropic.com))
- **ntfy.sh** — Push notifications to your phone (free, no account needed)
- **Google APIs** — Email/calendar sync
- **Tailscale** — Secure remote access from your phone

## Manual Setup

### 1. Clone and Install

```bash
git clone https://github.com/Lukearcnet/agent-brain-oss.git agent-brain
cd agent-brain
npm install
```

### 2. Run the Setup Wizard

```bash
npm run setup
```

The wizard walks you through:
- Supabase URL and secret key (or legacy service role key)
- API keys (Anthropic, ntfy)
- Project configuration
- Supabase connection test
- Instruction file generation
- Background service installation (optional)

### 3. Start the Server

```bash
npm start
```

Database migrations run automatically on first start. Open http://localhost:3030 to see the dashboard.

If you installed the background service during setup, Agent Brain is already running.

### 4. Create Supabase Project (if you haven't already)

1. Go to [supabase.com](https://supabase.com) and create a free account
2. Create a new project (any name, any region)
3. Wait for it to provision (~2 minutes)
4. Go to **Settings → API Keys** and note:
   - Project URL (like `https://abcdef.supabase.co`) — also shown in the **Connect** dialog
   - Secret key (starts with `sb_secret_...`) — or legacy `service_role` key if shown

### 5. Enable Auto-Migrations (One-Time)

For automatic database schema updates, run this SQL in Supabase SQL Editor:

```sql
CREATE TABLE IF NOT EXISTS schema_migrations (
  filename TEXT PRIMARY KEY,
  applied_at TIMESTAMPTZ DEFAULT now()
);

CREATE OR REPLACE FUNCTION exec_sql(query TEXT)
RETURNS VOID AS $$ BEGIN EXECUTE query; END; $$ LANGUAGE plpgsql SECURITY DEFINER;
```

After this, all future schema updates apply automatically when the server starts.

### 6. Configure Claude Code

The setup wizard generates instruction files automatically. To configure Claude Code manually, run:

```bash
npm run generate
```

This creates `~/.claude/CLAUDE.md` with Agent Brain integration instructions.

## Updating

```bash
bin/ab-update
```

This backs up your config, pulls latest changes, installs new dependencies, regenerates instruction files, and shows what changed. Restart the server to apply. Database migrations run automatically.

## Remote Access (Phone Control)

### Same WiFi (Easiest)

Your phone can reach Agent Brain at `http://<your-mac-ip>:3030`. The setup wizard shows your local IP.

### Tailscale (Secure, Anywhere)

1. Install: `brew install tailscale`
2. Connect: `tailscale up`
3. Note your Tailscale IP (`100.x.x.x`)
4. Access from anywhere: `http://100.x.x.x:3030`

### Cloudflare Tunnel (Shareable, With Auth)

For sharing access with friends via a custom domain:

1. Install: `brew install cloudflare/cloudflare/cloudflared`
2. Authenticate: `cloudflared tunnel login`
3. Create tunnel: `cloudflared tunnel create agent-brain`
4. Configure `~/.cloudflared/config.yml`:
   ```yaml
   tunnel: <UUID>
   credentials-file: ~/.cloudflared/<UUID>.json
   ingress:
     - hostname: brain.yourdomain.com
       service: http://localhost:3030
     - service: http_status:404
   ```
5. Create DNS: `cloudflared tunnel route dns agent-brain brain.yourdomain.com`
6. Run: `cloudflared tunnel run agent-brain`
7. (Optional) Auto-start: `cloudflared service install`

Add Cloudflare Access for authentication (free for up to 50 users).

## Push Notifications

1. Pick a unique ntfy topic name
2. Subscribe in the ntfy app (iOS/Android) to that topic
3. Add to `.env`: `NTFY_TOPIC=your-topic-name`
4. Restart server

## Customization

Agent Brain is designed to be customized without breaking updates:

- **Views**: Copy any `views/*.html` to `views/custom/` and edit. Custom views take priority.
- **Instructions**: Create `instructions/local.md` with your preferences, then `npm run generate`.
- **Settings**: Use the Settings UI at `/settings`.

## Docker

```bash
cp .env.example .env
# Edit .env with your credentials
docker compose up -d
```

User config is mounted as volumes — survives container rebuilds.

## Troubleshooting

**Server won't start:**
- Check `.env` has SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY
- Check `node -v` is 18+
- Run `npm install` again
- Check startup output for config validation messages

**Dashboard shows no sessions:**
- Verify `projects.json` has your projects
- Check the terminal/logs for errors
- Ensure Claude Code is running in a configured project

**Migrations not running:**
- Make sure you ran the SQL in step 5 above
- Check server logs for `[migrations]` messages

**Checkpoints timeout:**
- Default timeout is 24 hours
- Check your network allows long-poll connections

## What's Next?

- Set up push notifications for checkpoint alerts
- Configure email/calendar sync (requires Google OAuth — see Settings UI)
- Add more projects to `projects.json`
- Customize the dashboard via `views/custom/`
- Join a morning refresh briefing flow
