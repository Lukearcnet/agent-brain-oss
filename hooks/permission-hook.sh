#!/bin/bash
# Agent Brain Permission Hook
# This script is called by Claude Code's PermissionRequest hook.
# It forwards the permission request to Agent Brain's HTTP endpoint
# and returns the decision back to Claude Code.
#
# Claude Code passes the hook event data via stdin as JSON.
# We forward it to Agent Brain, which either auto-approves or
# holds the request until the user decides via the phone dashboard.

INPUT=$(cat /dev/stdin)

# Load AB_AUTH_* from agent-brain .env so this hook stays in sync with the server.
AB_ENV_FILE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/.env"
AUTH_HEADER=""
if [ -f "$AB_ENV_FILE" ]; then
  AB_AUTH_ENABLED=$(grep -E '^AB_AUTH_ENABLED=' "$AB_ENV_FILE" 2>/dev/null | tail -1 | sed 's/^AB_AUTH_ENABLED=//' | tr -d '"' | tr -d "'" | tr '[:upper:]' '[:lower:]')
  if [ "$AB_AUTH_ENABLED" = "true" ]; then
    AB_API_USER=$(grep -E '^AB_API_USER=' "$AB_ENV_FILE" 2>/dev/null | tail -1 | sed 's/^AB_API_USER=//' | tr -d '"' | tr -d "'")
    AB_API_PASSWORD=$(grep -E '^AB_API_PASSWORD=' "$AB_ENV_FILE" 2>/dev/null | tail -1 | sed 's/^AB_API_PASSWORD=//' | tr -d '"' | tr -d "'")
    AUTH_HEADER="Authorization: Basic $(printf '%s' "${AB_API_USER}:${AB_API_PASSWORD}" | base64)"
  fi
fi

# Forward to Agent Brain and return its response
# Timeout: 100 seconds (slightly longer than Agent Brain's 90s internal timeout)
if [ -n "$AUTH_HEADER" ]; then
  RESPONSE=$(curl -s --max-time 100 \
    -X POST http://localhost:3030/api/hooks/permission-request \
    -H "Content-Type: application/json" \
    -H "$AUTH_HEADER" \
    -d "$INPUT" 2>/dev/null)
else
  RESPONSE=$(curl -s --max-time 100 \
    -X POST http://localhost:3030/api/hooks/permission-request \
    -H "Content-Type: application/json" \
    -d "$INPUT" 2>/dev/null)
fi

# If curl failed (Agent Brain not running), allow by default to avoid blocking
if [ $? -ne 0 ] || [ -z "$RESPONSE" ]; then
  echo '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}'
  exit 0
fi

echo "$RESPONSE"
