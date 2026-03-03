# Agent Brain Project Instructions

## Agent Brain Integration
This project uses Agent Brain (http://localhost:3030) for persistent memory and inter-session communication across Claude Code sessions.

### At Session Start
1. Read the project memory to understand prior context:
```bash
curl -s http://localhost:3030/api/memory/-Users-lukeblanton-agent-brain | jq -r '.content'
```

2. Check the mailbox for any messages left by previous sessions or the user:
```bash
curl -s http://localhost:3030/api/mailbox/broadcast?unread=true
```
Also check for messages addressed specifically to this session's project:
```bash
curl -s http://localhost:3030/api/mailbox/-Users-lukeblanton-agent-brain?unread=true
```
If there are unread messages, read them and factor their contents into your work. Mark each message as read after processing:
```bash
curl -s -X POST http://localhost:3030/api/mailbox/<message_id>/read
```

### Before Session End or Context Compaction
1. Flush key findings, decisions, and progress back to memory:
```bash
curl -s -X PUT http://localhost:3030/api/memory/-Users-lukeblanton-agent-brain \
  -H "Content-Type: application/json" \
  -d "{\"content\": \"<updated MEMORY.md content>\"}"
```

2. Append a daily log entry summarizing what was accomplished:
```bash
curl -s -X POST http://localhost:3030/api/memory/-Users-lukeblanton-agent-brain/daily \
  -H "Content-Type: application/json" \
  -d "{\"content\": \"## Session Summary\n- <key accomplishments>\n- <decisions made>\n- <next steps>\"}"
```

3. If you have cross-session requests, information for the user, or notes for the next session, send a mailbox message:
```bash
curl -s -X POST http://localhost:3030/api/mailbox \
  -H "Content-Type: application/json" \
  -d "{\"from_session\": \"agent-brain-session\", \"to_session\": \"broadcast\", \"subject\": \"<subject>\", \"body\": \"<message body>\"}"
```
Use `"to_session": "broadcast"` for messages any session should see, or use a specific project directory key like `"-Users-lukeblanton-Documents-TCC-Project-Insiders-MVP"` to target a specific project's sessions.

## Project Context
- Node.js/Express server on port 3030
- Views are vanilla HTML in views/ directory (no framework)
- Templates loaded dynamically via readView() — changes take effect without restart
- Hook system for Claude Code permission approval from phone
- All data in sessions/ directory (JSON, JSONL)
- Push notifications via ntfy.sh
