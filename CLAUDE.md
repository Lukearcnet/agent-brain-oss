# Agent Brain Project Instructions

## Agent Brain Integration
This project uses Agent Brain (http://localhost:3030) for persistent memory and inter-session communication across Claude Code sessions.

### At Session Start
1. Determine your project key from the current working directory:
```bash
PROJECT_KEY=$(pwd | sed 's|/|-|g')
```

2. Read the project memory to understand prior context:
```bash
curl -s http://localhost:3030/api/memory/$PROJECT_KEY | jq -r '.content'
```

3. Check the mailbox for any messages left by previous sessions or the user:
```bash
curl -s http://localhost:3030/api/mailbox/broadcast?unread=true
curl -s http://localhost:3030/api/mailbox/$PROJECT_KEY?unread=true
```
If there are unread messages, read them and factor their contents into your work. Mark each message as read after processing:
```bash
curl -s -X POST http://localhost:3030/api/mailbox/<message_id>/read
```

### Before Session End or Context Compaction
1. Flush key findings, decisions, and progress back to memory:
```bash
PROJECT_KEY=$(pwd | sed 's|/|-|g')
curl -s -X PUT http://localhost:3030/api/memory/$PROJECT_KEY \
  -H "Content-Type: application/json" \
  -d "{\"content\": \"<updated MEMORY.md content>\"}"
```

2. Append a daily log entry summarizing what was accomplished:
```bash
curl -s -X POST http://localhost:3030/api/memory/$PROJECT_KEY/daily \
  -H "Content-Type: application/json" \
  -d "{\"content\": \"## Session Summary\n- <key accomplishments>\n- <decisions made>\n- <next steps>\"}"
```

3. If you have cross-session requests, information for the user, or notes for the next session, send a mailbox message:
```bash
curl -s -X POST http://localhost:3030/api/mailbox \
  -H "Content-Type: application/json" \
  -d "{\"from_session\": \"$PROJECT_KEY\", \"to_session\": \"broadcast\", \"subject\": \"<subject>\", \"body\": \"<message body>\"}"
```
Use `"to_session": "broadcast"` for messages any session should see, or use a specific project directory key to target a specific project's sessions.

## Memory Section Filtering
When reading project memory, you can request specific sections to reduce token usage:
```bash
PROJECT_KEY=$(pwd | sed 's|/|-|g')

# List available sections
curl -s "http://localhost:3030/api/memory/$PROJECT_KEY?list=true" | jq '.sections'

# Load only what you need (e.g., for email work, skip calendar/architecture details)
curl -s "http://localhost:3030/api/memory/$PROJECT_KEY?sections=email-module,known-issues" | jq -r '.content'

# Task-based filtering: let Haiku pick relevant sections for your task
curl -s "http://localhost:3030/api/memory/$PROJECT_KEY?task=fix+email+classification" | jq -r '.content'
```

**When to use each filter:**
- `?sections=` — When you know exactly which sections you need
- `?task=` — When you have a specific task and want AI to pick relevant context
- No param — Load full memory (for broad tasks or small memories)

## Checkpoints (User Approval from Phone)
When you need user input before proceeding, use the checkpoint system. This blocks for up to 4 hours, letting the user respond from their phone.

```bash
PROJECT_KEY=$(pwd | sed 's|/|-|g')

# Post a checkpoint (blocks up to 4 hours)
RESPONSE=$(curl -s --max-time 14410 -X POST http://localhost:3030/api/checkpoints \
  -H "Content-Type: application/json" \
  -d '{"project_dir": "'$PROJECT_KEY'", "question": "Your question here", "options": ["Option 1", "Option 2", "Other"]}')

echo "$RESPONSE"
```

**When to use checkpoints:**
- After creating a plan that needs approval
- When you hit a decision point with multiple approaches
- Before making significant/irreversible changes
- **When you complete a task** — ask what's next instead of going idle

**CRITICAL: Checkpoints vs AskUserQuestion**
- **NEVER use AskUserQuestion** for design decisions or clarifying questions
- AskUserQuestion = 90s timeout, requires user at computer
- Checkpoints = 4-hour timeout, user responds from phone
- Any "which approach?" or "what do you prefer?" question → USE A CHECKPOINT

**Important:** Always use `--max-time 14410` (4 hours + 10s buffer) for checkpoint curls.

## Session-to-Folder Assignment
Sessions are automatically assigned to project folders based on `projects.json`:
- When a Claude Code session starts in a directory defined in `projects.json`, Agent Brain auto-creates an Agent Brain session and assigns it to the matching project folder
- Handoffs inherit the source session's folder, or fall back to the project folder if source was unassigned
- Morning refreshes and AI Cron sessions also auto-assign to their respective project folders
- If a project folder doesn't exist, it's auto-created

To add a new project, add an entry to `projects.json` with:
```json
"project-key": {
  "dir": "-path-to-directory",
  "name": "Human Readable Name",
  "cwd": "/actual/filesystem/path",
  "repo_url": "https://github.com/...",
  "default_branch": "main"
}
```

## Project Context
- Node.js/Express server on port 3030
- Supabase for all persistent data (sessions, memory, events, orchestrator, checkpoints, messages)
- Views are vanilla HTML in views/ directory (no framework)
- Templates loaded dynamically via readView() — changes take effect without restart
- Hook system for Claude Code permission approval from phone
- PreToolUse hook for real-time message delivery to sessions
- Checkpoint system for user approval from phone (4-hour timeout)
- Push notifications via ntfy.sh
