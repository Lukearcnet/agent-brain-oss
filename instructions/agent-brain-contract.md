# Agent Brain Integration

Every {{PROVIDER}} session is connected to Agent Brain (http://localhost:3030) for persistent memory and cross-session communication. This applies to ALL projects.

## At Session Start
Determine your project key from the current working directory (replace `/` with `-`):
```bash
PROJECT_KEY=$(pwd | sed 's|/|-|g')
```

Then load context from previous sessions:
```bash
# 1. Read project memory (may be empty for new projects — that's fine)
curl -s http://localhost:3030/api/memory/$PROJECT_KEY | jq -r '.content // "No prior memory for this project."'

# 2. Check for unread broadcast messages
curl -s "http://localhost:3030/api/mailbox/broadcast?unread=true" | jq '.'

# 3. Check for project-specific messages
curl -s "http://localhost:3030/api/mailbox/$PROJECT_KEY?unread=true" | jq '.'
```
If there are unread messages, read them, factor them into your work, and mark each as read:
```bash
curl -s -X POST http://localhost:3030/api/mailbox/<message_id>/read
```

## Before Session End or Context Compaction
Always save your progress so the next session picks up where you left off:
```bash
PROJECT_KEY=$(pwd | sed 's|/|-|g')

# 1. Update project memory with current state (architecture, decisions, what's built, what's next)
curl -s -X PUT http://localhost:3030/api/memory/$PROJECT_KEY \
  -H "Content-Type: application/json" \
  -d "{\"content\": \"<updated memory content>\"}"

# 2. Append daily log entry
curl -s -X POST http://localhost:3030/api/memory/$PROJECT_KEY/daily \
  -H "Content-Type: application/json" \
  -d "{\"content\": \"## Session Summary\n- <key accomplishments>\n- <decisions made>\n- <next steps>\"}"
```

## Cross-Session Communication
Send messages to other sessions or leave notes for yourself:
```bash
# Broadcast (all sessions see it)
curl -s -X POST http://localhost:3030/api/mailbox \
  -H "Content-Type: application/json" \
  -d "{\"from_session\": \"$PROJECT_KEY\", \"to_session\": \"broadcast\", \"subject\": \"<subject>\", \"body\": \"<body>\"}"

# Target a specific project
curl -s -X POST http://localhost:3030/api/mailbox \
  -H "Content-Type: application/json" \
  -d "{\"from_session\": \"$PROJECT_KEY\", \"to_session\": \"-Users-lukeblanton-Documents-other-project\", \"subject\": \"<subject>\", \"body\": \"<body>\"}"
```

## Checkpoints (User Approval from Phone)
When you need user input before proceeding (plan approval, design decisions, clarifying questions), use the checkpoint system instead of just printing a question and waiting. This lets the user respond from their phone even when away from the computer.

Use the provider-specific checkpoint flow documented later in these instructions:
- `Claude Code` sessions use a blocking checkpoint command.
- `Codex` sessions use the `ab-checkpoint` wrapper with Agent Brain holding the long wait state.

In both cases, checkpoint responses contain:
- `status`: `"pending"`, `"responded"`, or `"timeout"`
- `response`: the user's text response when available

**When to use checkpoints:**
- After creating a plan that needs approval before execution
- When you hit a decision point with multiple valid approaches
- When you need clarification that would change your direction
- Before making significant/irreversible changes
- **IMPORTANT: When you complete a task** — don't just go idle! Post a checkpoint asking what's next

**When NOT to use checkpoints:**
- For minor decisions you can make yourself
- When the user already gave clear instructions
- For status updates (use memory/mailbox instead)

**CRITICAL: Checkpoints vs AskUserQuestion**
- **NEVER use AskUserQuestion** for design decisions, approach selection, or clarifying questions
- AskUserQuestion times out after 90 seconds and requires the user at the computer
- Checkpoints wait up to 4 hours and the user can respond from their phone
- If you're tempted to ask "which approach?" or "what do you prefer?" — USE A CHECKPOINT

## Task Completion Checkpoint (CRITICAL)
**Never end a task by simply going idle.** When you finish what you were asked to do, ALWAYS post a checkpoint:

Use the same provider-specific checkpoint flow as above, but change the question to:
- `Task complete: <brief summary of what was done>. What would you like me to work on next?`

This ensures the user can direct you from their phone instead of you going idle while they're away from the computer.

If the checkpoint times out (5 min with no response), proceed with the most conservative option or save your progress and note what you were waiting on.

## Pre-Review Self-Validation (IMPORTANT)
Before asking the user to review your work or posting a "task complete" checkpoint, run these mechanical checks to catch obvious breakage. This applies to ALL projects.

```bash
# 1. Syntax check all modified JS files (skip if no JS changes)
git diff --name-only HEAD | grep '\.js$' | xargs -I{} node -c {} 2>&1 | grep -v "^$"

# 2. If you modified server files, verify the server starts clean
#    (start in background, check for crash, then kill)
#    Skip this if you didn't touch server.js, lib/, or routes
timeout 5 node server.js &
SERVER_PID=$!
sleep 2
if kill -0 $SERVER_PID 2>/dev/null; then
  echo "Server starts clean"
  kill $SERVER_PID 2>/dev/null
else
  echo "Server crashed on startup"
fi

# 3. Check modified endpoints return 200 (adjust URLs as needed)
# Only run for endpoints you actually changed
curl -s -o /dev/null -w "%{http_code}" http://localhost:3030/api/health

# 4. Verify only intended files were changed
git diff --name-only

# 5. Run project tests if they exist
npm test 2>/dev/null || echo "No test script configured"
```

**Rules:**
- Do NOT skip validation just because you're confident
- If any check fails, fix it before asking for review
- If a check is not applicable (e.g., no JS files changed), skip it
- Log which checks you ran and their results in your checkpoint message
- For iOS/Swift projects: use `xcodebuild -scheme <scheme> build` instead of node checks

## Memory Sections (Optimization)
When reading project memory, you can request only the sections you need to reduce context size:

```bash
PROJECT_KEY=$(pwd | sed 's|/|-|g')

# List available sections (discovery)
curl -s "http://localhost:3030/api/memory/$PROJECT_KEY?list=true" | jq '.sections'

# Read only specific sections (comma-separated slugs)
curl -s "http://localhost:3030/api/memory/$PROJECT_KEY?sections=architecture,next-steps" | jq -r '.content'

# Task-based filter: let Haiku pick relevant sections for your task
curl -s "http://localhost:3030/api/memory/$PROJECT_KEY?task=fix+email+bug" | jq -r '.content'

# Read full memory (default, backward compatible)
curl -s "http://localhost:3030/api/memory/$PROJECT_KEY" | jq -r '.content'
```

**When to use each filter:**
- `?sections=` — When you know exactly which sections you need
- `?task=` — When you have a specific task and want AI to pick relevant context (uses Haiku, ~$0.001/call)
- No param — Load full memory (for broad tasks or small memories)

**When to use section filtering:**
- When you know your task only needs specific context (e.g., "fix email bug" → only need "email-module" section)
- When the full memory is large and you want to save tokens
- At session start, consider listing sections first, then loading only what's relevant

**When to load full memory:**
- When starting a broad task or you're unsure what context you need
- When the memory is small (< 2KB)
- First session on a new project

**When writing memory**, always structure it with `## Section Name` headings:
- `## Architecture` — system design, tech stack, key patterns
- `## Key Components` — what's built and how it connects
- `## Recent Changes` — what changed recently (rotate this section)
- `## Known Issues` — bugs, limitations, workarounds
- `## Next Steps` — what to work on next

## Key Rules
- ALWAYS read memory at session start — it contains critical context from prior sessions
- ALWAYS write memory before ending — the next session depends on it
- **NEVER go idle after completing a task** — post a checkpoint asking what's next
- Keep memory concise: architecture, key decisions, current state, next steps
- Structure memory with `## ` headings for section-level filtering
- Use daily logs for detailed session-by-session history
- Use mailbox for cross-project communication or notes to the user
- Run pre-review self-validation before completing any task
