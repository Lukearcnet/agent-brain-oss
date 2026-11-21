#!/bin/bash
# Generate CLAUDE.md and AGENTS.md from templates
# Run this whenever you update the shared contract or local overrides

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

# Read AB_URL from .env (default: http://localhost:3030)
AB_URL="http://localhost:3030"
if [ -f "$PROJECT_DIR/.env" ]; then
  ENV_URL=$(grep -E '^AB_URL=' "$PROJECT_DIR/.env" 2>/dev/null | sed 's/^AB_URL=//' | tr -d '"' | tr -d "'")
  if [ -n "$ENV_URL" ]; then
    AB_URL="$ENV_URL"
    echo "Using AB_URL from .env: $AB_URL"
  fi
fi

# Read templates and substitute AB_URL
CONTRACT=$(cat "$SCRIPT_DIR/agent-brain-contract.md" | sed "s|http://localhost:3030|$AB_URL|g")
CLAUDE_SPECIFIC=$(cat "$SCRIPT_DIR/claude-specific.md" | sed "s|http://localhost:3030|$AB_URL|g")
CODEX_SPECIFIC=$(cat "$SCRIPT_DIR/codex-specific.md" | sed "s|http://localhost:3030|$AB_URL|g")

# Read local overrides (user-specific, gitignored)
LOCAL_OVERRIDES=""
if [ -f "$SCRIPT_DIR/local.md" ]; then
  LOCAL_OVERRIDES=$(cat "$SCRIPT_DIR/local.md")
  echo "Including local overrides from instructions/local.md"
fi

# Generate CLAUDE.md (project-level)
CLAUDE_CONTENT="${CONTRACT//\{\{PROVIDER\}\}/Claude Code}"
CLAUDE_CONTENT="$CLAUDE_CONTENT

$CLAUDE_SPECIFIC"

# Generate AGENTS.md (project-level)
AGENTS_CONTENT="${CONTRACT//\{\{PROVIDER\}\}/Codex}"
AGENTS_CONTENT="$AGENTS_CONTENT

$CODEX_SPECIFIC"

# Add project-specific context section to both
PROJECT_CONTEXT="
## Project Context (Agent Brain)
- Node.js/Express server on port 3030
- Supabase for all persistent data (sessions, memory, events, orchestrator, checkpoints, messages)
- Views are vanilla HTML in views/ directory (no framework)
- Templates loaded dynamically via readView() — changes take effect without restart
- Hook system for permission approval from phone
- Checkpoint system for user approval from phone (24-hour timeout)
- Push notifications via ntfy.sh"

# Append local overrides section if present
LOCAL_SECTION=""
if [ -n "$LOCAL_OVERRIDES" ]; then
  LOCAL_SECTION="

## Local Customizations
$LOCAL_OVERRIDES"
fi

# Write project-level files
echo "# Agent Brain Project Instructions
$CLAUDE_CONTENT
$PROJECT_CONTEXT$LOCAL_SECTION" > "$PROJECT_DIR/CLAUDE.md"

echo "# Agent Brain Project Instructions
$AGENTS_CONTENT
$PROJECT_CONTEXT$LOCAL_SECTION" > "$PROJECT_DIR/AGENTS.md"

echo "Generated:"
echo "  - $PROJECT_DIR/CLAUDE.md"
echo "  - $PROJECT_DIR/AGENTS.md"

# Also generate global CLAUDE.md (without project context, but with local overrides)
# Create the directory if it doesn't exist — this is critical for new users
GLOBAL_DIR="$HOME/.claude"
mkdir -p "$GLOBAL_DIR"
echo "# Agent Brain Integration
$CLAUDE_CONTENT$LOCAL_SECTION" > "$GLOBAL_DIR/CLAUDE.md"
echo "  - $GLOBAL_DIR/CLAUDE.md (global)"

# Generate global AGENTS.md for Codex
CODEX_GLOBAL_DIR="$HOME/.codex"
if [ -d "$CODEX_GLOBAL_DIR" ] || command -v codex &>/dev/null; then
  mkdir -p "$CODEX_GLOBAL_DIR"
  echo "# Agent Brain Integration
$AGENTS_CONTENT$LOCAL_SECTION" > "$CODEX_GLOBAL_DIR/AGENTS.md"
  echo "  - $CODEX_GLOBAL_DIR/AGENTS.md (global)"
fi

echo "Done!"
