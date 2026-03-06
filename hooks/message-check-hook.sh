#!/bin/bash
# Agent Brain Message Check + File Lock Hook (PreToolUse)
#
# Called by Claude Code before every tool execution.
# 1. Checks the local inbox file for pending messages from the user (phone)
# 2. Checks file locks when the tool modifies files (Write, Edit, Bash)
#
# Performance: The fast path (no messages + no file-modifying tool) avoids Python.
# Target: <20ms for the common case.
#
# Exit code 0 = allow tool to proceed
# systemMessage = text shown to Claude

INBOX_DIR="$HOME/.claude/inbox"
LOCK_CACHE="$HOME/.claude/locks/state.json"

# Read stdin once, save for both checks
INPUT=$(cat /dev/stdin)

# ── Extract session info using lightweight grep+sed ──
CWD=$(echo "$INPUT" | grep -o '"cwd":"[^"]*"' | head -1 | sed 's/"cwd":"//;s/"$//')
TOOL_NAME=$(echo "$INPUT" | grep -o '"tool_name":"[^"]*"' | head -1 | sed 's/"tool_name":"//;s/"$//')
SESSION_ID=$(echo "$INPUT" | grep -o '"session_id":"[^"]*"' | head -1 | sed 's/"session_id":"//;s/"$//')

SYSTEM_MSG=""

# ── Part 1: Message Check ──────────────────────────────────────────────────
if [ -n "$CWD" ] && [ -d "$INBOX_DIR" ] && [ -n "$(ls -A "$INBOX_DIR" 2>/dev/null)" ]; then
  PROJECT_KEY=$(echo "$CWD" | tr '/' '-')
  INBOX_FILE="${INBOX_DIR}/${PROJECT_KEY}.json"

  if [ -f "$INBOX_FILE" ]; then
    INBOX_CONTENT=$(cat "$INBOX_FILE" 2>/dev/null)
    rm -f "$INBOX_FILE"

    if [ -n "$INBOX_CONTENT" ] && [ "$INBOX_CONTENT" != "[]" ]; then
      MSG_OUTPUT=$(echo "$INBOX_CONTENT" | /usr/bin/python3 -c "
import sys, json

try:
    messages = json.load(sys.stdin)
    if not messages:
        sys.exit(0)

    ids = []
    lines = ['=== INCOMING MESSAGE FROM USER (via Agent Brain) ===']
    for msg in messages:
        sender = msg.get('sender', 'user')
        content = msg.get('content', '')
        ts = msg.get('created_at', '')
        lines.append(f'From: {sender}')
        if ts:
            lines.append(f'Time: {ts}')
        lines.append(f'Message: {content}')
        lines.append('---')
        mid = msg.get('id', '')
        if mid:
            ids.append(mid)

    lines.append('Please acknowledge this message and factor it into your current work.')
    lines.append('=== END OF MESSAGE ===')
    print(chr(10).join(lines))

    # Mark as delivered (background, non-blocking)
    if ids:
        import subprocess
        subprocess.Popen(
            ['curl', '-s', '-X', 'POST',
             'http://localhost:3030/api/sessions/messages/deliver',
             '-H', 'Content-Type: application/json',
             '-d', json.dumps({'message_ids': ids})],
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL
        )
except:
    pass
" 2>/dev/null)

      if [ -n "$MSG_OUTPUT" ]; then
        SYSTEM_MSG="$MSG_OUTPUT"
      fi
    fi
  fi
fi

# ── Part 2: File Lock Check ────────────────────────────────────────────────
# Only check for file-modifying tools
case "$TOOL_NAME" in
  Write|Edit|MultiEdit)
    # Extract file_path from tool_input
    FILE_PATHS=$(/usr/bin/python3 -c "
import sys, json
try:
    data = json.loads(sys.argv[1])
    ti = data.get('tool_input', {})
    fp = ti.get('file_path', '')
    if fp:
        print(fp)
except:
    pass
" "$INPUT" 2>/dev/null)
    ;;
  Bash)
    # Parse command for file-modifying patterns
    FILE_PATHS=$(/usr/bin/python3 -c "
import sys, json, re, os
try:
    data = json.loads(sys.argv[1])
    cmd = data.get('tool_input', {}).get('command', '')
    files = set()
    # Redirect: > file, >> file
    for m in re.finditer(r'>{1,2}\s*([^\s;|&]+)', cmd):
        f = m.group(1).strip('\"').strip(\"'\")
        if f and not f.startswith('/dev/'):
            files.add(os.path.abspath(f) if not os.path.isabs(f) else f)
    # sed -i
    for m in re.finditer(r'sed\s+-i[^\s]*\s+[^\s]+\s+([^\s;|&]+)', cmd):
        files.add(os.path.abspath(m.group(1).strip('\"').strip(\"'\")))
    # tee
    for m in re.finditer(r'tee\s+(?:-a\s+)?([^\s;|&]+)', cmd):
        files.add(os.path.abspath(m.group(1).strip('\"').strip(\"'\")))
    for f in files:
        print(f)
except:
    pass
" "$INPUT" 2>/dev/null)
    ;;
  *)
    FILE_PATHS=""
    ;;
esac

# Check extracted file paths against the lock cache
if [ -n "$FILE_PATHS" ] && [ -f "$LOCK_CACHE" ]; then
  CONFLICTS=$(/usr/bin/python3 -c "
import sys, json, os
try:
    with open(os.path.expanduser('~/.claude/locks/state.json')) as f:
        locks = json.load(f)
    session_id = sys.argv[1]
    files = [l.strip() for l in sys.argv[2].split(chr(10)) if l.strip()]
    conflicts = []
    for fp in files:
        abs_fp = os.path.abspath(fp) if not os.path.isabs(fp) else fp
        if abs_fp in locks:
            lock = locks[abs_fp]
            if lock.get('session_id') != session_id:
                title = lock.get('session_title') or 'another session'
                conflicts.append(f'  - {os.path.basename(abs_fp)} (locked by {title})')
    if conflicts:
        print(chr(10).join(conflicts))
except:
    pass
" "$SESSION_ID" "$FILE_PATHS" 2>/dev/null)

  if [ -n "$CONFLICTS" ]; then
    LOCK_WARNING="
=== FILE LOCK WARNING ===
The following files are currently being edited by other sessions:
$CONFLICTS

To avoid conflicts:
- Skip editing these files and work on something else
- Coordinate with the other session via mailbox
- Ask the user to release the locks from the dashboard
=== END WARNING ==="

    if [ -n "$SYSTEM_MSG" ]; then
      SYSTEM_MSG="${SYSTEM_MSG}

${LOCK_WARNING}"
    else
      SYSTEM_MSG="$LOCK_WARNING"
    fi
  fi

  # Auto-acquire/renew locks in background (fire-and-forget)
  if [ -n "$CWD" ] && [ -n "$SESSION_ID" ]; then
    PROJECT_KEY=$(echo "$CWD" | tr '/' '-')
    FILE_PATHS_JSON=$(/usr/bin/python3 -c "
import sys, json, os
files = [os.path.abspath(l.strip()) if not os.path.isabs(l.strip()) else l.strip() for l in sys.argv[1].split(chr(10)) if l.strip()]
print(json.dumps(files))
" "$FILE_PATHS" 2>/dev/null)

    curl -s -X POST http://localhost:3030/api/locks/check-and-acquire \
      -H "Content-Type: application/json" \
      -d "{\"file_paths\":$FILE_PATHS_JSON,\"session_id\":\"$SESSION_ID\",\"project_dir\":\"$PROJECT_KEY\"}" \
      > /dev/null 2>&1 &
  fi
fi

# ── Output ─────────────────────────────────────────────────────────────────
if [ -n "$SYSTEM_MSG" ]; then
  /usr/bin/python3 -c "
import json, sys
print(json.dumps({'hookSpecificOutput': {}, 'systemMessage': sys.argv[1]}))
" "$SYSTEM_MSG" 2>/dev/null
else
  echo '{"hookSpecificOutput":{}}'
fi

exit 0
