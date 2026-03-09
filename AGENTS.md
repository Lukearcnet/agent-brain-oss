# Agent Brain Project Instructions
# Agent Brain Integration

Every Codex session is connected to Agent Brain (http://localhost:3030) for persistent memory and cross-session communication. This applies to ALL projects.

## At Session Start (CRITICAL - Read Carefully)

**If this is a HANDOFF session** (you received a briefing from a previous session):
1. Read and process the briefing to understand context
2. Load project memory and mailbox (see below)
3. **DO NOT start working yet!**
4. Post a checkpoint asking for direction:
```bash
PROJECT_KEY=$(pwd | sed 's|/|-|g')
curl -s --max-time 14410 -X POST http://localhost:3030/api/checkpoints \
  -H "Content-Type: application/json" \
  -d "{\"project_dir\": \"$PROJECT_KEY\", \"question\": \"Handoff received. I've caught up on context. What would you like me to focus on?\", \"options\": [\"Continue previous work\", \"New task\", \"Just checking in\"]}"
```
5. Wait for user response before proceeding with any work

**For all sessions**, determine your project key:
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

## Checkpoints (User Approval from Phone) — Codex Polling Mode

Codex uses a **non-blocking polling pattern** for checkpoints because its turn-based execution model doesn't support true blocking curls. When you need user input, use the checkpoint system.

### Step 1: Create Checkpoint (Non-blocking)
```bash
PROJECT_KEY=$(pwd | sed 's|/|-|g')

# Post checkpoint with ?blocking=false — returns immediately with checkpoint_id
RESULT=$(curl -s -X POST "http://localhost:3030/api/checkpoints?blocking=false" \
  -H "Content-Type: application/json" \
  -d "{\"project_dir\": \"$PROJECT_KEY\", \"provider\": \"codex\", \"question\": \"<your question>\", \"options\": [\"Option 1\", \"Option 2\", \"Other\"]}")

CHECKPOINT_ID=$(echo "$RESULT" | jq -r '.checkpoint_id')
echo "$CHECKPOINT_ID" > /tmp/agent-brain-checkpoint-id
echo "Checkpoint created: $CHECKPOINT_ID"
```

### Step 2: Poll for Response (Sequential /wait calls)
```bash
CHECKPOINT_ID=$(cat /tmp/agent-brain-checkpoint-id)

# Each /wait call blocks up to 30 seconds, then returns
RESPONSE=$(curl -s "http://localhost:3030/api/checkpoints/$CHECKPOINT_ID/wait?timeout=30")
STATUS=$(echo "$RESPONSE" | jq -r '.status')

if [ "$STATUS" = "responded" ]; then
  USER_RESPONSE=$(echo "$RESPONSE" | jq -r '.response')
  echo "User responded: $USER_RESPONSE"
  # Execute the user's instruction, then post a new checkpoint
else
  echo "Still pending, continue polling..."
  # Make another /wait call
fi
```

### Anti-Drift Rules (CRITICAL)
**Never end your turn while a checkpoint is still pending.**

After every `/wait` result with `status: "pending"`, remind yourself:
> **Pending means continue. Do NOT end the turn.**

**Minimum waiting requirement:**
- At least **10 /wait calls**, OR
- At least **5 minutes of waiting**

**Prohibited actions while checkpoint is pending:**
- Ending your turn
- Sending a "still waiting" message
- Treating repeated pending results as a reason to stop

**Recovery if session restarts:**
```bash
# Check if there's a pending checkpoint from a previous session
if [ -f /tmp/agent-brain-checkpoint-id ]; then
  CHECKPOINT_ID=$(cat /tmp/agent-brain-checkpoint-id)
  RESPONSE=$(curl -s "http://localhost:3030/api/checkpoints/$CHECKPOINT_ID/status")
  STATUS=$(echo "$RESPONSE" | jq -r '.status')
  if [ "$STATUS" = "pending" ]; then
    echo "Resuming wait for checkpoint $CHECKPOINT_ID"
    # Continue polling
  elif [ "$STATUS" = "responded" ]; then
    USER_RESPONSE=$(echo "$RESPONSE" | jq -r '.response')
    echo "User already responded: $USER_RESPONSE"
    # Execute the response
  fi
fi
```

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

## Task Completion Checkpoint (CRITICAL)
**Never end a task by simply going idle.** When you finish what you were asked to do, ALWAYS post a checkpoint:

```bash
PROJECT_KEY=$(pwd | sed 's|/|-|g')

# Create completion checkpoint
RESULT=$(curl -s -X POST "http://localhost:3030/api/checkpoints?blocking=false" \
  -H "Content-Type: application/json" \
  -d "{\"project_dir\": \"$PROJECT_KEY\", \"provider\": \"codex\", \"question\": \"Task complete: <brief summary of what was done>. What would you like me to work on next?\", \"options\": [\"Continue with related work\", \"New task\", \"Done for now\"]}")

CHECKPOINT_ID=$(echo "$RESULT" | jq -r '.checkpoint_id')
echo "$CHECKPOINT_ID" > /tmp/agent-brain-checkpoint-id

# Poll for response (minimum 10 calls or 5 minutes)
# ... use the polling pattern above ...
```

This ensures the user can direct you from their phone instead of you going idle while they're away from the computer.

**If polling times out** (after minimum wait period with no response): save progress to memory and note what you were waiting on.

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

## Real-Time Messages from User
For Codex sessions, real-time message injection is not yet supported. To receive user input during a session:
- Post a checkpoint and wait for the user's response
- Check the mailbox at logical breakpoints in your work
- The user can respond to checkpoints from their phone

This limitation may be removed in future versions when the Codex app-server protocol is stable.

## Project Context (Agent Brain)
- Node.js/Express server on port 3030
- Supabase for all persistent data (sessions, memory, events, orchestrator, checkpoints, messages)
- Views are vanilla HTML in views/ directory (no framework)
- Templates loaded dynamically via readView() — changes take effect without restart
- Hook system for permission approval from phone
- Checkpoint system for user approval from phone (4-hour timeout)
- Push notifications via ntfy.sh
