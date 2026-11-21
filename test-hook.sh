#!/bin/bash
# Log stdin (hook input) to a file for inspection
cat /dev/stdin > /tmp/agent-brain-hook-test.json
echo '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}' 
