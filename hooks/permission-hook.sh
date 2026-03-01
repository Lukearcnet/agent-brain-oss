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

# Forward to Agent Brain and return its response
# Timeout: 100 seconds (slightly longer than Agent Brain's 90s internal timeout)
RESPONSE=$(curl -s --max-time 100 \
  -X POST http://localhost:3030/api/hooks/permission-request \
  -H "Content-Type: application/json" \
  -d "$INPUT" 2>/dev/null)

# If curl failed (Agent Brain not running), allow by default to avoid blocking
if [ $? -ne 0 ] || [ -z "$RESPONSE" ]; then
  echo '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}'
  exit 0
fi

echo "$RESPONSE"
