#!/bin/bash
# Bootstrap a new project with Agent Brain integration.
# Usage: ./scripts/bootstrap-project.sh /path/to/project "Project Name"
#
# This creates a CLAUDE.md in the target project that connects it to Agent Brain,
# registers it in PROJECT_KEYWORDS, and initializes project memory.

set -e

PROJECT_DIR="${1:?Usage: $0 /path/to/project \"Project Name\"}"
PROJECT_NAME="${2:?Usage: $0 /path/to/project \"Project Name\"}"
AGENT_BRAIN_URL="${AGENT_BRAIN_URL:-http://localhost:3030}"

# Resolve to absolute path
PROJECT_DIR="$(cd "$PROJECT_DIR" 2>/dev/null && pwd || echo "$PROJECT_DIR")"

# Derive the project key (same format Agent Brain uses: dashes replacing slashes)
PROJECT_KEY=$(echo "$PROJECT_DIR" | sed 's|/|-|g')

echo "=== Agent Brain Project Bootstrap ==="
echo "Project:  $PROJECT_NAME"
echo "Path:     $PROJECT_DIR"
echo "Key:      $PROJECT_KEY"
echo ""

# 1. Create CLAUDE.md
CLAUDE_MD="$PROJECT_DIR/CLAUDE.md"
if [ -f "$CLAUDE_MD" ]; then
  echo "⚠️  CLAUDE.md already exists at $CLAUDE_MD"
  echo "   Appending Agent Brain section..."
  echo "" >> "$CLAUDE_MD"
  echo "---" >> "$CLAUDE_MD"
  echo "" >> "$CLAUDE_MD"
else
  echo "Creating $CLAUDE_MD..."
fi

cat >> "$CLAUDE_MD" << CLAUDEEOF
# Agent Brain Integration

This project is connected to Agent Brain ($AGENT_BRAIN_URL) for persistent memory, cross-session communication, and orchestrator task dispatch.

## At Session Start
Run these commands to load context from previous sessions:

\`\`\`bash
# 1. Read project memory
curl -s $AGENT_BRAIN_URL/api/memory/$PROJECT_KEY | jq -r '.content'

# 2. Check for unread messages (broadcast + project-specific)
curl -s "$AGENT_BRAIN_URL/api/mailbox/broadcast?unread=true"
curl -s "$AGENT_BRAIN_URL/api/mailbox/$PROJECT_KEY?unread=true"

# 3. Mark messages as read after processing
# curl -s -X POST $AGENT_BRAIN_URL/api/mailbox/<message_id>/read
\`\`\`

## Before Session End or Context Compaction
Always save your progress so the next session can pick up where you left off:

\`\`\`bash
# 1. Update project memory with current state
curl -s -X PUT $AGENT_BRAIN_URL/api/memory/$PROJECT_KEY \\
  -H "Content-Type: application/json" \\
  -d '{"content": "<updated memory content>"}'

# 2. Append daily log entry
curl -s -X POST $AGENT_BRAIN_URL/api/memory/$PROJECT_KEY/daily \\
  -H "Content-Type: application/json" \\
  -d '{"content": "## Session Summary\n- <key accomplishments>\n- <decisions made>\n- <next steps>"}'

# 3. Send messages to other sessions if needed
curl -s -X POST $AGENT_BRAIN_URL/api/mailbox \\
  -H "Content-Type: application/json" \\
  -d '{"from_session": "$PROJECT_KEY", "to_session": "broadcast", "subject": "<subject>", "body": "<body>"}'
\`\`\`

## Project Info
- **Name**: $PROJECT_NAME
- **Agent Brain Key**: $PROJECT_KEY
- **Dashboard**: $AGENT_BRAIN_URL
CLAUDEEOF

echo "✅ CLAUDE.md created/updated"

# 2. Initialize project memory
echo "Initializing project memory..."
curl -s -X PUT "$AGENT_BRAIN_URL/api/memory/$PROJECT_KEY" \
  -H "Content-Type: application/json" \
  -d "{\"content\": \"# $PROJECT_NAME - Project Memory\n\nInitialized $(date +%Y-%m-%d). No prior context yet.\"}" > /dev/null 2>&1 \
  && echo "✅ Project memory initialized" \
  || echo "⚠️  Could not reach Agent Brain at $AGENT_BRAIN_URL (start it first)"

echo ""
echo "=== Done ==="
echo ""
echo "Next steps:"
echo "  1. cd $PROJECT_DIR && claude"
echo "     (The session will auto-read CLAUDE.md and connect to Agent Brain)"
echo ""
echo "  2. To enable orchestrator dispatch, add this project to PROJECT_KEYWORDS in"
echo "     $AGENT_BRAIN_URL server.js — or ask a Claude Code session to do it."
echo ""
echo "  3. To enable GitHub webhook auto-dispatch, run:"
echo "     gh api repos/OWNER/REPO/hooks -X POST -f url=$AGENT_BRAIN_URL/api/webhooks/github ..."
