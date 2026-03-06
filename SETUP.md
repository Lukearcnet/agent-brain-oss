# Agent Brain Setup Guide

This guide helps you set up Agent Brain from scratch. You can paste this into Claude Code and ask it to help you through the setup.

## Prerequisites

You'll need accounts for:
- **Anthropic** - API key for Claude calls
- **Supabase** - Free tier database for sessions, memory, checkpoints

Optional (for extra features):
- **ntfy.sh** - Push notifications (free, no account)
- **Fly.io** - Remote agent runners
- **Google APIs** - Email/calendar sync
- **Tailscale** - Remote dashboard access

## Quick Start

### 1. Clone the Repository

```bash
git clone https://github.com/Lukearcnet/agent-brain-oss.git
cd agent-brain-oss
npm install
```

### 2. Create Supabase Project

1. Go to [supabase.com](https://supabase.com) and create a free account
2. Create a new project (any name, any region)
3. Wait for it to provision (~2 minutes)
4. Go to **Settings → API** and note:
   - Project URL (like `https://abcdef.supabase.co`)
   - `anon` public key
   - `service_role` secret key

### 3. Run Database Migrations

In Supabase SQL Editor, run the contents of these files in order:
- `scripts/schema.sql`
- `supabase/migrations/*.sql` (in date order)

Or use Supabase CLI:
```bash
supabase link --project-ref YOUR_PROJECT_REF
supabase db push
```

### 4. Configure Environment

Copy the example and fill in your values:
```bash
cp .env.example .env
```

Edit `.env`:
```env
# Required
ANTHROPIC_API_KEY=sk-ant-...your-key...
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_ANON_KEY=eyJ...
SUPABASE_SERVICE_KEY=eyJ...

# Optional
NTFY_TOPIC=your-unique-topic
NTFY_SERVER=https://ntfy.sh
PORT=3030
```

### 5. Configure Projects

Copy the example and add your projects:
```bash
cp projects.example.json projects.json
```

Edit `projects.json`:
```json
{
  "my-app": {
    "dir": "-Users-yourname-code-my-app",
    "name": "My App",
    "cwd": "/Users/yourname/code/my-app",
    "repo_url": "https://github.com/you/my-app.git",
    "default_branch": "main"
  }
}
```

The `dir` field is your path with `/` replaced by `-` (how Claude Code encodes it).

### 6. Start the Server

```bash
npm start
```

Open http://localhost:3030 to see the dashboard.

### 7. Configure Claude Code

Add to your `~/.claude/CLAUDE.md`:

```markdown
# Agent Brain Integration

Every Claude Code session connects to Agent Brain for persistent memory.

## At Session Start
\`\`\`bash
PROJECT_KEY=$(pwd | sed 's|/|-|g')
curl -s http://localhost:3030/api/memory/$PROJECT_KEY | jq -r '.content // "No prior memory."'
curl -s "http://localhost:3030/api/mailbox/$PROJECT_KEY?unread=true" | jq '.'
\`\`\`

## Before Session End
\`\`\`bash
PROJECT_KEY=$(pwd | sed 's|/|-|g')
curl -s -X PUT http://localhost:3030/api/memory/$PROJECT_KEY \
  -H "Content-Type: application/json" \
  -d '{"content": "<your memory content>"}'
\`\`\`

## Checkpoints (get approval from phone)
\`\`\`bash
curl -s --max-time 14410 -X POST http://localhost:3030/api/checkpoints \
  -H "Content-Type: application/json" \
  -d '{"project_dir": "$PROJECT_KEY", "question": "Your question?", "options": ["Yes", "No"]}'
\`\`\`
```

## Verification

1. Dashboard shows at http://localhost:3030
2. Create a test session by starting Claude Code in any project
3. Check the dashboard - you should see the session appear

## Optional: Remote Access with Tailscale

1. Install Tailscale: `brew install tailscale`
2. Connect: `tailscale up`
3. Note your Tailscale IP (like `100.x.x.x`)
4. Access dashboard from anywhere: `http://100.x.x.x:3030`

## Optional: Push Notifications

1. Pick a unique ntfy topic name
2. Subscribe in the ntfy app (iOS/Android)
3. Add to `.env`: `NTFY_TOPIC=your-topic-name`
4. Restart server

## Troubleshooting

**Server won't start:**
- Check `.env` has all required values
- Check `node -v` is 18+
- Run `npm install` again

**Dashboard shows no sessions:**
- Verify `projects.json` has your projects
- Check the terminal for errors
- Ensure Claude Code is running in a configured project

**Checkpoints timeout:**
- Default timeout is 4 hours
- Check your network allows long-poll connections

## What's Next?

- Set up the morning refresh briefings
- Configure email/calendar sync (optional)
- Add more projects to `projects.json`
- Customize the dashboard to your workflow
